import { lstat, readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { readPrivateUtf8File } from "./linux-provider-credential.js";
import type {
  ProviderModelGrade,
  ProviderModelVerification,
} from "./types.js";

const MAX_REPORT_FILES = 64;
const MAX_REPORT_BYTES = 64 * 1024;
const MAX_REPORT_AGE_MS = 30 * 24 * 60 * 60_000;
const MAX_FUTURE_SKEW_MS = 5 * 60_000;
const REPORT_FILE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,119}\.json$/;
const MODEL_PATTERN = /^[a-z0-9][a-z0-9._:/-]{0,199}$/;
const UPSTREAM_PATTERN = /^[a-z0-9][a-z0-9._/-]{0,119}$/;

export type GradedProviderId = "openai" | "openrouter";

export interface ProviderModelGradeRecord {
  providerId: GradedProviderId;
  modelId: string;
  upstreamId?: string;
  actualProvider?: string;
  checkedAt: string;
  expiresAt: string;
  verification: ProviderModelVerification;
}

export interface ProviderModelGradeSource {
  load(providerId: GradedProviderId): Promise<readonly ProviderModelGradeRecord[]>;
}

export class ProviderModelGradeError extends Error {}

export class ProtectedProviderModelGradeSource implements ProviderModelGradeSource {
  constructor(
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly now: () => number = Date.now,
  ) {}

  async load(providerId: GradedProviderId): Promise<readonly ProviderModelGradeRecord[]> {
    const directory = gradeDirectoryPath(this.environment);
    if (!directory) return [];
    const entries = await readGradeDirectory(directory);
    const records = new Map<string, ProviderModelGradeRecord>();
    for (const entry of entries) {
      const raw = await readPrivateUtf8File(
        join(directory, entry),
        "Provider model grade report",
        MAX_REPORT_BYTES,
        false,
      );
      if (raw === null) throw new ProviderModelGradeError("Provider model grade report를 읽을 수 없습니다.");
      const record = parseProviderModelGradeReport(raw, this.now());
      if (record.providerId !== providerId) continue;
      const key = JSON.stringify([record.modelId, record.upstreamId ?? null]);
      const existing = records.get(key);
      if (existing && existing.checkedAt === record.checkedAt
          && JSON.stringify(existing) !== JSON.stringify(record)) {
        throw new ProviderModelGradeError("같은 시각의 Provider model grade report가 서로 다릅니다.");
      }
      if (!existing || Date.parse(existing.checkedAt) < Date.parse(record.checkedAt)) records.set(key, record);
    }
    return [...records.values()].sort((left, right) => (
      left.modelId.localeCompare(right.modelId)
      || (left.upstreamId ?? "").localeCompare(right.upstreamId ?? "")
    ));
  }
}

export class StaticProviderModelGradeSource implements ProviderModelGradeSource {
  constructor(private readonly records: readonly ProviderModelGradeRecord[]) {}

  async load(providerId: GradedProviderId): Promise<readonly ProviderModelGradeRecord[]> {
    return this.records.filter((record) => record.providerId === providerId).map((record) => structuredClone(record));
  }
}

export function passingModelGrade(
  providerId: GradedProviderId,
  modelId: string,
  upstreamId?: string,
  checkedAt = "2026-08-24T00:00:00.000Z",
): ProviderModelGradeRecord {
  const expiresAt = new Date(Date.parse(checkedAt) + MAX_REPORT_AGE_MS).toISOString();
  return {
    providerId,
    modelId,
    ...(upstreamId ? { upstreamId } : {}),
    checkedAt,
    expiresAt,
    verification: {
      scope: upstreamId ? "upstream" : "model",
      conversation: "pass",
      projectRead: "pass",
      coding: "pass",
      checkedAt,
      expiresAt,
    },
  };
}

export function modelVerification(
  records: readonly ProviderModelGradeRecord[],
  modelId: string,
  upstreamId?: string,
  invalid = false,
): ProviderModelVerification {
  if (invalid) return emptyVerification(upstreamId ? "upstream" : "model", "invalid");
  const record = records.find((candidate) => (
    candidate.modelId === modelId && candidate.upstreamId === upstreamId
  ));
  return record?.verification ?? emptyVerification(upstreamId ? "upstream" : "model", "not_tested");
}

export function combinedModelVerification(
  verifications: readonly ProviderModelVerification[],
): ProviderModelVerification {
  if (verifications.length === 0) return emptyVerification("upstream", "not_tested");
  const checkedTimes = verifications.flatMap((item) => item.checkedAt ? [Date.parse(item.checkedAt)] : []);
  const expiryTimes = verifications.flatMap((item) => item.expiresAt ? [Date.parse(item.expiresAt)] : []);
  return {
    scope: "upstream",
    conversation: combineGrade(verifications.map((item) => item.conversation)),
    projectRead: combineGrade(verifications.map((item) => item.projectRead)),
    coding: combineGrade(verifications.map((item) => item.coding)),
    ...(checkedTimes.length === verifications.length
      ? { checkedAt: new Date(Math.min(...checkedTimes)).toISOString() }
      : {}),
    ...(expiryTimes.length === verifications.length
      ? { expiresAt: new Date(Math.min(...expiryTimes)).toISOString() }
      : {}),
  };
}

export function modelToolAccess(
  verification: ProviderModelVerification,
): "none" | "read" | "coding" {
  if (verification.coding === "pass" && verification.projectRead === "pass") return "coding";
  if (verification.projectRead === "pass") return "read";
  return "none";
}

export async function safeLoadModelGrades(
  source: ProviderModelGradeSource,
  providerId: GradedProviderId,
): Promise<{ records: readonly ProviderModelGradeRecord[]; invalid: boolean }> {
  try {
    return { records: await source.load(providerId), invalid: false };
  } catch {
    return { records: [], invalid: true };
  }
}

function gradeDirectoryPath(environment: NodeJS.ProcessEnv): string | null {
  const configured = environment.CODEX_POCKET_PROVIDER_GRADE_DIR;
  const directory = configured
    ?? (environment.XDG_CONFIG_HOME
      ? join(environment.XDG_CONFIG_HOME, "codex-pocket-voice", "provider-grades")
      : environment.HOME
        ? join(environment.HOME, ".config", "codex-pocket-voice", "provider-grades")
        : null);
  if (!directory) return null;
  if (!isAbsolute(directory) || /[\u0000-\u001f\u007f]/.test(directory)) {
    throw new ProviderModelGradeError("Provider model grade 디렉터리 설정이 잘못됐습니다.");
  }
  return directory;
}

async function readGradeDirectory(directory: string): Promise<string[]> {
  let info;
  try {
    info = await lstat(directory);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === "ENOENT") return [];
    throw new ProviderModelGradeError("Provider model grade 디렉터리를 읽을 수 없습니다.");
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new ProviderModelGradeError("Provider model grade 경로는 symlink가 아닌 디렉터리여야 합니다.");
  }
  const privateMode = info.mode & 0o777;
  if (privateMode !== 0o700 && privateMode !== 0o500) {
    throw new ProviderModelGradeError("Provider model grade 디렉터리 권한을 0700 또는 0500으로 제한해 주세요.");
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new ProviderModelGradeError("Provider model grade 디렉터리 소유자가 Companion 사용자와 다릅니다.");
  }
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.length > MAX_REPORT_FILES) {
    throw new ProviderModelGradeError("Provider model grade report가 너무 많습니다.");
  }
  return entries.map((entry) => {
    if (!entry.isFile() || entry.isSymbolicLink() || !REPORT_FILE_PATTERN.test(entry.name)) {
      throw new ProviderModelGradeError("Provider model grade 디렉터리에 허용되지 않은 항목이 있습니다.");
    }
    return entry.name;
  }).sort();
}

export function parseProviderModelGradeReport(
  raw: string,
  now = Date.now(),
): ProviderModelGradeRecord {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new ProviderModelGradeError("Provider model grade report가 올바른 JSON이 아닙니다.");
  }
  const report = record(value);
  if (!report || (report.provider !== "openai" && report.provider !== "openrouter")) {
    throw new ProviderModelGradeError("Provider model grade report의 provider가 잘못됐습니다.");
  }
  const checkedAt = timestamp(report.checkedAt, now);
  const checkedMs = Date.parse(checkedAt);
  const expired = now - checkedMs > MAX_REPORT_AGE_MS;
  const expiresAt = new Date(checkedMs + MAX_REPORT_AGE_MS).toISOString();
  if (report.provider === "openai") {
    if (report.schemaVersion !== 1) throw new ProviderModelGradeError("OpenAI grade report schema가 잘못됐습니다.");
    const privacyProfile = record(report.privacyProfile);
    if (privacyProfile?.store !== false) {
      throw new ProviderModelGradeError("OpenAI grade report의 privacy profile이 잘못됐습니다.");
    }
    const modelId = modelIdValue(report.requestedModel);
    const actualModel = modelIdValue(report.actualModel);
    const snapshotSuffix = actualModel.slice(modelId.length);
    if (actualModel !== modelId && !/^-\d{4}-\d{2}-\d{2}$/.test(snapshotSuffix)) {
      throw new ProviderModelGradeError("OpenAI grade report의 실제 모델이 요청 모델과 다릅니다.");
    }
    const grades = record(report.grades);
    const contract = contractGrade([
      grade(grades?.streaming),
      grade(grades?.conversation),
      grade(grades?.functionCalling),
      grade(grades?.statelessReplay),
    ]);
    return normalizedRecord("openai", modelId, undefined, checkedAt, expiresAt, expired, contract, grades);
  }
  if (report.schemaVersion !== 2) throw new ProviderModelGradeError("OpenRouter grade report schema가 잘못됐습니다.");
  const privacyProfile = record(report.privacyProfile);
  if (privacyProfile?.zdr !== true || privacyProfile.dataCollection !== "deny"
      || privacyProfile.allowFallbacks !== false) {
    throw new ProviderModelGradeError("OpenRouter grade report의 privacy profile이 잘못됐습니다.");
  }
  if (!Array.isArray(report.actualProviders) || report.actualProviders.length !== 1
      || typeof report.actualProviders[0] !== "string"
      || !safeProviderName(report.actualProviders[0])) {
    throw new ProviderModelGradeError("OpenRouter grade report의 실제 upstream이 잘못됐습니다.");
  }
  const modelId = modelIdValue(report.model);
  const upstreamId = upstreamIdValue(report.requestedUpstream);
  const grades = record(report.grades);
  const contract = contractGrade([grade(grades?.conversation), grade(grades?.toolCalling)]);
  return normalizedRecord(
    "openrouter",
    modelId,
    upstreamId,
    checkedAt,
    expiresAt,
    expired,
    contract,
    grades,
    report.actualProviders[0] as string,
  );
}

export function parseProtectedProviderCodingGradeReport(
  raw: string,
  now = Date.now(),
): ProviderModelGradeRecord {
  const normalized = parseProviderModelGradeReport(raw, now);
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new ProviderModelGradeError("Provider coding grade report가 올바른 JSON이 아닙니다.");
  }
  const report = record(value);
  const evaluation = record(report?.evaluation);
  if (!evaluation || evaluation.scope !== "coding"
      || evaluation.fixture !== "ephemeral_synthetic_workspace"
      || evaluation.approval !== "protected_workflow_and_exact_confirmation"
      || evaluation.maximumRequests !== 3
      || !["pass", "contract_failed", "infrastructure_failed"].includes(String(evaluation.outcome))) {
    throw new ProviderModelGradeError("Provider coding grade evaluation이 잘못됐습니다.");
  }
  if (!Array.isArray(evaluation.tools) || evaluation.tools.length > 2
      || evaluation.tools.some((tool) => {
        const item = record(tool);
        return !item || Object.keys(item).sort().join(":") !== "name:status"
          || typeof item.name !== "string" || !["workspace_read", "workspace_replace_text"].includes(item.name)
          || typeof item.status !== "string" || !["completed", "denied", "failed"].includes(item.status);
      })) {
    throw new ProviderModelGradeError("Provider coding grade tool evidence가 잘못됐습니다.");
  }
  const grades = record(report?.grades);
  const codingPassed = grades?.projectRead === "pass" && grades.coding === "pass";
  const exactPassingTools = evaluation.tools.length === 2
    && record(evaluation.tools[0])?.name === "workspace_read"
    && record(evaluation.tools[0])?.status === "completed"
    && record(evaluation.tools[1])?.name === "workspace_replace_text"
    && record(evaluation.tools[1])?.status === "completed";
  if (codingPassed !== (evaluation.outcome === "pass" && exactPassingTools)) {
    throw new ProviderModelGradeError("Provider coding grade verdict와 tool evidence가 일치하지 않습니다.");
  }
  return normalized;
}

function normalizedRecord(
  providerId: GradedProviderId,
  modelId: string,
  upstreamId: string | undefined,
  checkedAt: string,
  expiresAt: string,
  expired: boolean,
  contract: "pass" | "not_tested" | "fail",
  grades: Record<string, unknown> | null,
  actualProvider?: string,
): ProviderModelGradeRecord {
  const conversation = expired ? "expired" : contract;
  const projectRead = expired ? "expired" : contract === "pass" && grade(grades?.projectRead) === "pass"
    ? "pass"
    : contract === "pass" ? normalizedFailedGrade(grades?.projectRead) : contract;
  const coding = expired ? "expired" : projectRead === "pass" && grade(grades?.coding) === "pass"
    ? "pass"
    : normalizedFailedGrade(grades?.coding);
  return {
    providerId,
    modelId,
    ...(upstreamId ? { upstreamId } : {}),
    ...(actualProvider ? { actualProvider } : {}),
    checkedAt,
    expiresAt,
    verification: {
      scope: upstreamId ? "upstream" : "model",
      conversation,
      projectRead,
      coding,
      checkedAt,
      expiresAt,
    },
  };
}

function timestamp(value: unknown, now: number): string {
  if (typeof value !== "string" || value.length > 40) {
    throw new ProviderModelGradeError("Provider model grade report 시각이 잘못됐습니다.");
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value || parsed > now + MAX_FUTURE_SKEW_MS) {
    throw new ProviderModelGradeError("Provider model grade report 시각이 잘못됐습니다.");
  }
  return value;
}

function modelIdValue(value: unknown): string {
  if (typeof value !== "string" || !MODEL_PATTERN.test(value)) {
    throw new ProviderModelGradeError("Provider model grade report의 model ID가 잘못됐습니다.");
  }
  return value;
}

function upstreamIdValue(value: unknown): string {
  if (typeof value !== "string" || !UPSTREAM_PATTERN.test(value)) {
    throw new ProviderModelGradeError("OpenRouter grade report의 upstream ID가 잘못됐습니다.");
  }
  return value;
}

function safeProviderName(value: string): boolean {
  return value.length <= 120 && value.normalize("NFKC").trim().length > 0
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function grade(value: unknown): "pass" | "not_tested" | "fail" {
  if (value === "pass" || value === "not_tested" || value === "fail") return value;
  throw new ProviderModelGradeError("Provider model grade report의 등급이 잘못됐습니다.");
}

function normalizedFailedGrade(value: unknown): ProviderModelGrade {
  const parsed = grade(value);
  return parsed === "pass" ? "not_tested" : parsed;
}

function contractGrade(grades: readonly ("pass" | "not_tested" | "fail")[]): "pass" | "not_tested" | "fail" {
  if (grades.includes("fail")) return "fail";
  return grades.every((value) => value === "pass") ? "pass" : "not_tested";
}

function emptyVerification(
  scope: ProviderModelVerification["scope"],
  value: ProviderModelGrade,
): ProviderModelVerification {
  return { scope, conversation: value, projectRead: value, coding: value };
}

function combineGrade(values: readonly ProviderModelGrade[]): ProviderModelGrade {
  if (values.every((value) => value === "pass")) return "pass";
  for (const value of ["invalid", "expired", "fail", "not_tested"] as const) {
    if (values.includes(value)) return value;
  }
  return "not_tested";
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
