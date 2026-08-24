import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("release evidence binds functional and all three low-load gates to one candidate", () => {
  const report = evaluateReleaseEvidence(
    manifest,
    canonicalJson(passingObservations()),
    passingAndroidTexts(),
    source,
    evaluationTime,
  );

  assert.equal(report.gate.passed, true);
  assert.equal(report.gate.outcome, "passed");
  assert.deepEqual(report.candidate, candidate);
  assert.equal(report.functional.passedScenarioCount, FUNCTIONAL_FIELD_SCENARIOS.length);
  assert.deepEqual(
    report.androidTransports.map((entry) => entry.transport),
    ["direct_lan", "p2p", "outbound_relay"],
  );
  assert.ok(report.androidTransports.every((entry) => entry.outcome === "passed"));
  assert.ok(report.gate.checks.every((check) => check.outcome === "pass"));
  assert.deepEqual(report.privacy, {
    containsDeviceIdentifiers: false,
    containsNetworkValues: false,
    containsCredentials: false,
    containsRawDiagnostics: false,
    containsPromptOrResponse: false,
  });
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
      source,
      evaluationTime,
    ),
    /wrong slot/,
  );
});

test("Android aggregate parser rejects edited verdicts, extra fields, and noncanonical input", () => {
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

function passingObservations(): FunctionalFieldObservation {
  const observations = createFunctionalFieldObservationTemplate(candidate, "2026-08-25T00:00:00.000Z");
  observations.testWindow.completedAt = "2026-08-25T01:30:00.000Z";
  observations.environment = {
    physicalAndroidDevice: true,
    androidApiLevel: 30,
    linuxCompanionCount: 2,
    androidClientCount: 2,
    openRouterUpstreamFamilyCount: 2,
  };
  observations.attestations = {
    signedBundleVerified: true,
    candidateIdentityMatched: true,
    providerSecretsStayedOnCompanion: true,
    noPrivateValuesRecorded: true,
    touchApprovalsObserved: true,
    rollbackArtifactPreverified: true,
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

function passingAndroidTexts(): Record<AndroidFieldTransport, string> {
  return {
    direct_lan: canonicalJson(passingAndroidReport("direct_lan")),
    p2p: canonicalJson(passingAndroidReport("p2p")),
    outbound_relay: canonicalJson(passingAndroidReport("outbound_relay")),
  };
}

function passingAndroidReport(transport: AndroidFieldTransport): AndroidFieldReport {
  const report: AndroidFieldReport = {
    schemaVersion: 2,
    kind: "android_field_acceptance",
    evidenceKind: "adb_aggregate_measurement",
    candidate: { ...candidate },
    transport,
    testWindow: {
      startedAt: "2026-08-25T00:00:00.000Z",
      completedAt: "2026-08-25T01:00:01.000Z",
    },
    app: {
      packageName: candidate.applicationId,
      versionName: candidate.version,
      versionCode: candidate.versionCode,
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

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
