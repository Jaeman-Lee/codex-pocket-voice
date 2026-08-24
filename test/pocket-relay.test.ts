import assert from "node:assert/strict";
import { once } from "node:events";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createTlsServer, connect as connectTls, type Server as TlsServer } from "node:tls";
import { randomBytes, X509Certificate } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  connectPocketRelayClient,
  loadPocketRelayCompanionConfig,
  loadPocketRelayServerConfig,
  PocketRelayError,
  startPocketRelayCompanion,
  startPocketRelayServer,
} from "../src/pocket-relay.js";
import { publicKeyPin } from "../src/pocket-link.js";
import { createTestCertificate } from "./helpers/tls-certificate.js";

test("Pocket relay configuration requires private credentials and a pinned TLS endpoint", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-pocket-relay-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await chmod(directory, 0o700);
  const relayIdentity = await createTestCertificate(directory, "localhost", "relay");
  const certificate = await readFile(relayIdentity.certificateFile);
  const secretFile = join(directory, "relay-secret");
  const secret = randomBytes(32).toString("base64url");
  await writeFile(secretFile, `${secret}\n`, { mode: 0o600 });

  const companion = await loadPocketRelayCompanionConfig({
    CODEX_POCKET_RELAY_HOST: "127.0.0.1",
    CODEX_POCKET_RELAY_PORT: "9443",
    CODEX_POCKET_RELAY_SERVER_NAME: "localhost",
    CODEX_POCKET_RELAY_SERVER_PIN: publicKeyPin(new X509Certificate(certificate)),
    CODEX_POCKET_RELAY_CA_FILE: relayIdentity.certificateFile,
    CODEX_POCKET_RELAY_SLOT: randomBytes(16).toString("base64url"),
    CODEX_POCKET_RELAY_SECRET_FILE: secretFile,
    CODEX_POCKET_RELAY_POOL: "3",
  });
  assert.equal(companion?.secret, secret);
  assert.equal(companion?.standbyConnections, 3);
  assert.deepEqual(companion?.certificateAuthority, certificate);
  const defaultPool = await loadPocketRelayCompanionConfig({
    CODEX_POCKET_RELAY_HOST: "127.0.0.1",
    CODEX_POCKET_RELAY_PORT: "9443",
    CODEX_POCKET_RELAY_SERVER_NAME: "localhost",
    CODEX_POCKET_RELAY_SERVER_PIN: publicKeyPin(new X509Certificate(certificate)),
    CODEX_POCKET_RELAY_CA_FILE: relayIdentity.certificateFile,
    CODEX_POCKET_RELAY_SLOT: randomBytes(16).toString("base64url"),
    CODEX_POCKET_RELAY_SECRET_FILE: secretFile,
  });
  assert.equal(defaultPool?.standbyConnections, 4);
  assert.throws(() => startPocketRelayCompanion({
    relay: companion!,
    targetHost: "0.0.0.0",
    targetPort: 8789,
  }), /target is invalid/);

  const server = await loadPocketRelayServerConfig({
    CODEX_POCKET_RELAY_LISTEN_HOST: "127.0.0.1",
    CODEX_POCKET_RELAY_LISTEN_PORT: "9443",
    CODEX_POCKET_RELAY_CERT_FILE: relayIdentity.certificateFile,
    CODEX_POCKET_RELAY_KEY_FILE: relayIdentity.privateKeyFile,
    CODEX_POCKET_RELAY_RATE_WINDOW_MS: "30000",
    CODEX_POCKET_RELAY_MAX_CONNECTIONS_PER_IP: "12",
    CODEX_POCKET_RELAY_MAX_CONNECTION_STARTS_PER_IP: "40",
    CODEX_POCKET_RELAY_MAX_NEW_SLOTS_PER_IP: "6",
    CODEX_POCKET_RELAY_MAX_TRACKED_PEERS: "512",
  });
  assert.equal(server.host, "127.0.0.1");
  assert.equal(server.port, 9443);
  assert.equal(server.rateWindowMs, 30_000);
  assert.equal(server.maxConnectionsPerIp, 12);
  assert.equal(server.maxConnectionStartsPerIp, 40);
  assert.equal(server.maxNewSlotsPerIp, 6);
  assert.equal(server.maxTrackedPeers, 512);

  await assert.rejects(loadPocketRelayServerConfig({
    CODEX_POCKET_RELAY_LISTEN_HOST: "127.0.0.1",
    CODEX_POCKET_RELAY_CERT_FILE: relayIdentity.certificateFile,
    CODEX_POCKET_RELAY_KEY_FILE: relayIdentity.privateKeyFile,
    CODEX_POCKET_RELAY_RATE_WINDOW_MS: "999",
  }), /RATE_WINDOW_MS is invalid/);

  await chmod(relayIdentity.privateKeyFile, 0o644);
  await assert.rejects(loadPocketRelayServerConfig({
    CODEX_POCKET_RELAY_LISTEN_HOST: "127.0.0.1",
    CODEX_POCKET_RELAY_CERT_FILE: relayIdentity.certificateFile,
    CODEX_POCKET_RELAY_KEY_FILE: relayIdentity.privateKeyFile,
  }), /permissions must be 0600/);
  await chmod(secretFile, 0o644);
  await assert.rejects(loadPocketRelayCompanionConfig({
    CODEX_POCKET_RELAY_HOST: "127.0.0.1",
    CODEX_POCKET_RELAY_SERVER_PIN: publicKeyPin(new X509Certificate(certificate)),
    CODEX_POCKET_RELAY_SLOT: randomBytes(16).toString("base64url"),
    CODEX_POCKET_RELAY_SECRET_FILE: secretFile,
  }), /permissions must be 0600/);
  await assert.rejects(
    loadPocketRelayCompanionConfig({ CODEX_POCKET_RELAY_HOST: "relay.example" }),
    /SERVER_PIN is invalid/,
  );
});

test("Pocket relay pairs only the matching opaque slot and carries nested end-to-end mTLS", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-pocket-relay-e2e-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await chmod(directory, 0o700);
  const relayIdentity = await createTestCertificate(directory, "localhost", "relay");
  const companionIdentity = await createTestCertificate(directory, "localhost", "companion");
  const phoneIdentity = await createTestCertificate(directory, "phone.test", "phone");
  const [
    relayCertificate,
    relayPrivateKey,
    companionCertificate,
    companionPrivateKey,
    phoneCertificate,
    phonePrivateKey,
  ] = await Promise.all([
    readFile(relayIdentity.certificateFile),
    readFile(relayIdentity.privateKeyFile),
    readFile(companionIdentity.certificateFile),
    readFile(companionIdentity.privateKeyFile),
    readFile(phoneIdentity.certificateFile),
    readFile(phoneIdentity.privateKeyFile),
  ]);
  const expectedPhonePin = publicKeyPin(new X509Certificate(phoneCertificate));
  const target = createTlsServer({
    cert: companionCertificate,
    key: companionPrivateKey,
    minVersion: "TLSv1.2",
    maxVersion: "TLSv1.3",
    requestCert: true,
    rejectUnauthorized: false,
  }, (socket) => {
    const peer = socket.getPeerX509Certificate();
    if (!peer || publicKeyPin(peer) !== expectedPhonePin) {
      socket.destroy(new Error("phone mTLS identity did not reach the Companion"));
      return;
    }
    socket.once("data", (data) => socket.write(Buffer.concat([Buffer.from("companion:"), data])));
  });
  const targetPort = await listen(target);
  t.after(() => closeTlsServer(target));

  const relay = await startPocketRelayServer({
    host: "127.0.0.1",
    port: 0,
    certificate: relayCertificate,
    privateKey: relayPrivateKey,
    headerTimeoutMs: 2_000,
    waiterTimeoutMs: 5_000,
    tunnelIdleTimeoutMs: 5_000,
    tunnelLifetimeMs: 60_000,
    maxConnections: 16,
    maxSlots: 4,
    maxWaitersPerSlot: 2,
  });
  t.after(() => relay.close());
  await assert.rejects(startPocketRelayServer({
    host: "127.0.0.1",
    port: 0,
    certificate: relayCertificate,
    privateKey: relayPrivateKey,
    maxConnections: 0,
  }), /maxConnections is invalid/);

  const oversized = connectTls({
    host: "127.0.0.1",
    port: relay.port,
    servername: "localhost",
    ca: relayCertificate,
    rejectUnauthorized: true,
  });
  await once(oversized, "secureConnect");
  oversized.write(`${"x".repeat(2_100)}\n`);
  const [oversizedResponse] = await once(oversized, "data") as [Buffer];
  assert.match(oversizedResponse.toString("utf8"), /"status":"rejected"/);
  oversized.destroy();

  const slot = randomBytes(16).toString("base64url");
  const secret = randomBytes(32).toString("base64url");
  const relayClient = {
    host: "127.0.0.1",
    port: relay.port,
    serverName: "localhost",
    serverPublicKeyPin: publicKeyPin(new X509Certificate(relayCertificate)),
    certificateAuthority: relayCertificate,
    slot,
    secret,
  };
  const connector = startPocketRelayCompanion({
    relay: { ...relayClient, standbyConnections: 2 },
    targetHost: "127.0.0.1",
    targetPort,
    reconnectMinimumMs: 50,
    reconnectMaximumMs: 200,
  });
  t.after(() => connector.close());
  await connector.waitUntilReady(2, 5_000);
  const readyStats = relay.stats();
  assert.equal(readyStats.slots, 1);
  assert.equal(readyStats.waiting, 2);
  assert.equal(readyStats.tunnels, 0);
  assert.equal(readyStats.trackedPeers, 1);
  assert.equal(readyStats.slotLimited, 0);

  await assert.rejects(
    connectPocketRelayClient({ ...relayClient, serverName: "wrong-host.test" }),
    (error: unknown) => error instanceof PocketRelayError && error.code === "RELAY_UNAVAILABLE",
  );
  await assert.rejects(
    connectPocketRelayClient({
      ...relayClient,
      serverPublicKeyPin: publicKeyPin(new X509Certificate(companionCertificate)),
    }),
    (error: unknown) => error instanceof PocketRelayError && error.code === "RELAY_UNAVAILABLE",
  );
  await assert.rejects(
    connectPocketRelayClient({ ...relayClient, secret: randomBytes(32).toString("base64url") }),
    (error: unknown) => error instanceof PocketRelayError && error.code === "RELAY_UNAVAILABLE",
  );
  assert.equal(relay.stats().waiting, 2, "a rejected attach must not consume a Companion waiter");

  const outer = await connectPocketRelayClient(relayClient);
  const endToEnd = connectTls({
    socket: outer,
    servername: "localhost",
    ca: companionCertificate,
    cert: phoneCertificate,
    key: phonePrivateKey,
    rejectUnauthorized: true,
    minVersion: "TLSv1.2",
    maxVersion: "TLSv1.3",
  });
  await once(endToEnd, "secureConnect");
  endToEnd.write("opaque-through-relay");
  const [response] = await once(endToEnd, "data") as [Buffer];
  assert.equal(response.toString("utf8"), "companion:opaque-through-relay");
  assert.equal(relay.stats().tunnels, 1);
  endToEnd.destroy();
});

async function listen(server: TlsServer): Promise<number> {
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolvePromise();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test TLS server did not get a port");
  return address.port;
}

async function closeTlsServer(server: TlsServer): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolvePromise, reject) => {
    server.close((error) => error ? reject(error) : resolvePromise());
  });
}
