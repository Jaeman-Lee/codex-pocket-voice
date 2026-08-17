import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
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
  assert.equal(auth.device.kind, "linux");
  assert.equal((await stat(stateFile)).mode & 0o777, 0o600);
  const saved = await readFile(stateFile, "utf8");
  assert.doesNotMatch(saved, new RegExp(paired.token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  await auth.revoke(paired.client.id);
  assert.throws(() => auth.requireAuthorization(`Bearer ${paired.token}`), (error: unknown) => (
    error instanceof GatewayAuthError && error.code === "INVALID_TOKEN"
  ));
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
