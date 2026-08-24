#!/usr/bin/env node
import {
  loadLinuxPocketLinkP2pConfig,
  runLinuxPocketLinkP2p,
  type LinuxPocketLinkP2pStatus,
} from "./pocket-link-p2p-linux.js";

const controller = new AbortController();
let signalCount = 0;
const stop = () => {
  signalCount += 1;
  if (signalCount === 1) controller.abort();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

try {
  const config = loadLinuxPocketLinkP2pConfig();
  const result = await runLinuxPocketLinkP2p(config, {
    signal: controller.signal,
    onStatus: reportStatus,
  });
  process.stderr.write(`[codex-pocket-p2p] Session ended (${result.reason}); network state was cleaned up\n`);
} catch (error) {
  process.stderr.write(`[codex-pocket-p2p] ${safeError(error)}\n`);
  process.exitCode = 1;
} finally {
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
}

function reportStatus(status: LinuxPocketLinkP2pStatus): void {
  const messages: Record<LinuxPocketLinkP2pStatus, string> = {
    preflight: "Checking exclusive P2P control and the fixed local subnet",
    accepting: "Discoverable for one reviewed Android PBC request",
    forming: "Forming a bounded Linux group-owner session",
    ready: "P2P transport ready; PocketLink mTLS remains the authentication boundary",
    cleaning: "Stopping DHCP and removing the scoped group network",
  };
  process.stderr.write(`[codex-pocket-p2p] ${messages[status]}\n`);
}

function safeError(error: unknown): string {
  if (!(error instanceof Error)) return "PocketLink P2P failed";
  return error.message.replace(/[\r\n\p{Cc}\p{Cf}]+/gu, " ").slice(0, 240) || "PocketLink P2P failed";
}
