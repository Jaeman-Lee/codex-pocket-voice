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

test("gateway auth rotates a PocketLink TLS device key only after the new key proves possession", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-pocket-auth-tls-rotation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateFile = join(directory, "auth.json");
  const firstPin = `sha256/${Buffer.alloc(32, 3).toString("base64")}`;
  const secondPin = `sha256/${Buffer.alloc(32, 4).toString("base64")}`;
  const auth = await GatewayAuth.create({ stateFile, pairingCode: "33445566" });
  const paired = await auth.claim("33445566", "Rotating phone", firstPin);
  const authorization = `Bearer ${paired.token}`;

  await assert.rejects(
    auth.startTlsKeyRotation(paired.client.id, undefined),
    (error: unknown) => error instanceof GatewayAuthError && error.code === "TLS_DEVICE_PROOF_REQUIRED",
  );
  const started = await auth.startTlsKeyRotation(paired.client.id, firstPin);
  assert.match(started.rotationToken, /^[A-Za-z0-9_-]{43}$/);
  await assert.rejects(
    auth.startTlsKeyRotation(paired.client.id, firstPin),
    (error: unknown) => error instanceof GatewayAuthError && error.code === "TLS_KEY_ROTATION_ALREADY_PENDING",
  );
  assert.equal((await auth.inspectTlsKeyRotation(authorization, started.rotationToken, secondPin)).status, "pending");
  await assert.rejects(
    auth.inspectTlsKeyRotation(authorization, started.rotationToken, firstPin),
    (error: unknown) => error instanceof GatewayAuthError && error.code === "TLS_KEY_ROTATION_STATE_MISMATCH",
  );
  assert.throws(
    () => auth.requireAuthorization(authorization, secondPin),
    (error: unknown) => error instanceof GatewayAuthError && error.code === "TLS_DEVICE_MISMATCH",
  );

  const completed = await auth.completeTlsKeyRotation(authorization, started.rotationToken, secondPin);
  assert.equal(completed.status, "completed");
  assert.equal(completed.previousKeyRetired, true);
  assert.equal(auth.requireAuthorization(authorization, secondPin).tlsBound, true);
  assert.throws(
    () => auth.requireAuthorization(authorization, firstPin),
    (error: unknown) => error instanceof GatewayAuthError && error.code === "TLS_DEVICE_MISMATCH",
  );

  const savedBeforeFinalize = await readFile(stateFile, "utf8");
  assert.doesNotMatch(savedBeforeFinalize, new RegExp(started.rotationToken));
  assert.equal(JSON.parse(savedBeforeFinalize).version, 1);
  const restored = await GatewayAuth.create({ stateFile, pairingCode: "77889900" });
  assert.equal((await restored.inspectTlsKeyRotation(authorization, started.rotationToken, secondPin)).status, "completed");
  assert.equal((await restored.completeTlsKeyRotation(authorization, started.rotationToken, secondPin)).status, "completed");
  assert.equal((await restored.finalizeTlsKeyRotation(authorization, started.rotationToken, secondPin)).finalized, true);
  const savedAfterFinalize = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(savedAfterFinalize.clients[0].tlsPublicKeyPin, secondPin);
  assert.equal(savedAfterFinalize.clients[0].tlsKeyRotation, undefined);
});

test("gateway auth can abort or expire an uncompleted PocketLink key rotation without changing the old binding", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-pocket-auth-tls-rotation-abort-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let now = Date.parse("2026-08-24T00:00:00.000Z");
  const auth = await GatewayAuth.create({
    stateFile: join(directory, "auth.json"),
    pairingCode: "55667788",
    now: () => now,
  });
  const firstPin = `sha256/${Buffer.alloc(32, 5).toString("base64")}`;
  const secondPin = `sha256/${Buffer.alloc(32, 6).toString("base64")}`;
  const paired = await auth.claim("55667788", "Abort phone", firstPin);
  const authorization = `Bearer ${paired.token}`;

  const firstAttempt = await auth.startTlsKeyRotation(paired.client.id, firstPin);
  const aborted = await auth.abortTlsKeyRotation(authorization, firstAttempt.rotationToken, secondPin);
  assert.equal(aborted.retainedPreviousKey, true);
  assert.equal(auth.requireAuthorization(authorization, firstPin).tlsBound, true);

  const secondAttempt = await auth.startTlsKeyRotation(paired.client.id, firstPin);
  now += 5 * 60_000 + 1;
  await assert.rejects(
    auth.inspectTlsKeyRotation(authorization, secondAttempt.rotationToken, secondPin),
    (error: unknown) => error instanceof GatewayAuthError && error.code === "TLS_KEY_ROTATION_EXPIRED",
  );
  assert.equal(auth.requireAuthorization(authorization, firstPin).tlsBound, true);
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

test("gateway auth persists concurrent pairings in call order without exposing uncommitted clients", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-pocket-auth-serialization-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateFile = join(directory, "auth.json");
  const auth = await GatewayAuth.create({ stateFile, pairingCode: "12121212" });
  let activeWrites = 0;
  let maximumActiveWrites = 0;
  let writes = 0;
  let releaseFirstWrite!: () => void;
  const firstWriteReleased = new Promise<void>((resolve) => {
    releaseFirstWrite = resolve;
  });
  let markFirstWriteStarted!: () => void;
  const firstWriteStarted = new Promise<void>((resolve) => {
    markFirstWriteStarted = resolve;
  });
  overrideGatewayPersistence(auth, async (state) => {
    writes += 1;
    activeWrites += 1;
    maximumActiveWrites = Math.max(maximumActiveWrites, activeWrites);
    try {
      if (writes === 1) {
        markFirstWriteStarted();
        await firstWriteReleased;
      }
      await writeFile(stateFile, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    } finally {
      activeWrites -= 1;
    }
  });

  const firstClaim = auth.claim("12121212", "First phone");
  await firstWriteStarted;
  const secondClaim = auth.claim("12121212", "Second phone");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(auth.pairedClientCount, 0);
  assert.equal(writes, 1);
  assert.equal(maximumActiveWrites, 1);

  releaseFirstWrite();
  const [first, second] = await Promise.all([firstClaim, secondClaim]);
  assert.equal(auth.pairedClientCount, 2);
  assert.equal(writes, 2);
  assert.equal(maximumActiveWrites, 1);

  const restored = await GatewayAuth.create({ stateFile, pairingCode: "34343434" });
  assert.equal(restored.requireAuthorization(`Bearer ${first.token}`).label, "First phone");
  assert.equal(restored.requireAuthorization(`Bearer ${second.token}`).label, "Second phone");
});

test("only one concurrent TLS key rotation can become durable", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-pocket-auth-rotation-serialization-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateFile = join(directory, "auth.json");
  const firstPin = `sha256/${Buffer.alloc(32, 10).toString("base64")}`;
  const nextPin = `sha256/${Buffer.alloc(32, 11).toString("base64")}`;
  const auth = await GatewayAuth.create({ stateFile, pairingCode: "56565656" });
  const paired = await auth.claim("56565656", "Rotating phone", firstPin);
  let writes = 0;
  let activeWrites = 0;
  let maximumActiveWrites = 0;
  let releaseFirstWrite!: () => void;
  const firstWriteReleased = new Promise<void>((resolve) => {
    releaseFirstWrite = resolve;
  });
  let markFirstWriteStarted!: () => void;
  const firstWriteStarted = new Promise<void>((resolve) => {
    markFirstWriteStarted = resolve;
  });
  overrideGatewayPersistence(auth, async (state) => {
    writes += 1;
    activeWrites += 1;
    maximumActiveWrites = Math.max(maximumActiveWrites, activeWrites);
    try {
      if (writes === 1) {
        markFirstWriteStarted();
        await firstWriteReleased;
      }
      await writeFile(stateFile, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    } finally {
      activeWrites -= 1;
    }
  });

  const firstRotation = auth.startTlsKeyRotation(paired.client.id, firstPin);
  await firstWriteStarted;
  const competingRotation = auth.startTlsKeyRotation(paired.client.id, firstPin);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(writes, 1);
  assert.equal(maximumActiveWrites, 1);
  releaseFirstWrite();

  const started = await firstRotation;
  await assert.rejects(competingRotation, (error: unknown) => (
    error instanceof GatewayAuthError && error.code === "TLS_KEY_ROTATION_ALREADY_PENDING"
  ));
  assert.equal(writes, 1);
  assert.equal(maximumActiveWrites, 1);

  const restored = await GatewayAuth.create({ stateFile, pairingCode: "78787878" });
  assert.equal((await restored.inspectTlsKeyRotation(
    `Bearer ${paired.token}`,
    started.rotationToken,
    nextPin,
  )).status, "pending");
});

test("failed gateway auth persistence never changes live pairing or TLS authority", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-pocket-auth-persistence-failure-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const firstPin = `sha256/${Buffer.alloc(32, 12).toString("base64")}`;
  const nextPin = `sha256/${Buffer.alloc(32, 13).toString("base64")}`;
  const auth = await GatewayAuth.create({
    stateFile: join(directory, "auth.json"),
    pairingCode: "90909090",
  });
  let failNextWrite = false;
  overrideGatewayPersistence(auth, async () => {
    if (failNextWrite) {
      failNextWrite = false;
      throw new Error("synthetic auth persistence failure");
    }
  });

  failNextWrite = true;
  await assert.rejects(auth.claim("90909090", "Ghost phone"), /synthetic auth persistence failure/);
  assert.equal(auth.pairedClientCount, 0);

  const legacy = await auth.claim("90909090", "Retained phone");
  failNextWrite = true;
  await assert.rejects(auth.revoke(legacy.client.id), /synthetic auth persistence failure/);
  assert.equal(auth.requireAuthorization(`Bearer ${legacy.token}`).label, "Retained phone");
  await auth.revoke(legacy.client.id);
  assert.throws(() => auth.requireAuthorization(`Bearer ${legacy.token}`), (error: unknown) => (
    error instanceof GatewayAuthError && error.code === "INVALID_TOKEN"
  ));

  const pocketLink = await auth.claim("90909090", "PocketLink phone", firstPin);
  failNextWrite = true;
  await assert.rejects(
    auth.startTlsKeyRotation(pocketLink.client.id, firstPin),
    /synthetic auth persistence failure/,
  );
  assert.equal(auth.requireAuthorization(`Bearer ${pocketLink.token}`, firstPin).tlsBound, true);

  const started = await auth.startTlsKeyRotation(pocketLink.client.id, firstPin);
  failNextWrite = true;
  await assert.rejects(
    auth.completeTlsKeyRotation(`Bearer ${pocketLink.token}`, started.rotationToken, nextPin),
    /synthetic auth persistence failure/,
  );
  assert.equal(auth.requireAuthorization(`Bearer ${pocketLink.token}`, firstPin).tlsBound, true);
  assert.throws(
    () => auth.requireAuthorization(`Bearer ${pocketLink.token}`, nextPin),
    (error: unknown) => error instanceof GatewayAuthError && error.code === "TLS_DEVICE_MISMATCH",
  );

  await auth.completeTlsKeyRotation(`Bearer ${pocketLink.token}`, started.rotationToken, nextPin);
  failNextWrite = true;
  await assert.rejects(
    auth.finalizeTlsKeyRotation(`Bearer ${pocketLink.token}`, started.rotationToken, nextPin),
    /synthetic auth persistence failure/,
  );
  assert.equal((await auth.inspectTlsKeyRotation(
    `Bearer ${pocketLink.token}`,
    started.rotationToken,
    nextPin,
  )).status, "completed");
  assert.equal((await auth.finalizeTlsKeyRotation(
    `Bearer ${pocketLink.token}`,
    started.rotationToken,
    nextPin,
  )).finalized, true);
});

function overrideGatewayPersistence(
  auth: GatewayAuth,
  persist: (state: unknown) => Promise<void>,
): void {
  (auth as unknown as { persist: (state: unknown) => Promise<void> }).persist = persist;
}
