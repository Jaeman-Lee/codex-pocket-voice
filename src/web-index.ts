#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAppServerClient } from "./app-server-client.js";
import { PathPolicy } from "./path-policy.js";
import { startWebServer } from "./web-server.js";

const paths = await PathPolicy.fromEnvironment();
const client = new CodexAppServerClient();
const moduleDir = dirname(fileURLToPath(import.meta.url));
const staticDir = [resolve(process.cwd(), "web"), resolve(moduleDir, "../../web"), resolve(moduleDir, "../web")]
  .find((candidate) => existsSync(resolve(candidate, "index.html")));
if (!staticDir) throw new Error("Could not find the web/ static asset directory");

const port = Number(process.env.CODEX_WEB_PORT ?? "8787");
if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("CODEX_WEB_PORT is invalid");
const running = await startWebServer({
  client,
  paths,
  staticDir,
  host: process.env.CODEX_WEB_HOST ?? "127.0.0.1",
  port,
});

process.stderr.write(`[codex-web] Ready on http://${running.host}:${running.port}\n`);
process.stderr.write(`[codex-web] Allowed roots: ${paths.roots.join(", ")}\n`);

let closing = false;
async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  await running.close();
  await client.close();
}

process.once("SIGINT", () => void close().finally(() => process.exit(0)));
process.once("SIGTERM", () => void close().finally(() => process.exit(0)));
