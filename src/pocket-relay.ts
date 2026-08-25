import {
  constants as cryptoConstants,
  createHash,
  timingSafeEqual,
  X509Certificate,
} from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isIP, connect as connectTcp, type Socket } from "node:net";
import { dirname, resolve } from "node:path";
import {
  checkServerIdentity,
  connect as connectTls,
  createServer as createTlsServer,
  type Server as TlsServer,
  type TLSSocket,
} from "node:tls";
import { publicKeyPin } from "./pocket-link.js";

const RELAY_PROTOCOL_VERSION = 1;
const DEFAULT_RELAY_PORT = 9443;
const DEFAULT_POOL_SIZE = 4;
const MAX_RELAY_FRAME_BYTES = 2_048;
const MAX_SECRET_FILE_BYTES = 512;
const MAX_TLS_FILE_BYTES = 64 * 1_024;
const DEFAULT_TLS_HANDSHAKE_TIMEOUT_MS = 10_000;
const DEFAULT_HEADER_TIMEOUT_MS = 10_000;
const DEFAULT_WAIT_TIMEOUT_MS = 60_000;
const DEFAULT_IDLE_TIMEOUT_MS = 120_000;
const DEFAULT_TUNNEL_LIFETIME_MS = 24 * 60 * 60_000;
const DEFAULT_MAX_CONNECTIONS = 256;
const DEFAULT_MAX_SLOTS = 64;
const DEFAULT_MAX_WAITERS_PER_SLOT = 4;
const DEFAULT_RATE_WINDOW_MS = 60_000;
const DEFAULT_MAX_CONNECTIONS_PER_IP = 16;
const DEFAULT_MAX_CONNECTION_STARTS_PER_IP = 60;
const DEFAULT_MAX_NEW_SLOTS_PER_IP = 8;
const DEFAULT_MAX_TRACKED_PEERS = 1_024;

export interface PocketRelayClientConfig {
  host: string;
  port: number;
  serverName: string;
  serverPublicKeyPin: string;
  certificateAuthority?: Buffer;
  slot: string;
  secret: string;
}

export interface PocketRelayCompanionConfig extends PocketRelayClientConfig {
  standbyConnections: number;
}

export interface PocketRelayServerConfig {
  host: string;
  port: number;
  certificate: Buffer;
  privateKey: Buffer;
  tlsHandshakeTimeoutMs?: number;
  headerTimeoutMs?: number;
  waiterTimeoutMs?: number;
  tunnelIdleTimeoutMs?: number;
  tunnelLifetimeMs?: number;
  maxConnections?: number;
  maxSlots?: number;
  maxWaitersPerSlot?: number;
  rateWindowMs?: number;
  maxConnectionsPerIp?: number;
  maxConnectionStartsPerIp?: number;
  maxNewSlotsPerIp?: number;
  maxTrackedPeers?: number;
  now?: () => number;
}

export interface PocketRelayCompanionOptions {
  relay: PocketRelayCompanionConfig;
  targetHost: string;
  targetPort: number;
  reconnectMinimumMs?: number;
  reconnectMaximumMs?: number;
}

export interface PocketRelayServer {
  host: string;
  port: number;
  stats(): PocketRelayServerStats;
  close(): Promise<void>;
}

export interface PocketRelayServerStats {
  slots: number;
  waiting: number;
  tunnels: number;
  openConnections: number;
  trackedPeers: number;
  acceptedConnections: number;
  admissionRejected: number;
  requestRejected: number;
  rateLimited: number;
  slotLimited: number;
  pairedTunnels: number;
}

export interface PocketRelayCompanion {
  waitUntilReady(minimum?: number, timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

export class PocketRelayError extends Error {
  constructor(readonly code: "CONFIG_INVALID" | "RELAY_UNAVAILABLE" | "PROTOCOL_ERROR", message: string) {
    super(message);
  }
}

interface RelayRequest {
  version: 1;
  role: "companion" | "client";
  slot: string;
  secret: string;
}

interface RelayResponse {
  version: 1;
  status: "waiting" | "paired" | "unavailable" | "rejected";
}

interface RelayWaiter {
  socket: TLSSocket;
  timer: NodeJS.Timeout;
  onClose: () => void;
}

interface RelaySlot {
  secretHash: Buffer;
  waiters: Set<RelayWaiter>;
  activeTunnels: number;
}

interface RelayPeerState {
  openConnections: number;
  windowStartedAt: number;
  connectionStarts: number;
  newSlots: number;
  lastSeenAt: number;
}

interface RelayCounters {
  acceptedConnections: number;
  admissionRejected: number;
  requestRejected: number;
  rateLimited: number;
  slotLimited: number;
  pairedTunnels: number;
}

interface ReadyWaiter {
  check(): void;
  reject(error: Error): void;
}

export async function loadPocketRelayCompanionConfig(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<PocketRelayCompanionConfig | undefined> {
  const values = [
    environment.CODEX_POCKET_RELAY_HOST,
    environment.CODEX_POCKET_RELAY_PORT,
    environment.CODEX_POCKET_RELAY_SERVER_NAME,
    environment.CODEX_POCKET_RELAY_SERVER_PIN,
    environment.CODEX_POCKET_RELAY_CA_FILE,
    environment.CODEX_POCKET_RELAY_SLOT,
    environment.CODEX_POCKET_RELAY_SECRET_FILE,
    environment.CODEX_POCKET_RELAY_POOL,
  ];
  if (values.every((value) => !value)) return undefined;

  const host = requiredHost(environment.CODEX_POCKET_RELAY_HOST, "CODEX_POCKET_RELAY_HOST");
  const serverName = requiredHost(
    environment.CODEX_POCKET_RELAY_SERVER_NAME ?? host,
    "CODEX_POCKET_RELAY_SERVER_NAME",
  );
  const port = optionalPort(environment.CODEX_POCKET_RELAY_PORT, "CODEX_POCKET_RELAY_PORT");
  const serverPublicKeyPin = requiredPin(
    environment.CODEX_POCKET_RELAY_SERVER_PIN,
    "CODEX_POCKET_RELAY_SERVER_PIN",
  );
  const slot = requiredSlot(environment.CODEX_POCKET_RELAY_SLOT);
  const secretFile = requiredPath(
    environment.CODEX_POCKET_RELAY_SECRET_FILE,
    "CODEX_POCKET_RELAY_SECRET_FILE",
  );
  const secret = (await readPrivateFile(resolve(secretFile), "Pocket relay secret", MAX_SECRET_FILE_BYTES))
    .toString("utf8")
    .trim();
  assertRelaySecret(secret);
  const certificateAuthority = environment.CODEX_POCKET_RELAY_CA_FILE
    ? await readPublicFile(resolve(environment.CODEX_POCKET_RELAY_CA_FILE), "Pocket relay CA", MAX_TLS_FILE_BYTES)
    : undefined;
  const standbyConnections = optionalBoundedInteger(
    environment.CODEX_POCKET_RELAY_POOL,
    "CODEX_POCKET_RELAY_POOL",
    DEFAULT_POOL_SIZE,
    1,
    DEFAULT_MAX_WAITERS_PER_SLOT,
  );
  return {
    host,
    port,
    serverName,
    serverPublicKeyPin,
    certificateAuthority,
    slot,
    secret,
    standbyConnections,
  };
}

export async function loadPocketRelayServerConfig(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<PocketRelayServerConfig> {
  const host = requiredHost(
    environment.CODEX_POCKET_RELAY_LISTEN_HOST,
    "CODEX_POCKET_RELAY_LISTEN_HOST",
    true,
  );
  const port = optionalPort(environment.CODEX_POCKET_RELAY_LISTEN_PORT, "CODEX_POCKET_RELAY_LISTEN_PORT");
  const certificateFile = resolve(requiredPath(
    environment.CODEX_POCKET_RELAY_CERT_FILE,
    "CODEX_POCKET_RELAY_CERT_FILE",
  ));
  const privateKeyFile = resolve(requiredPath(
    environment.CODEX_POCKET_RELAY_KEY_FILE,
    "CODEX_POCKET_RELAY_KEY_FILE",
  ));
  if (certificateFile === privateKeyFile) {
    throw configError("Pocket relay certificate and private key must use different files");
  }
  const [certificate, privateKey] = await Promise.all([
    readPublicFile(certificateFile, "Pocket relay certificate", MAX_TLS_FILE_BYTES),
    readPrivateFile(privateKeyFile, "Pocket relay private key", MAX_TLS_FILE_BYTES),
  ]);
  try {
    const parsed = new X509Certificate(certificate);
    if (Date.now() < Date.parse(parsed.validFrom) || Date.now() > Date.parse(parsed.validTo)) {
      throw new Error("certificate is not currently valid");
    }
  } catch {
    throw configError("Pocket relay certificate is invalid or expired");
  }
  return {
    host,
    port,
    certificate,
    privateKey,
    tlsHandshakeTimeoutMs: optionalBoundedInteger(
      environment.CODEX_POCKET_RELAY_TLS_HANDSHAKE_TIMEOUT_MS,
      "CODEX_POCKET_RELAY_TLS_HANDSHAKE_TIMEOUT_MS",
      DEFAULT_TLS_HANDSHAKE_TIMEOUT_MS,
      1_000,
      60_000,
    ),
    rateWindowMs: optionalBoundedInteger(
      environment.CODEX_POCKET_RELAY_RATE_WINDOW_MS,
      "CODEX_POCKET_RELAY_RATE_WINDOW_MS",
      DEFAULT_RATE_WINDOW_MS,
      1_000,
      10 * 60_000,
    ),
    maxConnectionsPerIp: optionalBoundedInteger(
      environment.CODEX_POCKET_RELAY_MAX_CONNECTIONS_PER_IP,
      "CODEX_POCKET_RELAY_MAX_CONNECTIONS_PER_IP",
      DEFAULT_MAX_CONNECTIONS_PER_IP,
      1,
      DEFAULT_MAX_CONNECTIONS,
    ),
    maxConnectionStartsPerIp: optionalBoundedInteger(
      environment.CODEX_POCKET_RELAY_MAX_CONNECTION_STARTS_PER_IP,
      "CODEX_POCKET_RELAY_MAX_CONNECTION_STARTS_PER_IP",
      DEFAULT_MAX_CONNECTION_STARTS_PER_IP,
      1,
      10_000,
    ),
    maxNewSlotsPerIp: optionalBoundedInteger(
      environment.CODEX_POCKET_RELAY_MAX_NEW_SLOTS_PER_IP,
      "CODEX_POCKET_RELAY_MAX_NEW_SLOTS_PER_IP",
      DEFAULT_MAX_NEW_SLOTS_PER_IP,
      1,
      DEFAULT_MAX_SLOTS,
    ),
    maxTrackedPeers: optionalBoundedInteger(
      environment.CODEX_POCKET_RELAY_MAX_TRACKED_PEERS,
      "CODEX_POCKET_RELAY_MAX_TRACKED_PEERS",
      DEFAULT_MAX_TRACKED_PEERS,
      1,
      10_000,
    ),
  };
}

export async function startPocketRelayServer(config: PocketRelayServerConfig): Promise<PocketRelayServer> {
  validateServerLimits(config);
  const now = config.now ?? Date.now;
  const maxConnections = config.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
  const maxSlots = config.maxSlots ?? DEFAULT_MAX_SLOTS;
  const maxWaitersPerSlot = config.maxWaitersPerSlot ?? DEFAULT_MAX_WAITERS_PER_SLOT;
  const rateWindowMs = config.rateWindowMs ?? DEFAULT_RATE_WINDOW_MS;
  const maxConnectionsPerIp = config.maxConnectionsPerIp ?? DEFAULT_MAX_CONNECTIONS_PER_IP;
  const maxConnectionStartsPerIp = config.maxConnectionStartsPerIp ?? DEFAULT_MAX_CONNECTION_STARTS_PER_IP;
  const maxNewSlotsPerIp = config.maxNewSlotsPerIp ?? DEFAULT_MAX_NEW_SLOTS_PER_IP;
  const maxTrackedPeers = config.maxTrackedPeers ?? DEFAULT_MAX_TRACKED_PEERS;
  const slots = new Map<string, RelaySlot>();
  const peers = new Map<string, RelayPeerState>();
  const admittedSockets = new Set<Socket>();
  const admittedConnections = new Map<string, Socket>();
  const handshakeTimers = new Map<Socket, NodeJS.Timeout>();
  const pendingSockets = new Set<TLSSocket>();
  const tunnelSockets = new Set<TLSSocket>();
  const counters: RelayCounters = {
    acceptedConnections: 0,
    admissionRejected: 0,
    requestRejected: 0,
    rateLimited: 0,
    slotLimited: 0,
    pairedTunnels: 0,
  };
  let tunnelCount = 0;
  let openConnectionCount = 0;
  let closePromise: Promise<void> | undefined;
  let peerCleanup: NodeJS.Timeout | undefined;
  const tlsHandshakeTimeoutMs = config.tlsHandshakeTimeoutMs ?? DEFAULT_TLS_HANDSHAKE_TIMEOUT_MS;
  const headerTimeoutMs = config.headerTimeoutMs ?? DEFAULT_HEADER_TIMEOUT_MS;
  const waiterTimeoutMs = config.waiterTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const tunnelIdleTimeoutMs = config.tunnelIdleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const tunnelLifetimeMs = config.tunnelLifetimeMs ?? DEFAULT_TUNNEL_LIFETIME_MS;

  const server = createTlsServer({
    cert: config.certificate,
    key: config.privateKey,
    minVersion: "TLSv1.2",
    maxVersion: "TLSv1.3",
    requestCert: false,
    rejectUnauthorized: false,
    handshakeTimeout: tlsHandshakeTimeoutMs,
    secureOptions: cryptoConstants.SSL_OP_NO_TICKET,
  }, (socket) => {
    clearHandshakeTimer(socket);
    pendingSockets.add(socket);
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 30_000);
    socket.once("close", () => pendingSockets.delete(socket));
    void handleRelayRequest(socket).catch(() => rejectRequest(socket));
  });
  server.maxConnections = maxConnections;
  server.prependListener("connection", admitConnection);
  server.on("tlsClientError", () => undefined);
  server.on("resumeSession", (_sessionId, callback) => callback(null, null));

  async function handleRelayRequest(socket: TLSSocket): Promise<void> {
    const request = parseRelayRequest(await readFrame(socket, headerTimeoutMs));
    if (request.role === "companion") {
      await registerCompanion(socket, request);
    } else {
      await attachClient(socket, request);
    }
  }

  async function registerCompanion(socket: TLSSocket, request: RelayRequest): Promise<void> {
    const candidateHash = hashSecret(request.secret);
    let slot = slots.get(request.slot);
    if (!slot) {
      if (slots.size >= maxSlots) return rejectRequest(socket);
      if (!consumeNewSlot(socket)) return rejectSlotLimited(socket);
      slot = { secretHash: candidateHash, waiters: new Set(), activeTunnels: 0 };
      slots.set(request.slot, slot);
    } else if (!timingSafeEqual(slot.secretHash, candidateHash)) {
      return rejectRequest(socket);
    }
    if (slot.waiters.size >= maxWaitersPerSlot) return rejectRequest(socket);

    let waiter!: RelayWaiter;
    const onClose = () => removeWaiter(request.slot, waiter);
    const timer = setTimeout(() => {
      removeWaiter(request.slot, waiter);
      void writeFrame(socket, { version: RELAY_PROTOCOL_VERSION, status: "unavailable" })
        .catch(() => undefined)
        .finally(() => socket.destroy());
    }, waiterTimeoutMs);
    timer.unref();
    waiter = { socket, timer, onClose };
    slot.waiters.add(waiter);
    socket.once("close", onClose);
    await writeFrame(socket, { version: RELAY_PROTOCOL_VERSION, status: "waiting" });
  }

  async function attachClient(socket: TLSSocket, request: RelayRequest): Promise<void> {
    const slot = slots.get(request.slot);
    if (!slot || !timingSafeEqual(slot.secretHash, hashSecret(request.secret))) {
      return unavailableRequest(socket);
    }
    const waiter = slot.waiters.values().next().value as RelayWaiter | undefined;
    if (!waiter) return unavailableRequest(socket);
    removeWaiter(request.slot, waiter, false);
    slot.activeTunnels += 1;
    try {
      await Promise.all([
        writeFrame(socket, { version: RELAY_PROTOCOL_VERSION, status: "paired" }),
        writeFrame(waiter.socket, { version: RELAY_PROTOCOL_VERSION, status: "paired" }),
      ]);
    } catch {
      counters.requestRejected += 1;
      slot.activeTunnels -= 1;
      cleanupSlot(request.slot, slot);
      socket.destroy();
      waiter.socket.destroy();
      return;
    }
    pendingSockets.delete(socket);
    pendingSockets.delete(waiter.socket);
    tunnelSockets.add(socket);
    tunnelSockets.add(waiter.socket);
    tunnelCount += 1;
    counters.pairedTunnels += 1;
    bridge(socket, waiter.socket, () => {
      tunnelSockets.delete(socket);
      tunnelSockets.delete(waiter.socket);
      tunnelCount -= 1;
      slot.activeTunnels -= 1;
      cleanupSlot(request.slot, slot);
    }, tunnelIdleTimeoutMs, tunnelLifetimeMs);
  }

  function removeWaiter(slotId: string, waiter: RelayWaiter, cleanup = true): void {
    const slot = slots.get(slotId);
    if (!slot || !slot.waiters.delete(waiter)) return;
    clearTimeout(waiter.timer);
    waiter.socket.off("close", waiter.onClose);
    if (cleanup) cleanupSlot(slotId, slot);
  }

  function cleanupSlot(slotId: string, slot: RelaySlot): void {
    if (slot.waiters.size === 0 && slot.activeTunnels === 0) slots.delete(slotId);
  }

  function admitConnection(socket: Socket): void {
    const timestamp = now();
    const address = normalizePocketRelayPeerAddress(socket.remoteAddress);
    if (!address) {
      counters.admissionRejected += 1;
      socket.destroy();
      return;
    }
    let peer = peers.get(address);
    if (!peer) {
      if (peers.size >= maxTrackedPeers) cleanupPeers(timestamp);
      if (peers.size >= maxTrackedPeers) {
        counters.admissionRejected += 1;
        socket.destroy();
        return;
      }
      peer = {
        openConnections: 0,
        windowStartedAt: timestamp,
        connectionStarts: 0,
        newSlots: 0,
        lastSeenAt: timestamp,
      };
      peers.set(address, peer);
    }
    resetPeerWindow(peer, timestamp);
    peer.lastSeenAt = timestamp;
    if (peer.connectionStarts >= maxConnectionStartsPerIp) {
      counters.admissionRejected += 1;
      counters.rateLimited += 1;
      socket.destroy();
      return;
    }
    peer.connectionStarts += 1;
    if (peer.openConnections >= maxConnectionsPerIp) {
      counters.admissionRejected += 1;
      socket.destroy();
      return;
    }
    peer.openConnections += 1;
    openConnectionCount += 1;
    counters.acceptedConnections += 1;
    admittedSockets.add(socket);
    const connectionKey = relayConnectionKey(socket);
    if (connectionKey) admittedConnections.set(connectionKey, socket);
    const handshakeTimer = setTimeout(() => socket.destroy(), tlsHandshakeTimeoutMs);
    handshakeTimer.unref();
    handshakeTimers.set(socket, handshakeTimer);
    let released = false;
    socket.once("close", () => {
      if (released) return;
      released = true;
      admittedSockets.delete(socket);
      if (connectionKey && admittedConnections.get(connectionKey) === socket) {
        admittedConnections.delete(connectionKey);
      }
      const timer = handshakeTimers.get(socket);
      if (timer) clearTimeout(timer);
      handshakeTimers.delete(socket);
      peer!.openConnections = Math.max(0, peer!.openConnections - 1);
      peer!.lastSeenAt = now();
      openConnectionCount = Math.max(0, openConnectionCount - 1);
    });
  }

  function clearHandshakeTimer(socket: Socket): void {
    const connectionKey = relayConnectionKey(socket);
    const admitted = connectionKey ? admittedConnections.get(connectionKey) : undefined;
    const timer = admitted ? handshakeTimers.get(admitted) : undefined;
    if (!admitted || !timer) return;
    clearTimeout(timer);
    handshakeTimers.delete(admitted);
  }

  function consumeNewSlot(socket: TLSSocket): boolean {
    const address = normalizePocketRelayPeerAddress(socket.remoteAddress);
    const peer = address ? peers.get(address) : undefined;
    if (!peer) return false;
    const timestamp = now();
    resetPeerWindow(peer, timestamp);
    peer.lastSeenAt = timestamp;
    if (peer.newSlots >= maxNewSlotsPerIp) return false;
    peer.newSlots += 1;
    return true;
  }

  function resetPeerWindow(peer: RelayPeerState, timestamp: number): void {
    if (timestamp >= peer.windowStartedAt && timestamp - peer.windowStartedAt < rateWindowMs) return;
    peer.windowStartedAt = timestamp;
    peer.connectionStarts = 0;
    peer.newSlots = 0;
  }

  function cleanupPeers(timestamp = now()): void {
    for (const [address, peer] of peers) {
      if (peer.openConnections === 0 && timestamp >= peer.lastSeenAt
          && timestamp - peer.lastSeenAt >= rateWindowMs) peers.delete(address);
    }
  }

  function rejectRequest(socket: TLSSocket): Promise<void> {
    counters.requestRejected += 1;
    return rejectSocket(socket);
  }

  function rejectSlotLimited(socket: TLSSocket): Promise<void> {
    counters.slotLimited += 1;
    return rejectRequest(socket);
  }

  function unavailableRequest(socket: TLSSocket): Promise<void> {
    counters.requestRejected += 1;
    return unavailableSocket(socket);
  }

  const port = await listenTlsServer(server, config.port, config.host);
  peerCleanup = setInterval(cleanupPeers, Math.min(rateWindowMs, 60_000));
  peerCleanup.unref();
  return {
    host: config.host,
    port,
    stats: () => ({
      slots: slots.size,
      waiting: [...slots.values()].reduce((sum, slot) => sum + slot.waiters.size, 0),
      tunnels: tunnelCount,
      openConnections: openConnectionCount,
      trackedPeers: peers.size,
      ...counters,
    }),
    close() {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        if (peerCleanup) clearInterval(peerCleanup);
        for (const timer of handshakeTimers.values()) clearTimeout(timer);
        for (const socket of [...admittedSockets, ...pendingSockets, ...tunnelSockets]) socket.destroy();
        admittedSockets.clear();
        admittedConnections.clear();
        handshakeTimers.clear();
        pendingSockets.clear();
        tunnelSockets.clear();
        for (const slot of slots.values()) {
          for (const waiter of slot.waiters) clearTimeout(waiter.timer);
        }
        slots.clear();
        peers.clear();
        if (!server.listening) return;
        await new Promise<void>((resolvePromise, reject) => {
          server.close((error) => error ? reject(error) : resolvePromise());
        });
      })();
      return closePromise;
    },
  };
}

export function startPocketRelayCompanion(options: PocketRelayCompanionOptions): PocketRelayCompanion {
  validateClientConfig(options.relay);
  if (!validConnectionHost(options.targetHost)
      || !Number.isInteger(options.targetPort) || options.targetPort < 1 || options.targetPort > 65_535) {
    throw configError("Pocket relay target is invalid");
  }
  const minimumBackoff = boundedDuration(options.reconnectMinimumMs, 250, 50, 60_000, "reconnectMinimumMs");
  const maximumBackoff = boundedDuration(options.reconnectMaximumMs, 10_000, minimumBackoff, 60_000, "reconnectMaximumMs");
  const sockets = new Set<Socket>();
  const wakeups = new Set<() => void>();
  const readyWaiters = new Set<ReadyWaiter>();
  let ready = 0;
  let closed = false;

  const workers = Array.from({ length: options.relay.standbyConnections }, (_, worker) => runWorker(worker));

  async function runWorker(worker: number): Promise<void> {
    let failures = 0;
    while (!closed) {
      let relay: TLSSocket | undefined;
      let workerReady = false;
      try {
        relay = await connectRelay(options.relay, "companion", () => {
          workerReady = true;
          ready += 1;
          for (const waiter of readyWaiters) waiter.check();
        }, (socket) => {
          relay = socket;
          sockets.add(socket);
        });
        if (workerReady) {
          ready = Math.max(0, ready - 1);
          workerReady = false;
        }
        if (closed) {
          relay.destroy();
          return;
        }
        const target = await connectTarget(options.targetHost, options.targetPort);
        sockets.add(target);
        failures = 0;
        await bridgeAsync(relay, target);
        sockets.delete(target);
        sockets.delete(relay);
      } catch {
        if (workerReady) ready = Math.max(0, ready - 1);
        if (relay) sockets.delete(relay);
        relay?.destroy();
        if (closed) return;
        failures += 1;
        const exponential = minimumBackoff * (2 ** Math.min(failures - 1, 6));
        const jitter = (worker * 53 + failures * 97) % Math.max(1, Math.floor(minimumBackoff / 2));
        await sleep(Math.min(maximumBackoff, exponential + jitter));
      }
    }
  }

  function sleep(delayMs: number): Promise<void> {
    return new Promise((resolvePromise) => {
      const finish = () => {
        clearTimeout(timer);
        wakeups.delete(finish);
        resolvePromise();
      };
      const timer = setTimeout(finish, delayMs);
      timer.unref();
      wakeups.add(finish);
    });
  }

  return {
    waitUntilReady(minimum = 1, timeoutMs = 10_000) {
      if (!Number.isSafeInteger(minimum) || minimum < 1 || minimum > options.relay.standbyConnections) {
        return Promise.reject(new PocketRelayError("CONFIG_INVALID", "Pocket relay ready count is invalid"));
      }
      if (ready >= minimum) return Promise.resolve();
      return new Promise<void>((resolvePromise, reject) => {
        const waiter: ReadyWaiter = {
          check: () => {
            if (ready < minimum) return;
            clearTimeout(timer);
            readyWaiters.delete(waiter);
            resolvePromise();
          },
          reject: (error) => {
            clearTimeout(timer);
            readyWaiters.delete(waiter);
            reject(error);
          },
        };
        const timer = setTimeout(() => {
          waiter.reject(new PocketRelayError("RELAY_UNAVAILABLE", "Pocket relay did not become ready"));
        }, timeoutMs);
        timer.unref();
        readyWaiters.add(waiter);
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      for (const wakeup of [...wakeups]) wakeup();
      for (const waiter of [...readyWaiters]) {
        waiter.reject(new PocketRelayError("RELAY_UNAVAILABLE", "Pocket relay Companion closed"));
      }
      await Promise.all(workers);
    },
  };
}

export async function connectPocketRelayClient(config: PocketRelayClientConfig): Promise<TLSSocket> {
  validateClientConfig({ ...config, standbyConnections: 1 });
  return connectRelay(config, "client");
}

export function normalizePocketRelayPeerAddress(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (isIP(value) === 4) return value;
  if (isIP(value) !== 6) return undefined;

  const zoneIndex = value.indexOf("%");
  const address = zoneIndex >= 0 ? value.slice(0, zoneIndex) : value;
  const zone = zoneIndex >= 0 ? value.slice(zoneIndex + 1) : undefined;
  if (zone !== undefined && !/^[A-Za-z0-9_.-]{1,64}$/u.test(zone)) return undefined;
  let canonical: string;
  try {
    const hostname = new URL(`http://[${address}]/`).hostname.toLowerCase();
    canonical = hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;
  } catch {
    return undefined;
  }
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(canonical);
  if (!mapped) return zone ? `${canonical}%${zone}` : canonical;
  const high = Number.parseInt(mapped[1]!, 16);
  const low = Number.parseInt(mapped[2]!, 16);
  return `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`;
}

function relayConnectionKey(socket: Socket): string | undefined {
  const address = normalizePocketRelayPeerAddress(socket.remoteAddress);
  const port = socket.remotePort;
  return address && Number.isInteger(port) ? `${address}:${port}` : undefined;
}

async function connectRelay(
  config: PocketRelayClientConfig,
  role: RelayRequest["role"],
  onWaiting?: () => void,
  onSocket?: (socket: TLSSocket) => void,
): Promise<TLSSocket> {
  const socket = await connectOuterTls(config, onSocket);
  try {
    await writeFrame(socket, {
      version: RELAY_PROTOCOL_VERSION,
      role,
      slot: config.slot,
      secret: config.secret,
    });
    const first = parseRelayResponse(await readFrame(socket, DEFAULT_WAIT_TIMEOUT_MS + DEFAULT_HEADER_TIMEOUT_MS));
    if (role === "companion" && first.status === "waiting") {
      onWaiting?.();
      const paired = parseRelayResponse(await readFrame(socket, DEFAULT_WAIT_TIMEOUT_MS + DEFAULT_HEADER_TIMEOUT_MS));
      if (paired.status !== "paired") throw relayUnavailable();
    } else if (first.status !== "paired") {
      throw relayUnavailable();
    }
    socket.setTimeout(0);
    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

async function connectOuterTls(
  config: PocketRelayClientConfig,
  onSocket?: (socket: TLSSocket) => void,
): Promise<TLSSocket> {
  return new Promise<TLSSocket>((resolvePromise, reject) => {
    let settled = false;
    const socket = connectTls({
      host: config.host,
      port: config.port,
      ...(isIP(config.serverName) === 0 ? { servername: config.serverName } : {}),
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
      maxVersion: "TLSv1.3",
      checkServerIdentity: (_hostname, certificate) => checkServerIdentity(config.serverName, certificate),
      ...(config.certificateAuthority ? { ca: config.certificateAuthority } : {}),
    });
    onSocket?.(socket);
    const timer = setTimeout(() => {
      socket.destroy();
      fail(relayUnavailable());
    }, DEFAULT_HEADER_TIMEOUT_MS);
    timer.unref();
    const onError = (error: Error) => {
      clearTimeout(timer);
      fail(new PocketRelayError("RELAY_UNAVAILABLE", `Pocket relay TLS connection failed: ${safeNetworkError(error)}`));
    };
    socket.once("error", onError);
    socket.once("secureConnect", () => {
      clearTimeout(timer);
      try {
        const certificate = socket.getPeerX509Certificate();
        if (!certificate || !safeEqual(publicKeyPin(certificate), config.serverPublicKeyPin)) {
          throw new Error("relay pin mismatch");
        }
        socket.setNoDelay(true);
        socket.setKeepAlive(true, 30_000);
        settled = true;
        socket.off("error", onError);
        resolvePromise(socket);
      } catch {
        socket.destroy();
        fail(new PocketRelayError("RELAY_UNAVAILABLE", "Pocket relay TLS identity did not match the configured pin"));
      }
    });

    function fail(error: Error): void {
      if (settled) return;
      settled = true;
      socket.off("error", onError);
      reject(error);
    }
  });
}

function bridge(
  left: TLSSocket,
  right: TLSSocket,
  onClose: () => void,
  idleTimeoutMs: number,
  lifetimeMs: number,
): void {
  let closed = false;
  const lifetime = setTimeout(close, lifetimeMs);
  lifetime.unref();
  const closeOnIdle = () => close();
  left.setTimeout(idleTimeoutMs, closeOnIdle);
  right.setTimeout(idleTimeoutMs, closeOnIdle);
  left.on("error", close);
  right.on("error", close);
  left.on("close", close);
  right.on("close", close);
  left.pipe(right);
  right.pipe(left);
  left.resume();
  right.resume();

  function close(): void {
    if (closed) return;
    closed = true;
    clearTimeout(lifetime);
    left.destroy();
    right.destroy();
    onClose();
  }
}

function bridgeAsync(left: Socket, right: Socket): Promise<void> {
  return new Promise((resolvePromise) => {
    let closed = false;
    const finish = () => {
      if (closed) return;
      closed = true;
      left.destroy();
      right.destroy();
      resolvePromise();
    };
    left.on("error", finish);
    right.on("error", finish);
    left.on("close", finish);
    right.on("close", finish);
    left.pipe(right);
    right.pipe(left);
    left.resume();
    right.resume();
  });
}

function connectTarget(host: string, port: number): Promise<Socket> {
  if (!validConnectionHost(host) || !Number.isInteger(port) || port < 1 || port > 65_535) {
    return Promise.reject(configError("Pocket relay target is invalid"));
  }
  return new Promise((resolvePromise, reject) => {
    const socket = connectTcp({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(relayUnavailable());
    }, DEFAULT_HEADER_TIMEOUT_MS);
    timer.unref();
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.setNoDelay(true);
      socket.setKeepAlive(true, 30_000);
      resolvePromise(socket);
    });
  });
}

function readFrame(socket: TLSSocket, timeoutMs: number): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => finish(new PocketRelayError("PROTOCOL_ERROR", "Pocket relay frame timed out")), timeoutMs);
    timer.unref();

    const onData = (chunk: Buffer) => {
      const newline = chunk.indexOf(0x0a);
      const framePart = newline >= 0 ? chunk.subarray(0, newline) : chunk;
      size += framePart.length;
      if (size > MAX_RELAY_FRAME_BYTES) {
        finish(new PocketRelayError("PROTOCOL_ERROR", "Pocket relay frame is too large"));
        return;
      }
      chunks.push(framePart);
      if (newline < 0) return;
      socket.pause();
      const remainder = chunk.subarray(newline + 1);
      if (remainder.length > 0) socket.unshift(remainder);
      let value: unknown;
      try {
        value = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
      } catch {
        finish(new PocketRelayError("PROTOCOL_ERROR", "Pocket relay frame is not valid JSON"));
        return;
      }
      if (!isRecord(value)) {
        finish(new PocketRelayError("PROTOCOL_ERROR", "Pocket relay frame must be an object"));
        return;
      }
      finish(undefined, value);
    };
    const onError = () => finish(relayUnavailable());
    const onClose = () => finish(relayUnavailable());
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
    socket.resume();

    function finish(error?: Error, value?: Record<string, unknown>): void {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
      if (error) reject(error);
      else resolvePromise(value!);
    }
  });
}

async function writeFrame(socket: TLSSocket, value: RelayRequest | RelayResponse): Promise<void> {
  const encoded = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  if (encoded.length > MAX_RELAY_FRAME_BYTES) throw new PocketRelayError("PROTOCOL_ERROR", "Pocket relay frame is too large");
  if (socket.destroyed || !socket.writable) throw relayUnavailable();
  if (socket.write(encoded)) return;
  await new Promise<void>((resolvePromise, reject) => {
    const onDrain = () => {
      socket.off("error", onError);
      resolvePromise();
    };
    const onError = (error: Error) => {
      socket.off("drain", onDrain);
      reject(error);
    };
    socket.once("drain", onDrain);
    socket.once("error", onError);
  });
}

function parseRelayRequest(value: Record<string, unknown>): RelayRequest {
  if (!exactKeys(value, ["version", "role", "slot", "secret"])
      || value.version !== RELAY_PROTOCOL_VERSION
      || (value.role !== "companion" && value.role !== "client")
      || typeof value.slot !== "string"
      || typeof value.secret !== "string") {
    throw new PocketRelayError("PROTOCOL_ERROR", "Pocket relay request is invalid");
  }
  requiredSlot(value.slot);
  assertRelaySecret(value.secret);
  return value as unknown as RelayRequest;
}

function parseRelayResponse(value: Record<string, unknown>): RelayResponse {
  if (!exactKeys(value, ["version", "status"])
      || value.version !== RELAY_PROTOCOL_VERSION
      || !["waiting", "paired", "unavailable", "rejected"].includes(String(value.status))) {
    throw new PocketRelayError("PROTOCOL_ERROR", "Pocket relay response is invalid");
  }
  return value as unknown as RelayResponse;
}

async function rejectSocket(socket: TLSSocket): Promise<void> {
  if (socket.destroyed) return;
  try {
    await writeFrame(socket, { version: RELAY_PROTOCOL_VERSION, status: "rejected" });
    socket.end();
  } catch {
    socket.destroy();
  }
}

async function unavailableSocket(socket: TLSSocket): Promise<void> {
  if (socket.destroyed) return;
  try {
    await writeFrame(socket, { version: RELAY_PROTOCOL_VERSION, status: "unavailable" });
    socket.end();
  } catch {
    socket.destroy();
  }
}

function validateClientConfig(config: PocketRelayCompanionConfig): void {
  if (!validConnectionHost(config.host) || !validConnectionHost(config.serverName)
      || !Number.isInteger(config.port) || config.port < 1 || config.port > 65_535
      || !isPublicKeyPin(config.serverPublicKeyPin)) {
    throw configError("Pocket relay TLS configuration is invalid");
  }
  requiredSlot(config.slot);
  assertRelaySecret(config.secret);
  if (!Number.isSafeInteger(config.standbyConnections)
      || config.standbyConnections < 1 || config.standbyConnections > DEFAULT_MAX_WAITERS_PER_SLOT) {
    throw configError("Pocket relay standby connection count is invalid");
  }
}

function validateServerLimits(config: PocketRelayServerConfig): void {
  if (!validHost(config.host) || !Number.isInteger(config.port) || config.port < 0 || config.port > 65_535) {
    throw configError("Pocket relay listener is invalid");
  }
  boundedDuration(
    config.tlsHandshakeTimeoutMs,
    DEFAULT_TLS_HANDSHAKE_TIMEOUT_MS,
    1_000,
    60_000,
    "tlsHandshakeTimeoutMs",
  );
  boundedDuration(config.headerTimeoutMs, DEFAULT_HEADER_TIMEOUT_MS, 100, 60_000, "headerTimeoutMs");
  boundedDuration(config.waiterTimeoutMs, DEFAULT_WAIT_TIMEOUT_MS, 1_000, 10 * 60_000, "waiterTimeoutMs");
  boundedDuration(config.tunnelIdleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS, 1_000, 60 * 60_000, "tunnelIdleTimeoutMs");
  boundedDuration(config.tunnelLifetimeMs, DEFAULT_TUNNEL_LIFETIME_MS, 60_000, DEFAULT_TUNNEL_LIFETIME_MS, "tunnelLifetimeMs");
  boundedInteger(config.maxConnections, DEFAULT_MAX_CONNECTIONS, 1, 2_048, "maxConnections");
  boundedInteger(config.maxSlots, DEFAULT_MAX_SLOTS, 1, 1_024, "maxSlots");
  boundedInteger(config.maxWaitersPerSlot, DEFAULT_MAX_WAITERS_PER_SLOT, 1, 16, "maxWaitersPerSlot");
  boundedDuration(config.rateWindowMs, DEFAULT_RATE_WINDOW_MS, 1_000, 10 * 60_000, "rateWindowMs");
  boundedInteger(
    config.maxConnectionsPerIp,
    DEFAULT_MAX_CONNECTIONS_PER_IP,
    1,
    2_048,
    "maxConnectionsPerIp",
  );
  boundedInteger(
    config.maxConnectionStartsPerIp,
    DEFAULT_MAX_CONNECTION_STARTS_PER_IP,
    1,
    10_000,
    "maxConnectionStartsPerIp",
  );
  boundedInteger(config.maxNewSlotsPerIp, DEFAULT_MAX_NEW_SLOTS_PER_IP, 1, 1_024, "maxNewSlotsPerIp");
  boundedInteger(config.maxTrackedPeers, DEFAULT_MAX_TRACKED_PEERS, 1, 10_000, "maxTrackedPeers");
  if (config.now !== undefined && typeof config.now !== "function") throw configError("now is invalid");
}

function hashSecret(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function assertRelaySecret(value: string): void {
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(value)) {
    throw configError("Pocket relay secret must be at least 256 bits of base64url data");
  }
}

function requiredSlot(value: string | undefined): string {
  const slot = value?.trim();
  if (!slot || !/^[A-Za-z0-9_-]{22,86}$/.test(slot)) {
    throw configError("CODEX_POCKET_RELAY_SLOT must be opaque base64url data");
  }
  return slot;
}

function requiredPin(value: string | undefined, name: string): string {
  const pin = value?.trim();
  if (!pin || !isPublicKeyPin(pin)) throw configError(`${name} is invalid`);
  return pin;
}

function isPublicKeyPin(value: string): boolean {
  return /^sha256\/[A-Za-z0-9+/]{43}=$/.test(value);
}

function requiredHost(value: string | undefined, name: string, allowWildcard = false): string {
  const host = value?.trim();
  if (!host || !validHost(host) || (!allowWildcard && !validConnectionHost(host))) {
    throw configError(`${name} is invalid`);
  }
  return host;
}

function validConnectionHost(value: string): boolean {
  return validHost(value) && value !== "0.0.0.0" && value !== "::";
}

function validHost(value: string): boolean {
  return value.length <= 253 && (isIP(value) !== 0 || value.split(".").every((label) => (
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label)
  )));
}

function optionalPort(value: string | undefined, name: string): number {
  if (value === undefined || value === "") return DEFAULT_RELAY_PORT;
  if (!/^[0-9]{1,5}$/.test(value)) throw configError(`${name} is invalid`);
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1_024 || port > 65_535) {
    throw configError(`${name} must be between 1024 and 65535`);
  }
  return port;
}

function requiredPath(value: string | undefined, name: string): string {
  if (!value?.trim() || value.includes("\0")) throw configError(`${name} is required`);
  return value;
}

function optionalBoundedInteger(
  value: string | undefined,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/.test(value)) throw configError(`${name} is invalid`);
  return boundedInteger(Number(value), fallback, minimum, maximum, name);
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum) {
    throw configError(`${name} is invalid`);
  }
  return selected;
}

function boundedDuration(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  return boundedInteger(value, fallback, minimum, maximum, name);
}

async function readPrivateFile(path: string, label: string, maxBytes: number): Promise<Buffer> {
  await assertPrivateDirectory(dirname(path));
  return readBoundedFile(path, label, maxBytes, true);
}

async function readPublicFile(path: string, label: string, maxBytes: number): Promise<Buffer> {
  return readBoundedFile(path, label, maxBytes, false);
}

async function assertPrivateDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    throw configError("Pocket relay private directory permissions must be 0700");
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw configError("Pocket relay private directory owner does not match the current user");
  }
}

async function readBoundedFile(path: string, label: string, maxBytes: number, privateFile: boolean): Promise<Buffer> {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") throw configError(`${label} must not be a symlink`);
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size < 1 || info.size > maxBytes) {
      throw configError(`${label} must be a bounded regular single-link file`);
    }
    if (privateFile && (info.mode & 0o077) !== 0) throw configError(`${label} permissions must be 0600`);
    if (privateFile && typeof process.getuid === "function" && info.uid !== process.getuid()) {
      throw configError(`${label} owner does not match the current user`);
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function listenTlsServer(server: TlsServer, port: number, host: string): Promise<number> {
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolvePromise();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Pocket relay did not get a TCP address");
  return address.port;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === [...expected].sort()[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function safeNetworkError(error: unknown): string {
  const code = isRecord(error) && typeof error.code === "string" ? error.code : "connection_error";
  return /^[A-Z0-9_]{1,40}$/.test(code) ? code : "connection_error";
}

function configError(message: string): PocketRelayError {
  return new PocketRelayError("CONFIG_INVALID", message);
}

function relayUnavailable(): PocketRelayError {
  return new PocketRelayError("RELAY_UNAVAILABLE", "Pocket relay is unavailable");
}
