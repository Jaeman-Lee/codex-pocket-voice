import type { ProviderEvent } from "./providers/types.js";

const MAX_TRACKED_EVENT_IDS = 4_096;
const MAX_EVENT_ID_LENGTH = 512;

export interface ProviderRunEventScope {
  providerId: string;
  conversationId: string;
  runId: string;
}

/**
 * Applies the provider-neutral event ownership contract for one active run.
 *
 * Provider transports may replay a frame or deliver an old frame after a new
 * run starts in the same conversation. This gate keeps those frames from being
 * attributed to the new operation or persisted twice.
 */
export class ProviderRunEventGate {
  private lastSequence?: number;
  private terminal = false;
  private readonly eventIds = new Set<string>();
  private readonly eventIdOrder: string[] = [];

  constructor(private readonly scope: ProviderRunEventScope) {}

  accept(event: ProviderEvent): boolean {
    if (event.providerId !== this.scope.providerId || event.conversationId !== this.scope.conversationId) {
      return false;
    }
    if (event.runId !== undefined && event.runId !== this.scope.runId) return false;
    // Run-scoped events must identify their owner. A provider-wide warning is
    // the sole backward-compatible exception because Codex warnings can target
    // a thread without carrying a turn ID.
    if (event.runId === undefined && event.kind !== "warning") return false;
    if (this.terminal) return false;

    if (event.eventId !== undefined) {
      if (!validEventId(event.eventId) || this.eventIds.has(event.eventId)) return false;
    }
    if (event.sequence !== undefined) {
      if (!Number.isSafeInteger(event.sequence) || event.sequence <= 0) return false;
      if (this.lastSequence !== undefined && event.sequence <= this.lastSequence) return false;
    }

    if (event.eventId !== undefined) this.rememberEventId(event.eventId);
    if (event.sequence !== undefined) this.lastSequence = event.sequence;
    if (event.kind === "run.completed" || event.kind === "run.failed") this.terminal = true;
    return true;
  }

  private rememberEventId(eventId: string): void {
    this.eventIds.add(eventId);
    this.eventIdOrder.push(eventId);
    if (this.eventIdOrder.length <= MAX_TRACKED_EVENT_IDS) return;
    const expired = this.eventIdOrder.shift();
    if (expired !== undefined) this.eventIds.delete(expired);
  }
}

function validEventId(value: string): boolean {
  return value.length > 0
    && value.length <= MAX_EVENT_ID_LENGTH
    && !/[\u0000-\u001f\u007f]/.test(value);
}
