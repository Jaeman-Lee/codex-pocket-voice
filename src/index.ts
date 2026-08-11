#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CodexAppServerClient } from "./app-server-client.js";
import { PathPolicy } from "./path-policy.js";
import { createBridgeServer } from "./server.js";

const paths = await PathPolicy.fromEnvironment();
const client = new CodexAppServerClient();
const server = createBridgeServer({ client, paths });
const transport = new StdioServerTransport();

let closing = false;
async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  await client.close();
  await server.close();
}

process.once("SIGINT", () => void close().finally(() => process.exit(0)));
process.once("SIGTERM", () => void close().finally(() => process.exit(0)));
process.once("uncaughtException", (error) => {
  process.stderr.write(`[codex-voice-bridge] ${error.stack ?? error.message}\n`);
  void close().finally(() => process.exit(1));
});
process.once("unhandledRejection", (error) => {
  process.stderr.write(`[codex-voice-bridge] ${String(error)}\n`);
  void close().finally(() => process.exit(1));
});

await server.connect(transport);
