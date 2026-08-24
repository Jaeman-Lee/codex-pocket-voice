import assert from "node:assert/strict";
import { createHash, sign, X509Certificate } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  evaluateAndroidReleaseGate,
  type AndroidFieldReport,
  type AndroidFieldTransport,
} from "../src/android-field-metrics.js";
import {
  FUNCTIONAL_FIELD_SCENARIOS,
  createFunctionalFieldObservationTemplate,
  parseFunctionalCandidateManifest,
  type FunctionalFieldObservation,
} from "../src/functional-field-acceptance.js";
import {
  ReleaseEvidenceError,
  evaluateReleaseEvidence,
  parseAndroidFieldReport,
  requireUnusedReleaseEvidenceFile,
  writeReleaseEvidenceFile,
} from "../src/release-evidence.js";

const commit = "a".repeat(40);
const manifest = canonicalJson({
  schemaVersion: 1,
  applicationId: "io.github.jaemanlee.codexpocketvoice.stable",
  version: "2.0.0",
  versionCode: 20_000,
  channel: "stable",
  commit,
  createdAt: "2026-08-25T00:00:00.000Z",
  signed: true,
  signingCertificateSha256: "b".repeat(64),
  artifacts: [
    {
      kind: "apk",
      file: "Codex-Pocket-Voice-v2.0.0-stable.apk",
      sha256: "c".repeat(64),
      bytes: 12_345_678,
    },
    {
      kind: "sbom",
      file: "codex-pocket-sbom.json",
      sha256: "d".repeat(64),
      bytes: 54_321,
    },
  ],
});
const candidate = parseFunctionalCandidateManifest(manifest);
const source = { version: "2.0.0", versionCode: 20_000, commit };
const evaluationTime = Date.parse("2026-08-25T03:00:00.000Z");
const releaseEvidenceCli = fileURLToPath(new URL("../scripts/android-release-evidence.ts", import.meta.url));

test("release evidence binds functional and all three low-load gates to one candidate", () => {
  const report = evaluateReleaseEvidence(
    manifest,
    canonicalJson(passingObservations()),
    passingAndroidTexts(),
    passingProviderGradeTexts(),
    source,
    evaluationTime,
  );

  assert.equal(report.gate.passed, true);
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.gate.outcome, "passed");
  assert.deepEqual(report.candidate, candidate);
  assert.equal(report.functional.passedScenarioCount, FUNCTIONAL_FIELD_SCENARIOS.length);
  assert.deepEqual(
    report.androidTransports.map((entry) => entry.transport),
    ["direct_lan", "p2p", "outbound_relay"],
  );
  assert.ok(report.androidTransports.every((entry) => entry.outcome === "passed"));
  assert.equal(report.providerGrades.openai.coding, "pass");
  assert.equal(report.providerGrades.openrouter.length, 2);
  assert.equal(report.providerGrades.distinctOpenRouterUpstreamFamilies, true);
  assert.ok(report.gate.checks.every((check) => check.outcome === "pass"));
  assert.deepEqual(report.privacy, {
    containsDeviceIdentifiers: false,
    containsNetworkValues: false,
    containsCredentials: false,
    containsRawDiagnostics: false,
    containsPromptOrResponse: false,
  });
});

test("release evidence binds exact protected coding grades and requires two upstream families", () => {
  const expectedGrades = passingProviderGradeTexts();
  const mismatchedGrades = {
    ...expectedGrades,
    openai: expectedGrades.openai.replace('"coding": "pass"', '"coding": "fail"'),
  };
  assert.throws(
    () => evaluateReleaseEvidence(
      manifest,
      canonicalJson(passingObservations(candidate, expectedGrades)),
      passingAndroidTexts(),
      mismatchedGrades,
      source,
      evaluationTime,
    ),
    /does not match the functional observations/,
  );

  const sameFamilyGrades = passingProviderGradeTexts(
    "2026-08-24T23:55:00.000Z",
    ["Provider Family A", "Provider Family A"],
  );
  const sameFamily = evaluateReleaseEvidence(
    manifest,
    canonicalJson(passingObservations(candidate, sameFamilyGrades)),
    passingAndroidTexts(),
    sameFamilyGrades,
    source,
    evaluationTime,
  );
  assert.equal(sameFamily.gate.passed, false);
  assert.equal(sameFamily.providerGrades.distinctOpenRouterUpstreamFamilies, false);
  assert.ok(sameFamily.gate.checks.some((check) => (
    check.metric === "provider_grade:distinct_openrouter_upstream_families"
      && check.outcome === "fail"
  )));

  const failedCodingGrades = passingProviderGradeTexts();
  const failedCodingReport = JSON.parse(failedCodingGrades.openrouter[1]) as {
    grades: { coding: string };
    evaluation: { outcome: string; tools: Array<{ status: string }> };
  };
  failedCodingReport.grades.coding = "fail";
  failedCodingReport.evaluation.outcome = "contract_failed";
  failedCodingReport.evaluation.tools[1]!.status = "failed";
  failedCodingGrades.openrouter[1] = canonicalJson(failedCodingReport);
  const failedCoding = evaluateReleaseEvidence(
    manifest,
    canonicalJson(passingObservations(candidate, failedCodingGrades)),
    passingAndroidTexts(),
    failedCodingGrades,
    source,
    evaluationTime,
  );
  assert.equal(failedCoding.gate.passed, false);
  assert.ok(failedCoding.gate.checks.some((check) => (
    check.metric.startsWith("provider_grade:openrouter_")
      && check.metric.endsWith("_coding")
      && check.outcome === "fail"
  )));

  const lateGrades = passingProviderGradeTexts("2026-08-25T00:10:00.000Z");
  const late = evaluateReleaseEvidence(
    manifest,
    canonicalJson(passingObservations(candidate, lateGrades)),
    passingAndroidTexts(),
    lateGrades,
    source,
    evaluationTime,
  );
  assert.equal(late.gate.passed, false);
  assert.ok(late.gate.checks.some((check) => (
    check.metric.endsWith("_valid_at_field_start") && check.outcome === "fail"
  )));
});

test("release evidence rejects candidate drift and a report supplied for the wrong transport", () => {
  const drifted = passingAndroidReport("direct_lan");
  drifted.candidate.apkSha256 = "e".repeat(64);
  assert.throws(
    () => parseAndroidFieldReport(canonicalJson(drifted), candidate),
    /APK digest does not match the required value/,
  );

  const reports = passingAndroidTexts();
  reports.direct_lan = reports.p2p;
  assert.throws(
    () => evaluateReleaseEvidence(
      manifest,
      canonicalJson(passingObservations()),
      reports,
      passingProviderGradeTexts(),
      source,
      evaluationTime,
    ),
    /wrong slot/,
  );
});

test("Android aggregate parser rejects edited verdicts, extra fields, and noncanonical input", () => {
  const legacy = structuredClone(passingAndroidReport("p2p")) as unknown as { schemaVersion: number };
  legacy.schemaVersion = 2;
  assert.throws(
    () => parseAndroidFieldReport(canonicalJson(legacy), candidate),
    /schema is unsupported/,
  );

  const unverifiedApk = structuredClone(passingAndroidReport("p2p")) as unknown as {
    app: { digestVerifiedAtStartAndEnd: boolean };
  };
  unverifiedApk.app.digestVerifiedAtStartAndEnd = false;
  assert.throws(
    () => parseAndroidFieldReport(canonicalJson(unverifiedApk), candidate),
    /digest verification does not match/,
  );

  const tampered = passingAndroidReport("p2p");
  tampered.cpuPercent!.p95 = 6;
  tampered.cpuPercent!.max = 10;
  assert.throws(
    () => parseAndroidFieldReport(canonicalJson(tampered), candidate),
    /verdict does not match/,
  );

  const withPrivateNote = passingAndroidReport("p2p") as AndroidFieldReport & { note: string };
  withPrivateNote.note = "private-device private-network";
  assert.throws(
    () => parseAndroidFieldReport(canonicalJson(withPrivateNote), candidate),
    /fields are invalid/,
  );
  assert.throws(
    () => parseAndroidFieldReport(JSON.stringify(passingAndroidReport("p2p")), candidate),
    /not canonical JSON/,
  );
});

test("release evidence fails closed for stale or observation-only low-load evidence", () => {
  const stale = evaluateReleaseEvidence(
    manifest,
    canonicalJson(passingObservations()),
    passingAndroidTexts(),
    passingProviderGradeTexts(),
    source,
    Date.parse("2026-10-01T00:00:00.000Z"),
  );
  assert.equal(stale.gate.passed, false);
  assert.ok(stale.gate.checks.some((check) => (
    check.metric.startsWith("android_freshness:") && check.outcome === "fail"
  )));

  const observation = passingAndroidReport("outbound_relay");
  observation.gate = evaluateAndroidReleaseGate(observation, "observation");
  const reports = passingAndroidTexts();
  reports.outbound_relay = canonicalJson(observation);
  const incomplete = evaluateReleaseEvidence(
    manifest,
    canonicalJson(passingObservations()),
    reports,
    passingProviderGradeTexts(),
    source,
    evaluationTime,
  );
  assert.equal(incomplete.gate.passed, false);
  assert.ok(incomplete.gate.checks.some((check) => (
    check.metric === "android_gate:outbound_relay" && check.outcome === "fail"
  )));
});

test("Android report parser rejects inconsistent wall time and bounded input overflow", () => {
  const report = passingAndroidReport("direct_lan");
  report.testWindow.completedAt = "2026-08-25T02:30:00.000Z";
  assert.throws(
    () => parseAndroidFieldReport(canonicalJson(report), candidate),
    /durations do not agree/,
  );
  assert.throws(
    () => parseAndroidFieldReport(" ".repeat(65 * 1024), candidate),
    (error: unknown) => error instanceof ReleaseEvidenceError && /size limit/.test(error.message),
  );
});

test("final release evidence is owner-only, bounded, and create-once", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-pocket-release-evidence-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "release-evidence.json");
  const report = evaluateReleaseEvidence(
    manifest,
    canonicalJson(passingObservations()),
    passingAndroidTexts(),
    passingProviderGradeTexts(),
    source,
    evaluationTime,
  );
  await requireUnusedReleaseEvidenceFile(path);
  await writeReleaseEvidenceFile(path, report);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), report);
  await assert.rejects(requireUnusedReleaseEvidenceFile(path), /already exists/);
  await assert.rejects(writeReleaseEvidenceFile(path, report), /could not be written/);
});

test("final release evidence CLI cryptographically verifies the signed candidate before field evaluation", { timeout: 20_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-pocket-release-candidate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundleDirectory = join(root, "bundle");
  const fieldDirectory = join(root, "field");
  const binaryDirectory = join(root, "bin");
  await Promise.all([
    mkdir(bundleDirectory),
    mkdir(fieldDirectory),
    mkdir(binaryDirectory),
  ]);

  const apkPath = join(bundleDirectory, "Codex-Pocket-Voice-v2.0.0-stable.apk");
  const sbomPath = join(bundleDirectory, "codex-pocket-sbom.json");
  const manifestPath = join(bundleDirectory, "update-manifest.json");
  const signaturePath = join(bundleDirectory, "update-manifest.sig");
  const certificatePath = join(root, "trusted-certificate.pem");
  const privateKeyPath = join(root, "private-key.pem");
  await writeFile(apkPath, "signed APK fixture\n", { mode: 0o600 });
  await writeFile(sbomPath, "{\"bomFormat\":\"CycloneDX\"}\n", { mode: 0o600 });
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
    "-subj", "/CN=Codex Pocket Voice release evidence test",
    "-keyout", privateKeyPath,
    "-out", certificatePath,
  ], { stdio: "ignore" });
  const certificate = new X509Certificate(await readFile(certificatePath));
  const fingerprint = certificate.fingerprint256.replaceAll(":", "").toLowerCase();
  const signedManifest = canonicalJson({
    schemaVersion: 1,
    applicationId: "io.github.jaemanlee.codexpocketvoice.stable",
    version: "2.0.0",
    versionCode: 20_000,
    channel: "ci",
    commit,
    createdAt: "2026-08-25T00:00:00.000Z",
    signed: true,
    signingCertificateSha256: fingerprint,
    artifacts: [
      await artifactRecord("apk", apkPath, "Codex-Pocket-Voice-v2.0.0-stable.apk"),
      await artifactRecord("sbom", sbomPath, "codex-pocket-sbom.json"),
    ],
  });
  await writeFile(manifestPath, signedManifest, { mode: 0o600 });
  const signature = sign("sha256", Buffer.from(signedManifest), await readFile(privateKeyPath, "utf8"));
  await writeFile(signaturePath, `${signature.toString("base64")}\n`, { mode: 0o600 });

  const signedCandidate = parseFunctionalCandidateManifest(signedManifest);
  const observationPath = join(fieldDirectory, "functional-observations.json");
  const directPath = join(fieldDirectory, "direct-lan.json");
  const p2pPath = join(fieldDirectory, "p2p.json");
  const relayPath = join(fieldDirectory, "outbound-relay.json");
  const openaiGradePath = join(fieldDirectory, "openai-coding-grade.json");
  const openrouterGradePath1 = join(fieldDirectory, "openrouter-family-a-coding-grade.json");
  const openrouterGradePath2 = join(fieldDirectory, "openrouter-family-b-coding-grade.json");
  const testNow = Date.now();
  const testStartedAt = testNow - 2 * 60 * 60_000;
  const providerGrades = passingProviderGradeTexts(new Date(testStartedAt - 5 * 60_000).toISOString());
  const observations = passingObservations(signedCandidate, providerGrades);
  observations.testWindow = {
    startedAt: new Date(testStartedAt).toISOString(),
    completedAt: new Date(testNow - 5 * 60_000).toISOString(),
  };
  observations.scenarios = observations.scenarios.map((scenario) => ({
    ...scenario,
    observedAt: new Date(testNow - 60 * 60_000).toISOString(),
  }));
  const reports = Object.fromEntries(
    (["direct_lan", "p2p", "outbound_relay"] as const).map((transport) => {
      const report = passingAndroidReport(transport, signedCandidate);
      const completedAt = testNow - 10 * 60_000;
      report.testWindow = {
        startedAt: new Date(completedAt - report.measurement.actualDurationSeconds * 1_000).toISOString(),
        completedAt: new Date(completedAt).toISOString(),
      };
      return [transport, canonicalJson(report)];
    }),
  ) as Record<AndroidFieldTransport, string>;
  await Promise.all([
    writeFile(observationPath, canonicalJson(observations), { mode: 0o600 }),
    writeFile(directPath, reports.direct_lan, { mode: 0o600 }),
    writeFile(p2pPath, reports.p2p, { mode: 0o600 }),
    writeFile(relayPath, reports.outbound_relay, { mode: 0o600 }),
    writeFile(openaiGradePath, providerGrades.openai, { mode: 0o600 }),
    writeFile(openrouterGradePath1, providerGrades.openrouter[0], { mode: 0o600 }),
    writeFile(openrouterGradePath2, providerGrades.openrouter[1], { mode: 0o600 }),
  ]);

  const fakeApkSigner = join(binaryDirectory, "apksigner");
  await writeFile(
    fakeApkSigner,
    `#!/bin/sh\nprintf '%s\\n' 'Signer #1 certificate SHA-256 digest: ${fingerprint}'\n`,
    { mode: 0o700 },
  );
  await chmod(fakeApkSigner, 0o700);
  const fakeGit = join(binaryDirectory, "git");
  await writeFile(fakeGit, [
    "#!/bin/sh",
    `if [ \"$1\" = \"status\" ]; then printf '%s\\n' '# branch.oid ${commit}' '# branch.head feature/v2-control-plane'; exit 0; fi`,
    "exit 1",
    "",
  ].join("\n"), { mode: 0o700 });
  await chmod(fakeGit, 0o700);

  const reportPath = join(fieldDirectory, "release-evidence.json");
  const cliArguments = [
    "--manifest", manifestPath,
    "--signature", signaturePath,
    "--certificate", certificatePath,
    "--expected-certificate-sha256", fingerprint,
    "--artifact-dir", bundleDirectory,
    "--apksigner", fakeApkSigner,
    "--observations", observationPath,
    "--openai-grade-report", openaiGradePath,
    "--openrouter-grade-report-1", openrouterGradePath1,
    "--openrouter-grade-report-2", openrouterGradePath2,
    "--direct-lan-report", directPath,
    "--p2p-report", p2pPath,
    "--relay-report", relayPath,
  ];
  const environment = { ...process.env, PATH: `${binaryDirectory}:${process.env.PATH ?? ""}` };
  const valid = spawnSync(process.execPath, [
    "--import", "tsx", releaseEvidenceCli, ...cliArguments, "--report", reportPath,
  ], { encoding: "utf8", env: environment, timeout: 15_000 });
  assert.ifError(valid.error);
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /Exact-candidate release evidence gate passed/);
  assert.equal(JSON.parse(await readFile(reportPath, "utf8")).gate.passed, true);

  await chmod(openaiGradePath, 0o644);
  const broadGradeReportPath = join(fieldDirectory, "broad-grade-release-evidence.json");
  const broadGrade = spawnSync(process.execPath, [
    "--import", "tsx", releaseEvidenceCli, ...cliArguments, "--report", broadGradeReportPath,
  ], { encoding: "utf8", env: environment, timeout: 15_000 });
  assert.ifError(broadGrade.error);
  assert.notEqual(broadGrade.status, 0);
  assert.match(broadGrade.stderr, /OpenAI grade report is not an acceptable private regular file/);
  await assert.rejects(stat(broadGradeReportPath), /ENOENT/);
  await chmod(openaiGradePath, 0o600);

  const driftDirectory = join(root, "drift-bin");
  const driftCounter = join(root, "drift-counter");
  await mkdir(driftDirectory);
  const driftingGit = join(driftDirectory, "git");
  await writeFile(driftingGit, [
    "#!/usr/bin/env node",
    "import { existsSync, readFileSync, writeFileSync } from \"node:fs\";",
    `const counter = ${JSON.stringify(driftCounter)};`,
    "if (process.argv[2] !== \"status\") process.exit(1);",
    "const count = existsSync(counter) ? Number(readFileSync(counter, \"utf8\")) + 1 : 1;",
    "writeFileSync(counter, String(count));",
    `process.stdout.write(${JSON.stringify(`# branch.oid ${commit}\n# branch.head feature/v2-control-plane\n`)});`,
    "if (count > 1) process.stdout.write(\"? source-changed.ts\\n\");",
    "",
  ].join("\n"), { mode: 0o700 });
  await chmod(driftingGit, 0o700);
  const driftReportPath = join(fieldDirectory, "source-drift-release-evidence.json");
  const drifted = spawnSync(process.execPath, [
    "--import", "tsx", releaseEvidenceCli, ...cliArguments, "--report", driftReportPath,
  ], {
    encoding: "utf8",
    env: { ...environment, PATH: `${driftDirectory}:${environment.PATH ?? ""}` },
    timeout: 15_000,
  });
  assert.ifError(drifted.error);
  assert.notEqual(drifted.status, 0);
  assert.match(drifted.stderr, /Checked-out Git identity could not be verified/);
  await assert.rejects(stat(driftReportPath), /ENOENT/);

  const swappedManifest = canonicalJson({
    ...JSON.parse(signedManifest) as Record<string, unknown>,
    createdAt: "2026-08-25T00:00:01.000Z",
  });
  const swappingApkSigner = join(binaryDirectory, "swapping-apksigner.mjs");
  await writeFile(
    swappingApkSigner,
    [
      "#!/usr/bin/env node",
      "import { writeFileSync } from \"node:fs\";",
      `writeFileSync(${JSON.stringify(manifestPath)}, ${JSON.stringify(swappedManifest)}, { mode: 0o600 });`,
      `process.stdout.write(${JSON.stringify(`Signer #1 certificate SHA-256 digest: ${fingerprint}\n`)});`,
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  await chmod(swappingApkSigner, 0o700);
  const swappedReportPath = join(fieldDirectory, "swapped-release-evidence.json");
  const swapped = spawnSync(process.execPath, [
    "--import", "tsx", releaseEvidenceCli,
    ...replaceArgument(cliArguments, "--apksigner", swappingApkSigner),
    "--report", swappedReportPath,
  ], { encoding: "utf8", env: environment, timeout: 15_000 });
  assert.ifError(swapped.error);
  assert.notEqual(swapped.status, 0);
  assert.match(swapped.stderr, /Update manifest changed after cryptographic verification/);
  await assert.rejects(stat(swappedReportPath), /ENOENT/);
  await writeFile(manifestPath, signedManifest, { mode: 0o600 });

  await writeFile(apkPath, "tampered APK fixture\n", { mode: 0o600 });
  const rejectedReportPath = join(fieldDirectory, "rejected-release-evidence.json");
  const rejected = spawnSync(process.execPath, [
    "--import", "tsx", releaseEvidenceCli, ...cliArguments, "--report", rejectedReportPath,
  ], { encoding: "utf8", env: environment, timeout: 15_000 });
  assert.ifError(rejected.error);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /Signed update bundle verification failed before release evidence evaluation/);
  await assert.rejects(stat(rejectedReportPath), /ENOENT/);
});

function passingObservations(
  forCandidate = candidate,
  grades = passingProviderGradeTexts(),
): FunctionalFieldObservation {
  const observations = createFunctionalFieldObservationTemplate(forCandidate, "2026-08-25T00:00:00.000Z");
  observations.testWindow.completedAt = "2026-08-25T01:30:00.000Z";
  observations.environment = {
    physicalAndroidDevice: true,
    androidApiLevel: 30,
    linuxCompanionCount: 2,
    androidClientCount: 2,
    openRouterUpstreamFamilyCount: 2,
    rollback: {
      sourceVersion: "1.8.1",
      sourceVersionCode: 10_801,
      mechanism: "android_rollback_manager",
      dataPolicy: "restore",
    },
  };
  observations.providerGradeReports = {
    openaiCodingSha256: sha256(grades.openai),
    openRouterCodingSha256: [sha256(grades.openrouter[0]), sha256(grades.openrouter[1])],
  };
  observations.attestations = {
    signedBundleVerified: true,
    candidateIdentityMatched: true,
    providerSecretsStayedOnCompanion: true,
    noPrivateValuesRecorded: true,
    touchApprovalsObserved: true,
    rollbackArtifactPreverified: true,
    rollbackSnapshotAvailableBeforeCandidateRun: true,
  };
  observations.scenarios = FUNCTIONAL_FIELD_SCENARIOS.map((id) => ({
    id,
    outcome: "pass",
    attempts: 1,
    observedAt: "2026-08-25T01:00:00.000Z",
    reason: null,
  }));
  return observations;
}

function passingProviderGradeTexts(
  checkedAt = "2026-08-24T23:55:00.000Z",
  families: [string, string] = ["Provider Family A", "Provider Family B"],
) {
  return {
    openai: canonicalJson({
      schemaVersion: 1,
      provider: "openai",
      requestedModel: "gpt-release-model",
      actualModel: "gpt-release-model-2026-08-01",
      privacyProfile: { store: false, serviceTier: "default" },
      grades: {
        streaming: "pass",
        conversation: "pass",
        functionCalling: "pass",
        statelessReplay: "pass",
        projectRead: "pass",
        coding: "pass",
      },
      ...passingProviderGradeAccounting("openai"),
      evaluation: passingCodingEvaluation(),
      checkedAt,
    }),
    openrouter: (["family-a", "family-b"] as const).map((upstream, index) => canonicalJson({
      schemaVersion: 2,
      provider: "openrouter",
      model: "vendor/release-model",
      requestedUpstream: upstream,
      actualProviders: [families[index]],
      privacyProfile: { zdr: true, dataCollection: "deny", allowFallbacks: false },
      grades: {
        conversation: "pass",
        toolCalling: "pass",
        projectRead: "pass",
        coding: "pass",
      },
      ...passingProviderGradeAccounting("openrouter"),
      evaluation: passingCodingEvaluation(),
      checkedAt,
    })) as [string, string],
  };
}

function passingCodingEvaluation() {
  return {
    scope: "coding",
    fixture: "ephemeral_synthetic_workspace",
    approval: "protected_workflow_and_exact_confirmation",
    maximumRequests: 3,
    outcome: "pass",
    tools: [
      { name: "workspace_read", status: "completed" },
      { name: "workspace_replace_text", status: "completed" },
    ],
  };
}

function passingProviderGradeAccounting(provider: "openai" | "openrouter") {
  return {
    budgetUsd: 0.05,
    estimatedMaximumUsd: 0.026112,
    calls: 3,
    usage: {
      requestCount: 3,
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      ...(provider === "openrouter" ? { costCredits: 0.001 } : {}),
    },
    actualEstimatedUsd: 0.00014,
    ...(provider === "openai" ? {
      pricingBasis: {
        currency: "USD",
        inputUsdPerMillion: 1,
        outputUsdPerMillion: 2,
        source: "operator_reviewed",
      },
    } : {
      actualCostCredits: 0.001,
      creditBaseCurrency: "USD",
      pricingBasis: {
        currency: "USD",
        inputUsdPerMillion: 1,
        outputUsdPerMillion: 2,
        requestUsd: 0,
        source: "zdr_endpoint_catalog",
      },
    }),
  };
}

function passingAndroidTexts(forCandidate = candidate): Record<AndroidFieldTransport, string> {
  return {
    direct_lan: canonicalJson(passingAndroidReport("direct_lan", forCandidate)),
    p2p: canonicalJson(passingAndroidReport("p2p", forCandidate)),
    outbound_relay: canonicalJson(passingAndroidReport("outbound_relay", forCandidate)),
  };
}

function passingAndroidReport(transport: AndroidFieldTransport, forCandidate = candidate): AndroidFieldReport {
  const report: AndroidFieldReport = {
    schemaVersion: 3,
    kind: "android_field_acceptance",
    evidenceKind: "adb_aggregate_measurement",
    candidate: { ...forCandidate },
    transport,
    testWindow: {
      startedAt: "2026-08-25T00:00:00.000Z",
      completedAt: "2026-08-25T01:00:01.000Z",
    },
    app: {
      packageName: forCandidate.applicationId,
      versionName: forCandidate.version,
      versionCode: forCandidate.versionCode,
      apkSha256: forCandidate.apkSha256,
      digestVerifiedAtStartAndEnd: true,
    },
    measurement: {
      requestedDurationSeconds: 3_600,
      actualDurationSeconds: 3_601,
      intervalSeconds: 15,
      scheduledSamples: 241,
      processPresencePercent: 100,
      cpuCoveragePercent: 100,
      memoryCoveragePercent: 100,
    },
    cpuPercent: { mean: 1, p95: 2, max: 4 },
    memoryMib: {
      pss: { mean: 100, p95: 120, max: 150 },
      rss: { mean: 150, p95: 175, max: 190 },
    },
    battery: { state: "discharging", levelDropPercent: 2, percentPerHour: 2 },
    backgroundWake: { state: "available", durationMs: 36_000, percentOfMeasurement: 1 },
    gate: {
      mode: "observation",
      outcome: "observation_only",
      passed: null,
      thresholds: null,
      checks: [],
    },
    privacy: {
      containsDeviceIdentifiers: false,
      containsRawAdbOutput: false,
      containsNetworkValues: false,
    },
  };
  report.gate = evaluateAndroidReleaseGate(report, "release_gate");
  return report;
}

async function artifactRecord(kind: "apk" | "sbom", path: string, file: string) {
  const bytes = await readFile(path);
  return {
    kind,
    file,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  };
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function replaceArgument(values: string[], name: string, replacement: string): string[] {
  const result = [...values];
  const index = result.indexOf(name);
  assert.notEqual(index, -1);
  result[index + 1] = replacement;
  return result;
}
