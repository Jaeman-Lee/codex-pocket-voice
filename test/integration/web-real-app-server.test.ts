import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { CodexAppServerClient } from "../../src/app-server-client.js";
import { PathPolicy } from "../../src/path-policy.js";
import { startWebServer } from "../../src/web-server.js";

test("real app-server is reachable through the loopback web gateway without a model turn", async (t) => {
  const client = new CodexAppServerClient({ requestTimeoutMs: 15_000 });
  const paths = await PathPolicy.fromEnvironment(process.cwd());
  const running = await startWebServer({
    client,
    paths,
    staticDir: resolve(process.cwd(), "web"),
    port: 0,
  });
  t.after(async () => {
    await running.close();
    await client.close();
  });
  const base = `http://127.0.0.1:${running.port}`;

  const health = (await fetch(`${base}/api/health`).then((response) => response.json())) as any;
  assert.equal(health.ok, true);
  assert.match(health.userAgent, /codex/i);

  const threads = (await fetch(`${base}/api/threads?limit=1`).then((response) => response.json())) as any;
  assert.ok(Array.isArray(threads.threads));
});
