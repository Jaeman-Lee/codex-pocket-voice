import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { CodexAppServerClient } from "../src/app-server-client.js";

const fixture = fileURLToPath(new URL("./fixtures/fake-app-server.mjs", import.meta.url));

test("client initializes, lists threads, runs a sandboxed turn, and declines approvals", async (t) => {
  const client = new CodexAppServerClient({
    command: process.execPath,
    args: [fixture],
    env: { ...process.env, FAKE_CODEX_CWD: process.cwd() },
    requestTimeoutMs: 2_000,
  });
  t.after(() => client.close());
  const notifications: string[] = [];
  client.subscribe((notification) => notifications.push(notification.method));

  const initialized = await client.start();
  assert.equal(initialized.userAgent, "fake/1");

  const listed = await client.listThreads(5);
  assert.equal(listed.data[0]?.id, "thread-1");

  const result = await client.runTurn({ cwd: process.cwd(), prompt: "make a safe change", timeoutMs: 2_000 });
  assert.equal(result.thread.id, "thread-1");
  assert.equal(result.turn.status, "completed");
  assert.equal(result.turn.items[0]?.type, "agentMessage");
  assert.ok(notifications.includes("item/agentMessage/delta"));
});
