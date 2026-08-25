import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { CodexAppServerClient } from "../src/app-server-client.js";

const fixture = fileURLToPath(new URL("./fixtures/fake-app-server.mjs", import.meta.url));

test("client initializes, lists threads, runs a sandboxed turn, and declines approvals", async (t) => {
  const client = new CodexAppServerClient({
    command: process.execPath,
    args: [fixture],
    env: { ...process.env, FAKE_CODEX_CWD: process.cwd(), FAKE_EXPECT_IMAGE: "1" },
    requestTimeoutMs: 2_000,
  });
  t.after(() => client.close());
  const notifications: string[] = [];
  client.subscribe((notification) => notifications.push(notification.method));

  const initialized = await client.start();
  assert.equal(initialized.userAgent, "fake/1");

  const listed = await client.listThreads(5);
  assert.equal(listed.data[0]?.id, "thread-1");

  const result = await client.runTurn({
    cwd: process.cwd(),
    prompt: "make a safe change",
    imagePaths: [fixture],
    timeoutMs: 2_000,
  });
  assert.equal(result.thread.id, "thread-1");
  assert.equal(result.turn.status, "completed");
  assert.equal(result.turn.items[0]?.type, "agentMessage");
  assert.ok(notifications.includes("item/agentMessage/delta"));

  const resumed = await client.runTurn({
    threadId: result.thread.id,
    cwd: process.cwd(),
    prompt: "continue safely",
    timeoutMs: 2_000,
  });
  assert.equal(resumed.thread.id, "thread-1");
  assert.equal(resumed.turn.status, "completed");

  const unsubscribed = await client.unsubscribeThread(resumed.thread.id);
  assert.equal(unsubscribed.status, "unsubscribed");
});

test("client steers only the expected active Codex turn with bounded input", async (t) => {
  const client = new CodexAppServerClient({
    command: process.execPath,
    args: [fixture],
    env: {
      ...process.env,
      FAKE_CODEX_CWD: process.cwd(),
      FAKE_REQUIRE_STEER: "1",
      FAKE_EXPECT_STEER_IMAGE: "1",
    },
    requestTimeoutMs: 2_000,
  });
  t.after(() => client.close());
  const notifications: string[] = [];
  client.subscribe((notification) => notifications.push(notification.method));
  const begun = await client.beginTurn({
    cwd: process.cwd(),
    prompt: "start before steering",
    timeoutMs: 2_000,
  });
  await client.steerTurn({
    threadId: begun.thread.id,
    turnId: begun.turn.id,
    prompt: "change direction safely",
    imagePaths: [fixture],
  });
  const completed = await begun.completion;
  assert.equal(completed.status, "completed");
  assert.ok(notifications.includes("item/agentMessage/delta"));
});
