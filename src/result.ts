import type { Thread } from "../generated/app-server/v2/Thread";
import type { Turn } from "../generated/app-server/v2/Turn";

const MAX_DETAIL_CHARS = 24_000;

export function summarizeTurn(thread: Thread, turn: Turn): Record<string, unknown> {
  const messages = turn.items
    .filter((item) => item.type === "agentMessage")
    .map((item) => item.text);
  const commands = turn.items
    .filter((item) => item.type === "commandExecution")
    .map((item) => ({
      command: item.command,
      status: item.status,
      exitCode: item.exitCode,
      output: truncate(item.aggregatedOutput ?? ""),
    }));
  const fileChanges = turn.items
    .filter((item) => item.type === "fileChange")
    .map((item) => ({ status: item.status, changes: item.changes }));
  const finalResponse = messages.at(-1) ?? "";

  return {
    threadId: thread.id,
    turnId: turn.id,
    status: turn.status,
    cwd: thread.cwd,
    finalResponse: truncate(finalResponse),
    commands,
    fileChanges,
    error: turn.error,
  };
}

export function compactThread(thread: Thread): Record<string, unknown> {
  return {
    id: thread.id,
    name: thread.name,
    preview: truncate(thread.preview, 500),
    cwd: thread.cwd,
    status: thread.status,
    updatedAt: thread.updatedAt,
    createdAt: thread.createdAt,
    cliVersion: thread.cliVersion,
  };
}

export function presentThread(thread: Thread): Record<string, unknown> {
  return {
    ...compactThread(thread),
    turns: thread.turns.slice(-30).map((turn) => ({
      id: turn.id,
      status: turn.status,
      error: turn.error,
      startedAt: turn.startedAt,
      completedAt: turn.completedAt,
      items: turn.items.map(presentItem).filter((item) => item !== null),
    })),
  };
}

export function textResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>,
  };
}

export function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

function truncate(value: string, limit = MAX_DETAIL_CHARS): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n… [truncated ${value.length - limit} characters]`;
}

function presentItem(item: Turn["items"][number]): Record<string, unknown> | null {
  switch (item.type) {
    case "userMessage":
      return {
        type: item.type,
        id: item.id,
        text: item.content
          .filter((content) => content.type === "text")
          .map((content) => content.text)
          .join("\n"),
      };
    case "agentMessage":
      return { type: item.type, id: item.id, text: truncate(item.text), phase: item.phase };
    case "plan":
      return { type: item.type, id: item.id, text: truncate(item.text, 8_000) };
    case "commandExecution":
      return {
        type: item.type,
        id: item.id,
        command: truncate(item.command, 4_000),
        status: item.status,
        exitCode: item.exitCode,
        output: truncate(item.aggregatedOutput ?? "", 8_000),
      };
    case "fileChange":
      return {
        type: item.type,
        id: item.id,
        status: item.status,
        changes: item.changes.map((change) => ({
          path: change.path,
          kind: change.kind,
          diff: truncate(change.diff, 12_000),
        })),
      };
    default:
      return null;
  }
}
