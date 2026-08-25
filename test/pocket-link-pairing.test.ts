import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluatePocketLinkBootstrap,
  matchesPocketLinkConnection,
  type PendingPocketLinkBootstrap,
} from "../client/src/pocket-link-pairing.js";

const now = Date.parse("2026-08-24T00:00:00.000Z");
const bootstrap: PendingPocketLinkBootstrap = {
  version: 1,
  host: "companion.lan",
  port: 8789,
  serverPublicKeyPin: `sha256/${Buffer.alloc(32, 3).toString("base64")}`,
  pairingCode: "12345678",
  deviceId: "remote-device-1234",
  deviceName: "작업실 PC",
  expiresAt: new Date(now + 10 * 60_000).toISOString(),
};

test("PocketLink QR review is invalidated when a security connection field is edited", () => {
  assert.equal(matchesPocketLinkConnection(bootstrap, bootstrap.host, bootstrap.port, bootstrap.serverPublicKeyPin), true);
  assert.equal(matchesPocketLinkConnection(bootstrap, "other.lan", bootstrap.port, bootstrap.serverPublicKeyPin), false);
  assert.equal(matchesPocketLinkConnection(bootstrap, bootstrap.host, 8790, bootstrap.serverPublicKeyPin), false);
  assert.equal(matchesPocketLinkConnection(bootstrap, bootstrap.host, bootstrap.port, "sha256/changed"), false);
});

test("PocketLink QR code is released only to its selected target and matching live Companion", () => {
  assert.deepEqual(evaluatePocketLinkBootstrap(bootstrap, "target-a", bootstrap.deviceId, now), { kind: "wait" });
  const assigned = { ...bootstrap, targetId: "target-a" };
  assert.deepEqual(evaluatePocketLinkBootstrap(assigned, "target-b", bootstrap.deviceId, now), { kind: "wait" });
  assert.deepEqual(evaluatePocketLinkBootstrap(assigned, "target-a", "other-device", now), { kind: "device_mismatch" });
  assert.deepEqual(evaluatePocketLinkBootstrap(assigned, "target-a", bootstrap.deviceId, now + 10 * 60_000), { kind: "expired" });
  assert.deepEqual(evaluatePocketLinkBootstrap(assigned, "target-a", bootstrap.deviceId, now), {
    kind: "ready",
    pairingCode: "12345678",
  });
});
