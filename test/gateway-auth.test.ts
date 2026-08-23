import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GatewayAuth, GatewayAuthError } from "../src/gateway-auth.js";

test("gateway auth persists only token hashes and accepts a paired client", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-pocket-auth-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateFile = join(directory, "auth.json");
  const auth = await GatewayAuth.create({
    stateFile,
    deviceKind: "linux",
    deviceName: "Test Linux",
    pairingCode: "12345678",
  });

  assert.throws(() => auth.requireAuthorization(undefined), (error: unknown) => (
    error instanceof GatewayAuthError && error.code === "PAIRING_REQUIRED"
  ));
  const paired = await auth.claim("1234 5678", "Test phone");
  assert.equal(auth.requireAuthorization(`Bearer ${paired.token}`).label, "Test phone");
  assert.equal(paired.client.tlsBound, false);
  assert.equal(auth.device.kind, "linux");
  assert.equal((await stat(stateFile)).mode & 0o777, 0o600);
  const saved = await readFile(stateFile, "utf8");
  assert.doesNotMatch(saved, new RegExp(paired.token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  await auth.revoke(paired.client.id);
  assert.throws(() => auth.requireAuthorization(`Bearer ${paired.token}`), (error: unknown) => (
    error instanceof GatewayAuthError && error.code === "INVALID_TOKEN"
  ));
});

test("gateway auth binds PocketLink bearer tokens to the TLS device public key", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-pocket-auth-tls-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateFile = join(directory, "auth.json");
  const auth = await GatewayAuth.create({ stateFile, pairingCode: "11223344" });
  const firstPin = `sha256/${Buffer.alloc(32, 1).toString("base64")}`;
  const secondPin = `sha256/${Buffer.alloc(32, 2).toString("base64")}`;
  const legacy = await auth.claim("11223344", "Legacy phone");
  const paired = await auth.claim("11223344", "PocketLink phone", firstPin);

  assert.equal(paired.client.tlsBound, true);
  assert.equal(auth.requireAuthorization(`Bearer ${paired.token}`, firstPin).tlsBound, true);
  assert.equal(auth.requireAuthorization(`Bearer ${paired.token}`).tlsBound, true);
  assert.throws(() => auth.requireAuthorization(`Bearer ${legacy.token}`, firstPin), (error: unknown) => (
    error instanceof GatewayAuthError && error.code === "TLS_DEVICE_BINDING_REQUIRED"
  ));
  assert.throws(() => auth.requireAuthorization(`Bearer ${paired.token}`, secondPin), (error: unknown) => (
    error instanceof GatewayAuthError && error.code === "TLS_DEVICE_MISMATCH"
  ));
  const saved = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(saved.version, 1);
  assert.equal(saved.clients[1].tlsPublicKeyPin, firstPin);
});

test("gateway auth keeps the v1 rollback schema and does not invent a TLS binding", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-pocket-auth-v1-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateFile = join(directory, "auth.json");
  await writeFile(stateFile, JSON.stringify({
    version: 1,
    device: { id: "linux-v1", kind: "linux", name: "Legacy Linux" },
    clients: [{ id: "client-v1", label: "Legacy phone", tokenHash: "a".repeat(64), createdAt: "2026-08-23T00:00:00.000Z" }],
  }), { mode: 0o600 });
  await GatewayAuth.create({ stateFile, deviceName: "Legacy Linux" });
  const saved = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(saved.version, 1);
  assert.equal(saved.clients[0].tlsPublicKeyPin, undefined);
});

test("gateway auth rate limits incorrect pairing codes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-pocket-auth-rate-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const auth = await GatewayAuth.create({ stateFile: join(directory, "auth.json"), pairingCode: "87654321" });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await assert.rejects(auth.claim("00000000", "attacker"), (error: unknown) => (
      error instanceof GatewayAuthError && error.code === "PAIRING_CODE_INVALID"
    ));
  }
  await assert.rejects(auth.claim("87654321", "phone"), (error: unknown) => (
    error instanceof GatewayAuthError && error.code === "PAIRING_RATE_LIMITED"
  ));
});
