import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";
import { CodexAppServerClient } from "../../src/app-server-client.js";
import { PathPolicy } from "../../src/path-policy.js";
import { startWebServer } from "../../src/web-server.js";
import { GatewayAuth } from "../../src/gateway-auth.js";

test("real app-server is reachable through the loopback web gateway without a model turn", async (t) => {
  const client = new CodexAppServerClient({ requestTimeoutMs: 15_000 });
  const paths = await PathPolicy.fromEnvironment(process.cwd());
  const authHome = await mkdtemp(join(tmpdir(), "codex-pocket-real-auth-"));
  const auth = await GatewayAuth.create({ stateFile: join(authHome, "auth.json"), pairingCode: "12345678" });
  t.after(() => rm(authHome, { recursive: true, force: true }));
  const running = await startWebServer({
    client,
    paths,
    staticDir: resolve(process.cwd(), "client/dist"),
    auth,
    port: 0,
  });
  t.after(async () => {
    await running.close();
    await client.close();
  });
  const base = `http://127.0.0.1:${running.port}`;
  const paired = await fetch(`${base}/api/pairing/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost" },
    body: JSON.stringify({ code: "12345678", label: "integration" }),
  }).then((response) => response.json()) as { token: string };
  const headers = { Authorization: `Bearer ${paired.token}` };

  const health = (await fetch(`${base}/api/health`, { headers }).then((response) => response.json())) as any;
  assert.equal(health.ok, true);
  assert.match(health.userAgent, /codex/i);

  const threads = (await fetch(`${base}/api/threads?limit=1`, { headers }).then((response) => response.json())) as any;
  assert.ok(Array.isArray(threads.threads));
});
