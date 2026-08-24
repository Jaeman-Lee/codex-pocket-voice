import assert from "node:assert/strict";
import { once } from "node:events";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { connect as connectTls, type TLSSocket } from "node:tls";
import {
  normalizePocketRelayPeerAddress,
  startPocketRelayServer,
} from "../src/pocket-relay.js";
import { createTestCertificate } from "./helpers/tls-certificate.js";

test("Pocket relay normalizes equivalent kernel peer addresses", () => {
  assert.equal(normalizePocketRelayPeerAddress("127.0.0.1"), "127.0.0.1");
  assert.equal(normalizePocketRelayPeerAddress("::ffff:127.0.0.1"), "127.0.0.1");
  assert.equal(normalizePocketRelayPeerAddress("::ffff:7f00:1"), "127.0.0.1");
  assert.equal(
    normalizePocketRelayPeerAddress("2001:0db8:0000:0000:0000:0000:0000:0001"),
    "2001:db8::1",
  );
  assert.equal(normalizePocketRelayPeerAddress("fe80:0000:0000:0000:0000:0000:0000:0001%eth0"), "fe80::1%eth0");
  assert.equal(normalizePocketRelayPeerAddress("not-an-address"), undefined);
  assert.equal(normalizePocketRelayPeerAddress(undefined), undefined);
});

test("Pocket relay bounds concurrent and newly started connections per source address", async (t) => {
  const fixture = await createRelayFixture(t, "admission");
  let currentTime = 10_000;
  const relay = await startPocketRelayServer({
    ...fixture.serverIdentity,
    host: "127.0.0.1",
    port: 0,
    headerTimeoutMs: 10_000,
    maxConnections: 16,
    rateWindowMs: 1_000,
    maxConnectionsPerIp: 2,
    maxConnectionStartsPerIp: 3,
    maxNewSlotsPerIp: 4,
    maxTrackedPeers: 1,
    now: () => currentTime,
  });
  t.after(() => relay.close());

  const first = await openRelayTls(relay.port, fixture.certificate);
  const second = await openRelayTls(relay.port, fixture.certificate);
  t.after(() => first.destroy());
  t.after(() => second.destroy());

  await expectRelayTlsRejected(relay.port, fixture.certificate);
  const firstClosed = once(first, "close");
  first.destroy();
  await firstClosed;
  await expectRelayTlsRejected(relay.port, fixture.certificate);

  currentTime += 1_001;
  const afterWindow = await openRelayTls(relay.port, fixture.certificate);
  t.after(() => afterWindow.destroy());
  await expectRelayTlsRejected(relay.port, fixture.certificate, "127.0.0.2");

  const stats = relay.stats();
  assert.equal(stats.acceptedConnections, 3);
  assert.equal(stats.admissionRejected, 3);
  assert.equal(stats.rateLimited, 1);
  assert.equal(stats.openConnections, 2);
  assert.equal(stats.trackedPeers, 1);
  assert.equal(stats.requestRejected, 1, "an admitted socket closed without a frame is a rejected request");
});

test("Pocket relay limits new opaque slots without binding a slot to one IP", async (t) => {
  const fixture = await createRelayFixture(t, "slots");
  let currentTime = 20_000;
  const relay = await startPocketRelayServer({
    ...fixture.serverIdentity,
    host: "127.0.0.1",
    port: 0,
    headerTimeoutMs: 2_000,
    waiterTimeoutMs: 5_000,
    maxConnections: 32,
    maxSlots: 8,
    maxWaitersPerSlot: 4,
    rateWindowMs: 1_000,
    maxConnectionsPerIp: 16,
    maxConnectionStartsPerIp: 30,
    maxNewSlotsPerIp: 1,
    maxTrackedPeers: 8,
    now: () => currentTime,
  });
  t.after(() => relay.close());
  const sockets: TLSSocket[] = [];
  t.after(() => sockets.forEach((socket) => socket.destroy()));

  const slot = randomBytes(16).toString("base64url");
  const secret = randomBytes(32).toString("base64url");
  const first = await relayRequest(relay.port, fixture.certificate, "companion", slot, secret);
  sockets.push(first.socket);
  assert.equal(first.status, "waiting");

  const sameSlot = await relayRequest(relay.port, fixture.certificate, "companion", slot, secret);
  sockets.push(sameSlot.socket);
  assert.equal(sameSlot.status, "waiting", "an existing slot must not consume the new-slot budget");

  const unavailable = await relayRequest(
    relay.port,
    fixture.certificate,
    "client",
    randomBytes(16).toString("base64url"),
    secret,
  );
  sockets.push(unavailable.socket);
  assert.equal(unavailable.status, "unavailable");

  const limited = await relayRequest(
    relay.port,
    fixture.certificate,
    "companion",
    randomBytes(16).toString("base64url"),
    randomBytes(32).toString("base64url"),
  );
  sockets.push(limited.socket);
  assert.equal(limited.status, "rejected");

  const client = await relayRequest(relay.port, fixture.certificate, "client", slot, secret);
  sockets.push(client.socket);
  assert.equal(client.status, "paired");
  assert.equal(JSON.parse(await readLine(first.socket)).status, "paired");

  let stats = relay.stats();
  assert.equal(stats.slotLimited, 1);
  assert.equal(stats.pairedTunnels, 1);
  assert.equal(stats.tunnels, 1);
  assert.equal(stats.waiting, 1);

  currentTime += 1_001;
  const afterWindow = await relayRequest(
    relay.port,
    fixture.certificate,
    "companion",
    randomBytes(16).toString("base64url"),
    randomBytes(32).toString("base64url"),
  );
  sockets.push(afterWindow.socket);
  assert.equal(afterWindow.status, "waiting");
  stats = relay.stats();
  assert.equal(stats.slots, 2);
  assert.equal(stats.slotLimited, 1);
});

async function createRelayFixture(t: test.TestContext, name: string): Promise<{
  certificate: Buffer;
  serverIdentity: { certificate: Buffer; privateKey: Buffer };
}> {
  const directory = await mkdtemp(join(tmpdir(), `codex-pocket-relay-${name}-`));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await chmod(directory, 0o700);
  const identity = await createTestCertificate(directory, "localhost", `relay-${name}`);
  const [certificate, privateKey] = await Promise.all([
    readFile(identity.certificateFile),
    readFile(identity.privateKeyFile),
  ]);
  return { certificate, serverIdentity: { certificate, privateKey } };
}

async function openRelayTls(port: number, certificate: Buffer): Promise<TLSSocket> {
  const socket = connectTls({
    host: "127.0.0.1",
    port,
    servername: "localhost",
    ca: certificate,
    rejectUnauthorized: true,
  });
  await once(socket, "secureConnect");
  return socket;
}

async function expectRelayTlsRejected(port: number, certificate: Buffer, localAddress?: string): Promise<void> {
  const socket = connectTls({
    host: "127.0.0.1",
    port,
    ...(localAddress ? { localAddress } : {}),
    servername: "localhost",
    ca: certificate,
    rejectUnauthorized: true,
  });
  await new Promise<void>((resolvePromise, reject) => {
    const timeout = setTimeout(() => finish(new Error("timed out waiting for relay admission rejection")), 2_000);
    const onSecure = () => finish(new Error("relay unexpectedly completed TLS admission"));
    const onRejected = () => finish();
    socket.once("secureConnect", onSecure);
    socket.once("error", onRejected);
    socket.once("close", onRejected);

    function finish(error?: Error): void {
      clearTimeout(timeout);
      socket.off("secureConnect", onSecure);
      socket.off("error", onRejected);
      socket.off("close", onRejected);
      socket.destroy();
      if (error) reject(error);
      else resolvePromise();
    }
  });
}

async function relayRequest(
  port: number,
  certificate: Buffer,
  role: "companion" | "client",
  slot: string,
  secret: string,
): Promise<{ socket: TLSSocket; status: string }> {
  const socket = await openRelayTls(port, certificate);
  socket.write(`${JSON.stringify({ version: 1, role, slot, secret })}\n`);
  const response = JSON.parse(await readLine(socket)) as { status?: unknown };
  assert.equal(typeof response.status, "string");
  return { socket, status: response.status as string };
}

function readLine(socket: TLSSocket): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let value = "";
    const timeout = setTimeout(() => finish(new Error("timed out waiting for relay frame")), 2_000);
    const onData = (chunk: Buffer) => {
      value += chunk.toString("utf8");
      const newline = value.indexOf("\n");
      if (newline >= 0) finish(undefined, value.slice(0, newline));
    };
    const onError = (error: Error) => finish(error);
    const onClose = () => finish(new Error("relay socket closed before a complete frame"));
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
    socket.resume();

    function finish(error?: Error, line?: string): void {
      clearTimeout(timeout);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
      if (error) reject(error);
      else resolvePromise(line!);
    }
  });
}
