import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  FUNCTIONAL_FIELD_SCENARIOS,
  FunctionalFieldError,
  createFunctionalFieldObservationTemplate,
  evaluateFunctionalFieldAcceptance,
  parseFunctionalCandidateManifest,
  parseFunctionalFieldObservation,
  requireFunctionalCandidateSource,
  requireUnusedFunctionalFieldFile,
  writeFunctionalFieldFile,
  type FunctionalFieldObservation,
} from "../src/functional-field-acceptance.js";

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
const source = { version: "2.0.0", versionCode: 20_000, commit };

test("functional field gate binds every passing scenario to one signed candidate", () => {
  const candidate = parseFunctionalCandidateManifest(manifest);
  const observations = passingObservations();
  const report = evaluateFunctionalFieldAcceptance(
    manifest,
    canonicalJson(observations),
    source,
    Date.parse("2026-08-25T02:00:00.000Z"),
  );

  assert.equal(report.gate.passed, true);
  assert.equal(report.gate.outcome, "passed");
  assert.equal(report.gate.requiredScenarioCount, FUNCTIONAL_FIELD_SCENARIOS.length);
  assert.equal(report.gate.passedScenarioCount, FUNCTIONAL_FIELD_SCENARIOS.length);
  assert.deepEqual(report.gate.failedScenarioIds, []);
  assert.deepEqual(report.gate.notRunScenarioIds, []);
  assert.equal(report.candidate.manifestSha256, candidate.manifestSha256);
  assert.equal(report.candidate.apkSha256, "c".repeat(64));
  assert.equal(report.evidenceKind, "operator_attested_structured");
  assert.deepEqual(report.privacy, {
    containsDeviceIdentifiers: false,
    containsNetworkValues: false,
    containsCredentials: false,
    containsFreeformNotes: false,
  });
});

test("functional field template is inert and every missing or failed scenario fails closed", () => {
  const candidate = parseFunctionalCandidateManifest(manifest);
  const template = createFunctionalFieldObservationTemplate(candidate, "2026-08-25T00:00:00.000Z");
  assert.equal(template.scenarios.length, FUNCTIONAL_FIELD_SCENARIOS.length);
  assert.ok(template.scenarios.every((scenario) => scenario.outcome === "not_run" && scenario.attempts === 0));

  const templateReport = evaluateFunctionalFieldAcceptance(
    manifest,
    canonicalJson(template),
    source,
    Date.parse("2026-08-25T00:01:00.000Z"),
  );
  assert.equal(templateReport.gate.passed, false);
  assert.equal(templateReport.gate.notRunScenarioIds.length, FUNCTIONAL_FIELD_SCENARIOS.length);
  assert.ok(templateReport.gate.checks.some((check) => (
    check.metric === "physical_android_device" && check.outcome === "fail"
  )));

  const observations = passingObservations();
  observations.scenarios[3] = {
    ...observations.scenarios[3]!,
    outcome: "fail",
    reason: "authorization_mismatch",
  };
  const failed = evaluateFunctionalFieldAcceptance(
    manifest,
    canonicalJson(observations),
    source,
    Date.parse("2026-08-25T02:00:00.000Z"),
  );
  assert.equal(failed.gate.passed, false);
  assert.deepEqual(failed.gate.failedScenarioIds, [FUNCTIONAL_FIELD_SCENARIOS[3]]);
});

test("functional observations reject candidate drift, freeform fields, duplicates, and invalid time evidence", () => {
  const candidate = parseFunctionalCandidateManifest(manifest);
  assert.throws(
    () => requireFunctionalCandidateSource(candidate, { ...source, commit: "e".repeat(40) }),
    /does not match the checked-out source identity/,
  );

  const drifted = passingObservations();
  drifted.candidate.apkSha256 = "f".repeat(64);
  assert.throws(
    () => evaluateFunctionalFieldAcceptance(
      manifest,
      canonicalJson(drifted),
      source,
      Date.parse("2026-08-25T02:00:00.000Z"),
    ),
    /different candidate/,
  );

  const withNotes = passingObservations() as FunctionalFieldObservation & { notes: string };
  withNotes.notes = "private-device private-network secret-token";
  assert.throws(() => parseFunctionalFieldObservation(canonicalJson(withNotes)), /fields are invalid/);

  const duplicated = passingObservations();
  duplicated.scenarios[1] = { ...duplicated.scenarios[0]! };
  assert.throws(() => parseFunctionalFieldObservation(canonicalJson(duplicated)), /invalid or duplicated/);

  const outsideWindow = passingObservations();
  outsideWindow.scenarios[0] = {
    ...outsideWindow.scenarios[0]!,
    observedAt: "2026-08-24T23:59:59.000Z",
  };
  assert.throws(() => parseFunctionalFieldObservation(canonicalJson(outsideWindow)), /outside the test window/);

  const stale = evaluateFunctionalFieldAcceptance(
    manifest,
    canonicalJson(passingObservations()),
    source,
    Date.parse("2026-10-01T00:00:00.000Z"),
  );
  assert.equal(stale.gate.passed, false);
  assert.ok(stale.gate.checks.some((check) => check.metric === "test_window_freshness" && check.outcome === "fail"));
});

test("functional candidate parser accepts only canonical signed update manifests", () => {
  const parsed = JSON.parse(manifest) as Record<string, unknown>;
  assert.throws(
    () => parseFunctionalCandidateManifest(canonicalJson({ ...parsed, signed: false })),
    /signed schema 1/,
  );
  assert.throws(
    () => parseFunctionalCandidateManifest(JSON.stringify(parsed)),
    /not canonical JSON/,
  );
  assert.throws(
    () => parseFunctionalCandidateManifest(canonicalJson({ ...parsed, privatePath: "/secret" })),
    /fields are invalid/,
  );
});

test("functional field files are owner-only, bounded, and create-once", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-pocket-functional-field-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "observations.json");
  const template = createFunctionalFieldObservationTemplate(
    parseFunctionalCandidateManifest(manifest),
    "2026-08-25T00:00:00.000Z",
  );
  await requireUnusedFunctionalFieldFile(path);
  await writeFunctionalFieldFile(path, template);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), template);
  await assert.rejects(requireUnusedFunctionalFieldFile(path), /already exists/);
  await assert.rejects(writeFunctionalFieldFile(path, template), /could not be written/);
  await assert.rejects(
    writeFunctionalFieldFile(join(directory, "oversized.json"), { value: "x".repeat(70 * 1024) }),
    (error: unknown) => error instanceof FunctionalFieldError && /size limit/.test(error.message),
  );
});

function passingObservations(): FunctionalFieldObservation {
  const candidate = parseFunctionalCandidateManifest(manifest);
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

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
