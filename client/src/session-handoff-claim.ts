import type { Operation, SessionHandoff, ThreadDetail } from "./types";

export interface SessionHandoffClaimSteps {
  isCurrent(): boolean;
  readThread(threadId: string): Promise<unknown>;
  readOperation(operationId: string): Promise<unknown | null>;
  claim(handoffId: string): Promise<unknown>;
}

export interface ClaimedSessionHandoff {
  claimed: SessionHandoff;
  thread: ThreadDetail;
  operation: Operation | null;
}

export async function claimSessionHandoff(
  pending: SessionHandoff,
  steps: SessionHandoffClaimSteps,
): Promise<ClaimedSessionHandoff> {
  assertCurrent(steps);
  const threadEvidence = await steps.readThread(pending.threadId);
  assertCurrent(steps);
  if (!isThreadDetail(threadEvidence)
      || threadEvidence.id !== pending.threadId || threadEvidence.cwd !== pending.workspace) {
    throw new Error("인계된 대화가 선택한 프로젝트의 정확한 경로와 일치하지 않습니다.");
  }
  const thread = threadEvidence;

  const operationEvidence = pending.operationId
    ? await steps.readOperation(pending.operationId)
    : null;
  assertCurrent(steps);
  if (operationEvidence !== null && (!isOperation(operationEvidence)
      || !operationMatchesHandoff(operationEvidence, pending))) {
    throw new Error("인계된 PC 작업이 선택한 프로젝트와 대화에 속하지 않습니다.");
  }
  const operation = operationEvidence;

  const claimEvidence = await steps.claim(pending.id);
  assertCurrent(steps);
  if (!isSessionHandoff(claimEvidence) || !handoffMatches(claimEvidence, pending)) {
    throw new Error("Companion의 세션 이어받기 응답이 요청한 대상과 일치하지 않습니다.");
  }
  const claimed = claimEvidence;
  return { claimed, thread, operation };
}

function assertCurrent(steps: SessionHandoffClaimSteps): void {
  if (!steps.isCurrent()) {
    throw new Error("연결 대상이 바뀌어 세션을 이어받지 않았습니다.");
  }
}

function operationMatchesHandoff(operation: Operation, handoff: SessionHandoff): boolean {
  return operation.id === handoff.operationId
    && (operation.providerId ?? "codex") === "codex"
    && operation.cwd === handoff.workspace
    && (operation.threadId ?? operation.conversationId) === handoff.threadId;
}

function handoffMatches(claimed: SessionHandoff, pending: SessionHandoff): boolean {
  return claimed.id === pending.id
    && claimed.workspace === pending.workspace
    && claimed.threadId === pending.threadId
    && claimed.operationId === pending.operationId;
}

function isThreadDetail(value: unknown): value is ThreadDetail {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.cwd !== "string"
      || !Array.isArray(value.turns)) return false;
  return value.turns.every((turn) => isRecord(turn) && Array.isArray(turn.items)
    && turn.items.every(isHistoryItem));
}

function isHistoryItem(value: unknown): boolean {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  for (const field of ["text", "command", "output", "status"] as const) {
    if (value[field] !== undefined && typeof value[field] !== "string") return false;
  }
  if (value.changes === undefined) return true;
  return Array.isArray(value.changes) && value.changes.every((change) => isRecord(change)
    && typeof change.kind === "string" && typeof change.path === "string");
}

function isOperation(value: unknown): value is Operation {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.cwd === "string"
    && typeof value.prompt === "string"
    && typeof value.status === "string";
}

function isSessionHandoff(value: unknown): value is SessionHandoff {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.workspace === "string"
    && typeof value.threadId === "string"
    && (value.operationId === undefined || typeof value.operationId === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
