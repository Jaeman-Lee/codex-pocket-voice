import { createHash, randomUUID } from "node:crypto";

const DEFAULT_EXPIRY_MS = 2 * 60_000;
const MAX_EXPIRY_MS = 10 * 60_000;
export const MAX_APPROVAL_FEEDBACK_LINES = 8;
export const MAX_APPROVAL_FEEDBACK_COMMENT_LENGTH = 600;
export const MAX_APPROVAL_FEEDBACK_CODE_LENGTH = 500;
const MAX_APPROVAL_FEEDBACK_BYTES = 12 * 1024;

export type ApprovalRisk = "observation" | "change" | "execution" | "high_risk" | "external_effect";
export type ApprovalStatus = "pending" | "approved" | "declined" | "expired";
export type ApprovalDecisionSource = "touch" | "voice" | "system";

export interface ApprovalFeedbackLine {
  path: string;
  oldLine?: number;
  newLine?: number;
  code: string;
  comment: string;
}

export interface ApprovalFeedback {
  lines: ApprovalFeedbackLine[];
}

export interface ApprovalRequestInput {
  providerId: string;
  conversationId: string;
  runId: string;
  toolCallId: string;
  risk: ApprovalRisk;
  redactedSummary: string;
  redactedDetails?: Record<string, unknown>;
  requiresTouch?: boolean;
  expiresInMs?: number;
}

export interface ApprovalRequest extends ApprovalRequestInput {
  id: string;
  status: ApprovalStatus;
  requiresTouch: boolean;
  requestedAt: string;
  expiresAt: string;
}

export interface ApprovalResolution {
  requestId: string;
  decision: Exclude<ApprovalStatus, "pending">;
  source: ApprovalDecisionSource;
  decidedAt: string;
  feedback?: ApprovalFeedback;
}

export interface ApprovalHandle {
  request: ApprovalRequest;
  decision: Promise<ApprovalResolution>;
}

export type ApprovalBrokerEvent =
  | { type: "requested"; request: ApprovalRequest }
  | { type: "resolved"; request: ApprovalRequest; resolution: ApprovalResolution };

export interface ApprovalBroker {
  requestApproval(input: ApprovalRequestInput): ApprovalHandle;
  get(requestId: string): ApprovalRequest | undefined;
  resolve(
    requestId: string,
    decision: "approved" | "declined",
    source: ApprovalDecisionSource,
    feedback?: ApprovalFeedback,
  ): ApprovalResolution;
  listPending(): ApprovalRequest[];
  subscribe(listener: (event: ApprovalBrokerEvent) => void): () => void;
  sweepExpired(): number;
  close(): void;
}

export interface InMemoryApprovalBrokerOptions {
  now?: () => number;
  createId?: () => string;
}

interface ApprovalEntry {
  fingerprint: string;
  request: ApprovalRequest;
  decision: Promise<ApprovalResolution>;
  resolveDecision(value: ApprovalResolution): void;
  resolution?: ApprovalResolution;
  timer?: NodeJS.Timeout;
}

export class ApprovalBrokerError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

export class InMemoryApprovalBroker implements ApprovalBroker {
  private readonly entries = new Map<string, ApprovalEntry>();
  private readonly byToolCall = new Map<string, string>();
  private readonly listeners = new Set<(event: ApprovalBrokerEvent) => void>();
  private readonly now: () => number;
  private readonly createId: () => string;

  constructor(options: InMemoryApprovalBrokerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
  }

  requestApproval(input: ApprovalRequestInput): ApprovalHandle {
    this.sweepExpired();
    assertApprovalInput(input);
    const toolCallKey = approvalKey(input);
    const fingerprint = approvalFingerprint(input);
    const existingId = this.byToolCall.get(toolCallKey);
    const existing = existingId ? this.entries.get(existingId) : undefined;
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new ApprovalBrokerError(409, "같은 tool-call ID로 다른 승인 요청을 만들 수 없습니다.");
      }
      return { request: cloneRequest(existing.request), decision: existing.decision };
    }

    const requestedAtMs = this.now();
    const expiresInMs = boundedExpiry(input.expiresInMs);
    const request: ApprovalRequest = {
      ...input,
      id: this.createId(),
      status: "pending",
      requiresTouch: input.requiresTouch ?? requiresTouch(input.risk),
      requestedAt: new Date(requestedAtMs).toISOString(),
      expiresAt: new Date(requestedAtMs + expiresInMs).toISOString(),
    };
    let resolveDecision!: (value: ApprovalResolution) => void;
    const decision = new Promise<ApprovalResolution>((resolve) => {
      resolveDecision = resolve;
    });
    const entry: ApprovalEntry = { fingerprint, request, decision, resolveDecision };
    entry.timer = setTimeout(() => this.expire(request.id), expiresInMs);
    entry.timer.unref();
    this.entries.set(request.id, entry);
    this.byToolCall.set(toolCallKey, request.id);
    this.emit({ type: "requested", request: cloneRequest(request) });
    return { request: cloneRequest(request), decision };
  }

  get(requestId: string): ApprovalRequest | undefined {
    this.sweepExpired();
    const request = this.entries.get(requestId)?.request;
    return request ? cloneRequest(request) : undefined;
  }

  resolve(
    requestId: string,
    decision: "approved" | "declined",
    source: ApprovalDecisionSource,
    feedback?: ApprovalFeedback,
  ): ApprovalResolution {
    this.sweepExpired();
    const entry = this.entries.get(requestId);
    if (!entry) throw new ApprovalBrokerError(404, "Approval request not found");
    const reviewedFeedback = feedback === undefined ? undefined : parseApprovalFeedback(feedback);
    if (entry.resolution) {
      if (entry.resolution.decision === decision && entry.resolution.source === source
          && sameFeedback(entry.resolution.feedback, reviewedFeedback)) {
        return cloneResolution(entry.resolution);
      }
      throw new ApprovalBrokerError(409, "이미 처리된 승인 요청입니다.");
    }
    if (decision === "approved" && source === "system") {
      throw new ApprovalBrokerError(403, "시스템은 작업을 자동 승인할 수 없습니다.");
    }
    if (decision === "approved" && entry.request.requiresTouch && source !== "touch") {
      throw new ApprovalBrokerError(403, "이 작업은 화면의 터치 확인이 필요합니다.");
    }
    if (reviewedFeedback && (decision !== "declined" || source !== "touch")) {
      throw new ApprovalBrokerError(400, "줄 피드백은 화면에서 변경을 거절할 때만 보낼 수 있습니다.");
    }
    return this.finish(entry, decision, source, reviewedFeedback);
  }

  listPending(): ApprovalRequest[] {
    this.sweepExpired();
    return [...this.entries.values()]
      .filter((entry) => entry.request.status === "pending")
      .map((entry) => cloneRequest(entry.request));
  }

  subscribe(listener: (event: ApprovalBrokerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  sweepExpired(): number {
    const now = this.now();
    let count = 0;
    for (const entry of this.entries.values()) {
      if (entry.request.status === "pending" && Date.parse(entry.request.expiresAt) <= now) {
        this.finish(entry, "expired", "system");
        count += 1;
      }
    }
    return count;
  }

  close(): void {
    for (const entry of this.entries.values()) {
      if (entry.request.status === "pending") this.finish(entry, "expired", "system");
      if (entry.timer) clearTimeout(entry.timer);
    }
    this.listeners.clear();
  }

  private expire(requestId: string): void {
    const entry = this.entries.get(requestId);
    if (entry?.request.status === "pending") this.finish(entry, "expired", "system");
  }

  private finish(
    entry: ApprovalEntry,
    decision: Exclude<ApprovalStatus, "pending">,
    source: ApprovalDecisionSource,
    feedback?: ApprovalFeedback,
  ): ApprovalResolution {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = undefined;
    entry.request.status = decision;
    const resolution: ApprovalResolution = {
      requestId: entry.request.id,
      decision,
      source,
      decidedAt: new Date(this.now()).toISOString(),
      ...(feedback ? { feedback } : {}),
    };
    entry.resolution = resolution;
    entry.resolveDecision(resolution);
    this.emit({
      type: "resolved",
      request: cloneRequest(entry.request),
      resolution: cloneResolution(resolution),
    });
    return cloneResolution(resolution);
  }

  private emit(event: ApprovalBrokerEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        process.stderr.write(`[codex-approval-broker] Listener failed: ${String(error)}\n`);
      }
    }
  }
}

function requiresTouch(risk: ApprovalRisk): boolean {
  return risk === "high_risk" || risk === "external_effect";
}

function boundedExpiry(value: number | undefined): number {
  if (value === undefined) return DEFAULT_EXPIRY_MS;
  if (!Number.isFinite(value) || value < 1_000 || value > MAX_EXPIRY_MS) {
    throw new ApprovalBrokerError(400, "승인 만료 시간은 1초에서 10분 사이여야 합니다.");
  }
  return Math.floor(value);
}

function approvalKey(input: ApprovalRequestInput): string {
  return JSON.stringify([input.providerId, input.conversationId, input.runId, input.toolCallId]);
}

function approvalFingerprint(input: ApprovalRequestInput): string {
  return createHash("sha256").update(JSON.stringify({
    risk: input.risk,
    redactedSummary: input.redactedSummary,
    redactedDetails: input.redactedDetails ?? null,
    requiresTouch: input.requiresTouch ?? null,
    expiresInMs: input.expiresInMs ?? null,
  })).digest("hex");
}

function cloneRequest(request: ApprovalRequest): ApprovalRequest {
  return structuredClone(request);
}

function assertApprovalInput(input: ApprovalRequestInput): void {
  const risks: readonly ApprovalRisk[] = ["observation", "change", "execution", "high_risk", "external_effect"];
  if (
    !boundedText(input.providerId, 80)
    || !boundedText(input.conversationId, 500)
    || !boundedText(input.runId, 500)
    || !boundedText(input.toolCallId, 500)
    || !boundedText(input.redactedSummary, 2_000)
    || !risks.includes(input.risk)
    || (input.requiresTouch !== undefined && typeof input.requiresTouch !== "boolean")
  ) throw new ApprovalBrokerError(400, "승인 요청 식별자 또는 요약이 올바르지 않습니다.");
  if (input.redactedDetails !== undefined) {
    if (!input.redactedDetails || typeof input.redactedDetails !== "object" || Array.isArray(input.redactedDetails)) {
      throw new ApprovalBrokerError(400, "승인 요청 세부 정보가 올바른 객체가 아닙니다.");
    }
    let serialized: string;
    try {
      serialized = JSON.stringify(input.redactedDetails);
    } catch {
      throw new ApprovalBrokerError(400, "승인 요청 세부 정보가 올바른 JSON이 아닙니다.");
    }
    if (!serialized || Buffer.byteLength(serialized) > 32 * 1024) {
      throw new ApprovalBrokerError(400, "승인 요청 세부 정보가 크기 제한을 초과했습니다.");
    }
  }
}

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

export function parseApprovalFeedback(value: unknown): ApprovalFeedback {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApprovalBrokerError(400, "줄 피드백 형식이 올바르지 않습니다.");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "lines")
      || !Array.isArray(record.lines)
      || record.lines.length < 1
      || record.lines.length > MAX_APPROVAL_FEEDBACK_LINES) {
    throw new ApprovalBrokerError(400, `줄 피드백은 1~${MAX_APPROVAL_FEEDBACK_LINES}개여야 합니다.`);
  }
  const seen = new Set<string>();
  const lines = record.lines.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new ApprovalBrokerError(400, "줄 피드백 항목이 올바르지 않습니다.");
    }
    const line = item as Record<string, unknown>;
    if (Object.keys(line).some((key) => !["path", "oldLine", "newLine", "code", "comment"].includes(key))) {
      throw new ApprovalBrokerError(400, "줄 피드백에 지원하지 않는 필드가 있습니다.");
    }
    const path = normalizedFeedbackPath(line.path);
    const oldLine = optionalFeedbackLineNumber(line.oldLine);
    const newLine = optionalFeedbackLineNumber(line.newLine);
    if (oldLine === undefined && newLine === undefined) {
      throw new ApprovalBrokerError(400, "줄 피드백에는 이전 또는 새 줄 번호가 필요합니다.");
    }
    if (typeof line.code !== "string" || line.code.length > MAX_APPROVAL_FEEDBACK_CODE_LENGTH
        || /[\r\n\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(line.code)) {
      throw new ApprovalBrokerError(400, "줄 피드백 코드가 안전한 한 줄 형식이 아닙니다.");
    }
    const comment = normalizedFeedbackComment(line.comment);
    const target = JSON.stringify([path, oldLine ?? null, newLine ?? null]);
    if (seen.has(target)) throw new ApprovalBrokerError(400, "같은 변경 줄에 피드백을 중복해서 보낼 수 없습니다.");
    seen.add(target);
    return {
      path,
      ...(oldLine === undefined ? {} : { oldLine }),
      ...(newLine === undefined ? {} : { newLine }),
      code: line.code,
      comment,
    };
  });
  const feedback = { lines };
  if (Buffer.byteLength(JSON.stringify(feedback)) > MAX_APPROVAL_FEEDBACK_BYTES) {
    throw new ApprovalBrokerError(400, "줄 피드백이 안전한 크기 상한을 초과했습니다.");
  }
  return feedback;
}

function normalizedFeedbackPath(value: unknown): string {
  if (typeof value !== "string") throw new ApprovalBrokerError(400, "줄 피드백 경로가 올바르지 않습니다.");
  const path = value.trim();
  if (!path || path.length > 500 || path !== value || path.startsWith("/") || path.includes("\\")
      || path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
      || /[\u0000-\u001f\u007f]/u.test(path)) {
    throw new ApprovalBrokerError(400, "줄 피드백 경로가 안전한 프로젝트 상대 경로가 아닙니다.");
  }
  return path;
}

function optionalFeedbackLineNumber(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 10_000_000) {
    throw new ApprovalBrokerError(400, "줄 피드백 줄 번호가 올바르지 않습니다.");
  }
  return Number(value);
}

function normalizedFeedbackComment(value: unknown): string {
  if (typeof value !== "string") throw new ApprovalBrokerError(400, "줄 피드백 의견이 올바르지 않습니다.");
  const comment = value.replace(/\r\n?/g, "\n").trim();
  if (!comment || comment.length > MAX_APPROVAL_FEEDBACK_COMMENT_LENGTH
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(comment)) {
    throw new ApprovalBrokerError(400, `줄 피드백 의견은 1~${MAX_APPROVAL_FEEDBACK_COMMENT_LENGTH}자여야 합니다.`);
  }
  return comment;
}

function sameFeedback(left: ApprovalFeedback | undefined, right: ApprovalFeedback | undefined): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function cloneResolution(resolution: ApprovalResolution): ApprovalResolution {
  return structuredClone(resolution);
}
