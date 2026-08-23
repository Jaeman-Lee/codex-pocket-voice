#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAppServerClient } from "./app-server-client.js";
import { PathPolicy } from "./path-policy.js";
import { createPocketLinkBootstrapUri } from "./pocket-link-bootstrap.js";
import {
  pocketLinkDiscoveryEnabled,
  startPocketLinkDiscoveryAdvertisement,
} from "./pocket-link-discovery.js";
import { renderPocketLinkTerminalQr } from "./pocket-link-terminal-qr.js";
import { loadPocketLinkTlsConfig } from "./pocket-link.js";
import { startWebServer } from "./web-server.js";

const paths = await PathPolicy.fromEnvironment();
const client = new CodexAppServerClient();
const moduleDir = dirname(fileURLToPath(import.meta.url));
const staticDir = [
  resolve(process.cwd(), "client/dist"),
  resolve(moduleDir, "../../client/dist"),
  resolve(moduleDir, "../../../client/dist"),
]
  .find((candidate) => existsSync(resolve(candidate, "index.html")));
if (!staticDir) throw new Error("Could not find client/dist; run npm run build:client first");

const port = Number(process.env.CODEX_WEB_PORT ?? "8787");
if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("CODEX_WEB_PORT is invalid");
const pocketLink = await loadPocketLinkTlsConfig();
const discoveryEnabled = pocketLinkDiscoveryEnabled();
if (discoveryEnabled && !pocketLink) {
  throw new Error("CODEX_POCKET_LINK_DISCOVERY requires a configured PocketLink TLS listener");
}
const running = await startWebServer({
  client,
  paths,
  staticDir,
  host: process.env.CODEX_WEB_HOST ?? "127.0.0.1",
  port,
  pocketLink,
});
const discovery = discoveryEnabled && running.pocketLink
  ? startPocketLinkDiscoveryAdvertisement({
      deviceName: running.deviceName,
      port: running.pocketLink.port,
      onError: () => {
        process.stderr.write("[codex-web] PocketLink LAN discovery advertisement failed\n");
      },
    })
  : undefined;

process.stderr.write(`[codex-web] Ready on http://${running.host}:${running.port}\n`);
process.stderr.write(`[codex-web] Allowed roots: ${paths.roots.join(", ")}\n`);
process.stderr.write(`[codex-web] Device ID: ${running.deviceId}\n`);
process.stderr.write(`[codex-web] Pairing code: ${running.pairingCode} (expires ${running.pairingExpiresAt})\n`);
if (running.pocketLink) {
  const advertiseHost = running.pocketLink.advertiseHost.includes(":")
    ? `[${running.pocketLink.advertiseHost}]`
    : running.pocketLink.advertiseHost;
  process.stderr.write(`[codex-web] PocketLink TLS: ${advertiseHost}:${running.pocketLink.port}\n`);
  process.stderr.write(`[codex-web] PocketLink SPKI pin: ${running.pocketLink.publicKeyPin}\n`);
  const qrSetting = process.env.CODEX_POCKET_LINK_SHOW_QR;
  if (qrSetting === "1" || (qrSetting !== "0" && process.stderr.isTTY)) {
    try {
      const bootstrap = createPocketLinkBootstrapUri({
        host: running.pocketLink.advertiseHost,
        port: running.pocketLink.port,
        serverPublicKeyPin: running.pocketLink.publicKeyPin,
        pairingCode: running.pairingCode,
        deviceId: running.deviceId,
        deviceName: running.deviceName.trim().slice(0, 60) || "Linux Companion",
        expiresAt: running.pairingExpiresAt,
      });
      const rendered = renderPocketLinkTerminalQr(bootstrap);
      process.stderr.write("[codex-web] PocketLink QR (10분 안에 Android에서 스캔):\n");
      process.stderr.write(`${rendered}\n`);
    } catch {
      process.stderr.write("[codex-web] PocketLink QR을 만들 수 없습니다. 공개 연결 필드를 확인하세요.\n");
    }
  }
}

let closing = false;
async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  discovery?.close();
  await running.close();
  await client.close();
}

process.once("SIGINT", () => void close().finally(() => process.exit(0)));
process.once("SIGTERM", () => void close().finally(() => process.exit(0)));
