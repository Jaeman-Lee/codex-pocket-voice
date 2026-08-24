import { createHash } from "node:crypto";
import { lstat, writeFile } from "node:fs/promises";

const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_OBSERVATION_BYTES = 64 * 1024;
const MAX_REPORT_BYTES = 64 * 1024;
const MAX_FIELD_AGE_MS = 30 * 24 * 60 * 60_000;
const MAX_CLOCK_SKEW_MS = 5 * 60_000;

export const FUNCTIONAL_FIELD_SCENARIOS = [
  "candidate_update_install",
  "workspace_project_identity",
  "multi_client_pairing_restart",
  "client_revoke_restart",
  "tls_key_rotation_restart",
  "codex_queue_steer_handoff",
  "openai_project_patch_test",
  "openrouter_two_upstream_tool_contract",
  "provider_context_fork",
  "approval_decline_expiry_recovery",
  "provider_failure_no_fallback",
  "openrouter_strict_privacy_rejection",
  "multi_project_exit_network_restore",
  "notification_locked_process_kill",
  "voice_and_spoken_settings",
  "media_and_artifact_review",
  "direct_lan_transport",
  "p2p_transport",
  "outbound_relay_transport",
  "rollback_1_8_1_records",
] as const;

export type FunctionalFieldScenarioId = typeof FUNCTIONAL_FIELD_SCENARIOS[number];
export type FunctionalFieldOutcome = "pass" | "fail" | "not_run";
export type FunctionalFieldReason =
  | "unexpected_behavior"
  | "unsafe_fallback"
  | "state_not_restored"
  | "authorization_mismatch"
  | "transport_unavailable"
  | "provider_unavailable"
  | "artifact_unavailable"
  | "rollback_failed"
  | "operator_aborted"
  | "not_run";

export interface FunctionalCandidateIdentity {
  applicationId: string;
  version: string;
  versionCode: number;
  channel: string;
  commit: string;
  manifestSha256: string;
  apkSha256: string;
  signingCertificateSha256: string;
}

export interface FunctionalFieldObservation {
  schemaVersion: 1;
  kind: "codex_pocket_functional_observations";
  candidate: {
    manifestSha256: string;
    commit: string;
    apkSha256: string;
  };
  testWindow: {
    startedAt: string;
    completedAt: string;
  };
  environment: {
    physicalAndroidDevice: boolean;
    androidApiLevel: number;
    linuxCompanionCount: number;
    androidClientCount: number;
    openRouterUpstreamFamilyCount: number;
  };
  attestations: {
    signedBundleVerified: boolean;
    candidateIdentityMatched: boolean;
    providerSecretsStayedOnCompanion: boolean;
    noPrivateValuesRecorded: boolean;
    touchApprovalsObserved: boolean;
    rollbackArtifactPreverified: boolean;
  };
  scenarios: Array<{
    id: FunctionalFieldScenarioId;
    outcome: FunctionalFieldOutcome;
    attempts: number;
    observedAt: string | null;
    reason: FunctionalFieldReason | null;
  }>;
}

interface FunctionalGateCheck {
  metric: string;
  outcome: "pass" | "fail";
  observed: boolean | number | string;
  requirement: boolean | number | string;
}

export interface FunctionalFieldReport {
  schemaVersion: 1;
  kind: "codex_pocket_functional_acceptance";
  evidenceKind: "operator_attested_structured";
  createdAt: string;
  candidate: FunctionalCandidateIdentity;
  testWindow: FunctionalFieldObservation["testWindow"];
  environment: FunctionalFieldObservation["environment"];
  attestations: FunctionalFieldObservation["attestations"];
  scenarios: FunctionalFieldObservation["scenarios"];
  gate: {
    outcome: "passed" | "failed";
    passed: boolean;
    requiredScenarioCount: number;
    passedScenarioCount: number;
    failedScenarioIds: FunctionalFieldScenarioId[];
    notRunScenarioIds: FunctionalFieldScenarioId[];
    checks: FunctionalGateCheck[];
  };
  privacy: {
    containsDeviceIdentifiers: false;
    containsNetworkValues: false;
    containsCredentials: false;
    containsFreeformNotes: false;
  };
}

export class FunctionalFieldError extends Error {}

export function parseFunctionalCandidateManifest(text: string): FunctionalCandidateIdentity {
  boundedText(text, MAX_MANIFEST_BYTES, "Update manifest");
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new FunctionalFieldError("Update manifest is not valid JSON");
  }
  const record = exactRecord(value, [
    "schemaVersion", "applicationId", "version", "versionCode", "channel", "commit", "createdAt",
    "signed", "signingCertificateSha256", "artifacts",
  ], "Update manifest");
  if (record.schemaVersion !== 1 || record.signed !== true) {
    throw new FunctionalFieldError("A signed schema 1 update manifest is required");
  }
  const applicationId = requiredString(record.applicationId, /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/, "Application ID");
  const version = requiredString(record.version, /^\d+\.\d+\.\d+$/, "Version");
  const parts = version.split(".").map(Number);
  const versionCode = strictInteger(record.versionCode, 1, Number.MAX_SAFE_INTEGER, "Version code");
  if (parts[1]! > 99 || parts[2]! > 99
      || versionCode !== parts[0]! * 10_000 + parts[1]! * 100 + parts[2]!) {
    throw new FunctionalFieldError("Version code does not match the update version");
  }
  const channel = requiredString(record.channel, /^[a-z0-9][a-z0-9-]{0,31}$/, "Channel");
  const commit = requiredDigest(record.commit, 40, "Commit");
  canonicalTimestamp(record.createdAt, "Manifest creation time");
  const signingCertificateSha256 = requiredDigest(record.signingCertificateSha256, 64, "Signing certificate digest");
  if (!Array.isArray(record.artifacts) || record.artifacts.length !== 2) {
    throw new FunctionalFieldError("Update manifest artifact list is invalid");
  }
  const artifacts = record.artifacts.map((artifact) => parseArtifact(artifact));
  const apk = artifacts.filter((artifact) => artifact.kind === "apk");
  const sbom = artifacts.filter((artifact) => artifact.kind === "sbom");
  if (apk.length !== 1 || sbom.length !== 1) {
    throw new FunctionalFieldError("Update manifest requires one APK and one SBOM");
  }
  if (!apk[0]!.file.includes(`v${version}`) || !apk[0]!.file.endsWith(".apk")) {
    throw new FunctionalFieldError("APK filename does not match the update version");
  }
  if (text !== `${JSON.stringify(value, null, 2)}\n`) {
    throw new FunctionalFieldError("Update manifest is not canonical JSON");
  }
  return {
    applicationId,
    version,
    versionCode,
    channel,
    commit,
    manifestSha256: createHash("sha256").update(text, "utf8").digest("hex"),
    apkSha256: apk[0]!.sha256,
    signingCertificateSha256,
  };
}

export function createFunctionalFieldObservationTemplate(
  candidate: FunctionalCandidateIdentity,
  timestamp = new Date().toISOString(),
): FunctionalFieldObservation {
  const canonical = canonicalTimestamp(timestamp, "Template time");
  return {
    schemaVersion: 1,
    kind: "codex_pocket_functional_observations",
    candidate: {
      manifestSha256: candidate.manifestSha256,
      commit: candidate.commit,
      apkSha256: candidate.apkSha256,
    },
    testWindow: { startedAt: canonical, completedAt: canonical },
    environment: {
      physicalAndroidDevice: false,
      androidApiLevel: 0,
      linuxCompanionCount: 0,
      androidClientCount: 0,
      openRouterUpstreamFamilyCount: 0,
    },
    attestations: {
      signedBundleVerified: false,
      candidateIdentityMatched: false,
      providerSecretsStayedOnCompanion: false,
      noPrivateValuesRecorded: false,
      touchApprovalsObserved: false,
      rollbackArtifactPreverified: false,
    },
    scenarios: FUNCTIONAL_FIELD_SCENARIOS.map((id) => ({
      id,
      outcome: "not_run",
      attempts: 0,
      observedAt: null,
      reason: "not_run",
    })),
  };
}

export function parseFunctionalFieldObservation(text: string): FunctionalFieldObservation {
  boundedText(text, MAX_OBSERVATION_BYTES, "Functional observations");
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new FunctionalFieldError("Functional observations are not valid JSON");
  }
  const root = exactRecord(value, [
    "schemaVersion", "kind", "candidate", "testWindow", "environment", "attestations", "scenarios",
  ], "Functional observations");
  if (root.schemaVersion !== 1 || root.kind !== "codex_pocket_functional_observations") {
    throw new FunctionalFieldError("Functional observation schema is unsupported");
  }
  const candidateRecord = exactRecord(
    root.candidate,
    ["manifestSha256", "commit", "apkSha256"],
    "Observation candidate",
  );
  const candidate = {
    manifestSha256: requiredDigest(candidateRecord.manifestSha256, 64, "Observation manifest digest"),
    commit: requiredDigest(candidateRecord.commit, 40, "Observation commit"),
    apkSha256: requiredDigest(candidateRecord.apkSha256, 64, "Observation APK digest"),
  };
  const windowRecord = exactRecord(root.testWindow, ["startedAt", "completedAt"], "Test window");
  const testWindow = {
    startedAt: canonicalTimestamp(windowRecord.startedAt, "Test start time"),
    completedAt: canonicalTimestamp(windowRecord.completedAt, "Test completion time"),
  };
  const startedAt = Date.parse(testWindow.startedAt);
  const completedAt = Date.parse(testWindow.completedAt);
  if (completedAt < startedAt || completedAt - startedAt > MAX_FIELD_AGE_MS) {
    throw new FunctionalFieldError("Functional test window is invalid");
  }
  const environmentRecord = exactRecord(root.environment, [
    "physicalAndroidDevice", "androidApiLevel", "linuxCompanionCount", "androidClientCount",
    "openRouterUpstreamFamilyCount",
  ], "Field environment");
  const environment = {
    physicalAndroidDevice: strictBoolean(environmentRecord.physicalAndroidDevice, "Physical-device state"),
    androidApiLevel: strictInteger(environmentRecord.androidApiLevel, 0, 100, "Android API level"),
    linuxCompanionCount: strictInteger(environmentRecord.linuxCompanionCount, 0, 8, "Linux Companion count"),
    androidClientCount: strictInteger(environmentRecord.androidClientCount, 0, 8, "Android client count"),
    openRouterUpstreamFamilyCount: strictInteger(
      environmentRecord.openRouterUpstreamFamilyCount,
      0,
      8,
      "OpenRouter upstream family count",
    ),
  };
  const attestationRecord = exactRecord(root.attestations, [
    "signedBundleVerified", "candidateIdentityMatched", "providerSecretsStayedOnCompanion",
    "noPrivateValuesRecorded", "touchApprovalsObserved", "rollbackArtifactPreverified",
  ], "Field attestations");
  const attestations = {
    signedBundleVerified: strictBoolean(attestationRecord.signedBundleVerified, "Signed-bundle attestation"),
    candidateIdentityMatched: strictBoolean(attestationRecord.candidateIdentityMatched, "Candidate identity attestation"),
    providerSecretsStayedOnCompanion: strictBoolean(
      attestationRecord.providerSecretsStayedOnCompanion,
      "Provider-secret attestation",
    ),
    noPrivateValuesRecorded: strictBoolean(attestationRecord.noPrivateValuesRecorded, "Privacy attestation"),
    touchApprovalsObserved: strictBoolean(attestationRecord.touchApprovalsObserved, "Touch-approval attestation"),
    rollbackArtifactPreverified: strictBoolean(
      attestationRecord.rollbackArtifactPreverified,
      "Rollback attestation",
    ),
  };
  if (!Array.isArray(root.scenarios) || root.scenarios.length !== FUNCTIONAL_FIELD_SCENARIOS.length) {
    throw new FunctionalFieldError("Functional scenario list is incomplete");
  }
  const seen = new Set<string>();
  const scenarios = root.scenarios.map((scenario) => {
    const record = exactRecord(
      scenario,
      ["id", "outcome", "attempts", "observedAt", "reason"],
      "Functional scenario",
    );
    if (typeof record.id !== "string" || !isScenarioId(record.id) || seen.has(record.id)) {
      throw new FunctionalFieldError("Functional scenario ID is invalid or duplicated");
    }
    seen.add(record.id);
    if (record.outcome !== "pass" && record.outcome !== "fail" && record.outcome !== "not_run") {
      throw new FunctionalFieldError("Functional scenario outcome is invalid");
    }
    const outcome: FunctionalFieldOutcome = record.outcome;
    const attempts = strictInteger(record.attempts, 0, 20, "Functional scenario attempts");
    let observedAt: string | null;
    let reason: FunctionalFieldReason | null;
    if (outcome === "not_run") {
      if (attempts !== 0 || record.observedAt !== null || record.reason !== "not_run") {
        throw new FunctionalFieldError("A not-run scenario must remain an inert observation");
      }
      observedAt = null;
      reason = "not_run";
    } else {
      if (attempts < 1) throw new FunctionalFieldError("An observed scenario requires at least one attempt");
      observedAt = canonicalTimestamp(record.observedAt, "Scenario observation time");
      const observedTime = Date.parse(observedAt);
      if (observedTime < startedAt || observedTime > completedAt) {
        throw new FunctionalFieldError("Scenario observation time falls outside the test window");
      }
      if (outcome === "pass") {
        if (record.reason !== null) throw new FunctionalFieldError("A passing scenario cannot have a failure reason");
        reason = null;
      } else {
        if (!isFailureReason(record.reason)) throw new FunctionalFieldError("Scenario failure reason is invalid");
        reason = record.reason;
      }
    }
    return { id: record.id, outcome, attempts, observedAt, reason };
  });
  if (FUNCTIONAL_FIELD_SCENARIOS.some((id) => !seen.has(id))) {
    throw new FunctionalFieldError("Functional scenario list is incomplete");
  }
  return {
    schemaVersion: 1,
    kind: "codex_pocket_functional_observations",
    candidate,
    testWindow,
    environment,
    attestations,
    scenarios,
  };
}

export function evaluateFunctionalFieldAcceptance(
  manifestText: string,
  observationText: string,
  expectedSource: { version: string; versionCode: number; commit: string },
  now = Date.now(),
): FunctionalFieldReport {
  const candidate = parseFunctionalCandidateManifest(manifestText);
  requireFunctionalCandidateSource(candidate, expectedSource);
  const observations = parseFunctionalFieldObservation(observationText);
  if (observations.candidate.manifestSha256 !== candidate.manifestSha256
      || observations.candidate.commit !== candidate.commit
      || observations.candidate.apkSha256 !== candidate.apkSha256) {
    throw new FunctionalFieldError("Functional observations belong to a different candidate");
  }
  if (!Number.isFinite(now)) throw new FunctionalFieldError("Evaluation time is invalid");
  const completedAt = Date.parse(observations.testWindow.completedAt);
  const durationSeconds = (completedAt - Date.parse(observations.testWindow.startedAt)) / 1_000;
  const scenarioChecks: FunctionalGateCheck[] = observations.scenarios.map((scenario) => ({
    metric: `scenario:${scenario.id}`,
    outcome: scenario.outcome === "pass" ? "pass" : "fail",
    observed: scenario.outcome,
    requirement: "pass",
  }));
  const checks: FunctionalGateCheck[] = [
    booleanCheck("physical_android_device", observations.environment.physicalAndroidDevice),
    minimumCheck("android_api_level", observations.environment.androidApiLevel, 30),
    minimumCheck("linux_companion_count", observations.environment.linuxCompanionCount, 2),
    minimumCheck("android_client_count", observations.environment.androidClientCount, 2),
    minimumCheck("openrouter_upstream_family_count", observations.environment.openRouterUpstreamFamilyCount, 2),
    minimumCheck("test_window_seconds", durationSeconds, 60),
    {
      metric: "test_window_freshness",
      outcome: completedAt <= now + MAX_CLOCK_SKEW_MS && completedAt >= now - MAX_FIELD_AGE_MS ? "pass" : "fail",
      observed: observations.testWindow.completedAt,
      requirement: "within 30 days and not in the future",
    },
    ...Object.entries(observations.attestations).map(([name, observed]) => booleanCheck(`attestation:${name}`, observed)),
    ...scenarioChecks,
  ];
  const passed = checks.every((check) => check.outcome === "pass");
  return {
    schemaVersion: 1,
    kind: "codex_pocket_functional_acceptance",
    evidenceKind: "operator_attested_structured",
    createdAt: new Date(now).toISOString(),
    candidate,
    testWindow: observations.testWindow,
    environment: observations.environment,
    attestations: observations.attestations,
    scenarios: observations.scenarios,
    gate: {
      outcome: passed ? "passed" : "failed",
      passed,
      requiredScenarioCount: FUNCTIONAL_FIELD_SCENARIOS.length,
      passedScenarioCount: observations.scenarios.filter((scenario) => scenario.outcome === "pass").length,
      failedScenarioIds: observations.scenarios
        .filter((scenario) => scenario.outcome === "fail")
        .map((scenario) => scenario.id),
      notRunScenarioIds: observations.scenarios
        .filter((scenario) => scenario.outcome === "not_run")
        .map((scenario) => scenario.id),
      checks,
    },
    privacy: {
      containsDeviceIdentifiers: false,
      containsNetworkValues: false,
      containsCredentials: false,
      containsFreeformNotes: false,
    },
  };
}

export function requireFunctionalCandidateSource(
  candidate: FunctionalCandidateIdentity,
  expectedSource: { version: string; versionCode: number; commit: string },
): void {
  validateExpectedSource(expectedSource);
  if (candidate.version !== expectedSource.version || candidate.versionCode !== expectedSource.versionCode
      || candidate.commit !== expectedSource.commit) {
    throw new FunctionalFieldError("Update manifest does not match the checked-out source identity");
  }
}

export async function requireUnusedFunctionalFieldFile(path: string): Promise<void> {
  if (!path || path.length > 4_096 || /[\u0000-\u001f\u007f]/.test(path)) {
    throw new FunctionalFieldError("Functional field file path is invalid");
  }
  try {
    await lstat(path);
    throw new FunctionalFieldError("Functional field file already exists");
  } catch (error) {
    if (error instanceof FunctionalFieldError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new FunctionalFieldError("Functional field file path could not be checked");
    }
  }
}

export async function writeFunctionalFieldFile(path: string, value: unknown): Promise<void> {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_REPORT_BYTES) {
    throw new FunctionalFieldError("Functional field file exceeded its size limit");
  }
  try {
    await writeFile(path, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch {
    throw new FunctionalFieldError("Functional field file could not be written");
  }
}

function parseArtifact(value: unknown): { kind: "apk" | "sbom"; file: string; sha256: string; bytes: number } {
  const record = exactRecord(value, ["kind", "file", "sha256", "bytes"], "Update artifact");
  if (record.kind !== "apk" && record.kind !== "sbom") {
    throw new FunctionalFieldError("Update artifact kind is invalid");
  }
  const kind = record.kind;
  const file = requiredString(record.file, /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/, "Artifact filename");
  if (file === "." || file === "..") throw new FunctionalFieldError("Artifact filename is invalid");
  return {
    kind,
    file,
    sha256: requiredDigest(record.sha256, 64, "Artifact digest"),
    bytes: strictInteger(
      record.bytes,
      1,
      kind === "apk" ? 1024 * 1024 * 1024 : 64 * 1024 * 1024,
      "Artifact byte count",
    ),
  };
}

function exactRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new FunctionalFieldError(`${label} is invalid`);
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new FunctionalFieldError(`${label} fields are invalid`);
  }
  return record;
}

function requiredString(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== "string" || !pattern.test(value)) throw new FunctionalFieldError(`${label} is invalid`);
  return value;
}

function requiredDigest(value: unknown, length: 40 | 64, label: string): string {
  return requiredString(value, new RegExp(`^[a-f0-9]{${length}}$`), label);
}

function strictInteger(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new FunctionalFieldError(`${label} is invalid`);
  }
  return value as number;
}

function strictBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new FunctionalFieldError(`${label} is invalid`);
  return value;
}

function canonicalTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))
      || new Date(value).toISOString() !== value) {
    throw new FunctionalFieldError(`${label} is invalid`);
  }
  return value;
}

function isScenarioId(value: string): value is FunctionalFieldScenarioId {
  return (FUNCTIONAL_FIELD_SCENARIOS as readonly string[]).includes(value);
}

function isFailureReason(value: unknown): value is Exclude<FunctionalFieldReason, "not_run"> {
  return typeof value === "string" && [
    "unexpected_behavior",
    "unsafe_fallback",
    "state_not_restored",
    "authorization_mismatch",
    "transport_unavailable",
    "provider_unavailable",
    "artifact_unavailable",
    "rollback_failed",
    "operator_aborted",
  ].includes(value);
}

function validateExpectedSource(source: { version: string; versionCode: number; commit: string }): void {
  if (!/^\d+\.\d+\.\d+$/.test(source.version)
      || !Number.isSafeInteger(source.versionCode) || source.versionCode <= 0
      || !/^[a-f0-9]{40}$/.test(source.commit)) {
    throw new FunctionalFieldError("Checked-out source identity is invalid");
  }
}

function booleanCheck(metric: string, observed: boolean): FunctionalGateCheck {
  return { metric, outcome: observed ? "pass" : "fail", observed, requirement: true };
}

function minimumCheck(metric: string, observed: number, requirement: number): FunctionalGateCheck {
  return { metric, outcome: observed >= requirement ? "pass" : "fail", observed, requirement };
}

function boundedText(value: string, maximum: number, label: string): void {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maximum) {
    throw new FunctionalFieldError(`${label} exceeded its size limit`);
  }
}
