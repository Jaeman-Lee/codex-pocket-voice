import assert from "node:assert/strict";
import test from "node:test";
import { ProviderRunEventGate } from "../src/provider-event-contract.js";
import type { ProviderEvent } from "../src/providers/types.js";

const scope = {
  providerId: "provider-a",
  conversationId: "conversation-a",
  runId: "run-current",
};

test("provider event gate rejects stale, duplicate, out-of-order, and post-terminal frames", () => {
  const gate = new ProviderRunEventGate(scope);
  assert.equal(gate.accept(event("run.started", 1)), true);
  assert.equal(gate.accept(event("output.delta", 2, { delta: "first" })), true);

  assert.equal(gate.accept(event("output.delta", 2, { delta: "duplicate sequence" })), false);
  assert.equal(gate.accept(event("output.delta", 3, { delta: "duplicate id" }, "run-current:2")), false);
  assert.equal(gate.accept({ ...event("output.delta", 3, { delta: "old run" }), runId: "run-old" }), false);
  assert.equal(gate.accept({ ...event("output.delta", 3, { delta: "wrong provider" }), providerId: "provider-b" }), false);
  assert.equal(gate.accept({
    providerId: scope.providerId,
    conversationId: scope.conversationId,
    kind: "output.delta",
    delta: "missing owner",
  }), false);

  assert.equal(gate.accept(event("run.completed", 4, { status: "completed" })), true);
  assert.equal(gate.accept(event("output.delta", 5, { delta: "after terminal" })), false);
});

test("provider event gate permits a scoped Codex warning without a turn ID", () => {
  const gate = new ProviderRunEventGate(scope);
  assert.equal(gate.accept({
    providerId: scope.providerId,
    conversationId: scope.conversationId,
    kind: "warning",
    message: "thread-scoped warning",
  }), true);
});

function event(
  kind: ProviderEvent["kind"],
  sequence: number,
  payload: Record<string, unknown> = {},
  eventId = `run-current:${sequence}`,
): ProviderEvent {
  return {
    providerId: scope.providerId,
    conversationId: scope.conversationId,
    runId: scope.runId,
    eventId,
    sequence,
    kind,
    ...payload,
  } as ProviderEvent;
}
