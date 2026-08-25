import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const STATE_VERSION = 1;
const PAIRING_LIFETIME_MS = 10 * 60_000;
const TLS_KEY_ROTATION_LIFETIME_MS = 5 * 60_000;
const MAX_PAIRING_ATTEMPTS = 5;
const ATTEMPT_WINDOW_MS = 60_000;

export type GatewayDeviceKind = "linux" | "android";

export interface GatewayDevice {
  id: string;
  kind: GatewayDeviceKind;
  name: string;
}

interface StoredClient {
  id: string;
  label: string;
  tokenHash: string;
  createdAt: string;
  tlsPublicKeyPin?: string;
  tlsKeyRotation?: StoredTlsKeyRotation;
}

interface StoredTlsKeyRotation {
  tokenHash: string;
  previousPin: string;
  expiresAt: string;
  nextPin?: string;
}

interface StoredGatewayState {
  version: number;
  device: GatewayDevice;
  clients: StoredClient[];
}

export interface AuthenticatedClient {
  id: string;
  label: string;
  tlsBound: boolean;
}

export interface PairingResult {
  token: string;
  client: AuthenticatedClient;
  device: GatewayDevice;
}

export interface TlsKeyRotationStart {
  rotationToken: string;
  expiresAt: string;
}

export interface TlsKeyRotationState {
  status: "pending" | "completed";
  expiresAt: string;
}

export interface GatewayAuthOptions {
  stateFile?: string;
  deviceKind?: GatewayDeviceKind;
  deviceName?: string;
  pairingCode?: string;
  now?: () => number;
}

export class GatewayAuthError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message);
  }
}

export class GatewayAuth {
  readonly stateFile: string;
  readonly pairingCode: string;
  readonly pairingExpiresAt: string;
  private state: StoredGatewayState;
  private readonly now: () => number;
  private failedAttempts: number[] = [];
  private mutationTail: Promise<void> = Promise.resolve();

  private constructor(state: StoredGatewayState, options: Required<Pick<GatewayAuthOptions, "stateFile" | "now">> & GatewayAuthOptions) {
    this.state = state;
    this.stateFile = options.stateFile;
    this.now = options.now;
    this.pairingCode = options.pairingCode ?? createPairingCode();
    this.pairingExpiresAt = new Date(this.now() + PAIRING_LIFETIME_MS).toISOString();
  }

  static async create(options: GatewayAuthOptions = {}): Promise<GatewayAuth> {
    const stateFile = options.stateFile ?? process.env.CODEX_POCKET_AUTH_STATE
      ?? join(homedir(), ".config", "codex-pocket-voice", "gateway-auth.json");
    const now = options.now ?? Date.now;
    const configuredKind = options.deviceKind ?? environmentDeviceKind();
    const configuredName = options.deviceName ?? process.env.CODEX_DEVICE_NAME
      ?? (configuredKind === "android" ? "이 스마트폰" : "Linux PC");
    const existing = await readState(stateFile);
    const state = existing ?? {
      version: STATE_VERSION,
      device: { id: randomUUID(), kind: configuredKind, name: configuredName },
      clients: [],
    };
    if (state.device.kind !== configuredKind || state.device.name !== configuredName) {
      state.device = { ...state.device, kind: configuredKind, name: configuredName };
    }
    const auth = new GatewayAuth(state, { ...options, stateFile, now });
    await auth.persist(state);
    return auth;
  }

  get device(): GatewayDevice {
    return { ...this.state.device };
  }

  get pairedClientCount(): number {
    return this.state.clients.length;
  }

  pairingStatus(): { device: GatewayDevice; pairedClientCount: number; pairingExpiresAt: string } {
    return {
      device: this.device,
      pairedClientCount: this.pairedClientCount,
      pairingExpiresAt: this.pairingExpiresAt,
    };
  }

  requireAuthorization(header: string | undefined, tlsPublicKeyPin?: string): AuthenticatedClient {
    const client = this.clientForBearer(header);
    if (tlsPublicKeyPin !== undefined) {
      if (!client.tlsPublicKeyPin) {
        throw new GatewayAuthError(401, "TLS_DEVICE_BINDING_REQUIRED", "PocketLink에서 이 단말을 다시 페어링해 주세요.");
      }
      if (!safeEqual(client.tlsPublicKeyPin, tlsPublicKeyPin)) {
        throw new GatewayAuthError(401, "TLS_DEVICE_MISMATCH", "PocketLink 단말 인증서가 페어링 기록과 다릅니다.");
      }
    }
    return { id: client.id, label: client.label, tlsBound: client.tlsPublicKeyPin !== undefined };
  }

  async claim(code: unknown, label: unknown, tlsPublicKeyPin?: string): Promise<PairingResult> {
    return this.enqueueMutation(async () => {
      this.trimFailedAttempts();
      if (this.failedAttempts.length >= MAX_PAIRING_ATTEMPTS) {
        throw new GatewayAuthError(429, "PAIRING_RATE_LIMITED", "잠시 후 페어링을 다시 시도해 주세요.");
      }
      if (this.now() > Date.parse(this.pairingExpiresAt)) {
        throw new GatewayAuthError(410, "PAIRING_CODE_EXPIRED", "페어링 코드가 만료되었습니다. Companion을 다시 시작해 주세요.");
      }
      if (typeof code !== "string" || !safeEqual(code.replace(/[ -]/g, ""), this.pairingCode)) {
        this.failedAttempts.push(this.now());
        throw new GatewayAuthError(403, "PAIRING_CODE_INVALID", "페어링 코드가 올바르지 않습니다.");
      }
      const clientLabel = typeof label === "string" && label.trim()
        ? label.trim().slice(0, 80)
        : "Codex Pocket";
      if (tlsPublicKeyPin !== undefined && !isPublicKeyPin(tlsPublicKeyPin)) {
        throw new GatewayAuthError(400, "TLS_DEVICE_PROOF_INVALID", "PocketLink 단말 인증서가 올바르지 않습니다.");
      }
      const token = randomBytes(32).toString("base64url");
      const client: StoredClient = {
        id: randomUUID(),
        label: clientLabel,
        tokenHash: hashToken(token),
        createdAt: new Date(this.now()).toISOString(),
        ...(tlsPublicKeyPin ? { tlsPublicKeyPin } : {}),
      };
      const nextState: StoredGatewayState = {
        ...this.state,
        clients: [...this.state.clients, client],
      };
      await this.commit(nextState);
      return {
        token,
        client: { id: client.id, label: client.label, tlsBound: tlsPublicKeyPin !== undefined },
        device: this.device,
      };
    });
  }

  async revoke(clientId: string): Promise<void> {
    return this.enqueueMutation(async () => {
      const clients = this.state.clients.filter((client) => client.id !== clientId);
      if (clients.length === this.state.clients.length) return;
      await this.commit({ ...this.state, clients });
    });
  }

  async startTlsKeyRotation(clientId: string, tlsPublicKeyPin: string | undefined): Promise<TlsKeyRotationStart> {
    return this.enqueueMutation(async () => {
      const client = this.state.clients.find((item) => item.id === clientId);
      if (!client?.tlsPublicKeyPin) {
        throw new GatewayAuthError(409, "TLS_KEY_ROTATION_UNAVAILABLE", "PocketLink로 페어링된 단말만 key를 교체할 수 있습니다.");
      }
      if (!isPublicKeyPin(tlsPublicKeyPin) || !safeEqual(client.tlsPublicKeyPin, tlsPublicKeyPin)) {
        throw new GatewayAuthError(401, "TLS_DEVICE_PROOF_REQUIRED", "현재 PocketLink 단말 identity의 TLS proof가 필요합니다.");
      }
      if (client.tlsKeyRotation?.nextPin
          || (client.tlsKeyRotation && this.now() <= Date.parse(client.tlsKeyRotation.expiresAt))) {
        throw new GatewayAuthError(409, "TLS_KEY_ROTATION_ALREADY_PENDING", "이미 진행 중인 PocketLink key 교체를 먼저 확인해 주세요.");
      }
      const rotationToken = randomBytes(32).toString("base64url");
      const expiresAt = new Date(this.now() + TLS_KEY_ROTATION_LIFETIME_MS).toISOString();
      await this.replaceClient(client.id, {
        ...client,
        tlsKeyRotation: {
          tokenHash: hashToken(rotationToken),
          previousPin: client.tlsPublicKeyPin,
          expiresAt,
        },
      });
      return { rotationToken, expiresAt };
    });
  }

  async inspectTlsKeyRotation(
    header: string | undefined,
    rotationToken: unknown,
    tlsPublicKeyPin: string | undefined,
  ): Promise<TlsKeyRotationState> {
    return this.enqueueMutation(async () => {
      const { client, rotation } = await this.requireTlsKeyRotation(header, rotationToken, tlsPublicKeyPin);
      if (rotation.nextPin) {
        if (!safeEqual(client.tlsPublicKeyPin!, rotation.nextPin) || !safeEqual(tlsPublicKeyPin!, rotation.nextPin)) {
          throw new GatewayAuthError(409, "TLS_KEY_ROTATION_STATE_MISMATCH", "PocketLink key 교체 상태가 일치하지 않습니다.");
        }
        return { status: "completed", expiresAt: rotation.expiresAt };
      }
      if (!safeEqual(client.tlsPublicKeyPin!, rotation.previousPin) || safeEqual(tlsPublicKeyPin!, rotation.previousPin)) {
        throw new GatewayAuthError(409, "TLS_KEY_ROTATION_STATE_MISMATCH", "새 PocketLink 단말 key의 TLS proof가 필요합니다.");
      }
      return { status: "pending", expiresAt: rotation.expiresAt };
    });
  }

  async completeTlsKeyRotation(
    header: string | undefined,
    rotationToken: unknown,
    tlsPublicKeyPin: string | undefined,
  ): Promise<TlsKeyRotationState & { previousKeyRetired: true }> {
    return this.enqueueMutation(async () => {
      const { client, rotation } = await this.requireTlsKeyRotation(header, rotationToken, tlsPublicKeyPin);
      if (rotation.nextPin) {
        if (!safeEqual(client.tlsPublicKeyPin!, rotation.nextPin) || !safeEqual(tlsPublicKeyPin!, rotation.nextPin)) {
          throw new GatewayAuthError(409, "TLS_KEY_ROTATION_STATE_MISMATCH", "PocketLink key 교체 상태가 일치하지 않습니다.");
        }
        return { status: "completed", expiresAt: rotation.expiresAt, previousKeyRetired: true };
      }
      if (!safeEqual(client.tlsPublicKeyPin!, rotation.previousPin) || safeEqual(tlsPublicKeyPin!, rotation.previousPin)) {
        throw new GatewayAuthError(409, "TLS_KEY_ROTATION_STATE_MISMATCH", "새 PocketLink 단말 key의 TLS proof가 필요합니다.");
      }
      const nextPin = tlsPublicKeyPin!;
      await this.replaceClient(client.id, {
        ...client,
        tlsPublicKeyPin: nextPin,
        tlsKeyRotation: { ...rotation, nextPin },
      });
      return { status: "completed", expiresAt: rotation.expiresAt, previousKeyRetired: true };
    });
  }

  async abortTlsKeyRotation(
    header: string | undefined,
    rotationToken: unknown,
    tlsPublicKeyPin: string | undefined,
  ): Promise<{ aborted: true; retainedPreviousKey: true }> {
    return this.enqueueMutation(async () => {
      const { client, rotation } = await this.requireTlsKeyRotation(header, rotationToken, tlsPublicKeyPin);
      if (rotation.nextPin) {
        throw new GatewayAuthError(409, "TLS_KEY_ROTATION_ALREADY_COMPLETED", "Companion은 이미 새 단말 key만 허용합니다.");
      }
      if (!safeEqual(client.tlsPublicKeyPin!, rotation.previousPin)) {
        throw new GatewayAuthError(409, "TLS_KEY_ROTATION_STATE_MISMATCH", "PocketLink key 교체 상태가 일치하지 않습니다.");
      }
      const next = { ...client };
      delete next.tlsKeyRotation;
      await this.replaceClient(client.id, next);
      return { aborted: true, retainedPreviousKey: true };
    });
  }

  async finalizeTlsKeyRotation(
    header: string | undefined,
    rotationToken: unknown,
    tlsPublicKeyPin: string | undefined,
  ): Promise<{ finalized: true }> {
    return this.enqueueMutation(async () => {
      const { client, rotation } = await this.requireTlsKeyRotation(header, rotationToken, tlsPublicKeyPin);
      if (!rotation.nextPin || !safeEqual(client.tlsPublicKeyPin!, rotation.nextPin)
          || !safeEqual(tlsPublicKeyPin!, rotation.nextPin)) {
        throw new GatewayAuthError(409, "TLS_KEY_ROTATION_NOT_COMPLETED", "PocketLink 단말 key 교체가 아직 완료되지 않았습니다.");
      }
      const next = { ...client };
      delete next.tlsKeyRotation;
      await this.replaceClient(client.id, next);
      return { finalized: true };
    });
  }

  private trimFailedAttempts(): void {
    const cutoff = this.now() - ATTEMPT_WINDOW_MS;
    this.failedAttempts = this.failedAttempts.filter((attempt) => attempt >= cutoff);
  }

  private clientForBearer(header: string | undefined): StoredClient {
    if (!header?.startsWith("Bearer ")) {
      throw new GatewayAuthError(401, "PAIRING_REQUIRED", "이 단말과 먼저 페어링해 주세요.");
    }
    const token = header.slice("Bearer ".length).trim();
    if (!token) throw new GatewayAuthError(401, "PAIRING_REQUIRED", "이 단말과 먼저 페어링해 주세요.");
    const tokenHash = hashToken(token);
    const client = this.state.clients.find((item) => safeEqual(item.tokenHash, tokenHash));
    if (!client) throw new GatewayAuthError(401, "INVALID_TOKEN", "페어링이 만료되었거나 해제되었습니다.");
    return client;
  }

  private async requireTlsKeyRotation(
    header: string | undefined,
    rotationToken: unknown,
    tlsPublicKeyPin: string | undefined,
  ): Promise<{ client: StoredClient; rotation: StoredTlsKeyRotation }> {
    const client = this.clientForBearer(header);
    if (!isPublicKeyPin(tlsPublicKeyPin)) {
      throw new GatewayAuthError(401, "TLS_DEVICE_PROOF_REQUIRED", "새 PocketLink 단말 인증서가 필요합니다.");
    }
    const rotation = client.tlsKeyRotation;
    if (!rotation) {
      throw new GatewayAuthError(409, "TLS_KEY_ROTATION_NOT_PENDING", "진행 중인 PocketLink key 교체가 없습니다.");
    }
    if (typeof rotationToken !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(rotationToken)
        || !safeEqual(rotation.tokenHash, hashToken(rotationToken))) {
      throw new GatewayAuthError(403, "TLS_KEY_ROTATION_TOKEN_INVALID", "PocketLink key 교체 승인이 올바르지 않습니다.");
    }
    if (!rotation.nextPin && this.now() > Date.parse(rotation.expiresAt)) {
      const next = { ...client };
      delete next.tlsKeyRotation;
      await this.replaceClient(client.id, next);
      throw new GatewayAuthError(410, "TLS_KEY_ROTATION_EXPIRED", "PocketLink key 교체 승인이 만료되었습니다.");
    }
    return { client, rotation };
  }

  private async replaceClient(clientId: string, next: StoredClient): Promise<void> {
    const index = this.state.clients.findIndex((client) => client.id === clientId);
    if (index < 0) throw new GatewayAuthError(401, "INVALID_TOKEN", "페어링이 만료되었거나 해제되었습니다.");
    const clients = [...this.state.clients];
    clients[index] = next;
    await this.commit({ ...this.state, clients });
  }

  private enqueueMutation<T>(mutation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(mutation);
    this.mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async commit(state: StoredGatewayState): Promise<void> {
    await this.persist(state);
    this.state = state;
  }

  private async persist(state: StoredGatewayState): Promise<void> {
    const directory = dirname(this.stateFile);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.stateFile}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, this.stateFile);
  }
}

async function readState(path: string): Promise<StoredGatewayState | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Gateway auth state is not valid JSON: ${path}`);
  }
  if (!isStoredState(value)) throw new Error(`Gateway auth state has an unsupported format: ${path}`);
  return value;
}

function isStoredState(value: unknown): value is StoredGatewayState {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const device = record.device as Record<string, unknown> | undefined;
  const clients = record.clients;
  return record.version === STATE_VERSION
    && Boolean(device && typeof device.id === "string" && (device.kind === "linux" || device.kind === "android") && typeof device.name === "string")
    && Array.isArray(clients)
    && clients.every((client) => {
      if (!client || typeof client !== "object") return false;
      const item = client as Record<string, unknown>;
      return typeof item.id === "string" && typeof item.label === "string"
        && typeof item.tokenHash === "string" && typeof item.createdAt === "string"
        && (item.tlsPublicKeyPin === undefined || isPublicKeyPin(item.tlsPublicKeyPin))
        && isStoredTlsKeyRotation(item.tlsKeyRotation, item.tlsPublicKeyPin);
    });
}

function isStoredTlsKeyRotation(value: unknown, currentPin: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || !isPublicKeyPin(currentPin)) return false;
  const rotation = value as Record<string, unknown>;
  if (typeof rotation.tokenHash !== "string" || !/^[a-f0-9]{64}$/.test(rotation.tokenHash)
      || !isPublicKeyPin(rotation.previousPin) || typeof rotation.expiresAt !== "string"
      || !Number.isFinite(Date.parse(rotation.expiresAt))) return false;
  if (rotation.nextPin === undefined) return safeEqual(currentPin, rotation.previousPin);
  return isPublicKeyPin(rotation.nextPin)
    && !safeEqual(rotation.previousPin, rotation.nextPin)
    && safeEqual(currentPin, rotation.nextPin);
}

function environmentDeviceKind(): GatewayDeviceKind {
  return process.env.CODEX_DEVICE_ID === "phone" ? "android" : "linux";
}

function createPairingCode(): string {
  return String(randomInt(0, 100_000_000)).padStart(8, "0");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function isPublicKeyPin(value: unknown): value is string {
  return typeof value === "string" && /^sha256\/[A-Za-z0-9+/]{43}=$/.test(value);
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
