import type { Operation, SessionHandoff } from "./types";

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
