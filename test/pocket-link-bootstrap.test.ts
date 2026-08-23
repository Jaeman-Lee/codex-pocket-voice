import assert from "node:assert/strict";
import test from "node:test";
import {
  createPocketLinkBootstrapUri,
  parsePocketLinkBootstrapUri,
} from "../src/pocket-link-bootstrap.js";
import { renderPocketLinkTerminalQr } from "../src/pocket-link-terminal-qr.js";

const now = Date.parse("2026-08-24T00:00:00.000Z");
const pin = `sha256/${Buffer.alloc(32, 7).toString("base64")}`;

test("PocketLink QR bootstrap round-trips only bounded public connection data and an expiring code", () => {
  const uri = createPocketLinkBootstrapUri({
    host: "companion.lan",
    port: 8789,
    serverPublicKeyPin: pin,
    pairingCode: "12345678",
    deviceId: "12345678-abcd-4abc-8abc-1234567890ab",
    deviceName: "작업실 PC",
    expiresAt: new Date(now + 10 * 60_000).toISOString(),
  });
  assert.equal(uri.startsWith("codex-pocket://pair?"), true);
  assert.doesNotMatch(uri, /Provider|API[_-]?KEY|workspace/i);
  assert.deepEqual(parsePocketLinkBootstrapUri(uri, now), {
    version: 1,
    host: "companion.lan",
    port: 8789,
    serverPublicKeyPin: pin,
    pairingCode: "12345678",
    deviceId: "12345678-abcd-4abc-8abc-1234567890ab",
    deviceName: "작업실 PC",
    expiresAt: new Date(now + 10 * 60_000).toISOString(),
  });

  const rendered = renderPocketLinkTerminalQr(uri);
  assert.ok(rendered.length > 100);
  assert.match(rendered, /\u001b\[(?:37;40|40|47)m/);
  assert.doesNotMatch(rendered, /12345678|companion\.lan/);
});

test("PocketLink QR parser rejects replay, field smuggling, wildcard hosts and malformed pins", () => {
  const valid = createPocketLinkBootstrapUri({
    host: "2001:db8::7",
    port: 8789,
    serverPublicKeyPin: pin,
    pairingCode: "87654321",
    deviceId: "device-id-1234",
    deviceName: "IPv6 PC",
    expiresAt: new Date(now + 10 * 60_000).toISOString(),
  });
  assert.equal(parsePocketLinkBootstrapUri(valid, now).host, "2001:db8::7");
  assert.throws(() => parsePocketLinkBootstrapUri(valid, now + 10 * 60_000), /만료/);
  assert.throws(() => parsePocketLinkBootstrapUri(`${valid}&c=00000000`, now), /필드/);
  assert.throws(() => parsePocketLinkBootstrapUri(`${valid}&unexpected=value`, now), /필드/);
  assert.throws(() => parsePocketLinkBootstrapUri(valid.replace("2001%3Adb8%3A%3A7", "0.0.0.0"), now), /host/);
  assert.throws(() => parsePocketLinkBootstrapUri(valid.replace(encodeURIComponent(pin), "sha256%2Fbad"), now), /pin/);
});
