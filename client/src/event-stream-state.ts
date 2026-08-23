import type { CodexEvent } from "./types";

export interface AppliedEventFrame {
  event?: CodexEvent;
  cursorAction?: { type: "set"; cursor: number } | { type: "remove" };
}

export class EventStreamState {
  constructor(private cursor: number | undefined) {}

  apply(frame: string): AppliedEventFrame {
    const data = frame.split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) return {};
    let event: CodexEvent;
    try {
      event = JSON.parse(data) as CodexEvent;
    } catch {
      return {};
    }
    if (event.type === "journal" && event.action === "reset") {
      this.cursor = undefined;
      return { event, cursorAction: { type: "remove" } };
    }
    const nextCursor = parseEventCursor(frame);
    if (nextCursor !== undefined && this.cursor !== undefined && nextCursor <= this.cursor) return {};
    if (nextCursor === undefined) return { event };
    this.cursor = nextCursor;
    return { event, cursorAction: { type: "set", cursor: nextCursor } };
  }
}

function parseEventCursor(frame: string): number | undefined {
  const value = frame.split("\n").find((line) => line.startsWith("id:"))?.slice(3).trim();
  if (!value || !/^[0-9]{1,16}$/.test(value)) return undefined;
  const cursor = Number(value);
  return Number.isSafeInteger(cursor) ? cursor : undefined;
}
