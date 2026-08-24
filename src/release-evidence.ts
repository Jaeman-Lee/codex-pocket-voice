import { createHash } from "node:crypto";
import { lstat, writeFile } from "node:fs/promises";
import {
  ANDROID_FIELD_LIMITS,
  ANDROID_FIELD_TRANSPORTS,
  ANDROID_RELEASE_THRESHOLDS,
  evaluateAndroidReleaseGate,
  type AndroidFieldReport,
  type AndroidFieldTransport,
} from "./android-field-metrics.js";
import {
  evaluateFunctionalFieldAcceptance,
  type FunctionalCandidateIdentity,
} from "./functional-field-acceptance.js";
import {
  parseProtectedProviderCodingGradeReport,
  type ProviderModelGradeRecord,
} from "./providers/model-grades.js";

const MAX_ANDROID_REPORT_BYTES = 64 * 1024;
const MAX_PROVIDER_GRADE_REPORT_BYTES = 64 * 1024;
const MAX_RELEASE_REPORT_BYTES = 64 * 1024;
const MAX_FIELD_AGE_MS = 30 * 24 * 60 * 60_000;
const MAX_CLOCK_SKEW_MS = 5 * 60_000;
const MAX_WALL_CLOCK_OVERHEAD_MS = 10 * 60_000;

interface ReleaseEvidenceCheck {
  metric: string;
  outcome: "pass" | "fail";
  observed: boolean | number | string;
  requirement: boolean | number | string;
}

export interface ReleaseEvidenceReport {
  schemaVersion: 2;
  kind: "codex_pocket_release_evidence";
  evidenceKind: "structured_aggregate_only";
  createdAt: string;
  candidate: FunctionalCandidateIdentity;
  functional: {
    testWindow: { startedAt: string; completedAt: string };
    outcome: "passed" | "failed";
    passedScenarioCount: number;
    requiredScenarioCount: number;
  };
  providerGrades: {
    openai: ProviderGradeEvidenceSummary;
    openrouter: [ProviderGradeEvidenceSummary, ProviderGradeEvidenceSummary];
    distinctOpenRouterUpstreamFamilies: boolean;
  };
  androidTransports: Array<{
    transport: AndroidFieldTransport;
    testWindow: { startedAt: string; completedAt: string };
    outcome: "passed" | "failed" | "observation_only";
    actualDurationSeconds: number;
  }>;
  gate: {
    outcome: "passed" | "failed";
    passed: boolean;
    checks: ReleaseEvidenceCheck[];
  };
  privacy: {
    containsDeviceIdentifiers: false;
    containsNetworkValues: false;
    containsCredentials: false;
    containsRawDiagnostics: false;
    containsPromptOrResponse: false;
  };
}

interface ProviderGradeEvidenceSummary {
  reportSha256: string;
  checkedAt: string;
  projectRead: string;
  coding: string;
  validAtFieldStart: boolean;
}

export interface ReleaseProviderGradeTexts {
  openai: string;
  openrouter: [string, string];
}

export class ReleaseEvidenceError extends Error {}

export async function requireUnusedReleaseEvidenceFile(path: string): Promise<void> {
  if (!path || path.length > 4_096 || /[\u0000-\u001f\u007f]/.test(path)) {
    throw new ReleaseEvidenceError("Release evidence path is invalid");
  }
  try {
    await lstat(path);
    throw new ReleaseEvidenceError("Release evidence path already exists");
  } catch (error) {
    if (error instanceof ReleaseEvidenceError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new ReleaseEvidenceError("Release evidence path could not be checked");
    }
  }
}

export async function writeReleaseEvidenceFile(path: string, report: ReleaseEvidenceReport): Promise<void> {
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_RELEASE_REPORT_BYTES) {
    throw new ReleaseEvidenceError("Release evidence exceeded its size limit");
  }
  try {
    await writeFile(path, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch {
    throw new ReleaseEvidenceError("Release evidence could not be written");
  }
}

export function evaluateReleaseEvidence(
  manifestText: string,
  functionalObservationText: string,
  androidReportTexts: Record<AndroidFieldTransport, string>,
  providerGradeTexts: ReleaseProviderGradeTexts,
  expectedSource: { version: string; versionCode: number; commit: string },
  now = Date.now(),
): ReleaseEvidenceReport {
  if (!Number.isFinite(now)) throw new ReleaseEvidenceError("Release evidence evaluation time is invalid");
  let createdAt: string;
  try {
    createdAt = new Date(now).toISOString();
  } catch {
    throw new ReleaseEvidenceError("Release evidence evaluation time is invalid");
  }
  const functional = evaluateFunctionalFieldAcceptance(
    manifestText,
    functionalObservationText,
    expectedSource,
    now,
  );
  const providerGrades = evaluateProviderGradeEvidence(
    providerGradeTexts,
    functional.providerGradeReports,
    functional.testWindow.startedAt,
    now,
  );
  const androidReports = ANDROID_FIELD_TRANSPORTS.map((transport) => {
    const text = androidReportTexts[transport];
    if (typeof text !== "string") throw new ReleaseEvidenceError("Every Android transport report is required");
    const report = parseAndroidFieldReport(text, functional.candidate);
    if (report.transport !== transport) {
      throw new ReleaseEvidenceError("Android transport report was supplied in the wrong slot");
    }
    return report;
  });

  const checks: ReleaseEvidenceCheck[] = [
    booleanCheck("functional_gate", functional.gate.passed),
    booleanCheck("provider_grade:openai_project_read", providerGrades.openai.projectRead === "pass"),
    booleanCheck("provider_grade:openai_coding", providerGrades.openai.coding === "pass"),
    booleanCheck("provider_grade:openai_valid_at_field_start", providerGrades.openai.validAtFieldStart),
    ...providerGrades.openrouter.flatMap((grade, index) => [
      booleanCheck(`provider_grade:openrouter_${index + 1}_project_read`, grade.projectRead === "pass"),
      booleanCheck(`provider_grade:openrouter_${index + 1}_coding`, grade.coding === "pass"),
      booleanCheck(`provider_grade:openrouter_${index + 1}_valid_at_field_start`, grade.validAtFieldStart),
    ]),
    booleanCheck(
      "provider_grade:distinct_openrouter_upstream_families",
      providerGrades.distinctOpenRouterUpstreamFamilies,
    ),
  ];
  for (const report of androidReports) {
    const completedAt = Date.parse(report.testWindow.completedAt);
    checks.push(
      booleanCheck(
        `android_gate:${report.transport}`,
        report.gate.mode === "release_gate" && report.gate.passed === true,
      ),
      {
        metric: `android_freshness:${report.transport}`,
        outcome: completedAt <= now + MAX_CLOCK_SKEW_MS && completedAt >= now - MAX_FIELD_AGE_MS
          ? "pass"
          : "fail",
        observed: report.testWindow.completedAt,
        requirement: "within 30 days and not in the future",
      },
    );
  }
  const passed = checks.every((check) => check.outcome === "pass");
  return {
    schemaVersion: 2,
    kind: "codex_pocket_release_evidence",
    evidenceKind: "structured_aggregate_only",
    createdAt,
    candidate: functional.candidate,
    functional: {
      testWindow: functional.testWindow,
      outcome: functional.gate.outcome,
      passedScenarioCount: functional.gate.passedScenarioCount,
      requiredScenarioCount: functional.gate.requiredScenarioCount,
    },
    providerGrades,
    androidTransports: androidReports.map((report) => ({
      transport: report.transport,
      testWindow: report.testWindow,
      outcome: report.gate.outcome,
      actualDurationSeconds: report.measurement.actualDurationSeconds,
    })),
    gate: {
      outcome: passed ? "passed" : "failed",
      passed,
      checks,
    },
    privacy: {
      containsDeviceIdentifiers: false,
      containsNetworkValues: false,
      containsCredentials: false,
      containsRawDiagnostics: false,
      containsPromptOrResponse: false,
    },
  };
}

function evaluateProviderGradeEvidence(
  texts: ReleaseProviderGradeTexts,
  expected: {
    openaiCodingSha256: string | null;
    openRouterCodingSha256: [string | null, string | null];
  },
  fieldStartedAt: string,
  now: number,
): ReleaseEvidenceReport["providerGrades"] {
  if (!texts || typeof texts.openai !== "string" || !Array.isArray(texts.openrouter)
      || texts.openrouter.length !== 2 || texts.openrouter.some((text) => typeof text !== "string")) {
    throw new ReleaseEvidenceError("Every protected Provider grade report is required");
  }
  const openaiDigest = providerReportDigest(texts.openai, "OpenAI grade report");
  const openrouterDigests = texts.openrouter.map((text) => (
    providerReportDigest(text, "OpenRouter grade report")
  )) as [string, string];
  if (expected.openaiCodingSha256 === null || expected.openaiCodingSha256 !== openaiDigest) {
    throw new ReleaseEvidenceError("OpenAI grade report does not match the functional observations");
  }
  const expectedOpenRouter = expected.openRouterCodingSha256;
  if (expectedOpenRouter.some((digest) => digest === null)
      || new Set(openrouterDigests).size !== 2
      || [...openrouterDigests].sort().join(":") !== [...expectedOpenRouter as [string, string]].sort().join(":")) {
    throw new ReleaseEvidenceError("OpenRouter grade reports do not match the functional observations");
  }

  let openaiRecord: ProviderModelGradeRecord;
  let openrouterRecords: [ProviderModelGradeRecord, ProviderModelGradeRecord];
  try {
    openaiRecord = parseProtectedProviderCodingGradeReport(texts.openai, now);
    openrouterRecords = texts.openrouter.map((text) => (
      parseProtectedProviderCodingGradeReport(text, now)
    )) as [ProviderModelGradeRecord, ProviderModelGradeRecord];
  } catch {
    throw new ReleaseEvidenceError("Protected Provider grade report is invalid");
  }
  if (openaiRecord.providerId !== "openai" || openaiRecord.upstreamId !== undefined
      || openaiRecord.actualProvider !== undefined
      || openrouterRecords.some((record) => (
        record.providerId !== "openrouter" || !record.upstreamId || !record.actualProvider
      ))) {
    throw new ReleaseEvidenceError("Protected Provider grade report identity is invalid");
  }

  const openrouter = openrouterRecords.map((record, index) => ({
    record,
    digest: openrouterDigests[index]!,
    summary: providerGradeSummary(record, openrouterDigests[index]!, fieldStartedAt),
  })).sort((left, right) => left.digest.localeCompare(right.digest));
  const upstreamIds = new Set(openrouterRecords.map((record) => record.upstreamId));
  const upstreamFamilies = new Set(openrouterRecords.map((record) => normalizeProviderFamily(record.actualProvider!)));
  return {
    openai: providerGradeSummary(openaiRecord, openaiDigest, fieldStartedAt),
    openrouter: [openrouter[0]!.summary, openrouter[1]!.summary],
    distinctOpenRouterUpstreamFamilies: upstreamIds.size === 2 && upstreamFamilies.size === 2,
  };
}

function providerReportDigest(text: string, label: string): string {
  boundedText(text, MAX_PROVIDER_GRADE_REPORT_BYTES, label);
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function providerGradeSummary(
  record: ProviderModelGradeRecord,
  reportSha256: string,
  fieldStartedAt: string,
): ProviderGradeEvidenceSummary {
  const checkedAt = Date.parse(record.checkedAt);
  const fieldStart = Date.parse(fieldStartedAt);
  return {
    reportSha256,
    checkedAt: record.checkedAt,
    projectRead: record.verification.projectRead,
    coding: record.verification.coding,
    validAtFieldStart: checkedAt >= fieldStart - MAX_FIELD_AGE_MS
      && checkedAt <= fieldStart + MAX_CLOCK_SKEW_MS,
  };
}

function normalizeProviderFamily(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

export function parseAndroidFieldReport(
  text: string,
  expectedCandidate: FunctionalCandidateIdentity,
): AndroidFieldReport {
  boundedText(text, MAX_ANDROID_REPORT_BYTES, "Android field report");
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new ReleaseEvidenceError("Android field report is not valid JSON");
  }
  if (text !== `${JSON.stringify(value, null, 2)}\n`) {
    throw new ReleaseEvidenceError("Android field report is not canonical JSON");
  }
  const root = exactRecord(value, [
    "schemaVersion", "kind", "evidenceKind", "candidate", "transport", "testWindow", "app",
    "measurement", "cpuPercent", "memoryMib", "battery", "backgroundWake", "gate", "privacy",
  ], "Android field report");
  if (root.schemaVersion !== 3 || root.kind !== "android_field_acceptance"
      || root.evidenceKind !== "adb_aggregate_measurement") {
    throw new ReleaseEvidenceError("Android field report schema is unsupported");
  }
  const candidateRecord = exactRecord(root.candidate, [
    "applicationId", "version", "versionCode", "channel", "commit", "manifestSha256", "apkSha256",
    "signingCertificateSha256",
  ], "Android candidate");
  const candidate: FunctionalCandidateIdentity = {
    applicationId: exactValue(candidateRecord.applicationId, expectedCandidate.applicationId, "Android application ID"),
    version: exactValue(candidateRecord.version, expectedCandidate.version, "Android candidate version"),
    versionCode: exactValue(candidateRecord.versionCode, expectedCandidate.versionCode, "Android candidate version code"),
    channel: exactValue(candidateRecord.channel, expectedCandidate.channel, "Android candidate channel"),
    commit: exactValue(candidateRecord.commit, expectedCandidate.commit, "Android candidate commit"),
    manifestSha256: exactValue(
      candidateRecord.manifestSha256,
      expectedCandidate.manifestSha256,
      "Android manifest digest",
    ),
    apkSha256: exactValue(candidateRecord.apkSha256, expectedCandidate.apkSha256, "Android APK digest"),
    signingCertificateSha256: exactValue(
      candidateRecord.signingCertificateSha256,
      expectedCandidate.signingCertificateSha256,
      "Android signer digest",
    ),
  };
  if (typeof root.transport !== "string"
      || !(ANDROID_FIELD_TRANSPORTS as readonly string[]).includes(root.transport)) {
    throw new ReleaseEvidenceError("Android field transport is invalid");
  }
  const transport = root.transport as AndroidFieldTransport;
  const windowRecord = exactRecord(root.testWindow, ["startedAt", "completedAt"], "Android test window");
  const testWindow = {
    startedAt: canonicalTimestamp(windowRecord.startedAt, "Android test start"),
    completedAt: canonicalTimestamp(windowRecord.completedAt, "Android test completion"),
  };
  const wallDurationMs = Date.parse(testWindow.completedAt) - Date.parse(testWindow.startedAt);
  if (wallDurationMs < 0
      || wallDurationMs > ANDROID_FIELD_LIMITS.maximumDurationSeconds * 1_000 + MAX_WALL_CLOCK_OVERHEAD_MS) {
    throw new ReleaseEvidenceError("Android test window is invalid");
  }

  const appRecord = exactRecord(
    root.app,
    ["packageName", "versionName", "versionCode", "apkSha256", "digestVerifiedAtStartAndEnd"],
    "Android app identity",
  );
  const app = {
    packageName: exactValue(appRecord.packageName, candidate.applicationId, "Installed package"),
    versionName: exactValue(appRecord.versionName, candidate.version, "Installed version"),
    versionCode: exactValue(appRecord.versionCode, candidate.versionCode, "Installed version code"),
    apkSha256: exactValue(appRecord.apkSha256, candidate.apkSha256, "Installed APK digest"),
    digestVerifiedAtStartAndEnd: exactValue(
      appRecord.digestVerifiedAtStartAndEnd,
      true,
      "Installed APK digest verification",
    ),
  };
  const measurementRecord = exactRecord(root.measurement, [
    "requestedDurationSeconds", "actualDurationSeconds", "intervalSeconds", "scheduledSamples",
    "processPresencePercent", "cpuCoveragePercent", "memoryCoveragePercent",
  ], "Android measurement");
  const requestedDurationSeconds = strictInteger(
    measurementRecord.requestedDurationSeconds,
    ANDROID_FIELD_LIMITS.minimumDurationSeconds,
    ANDROID_FIELD_LIMITS.maximumDurationSeconds,
    "Requested duration",
  );
  const intervalSeconds = strictInteger(
    measurementRecord.intervalSeconds,
    ANDROID_FIELD_LIMITS.minimumIntervalSeconds,
    ANDROID_FIELD_LIMITS.maximumIntervalSeconds,
    "Measurement interval",
  );
  if (requestedDurationSeconds % intervalSeconds !== 0) {
    throw new ReleaseEvidenceError("Android measurement interval is invalid");
  }
  const measurement = {
    requestedDurationSeconds,
    actualDurationSeconds: strictNumber(
      measurementRecord.actualDurationSeconds,
      0.001,
      ANDROID_FIELD_LIMITS.maximumDurationSeconds + MAX_WALL_CLOCK_OVERHEAD_MS / 1_000,
      "Actual duration",
    ),
    intervalSeconds,
    scheduledSamples: exactValue(
      measurementRecord.scheduledSamples,
      requestedDurationSeconds / intervalSeconds + 1,
      "Scheduled sample count",
    ),
    processPresencePercent: strictNumber(measurementRecord.processPresencePercent, 0, 100, "Process coverage"),
    cpuCoveragePercent: strictNumber(measurementRecord.cpuCoveragePercent, 0, 100, "CPU coverage"),
    memoryCoveragePercent: strictNumber(measurementRecord.memoryCoveragePercent, 0, 100, "Memory coverage"),
  };
  if (Math.abs(wallDurationMs / 1_000 - measurement.actualDurationSeconds) > MAX_WALL_CLOCK_OVERHEAD_MS / 1_000) {
    throw new ReleaseEvidenceError("Android wall and monotonic measurement durations do not agree");
  }

  const memoryRecord = exactRecord(root.memoryMib, ["pss", "rss"], "Android memory summary");
  const batteryRecord = exactRecord(
    root.battery,
    ["state", "levelDropPercent", "percentPerHour"],
    "Android battery summary",
  );
  if (batteryRecord.state !== "discharging" && batteryRecord.state !== "not_discharging"
      && batteryRecord.state !== "unavailable") {
    throw new ReleaseEvidenceError("Android battery state is invalid");
  }
  const batteryState = batteryRecord.state as AndroidFieldReport["battery"]["state"];
  const battery = batteryState === "discharging"
    ? {
        state: batteryState,
        levelDropPercent: strictNumber(batteryRecord.levelDropPercent, 0, 100, "Battery drop"),
        percentPerHour: strictNumber(batteryRecord.percentPerHour, 0, 10_000, "Battery rate"),
      }
    : {
        state: batteryState,
        levelDropPercent: exactNull(batteryRecord.levelDropPercent, "Battery drop"),
        percentPerHour: exactNull(batteryRecord.percentPerHour, "Battery rate"),
      };
  const wakeRecord = exactRecord(
    root.backgroundWake,
    ["state", "durationMs", "percentOfMeasurement"],
    "Android wake summary",
  );
  if (wakeRecord.state !== "available" && wakeRecord.state !== "counter_reset"
      && wakeRecord.state !== "unavailable") {
    throw new ReleaseEvidenceError("Android wake state is invalid");
  }
  const wakeState = wakeRecord.state as AndroidFieldReport["backgroundWake"]["state"];
  const backgroundWake = wakeState === "available"
    ? {
        state: wakeState,
        durationMs: strictNumber(wakeRecord.durationMs, 0, Number.MAX_SAFE_INTEGER, "Wake duration"),
        percentOfMeasurement: strictNumber(wakeRecord.percentOfMeasurement, 0, 100, "Wake percentage"),
      }
    : {
        state: wakeState,
        durationMs: exactNull(wakeRecord.durationMs, "Wake duration"),
        percentOfMeasurement: exactNull(wakeRecord.percentOfMeasurement, "Wake percentage"),
      };

  const gateRecord = exactRecord(root.gate, ["mode", "outcome", "passed", "thresholds", "checks"], "Android gate");
  if (gateRecord.mode !== "observation" && gateRecord.mode !== "release_gate") {
    throw new ReleaseEvidenceError("Android gate mode is invalid");
  }
  const mode = gateRecord.mode;
  if (gateRecord.outcome !== "passed" && gateRecord.outcome !== "failed"
      && gateRecord.outcome !== "observation_only") {
    throw new ReleaseEvidenceError("Android gate outcome is invalid");
  }
  if (gateRecord.passed !== true && gateRecord.passed !== false && gateRecord.passed !== null) {
    throw new ReleaseEvidenceError("Android gate verdict is invalid");
  }
  const thresholds = gateRecord.thresholds === null
    ? null
    : parseThresholds(gateRecord.thresholds);
  if (!Array.isArray(gateRecord.checks) || gateRecord.checks.length > 32) {
    throw new ReleaseEvidenceError("Android gate checks are invalid");
  }
  const gate = {
    mode,
    outcome: gateRecord.outcome,
    passed: gateRecord.passed,
    thresholds,
    checks: gateRecord.checks.map((check) => parseGateCheck(check)),
  } as AndroidFieldReport["gate"];
  const privacyRecord = exactRecord(
    root.privacy,
    ["containsDeviceIdentifiers", "containsRawAdbOutput", "containsNetworkValues"],
    "Android privacy declaration",
  );
  if (privacyRecord.containsDeviceIdentifiers !== false || privacyRecord.containsRawAdbOutput !== false
      || privacyRecord.containsNetworkValues !== false) {
    throw new ReleaseEvidenceError("Android field report privacy declaration is invalid");
  }

  const report: AndroidFieldReport = {
    schemaVersion: 3,
    kind: "android_field_acceptance",
    evidenceKind: "adb_aggregate_measurement",
    candidate,
    transport,
    testWindow,
    app,
    measurement,
    cpuPercent: parseNumericSummary(root.cpuPercent, 10_000, "Android CPU summary"),
    memoryMib: {
      pss: parseNumericSummary(memoryRecord.pss, 1024 * 1024, "Android PSS summary"),
      rss: parseNumericSummary(memoryRecord.rss, 1024 * 1024, "Android RSS summary"),
    },
    battery,
    backgroundWake,
    gate,
    privacy: {
      containsDeviceIdentifiers: false,
      containsRawAdbOutput: false,
      containsNetworkValues: false,
    },
  };
  if (mode === "release_gate" && requestedDurationSeconds < ANDROID_RELEASE_THRESHOLDS.minimumDurationSeconds) {
    throw new ReleaseEvidenceError("Android release-gate request was too short");
  }
  const recalculated = evaluateAndroidReleaseGate(report, mode);
  if (JSON.stringify(gate) !== JSON.stringify(recalculated)) {
    throw new ReleaseEvidenceError("Android release verdict does not match its aggregate measurements");
  }
  return report;
}

function parseNumericSummary(value: unknown, maximum: number, label: string): AndroidFieldReport["cpuPercent"] {
  if (value === null) return null;
  const record = exactRecord(value, ["mean", "p95", "max"], label);
  const summary = {
    mean: strictNumber(record.mean, 0, maximum, `${label} mean`),
    p95: strictNumber(record.p95, 0, maximum, `${label} p95`),
    max: strictNumber(record.max, 0, maximum, `${label} max`),
  };
  if (summary.mean > summary.max || summary.p95 > summary.max) {
    throw new ReleaseEvidenceError(`${label} ordering is invalid`);
  }
  return summary;
}

function parseThresholds(value: unknown): typeof ANDROID_RELEASE_THRESHOLDS {
  const record = exactRecord(value, Object.keys(ANDROID_RELEASE_THRESHOLDS), "Android release thresholds");
  for (const [name, expected] of Object.entries(ANDROID_RELEASE_THRESHOLDS)) {
    exactValue(record[name], expected, `Android threshold ${name}`);
  }
  return { ...ANDROID_RELEASE_THRESHOLDS };
}

function parseGateCheck(value: unknown): AndroidFieldReport["gate"]["checks"][number] {
  const record = exactRecord(value, ["metric", "outcome", "observed", "requirement"], "Android gate check");
  if (typeof record.metric !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(record.metric)) {
    throw new ReleaseEvidenceError("Android gate metric is invalid");
  }
  if (record.outcome !== "pass" && record.outcome !== "fail") {
    throw new ReleaseEvidenceError("Android gate check outcome is invalid");
  }
  if (!isObservedCheckValue(record.observed) || !isRequiredCheckValue(record.requirement)) {
    throw new ReleaseEvidenceError("Android gate check value is invalid");
  }
  return {
    metric: record.metric,
    outcome: record.outcome,
    observed: record.observed,
    requirement: record.requirement,
  };
}

function isObservedCheckValue(value: unknown): value is number | string | null {
  return value === null || (typeof value === "number" && Number.isFinite(value))
    || (typeof value === "string" && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value));
}

function isRequiredCheckValue(value: unknown): value is number | string {
  return value !== null && isObservedCheckValue(value);
}

function exactRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ReleaseEvidenceError(`${label} is invalid`);
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new ReleaseEvidenceError(`${label} fields are invalid`);
  }
  return record;
}

function exactValue<T extends string | number | boolean>(value: unknown, expected: T, label: string): T {
  if (value !== expected) throw new ReleaseEvidenceError(`${label} does not match the required value`);
  return expected;
}

function exactNull(value: unknown, label: string): null {
  if (value !== null) throw new ReleaseEvidenceError(`${label} must be unavailable`);
  return null;
}

function strictInteger(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new ReleaseEvidenceError(`${label} is invalid`);
  }
  return value as number;
}

function strictNumber(value: unknown, minimum: number, maximum: number, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new ReleaseEvidenceError(`${label} is invalid`);
  }
  return value;
}

function canonicalTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))
      || new Date(value).toISOString() !== value) {
    throw new ReleaseEvidenceError(`${label} is invalid`);
  }
  return value;
}

function booleanCheck(metric: string, observed: boolean): ReleaseEvidenceCheck {
  return { metric, outcome: observed ? "pass" : "fail", observed, requirement: true };
}

function boundedText(value: string, maximum: number, label: string): void {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maximum) {
    throw new ReleaseEvidenceError(`${label} exceeded its size limit`);
  }
}
