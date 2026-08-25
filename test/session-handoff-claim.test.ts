import assert from "node:assert/strict";
import test from "node:test";
import {
  claimSessionHandoff,
  type SessionHandoffClaimSteps,
} from "../client/src/session-handoff-claim.js";
import type { Operation, SessionHandoff, ThreadDetail } from "../client/src/types.js";

const pending: SessionHandoff = {
  id: "handoff-exact",
  workspace: "/workspace/project",
  threadId: "thread-exact",
  operationId: "operation-exact",
  releasedBy: { id: "phone-a", label: "Phone A" },
  releasedAt: "2026-08-24T00:00:00.000Z",
  expiresAt: "2026-08-25T00:00:00.000Z",
};

const thread: ThreadDetail = {
  id: pending.threadId,
  cwd: pending.workspace,
  turns: [],
};

const operation: Operation = {
  id: pending.operationId!,
  providerId: "codex",
  conversationId: pending.threadId,
  threadId: pending.threadId,
  cwd: pending.workspace,
  prompt: "continue safely",
  status: "running",
};

test("session claim validates the exact thread and operation before the server mutation", async () => {
  const calls: string[] = [];
  const result = await claimSessionHandoff(pending, steps({
    readThread: async (id) => { calls.push(`thread:${id}`); return thread; },
    readOperation: async (id) => { calls.push(`operation:${id}`); return operation; },
    claim: async (id) => { calls.push(`claim:${id}`); return pending; },
  }));

  assert.deepEqual(calls, [
    "thread:thread-exact",
    "operation:operation-exact",
    "claim:handoff-exact",
  ]);
  assert.equal(result.thread, thread);
  assert.equal(result.operation, operation);
  assert.equal(result.claimed, pending);
});

test("nested or mismatched session evidence never reaches claim", async () => {
  for (const [replacement, message] of [
    [{ thread: { ...thread, cwd: `${pending.workspace}/nested` } }, /정확한 경로/],
    [{ operation: { ...operation, conversationId: "thread-other", threadId: "thread-other" } }, /PC 작업/],
  ] as const) {
    const calls: string[] = [];
    await assert.rejects(
      claimSessionHandoff(pending, steps({
        readThread: async () => { calls.push("thread"); return replacement.thread ?? thread; },
        readOperation: async () => { calls.push("operation"); return replacement.operation ?? operation; },
        claim: async () => { calls.push("claim"); return pending; },
      })),
      message,
    );
    assert.equal(calls.includes("claim"), false);
  }
});

test("a stale selection or mismatched claim response fails without accepting the session", async () => {
  let current = true;
  await assert.rejects(
    claimSessionHandoff(pending, steps({
      readThread: async () => { current = false; return thread; },
      isCurrent: () => current,
    })),
    /연결 대상이 바뀌어/,
  );

  await assert.rejects(
    claimSessionHandoff(pending, steps({
      claim: async () => ({ ...pending, threadId: "thread-other" }),
    })),
    /응답이 요청한 대상과 일치하지 않습니다/,
  );

  await assert.rejects(
    claimSessionHandoff(pending, steps({ claim: async () => null })),
    /응답이 요청한 대상과 일치하지 않습니다/,
  );
});

test("malformed thread history or operation evidence is rejected before claim", async () => {
  for (const replacement of [
    { thread: { ...thread, turns: [{ items: "not-an-array" }] } },
    { operation: undefined },
  ]) {
    let claimed = false;
    await assert.rejects(claimSessionHandoff(pending, steps({
      readThread: async () => replacement.thread ?? thread,
      readOperation: async () => "operation" in replacement ? replacement.operation : operation,
      claim: async () => { claimed = true; return pending; },
    })));
    assert.equal(claimed, false);
  }
});

test("a retained thread remains claimable after its operation leaves the run snapshot", async () => {
  const result = await claimSessionHandoff(pending, steps({ readOperation: async () => null }));
  assert.equal(result.operation, null);
  assert.equal(result.thread.id, pending.threadId);
});

function steps(overrides: Partial<SessionHandoffClaimSteps>): SessionHandoffClaimSteps {
  return {
    isCurrent: () => true,
    readThread: async () => thread,
    readOperation: async () => operation,
    claim: async () => pending,
    ...overrides,
  };
}
