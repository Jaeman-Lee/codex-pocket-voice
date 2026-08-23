import assert from "node:assert/strict";
import test from "node:test";
import {
  activeApprovals,
  applyApprovalEvent,
  dashboardOperations,
  groupOperations,
  operationCounts,
  upsertOperation,
} from "../client/src/operations-state.js";
import type { ApprovalItem, Operation } from "../client/src/types.js";

const now = Date.parse("2026-08-24T02:00:00.000Z");

test("operation dashboard state deduplicates runs and groups approval work first", () => {
  const first = operation("first", "/workspace/a", "running", "2026-08-24T01:00:00.000Z");
  const second = operation("second", "/workspace/b", "completed", "2026-08-24T01:30:00.000Z");
  const updated = upsertOperation([first, second], { ...first, status: "failed", completedAt: "2026-08-24T01:40:00.000Z" });
  assert.deepEqual(updated.map((item) => item.id), ["first", "second"]);
  assert.equal(updated[0]?.status, "failed");

  const approval = pendingApproval();
  const groups = groupOperations(updated, [approval]);
  assert.equal(groups[0]?.cwd, "/workspace/a");
  assert.equal(groups[0]?.approvals[0]?.id, approval.id);
  assert.deepEqual(operationCounts(updated, [approval]), {
    running: 0,
    waitingForApproval: 1,
    completed: 1,
    failed: 1,
    unknown: 0,
  });
});

test("approval inbox removes resolved and expired requests without replay duplication", () => {
  const approval = pendingApproval();
  const requested = { type: "approval", action: "requested", approval };
  const once = applyApprovalEvent([], requested, now);
  assert.equal(applyApprovalEvent(once, requested, now).length, 1);
  assert.equal(activeApprovals(once, now).length, 1);
  assert.deepEqual(applyApprovalEvent(once, { ...requested, action: "resolved" }, now), []);
  assert.deepEqual(activeApprovals(once, Date.parse(approval.expiresAt) + 1), []);
});

test("operation dashboard hides archived work and orders pins ahead of ordinary terminal work", () => {
  const ordinary = operation("ordinary", "/workspace/a", "completed", "2026-08-24T01:50:00.000Z");
  const pinned = {
    ...operation("pinned", "/workspace/a", "completed", "2026-08-24T01:00:00.000Z"),
    pinnedAt: "2026-08-24T01:55:00.000Z",
  };
  const archived = {
    ...operation("archived", "/workspace/a", "completed", "2026-08-24T01:59:00.000Z"),
    archivedAt: "2026-08-24T02:00:00.000Z",
  };
  const hidden = dashboardOperations([archived, ordinary, pinned]);
  assert.deepEqual(hidden.map((item) => item.id), ["ordinary", "pinned"]);
  assert.equal(dashboardOperations([archived], true).length, 1);
  assert.deepEqual(groupOperations(hidden, [])[0]?.operations.map((item) => item.id), ["pinned", "ordinary"]);
});

function operation(
  id: string,
  cwd: string,
  status: Operation["status"],
  startedAt: string,
): Operation {
  return { id, cwd, prompt: id, status, startedAt, providerId: "codex" };
}

function pendingApproval(): ApprovalItem {
  return {
    id: "approval-1",
    operationId: "first",
    cwd: "/workspace/a",
    providerId: "openai",
    conversationId: "conversation-1",
    runId: "run-1",
    toolCallId: "tool-1",
    risk: "change",
    redactedSummary: "Apply one reviewed patch",
    status: "pending",
    requiresTouch: false,
    requestedAt: "2026-08-24T01:59:00.000Z",
    expiresAt: "2026-08-24T02:01:00.000Z",
  };
}
