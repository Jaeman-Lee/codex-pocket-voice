import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  activeRunScope,
  initialActiveRunState,
  reduceActiveRun,
} from "../client/src/active-run-state.js";
import {
  initialJournalState,
  mergeRestoredPrompts,
  queueLoadMatches,
  reduceJournalState,
} from "../client/src/journal-state.js";
import type { Operation, QueuedPrompt } from "../client/src/types.js";

const operation: Operation = {
  id: "operation-new",
  providerId: "codex",
  conversationId: "thread-new",
  threadId: "thread-new",
  runId: "turn-new",
  turnId: "turn-new",
  cwd: "/workspace/new",
  prompt: "inspect",
  status: "running",
};

test("active run generation rejects stale start, poll, stream, and terminal transitions", () => {
  let state = initialActiveRunState("linux");
  state = reduceActiveRun(state, {
    type: "begin",
    generation: 1,
    device: "linux",
    requestId: "request-old",
    liveMessageId: "message-old",
  });
  state = reduceActiveRun(state, { type: "begin", generation: 2, device: "remote", requestId: "request-new" });
  const current = state;

  state = reduceActiveRun(state, {
    type: "adopt",
    generation: 1,
    device: "linux",
    requestId: "request-old",
    operation,
  });
  assert.equal(state, current);
  state = reduceActiveRun(state, {
    type: "adopt",
    generation: 2,
    device: "remote",
    requestId: "request-new",
    operation,
  });
  assert.equal(state.operation?.id, operation.id);

  const scope = activeRunScope(state);
  state = reduceActiveRun(state, {
    type: "append_output",
    ...scope,
    operationId: operation.id,
    messageId: "message-new",
    delta: "hello",
  });
  state = reduceActiveRun(state, {
    type: "append_output",
    ...scope,
    operationId: operation.id,
    messageId: "message-new",
    delta: " world",
  });
  state = reduceActiveRun(state, {
    type: "set_diff",
    ...scope,
    operationId: operation.id,
    diff: "safe diff",
  });
  assert.deepEqual(
    { message: state.liveMessageId, text: state.liveText, diff: state.latestDiff },
    { message: "message-new", text: "hello world", diff: "safe diff" },
  );

  const wrongOperation = reduceActiveRun(state, {
    type: "finish",
    ...scope,
    operationId: "operation-old",
  });
  assert.equal(wrongOperation, state);
  state = reduceActiveRun(state, { type: "finish", ...scope, operationId: operation.id });
  assert.equal(state.operation, null);
  assert.equal(state.liveText, "");
  assert.equal(state.activity.running, false);
});

test("unknown active runs remain blocking until the exact operation is acknowledged", () => {
  let state = reduceActiveRun(initialActiveRunState("linux"), {
    type: "begin",
    generation: 1,
    device: "linux",
  });
  state = reduceActiveRun(state, { type: "adopt", generation: 1, device: "linux", operation });
  const unknown = { ...operation, status: "unknown" as const };
  state = reduceActiveRun(state, {
    type: "mark_unknown",
    generation: 1,
    device: "linux",
    operationId: operation.id,
    operation: unknown,
  });
  assert.equal(state.operation?.status, "unknown");
  state = reduceActiveRun(state, {
    type: "acknowledge",
    generation: 1,
    device: "linux",
    operationId: operation.id,
  });
  assert.equal(state.operation, null);
});

test("journal generations reject stale loads and merge prompts created during queue restore", () => {
  let state = reduceJournalState(initialJournalState, {
    type: "conversation_begin",
    generation: 1,
    key: "old",
  });
  state = reduceJournalState(state, { type: "conversation_begin", generation: 2, key: "new" });
  const stale = reduceJournalState(state, {
    type: "conversation_loaded",
    generation: 1,
    key: "old",
    restored: true,
  });
  assert.equal(stale, state);

  state = reduceJournalState(state, { type: "queue_begin", generation: 1, device: "linux" });
  state = reduceJournalState(state, { type: "queue_changed", device: "linux" });
  assert.equal(state.queue.changedDuringLoad, true);
  assert.equal(queueLoadMatches(state, 1, "linux"), true);

  const switched = reduceJournalState(state, { type: "queue_begin", generation: 2, device: "remote" });
  const staleQueue = reduceJournalState(switched, { type: "queue_loaded", generation: 1, device: "linux" });
  assert.equal(staleQueue, switched);
  assert.equal(queueLoadMatches(switched, 1, "linux"), false);

  const restored = [queued("saved", true), queued("same", true)];
  const live = [queued("same", false), queued("new", false)];
  assert.deepEqual(
    mergeRestoredPrompts(restored, live).map(({ id, requiresConfirmation }) => ({ id, requiresConfirmation })),
    [
      { id: "saved", requiresConfirmation: true },
      { id: "same", requiresConfirmation: false },
      { id: "new", requiresConfirmation: false },
    ],
  );
});

test("App delegates active run and journal restore state to extracted reducers", async () => {
  const app = await readFile(new URL("../client/src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /useReducer\(\s*reduceActiveRun/);
  assert.match(app, /useReducer\(reduceJournalState/);
  assert.match(app, /activeRunScopeMatches/);
  assert.match(app, /activeRunOwnsOperation/);
  assert.match(app, /pollOperation\(operationId, scope\)/);
  assert.match(app, /activeRunRef\.current\.requestId/);
  assert.match(app, /queueLoadMatches/);
  assert.doesNotMatch(app, /operationRef/);
  assert.doesNotMatch(app, /liveMessageIdRef|liveTextRef|latestDiffRef/);
  assert.doesNotMatch(app, /const \[journalRestored, setJournalRestored\]/);
});

function queued(id: string, requiresConfirmation: boolean): QueuedPrompt {
  return {
    id,
    text: id,
    cwd: "/workspace/new",
    threadId: "",
    networkAccess: false,
    model: "",
    effort: "",
    provider: "codex",
    accountId: "cli-default",
    attachments: [],
    requiresConfirmation,
  };
}
