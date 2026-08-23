import { createHash, randomUUID } from "node:crypto";

const DEFAULT_EXPIRY_MS = 2 * 60_000;
const MAX_EXPIRY_MS = 10 * 60_000;

export type ApprovalRisk = "observation" | "change" | "execution" | "high_risk" | "external_effect";
export type ApprovalStatus = "pending" | "approved" | "declined" | "expired";
export type ApprovalDecisionSource = "touch" | "voice" | "system";

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
  ): ApprovalResolution {
    this.sweepExpired();
    const entry = this.entries.get(requestId);
    if (!entry) throw new ApprovalBrokerError(404, "Approval request not found");
    if (entry.resolution) {
      if (entry.resolution.decision === decision && entry.resolution.source === source) {
        return { ...entry.resolution };
      }
      throw new ApprovalBrokerError(409, "이미 처리된 승인 요청입니다.");
    }
    if (decision === "approved" && source === "system") {
      throw new ApprovalBrokerError(403, "시스템은 작업을 자동 승인할 수 없습니다.");
    }
    if (decision === "approved" && entry.request.requiresTouch && source !== "touch") {
      throw new ApprovalBrokerError(403, "이 작업은 화면의 터치 확인이 필요합니다.");
    }
    return this.finish(entry, decision, source);
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
  ): ApprovalResolution {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = undefined;
    entry.request.status = decision;
    const resolution: ApprovalResolution = {
      requestId: entry.request.id,
      decision,
      source,
      decidedAt: new Date(this.now()).toISOString(),
    };
    entry.resolution = resolution;
    entry.resolveDecision(resolution);
    this.emit({
      type: "resolved",
      request: cloneRequest(entry.request),
      resolution: { ...resolution },
    });
    return { ...resolution };
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
