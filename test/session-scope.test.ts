import assert from "node:assert/strict";
import test from "node:test";
import { operationBelongsToSession, scopedHandoff } from "../client/src/session-scope.js";
import type { Operation, SessionHandoff } from "../client/src/types.js";

const handoff: SessionHandoff = {
  id: "handoff-stock",
  workspace: "/workspace/stock-explorer",
  threadId: "thread-stock",
  releasedBy: { id: "phone", label: "Phone" },
  releasedAt: "2026-08-23T00:00:00.000Z",
  expiresAt: "2026-08-24T00:00:00.000Z",
};

test("handoff UI never presents another project's session as the current project", () => {
  assert.equal(scopedHandoff(handoff, "/workspace/codex-pocket-voice", null), null);
  assert.equal(scopedHandoff(handoff, "/workspace/stock-explorer", null)?.id, handoff.id);
  assert.equal(scopedHandoff(handoff, "/workspace/stock-explorer", handoff.id), null);
});

test("session actions ignore operations owned by another project or conversation", () => {
  const operation: Operation = {
    id: "operation-stock",
    providerId: "codex",
    conversationId: "thread-stock",
    runId: "run-stock",
    threadId: "thread-stock",
    turnId: "run-stock",
    cwd: "/workspace/stock-explorer",
    prompt: "inspect",
    status: "running",
  };
  assert.equal(operationBelongsToSession(operation, "/workspace/codex-pocket-voice", ""), false);
  assert.equal(operationBelongsToSession(operation, "/workspace/stock-explorer", "another-thread"), false);
  assert.equal(operationBelongsToSession(operation, "/workspace/stock-explorer", "thread-stock"), true);
});
