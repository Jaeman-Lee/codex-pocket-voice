import type { ChatMessage, Operation, ProviderId, ThreadSummary } from "./types";

export function providerConversationThreads(
  operations: readonly Operation[],
  providerId: ProviderId,
  workspace: string,
): ThreadSummary[] {
  const latest = new Map<string, Operation>();
  for (const operation of operations) {
    if (operation.providerId !== providerId || operation.cwd !== workspace
        || !operation.conversationId || operation.resumable !== true) continue;
    const previous = latest.get(operation.conversationId);
    if (!previous || operationTime(operation) > operationTime(previous)) {
      latest.set(operation.conversationId, operation);
    }
  }
  return [...latest.values()]
    .sort((left, right) => operationTime(right) - operationTime(left))
    .map((operation) => ({
      id: operation.conversationId!,
      cwd: operation.cwd,
      name: operation.prompt.slice(0, 80),
      preview: operation.result?.finalResponse?.slice(0, 120) ?? operation.prompt.slice(0, 120),
    }));
}

export function providerConversationMessages(
  operations: readonly Operation[],
  providerId: ProviderId,
  workspace: string,
  conversationId: string,
): ChatMessage[] {
  return operations
    .filter((operation) => operation.providerId === providerId && operation.cwd === workspace
      && operation.conversationId === conversationId)
    .sort((left, right) => operationTime(left) - operationTime(right))
    .flatMap((operation) => {
      const assistant = operation.result?.finalResponse
        || (operation.status === "failed" ? `작업 실패: ${operation.error || "알 수 없는 오류"}` : "");
      return [
        { id: `${operation.id}:user`, role: "user" as const, text: operation.prompt },
        ...(assistant ? [{
          id: `${operation.id}:assistant`,
          role: "assistant" as const,
          text: assistant,
          error: operation.status === "failed" || operation.status === "unknown",
        }] : []),
      ];
    });
}

function operationTime(operation: Operation): number {
  return Date.parse(operation.completedAt ?? operation.startedAt ?? "1970-01-01T00:00:00.000Z");
}
