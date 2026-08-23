import assert from "node:assert/strict";
import test from "node:test";
import { CodexAppServerClient } from "../../src/app-server-client.js";

test("real codex app-server initializes and lists threads without starting a model turn", async (t) => {
  const client = new CodexAppServerClient({ requestTimeoutMs: 15_000 });
  t.after(() => client.close());

  const initialized = await client.start();
  assert.match(initialized.userAgent, /codex/i);
  const listed = await client.listThreads(1);
  assert.ok(Array.isArray(listed.data));
  if (listed.data[0]) {
    const released = await client.unsubscribeThread(listed.data[0].id);
    assert.ok(["notLoaded", "notSubscribed", "unsubscribed"].includes(released.status));
  }
});
