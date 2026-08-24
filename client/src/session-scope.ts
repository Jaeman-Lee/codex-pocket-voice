import type { Operation, SessionHandoff, ThreadSummary } from "./types";

export function threadsForWorkspace(
  threads: readonly ThreadSummary[],
  workspace: string,
): ThreadSummary[] {
  if (!workspace) return [];
  return threads.filter((thread) => thread.cwd === workspace);
}

export function threadBelongsToWorkspace(
  threads: readonly ThreadSummary[],
  workspace: string,
  threadId: string,
): boolean {
  return Boolean(threadId) && threads.some((thread) => thread.id === threadId && thread.cwd === workspace);
}

export function scopedHandoff(
  handoff: SessionHandoff | null,
  workspace: string,
  dismissedHandoffId: string | null,
): SessionHandoff | null {
  if (!workspace || !handoff || handoff.workspace !== workspace || handoff.id === dismissedHandoffId) return null;
  return handoff;
}

export function operationBelongsToSession(
  operation: Operation | null,
  workspace: string,
  threadId: string,
): operation is Operation {
  if (!operation || operation.cwd !== workspace) return false;
  const conversationId = operation.conversationId ?? operation.threadId;
  return !threadId || conversationId === threadId;
}
