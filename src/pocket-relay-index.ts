#!/usr/bin/env node
import { X509Certificate } from "node:crypto";
import { publicKeyPin } from "./pocket-link.js";
import { loadPocketRelayServerConfig, startPocketRelayServer } from "./pocket-relay.js";

const config = await loadPocketRelayServerConfig();
const relay = await startPocketRelayServer(config);
process.stderr.write(`[codex-pocket-relay] Ready on ${relay.host}:${relay.port}\n`);
process.stderr.write(`[codex-pocket-relay] TLS SPKI pin: ${publicKeyPin(new X509Certificate(config.certificate))}\n`);

let closing = false;
async function close(exitCode: number): Promise<void> {
  if (closing) return;
  closing = true;
  await relay.close();
  process.exit(exitCode);
}

process.once("SIGINT", () => void close(0));
process.once("SIGTERM", () => void close(0));
process.once("uncaughtException", (error) => {
  process.stderr.write(`[codex-pocket-relay] ${error instanceof Error ? error.message : "unexpected error"}\n`);
  void close(1);
});
process.once("unhandledRejection", (error) => {
  process.stderr.write(`[codex-pocket-relay] ${error instanceof Error ? error.message : "unexpected error"}\n`);
  void close(1);
});
