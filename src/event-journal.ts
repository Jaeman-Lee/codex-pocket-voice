import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import type {
  RestoredRunState,
  RunIdempotencyRecord,
  RunOperation,
  RunStateStore,
} from "./run-coordinator.js";

const SCHEMA_VERSION = 1;
const KEY_BYTES = 32;
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60_000;
const DEFAULT_MAX_OPERATIONS = 500;
const DEFAULT_MAX_EVENTS = 2_000;
const MAX_OPERATION_BYTES = 4 * 1024 * 1024;
const MAX_EVENT_BYTES = 128 * 1024;

interface StoredOperationPayload {
  operation: RunOperation;
  idempotency?: RunIdempotencyRecord;
}

interface OperationRow {
  id: string;
  workspace_index: string;
  status: string;
  started_at: number;
  completed_at: number | null;
  envelope: string;
}

interface EventRow {
  cursor: number;
  event_id: string;
  operation_id: string;
  workspace_index: string;
  created_at: number;
  envelope: string;
}

export interface JournalReplayEvent {
  cursor: number;
  eventId: string;
  createdAt: string;
  event: Record<string, unknown>;
}

export interface JournalReplay {
  events: JournalReplayEvent[];
  gapBefore: boolean;
  journalReset: boolean;
  latestCursor: number;
}

export interface EventJournalOptions {
  keyFile?: string;
  now?: () => number;
  retentionMs?: number;
  maxOperations?: number;
  maxEvents?: number;
  createId?: () => string;
}

export class EventJournal implements RunStateStore {
  private constructor(
    readonly databaseFile: string,
    readonly keyFile: string,
    private readonly database: Database.Database,
    private readonly key: Buffer,
    private readonly now: () => number,
    private readonly retentionMs: number,
    private readonly maxOperations: number,
    private readonly maxEvents: number,
    private readonly createId: () => string,
  ) {}

  static async create(databaseFile: string, options: EventJournalOptions = {}): Promise<EventJournal> {
    const resolvedDatabaseFile = resolve(databaseFile);
    const keyFile = resolve(options.keyFile ?? `${resolvedDatabaseFile}.key`);
    if (resolvedDatabaseFile === keyFile) throw new Error("Event journal database and key must use different files");
    const retentionMs = positiveInteger(options.retentionMs ?? DEFAULT_RETENTION_MS, "retentionMs");
    const maxOperations = positiveInteger(options.maxOperations ?? DEFAULT_MAX_OPERATIONS, "maxOperations");
    const maxEvents = positiveInteger(options.maxEvents ?? DEFAULT_MAX_EVENTS, "maxEvents");
    await mkdir(dirname(resolvedDatabaseFile), { recursive: true, mode: 0o700 });
    await assertPrivateDirectory(dirname(resolvedDatabaseFile), "Event journal database directory");
    await assertSafeExistingFile(resolvedDatabaseFile, "Event journal database");
    await chmod(resolvedDatabaseFile, 0o600).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
    const key = await loadOrCreateKey(keyFile);
    const database = new Database(resolvedDatabaseFile);
    try {
      await chmod(resolvedDatabaseFile, 0o600);
      database.pragma("journal_mode = WAL");
      database.pragma("synchronous = FULL");
      database.pragma("foreign_keys = ON");
      database.pragma("secure_delete = ON");
      initializeSchema(database);
      return new EventJournal(
        resolvedDatabaseFile,
        keyFile,
        database,
        key,
        options.now ?? Date.now,
        retentionMs,
        maxOperations,
        maxEvents,
        options.createId ?? randomUUID,
      );
    } catch (error) {
      database.close();
      throw error;
    }
  }

  load(): RestoredRunState {
    const rows = this.database.prepare(`
      SELECT id, workspace_index, status, started_at, completed_at, envelope
      FROM operations
      ORDER BY started_at ASC
    `).all() as OperationRow[];
    const operations: RunOperation[] = [];
    const idempotency: RunIdempotencyRecord[] = [];
    const recover = this.database.transaction((items: OperationRow[]) => {
      for (const row of items) {
        const payload = this.open<StoredOperationPayload>(operationAad(row), row.envelope, MAX_OPERATION_BYTES);
        assertStoredOperation(payload, row.id);
        assertOperationMetadata(payload.operation, row, this.workspaceIndex(payload.operation.cwd));
        let operation = payload.operation;
        if (operation.status === "running") {
          operation = {
            ...operation,
            status: "unknown",
            completedAt: new Date(this.now()).toISOString(),
            error: "Companion이 재시작되어 이전 실행의 최종 상태를 확인할 수 없습니다.",
          };
          this.saveOperation(operation, payload.idempotency);
          this.appendEvent(operation.id, operation.cwd, {
            type: "operation",
            action: "recovered",
            operation,
          });
        }
        operations.push(structuredClone(operation));
        if (payload.idempotency) idempotency.push({ ...payload.idempotency });
      }
    });
    recover(rows);
    this.cleanup();
    return { operations, idempotency };
  }

  saveOperation(operation: RunOperation, idempotency?: RunIdempotencyRecord): void {
    const payload: StoredOperationPayload = {
      operation: structuredClone(operation),
      ...(idempotency ? { idempotency: { ...idempotency } } : {}),
    };
    assertStoredOperation(payload, operation.id);
    const serialized = JSON.stringify(payload);
    if (Buffer.byteLength(serialized) > MAX_OPERATION_BYTES) {
      throw new Error("Run operation exceeds the encrypted journal size limit");
    }
    const metadata: Omit<OperationRow, "envelope"> = {
      id: operation.id,
      workspace_index: this.workspaceIndex(operation.cwd),
      status: operation.status,
      started_at: requiredTimestamp(operation.startedAt, "startedAt"),
      completed_at: operation.completedAt ? requiredTimestamp(operation.completedAt, "completedAt") : null,
    };
    this.database.prepare(`
      INSERT INTO operations (
        id, workspace_index, status, started_at, completed_at, envelope
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        workspace_index = excluded.workspace_index,
        status = excluded.status,
        started_at = excluded.started_at,
        completed_at = excluded.completed_at,
        envelope = excluded.envelope
    `).run(
      metadata.id,
      metadata.workspace_index,
      metadata.status,
      metadata.started_at,
      metadata.completed_at,
      this.seal(operationAad(metadata), serialized),
    );
    this.cleanup();
  }

  deleteOperation(operationId: string): void {
    this.database.prepare("DELETE FROM operations WHERE id = ?").run(operationId);
  }

  appendEvent(operationId: string, cwd: string, event: Record<string, unknown>): JournalReplayEvent {
    const serialized = JSON.stringify(event);
    if (Buffer.byteLength(serialized) > MAX_EVENT_BYTES) {
      throw new Error("Run event exceeds the encrypted journal size limit");
    }
    const eventId = `journal-${this.createId()}`;
    const createdAtMs = safeEpochMilliseconds(this.now(), "event timestamp");
    const workspaceIndex = this.workspaceIndex(cwd);
    const result = this.database.prepare(`
      INSERT INTO events (event_id, operation_id, workspace_index, created_at, envelope)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      eventId,
      operationId,
      workspaceIndex,
      createdAtMs,
      this.seal(eventAad({
        event_id: eventId,
        operation_id: operationId,
        workspace_index: workspaceIndex,
        created_at: createdAtMs,
      }), serialized),
    );
    this.cleanup();
    return {
      cursor: asSafeInteger(result.lastInsertRowid),
      eventId,
      createdAt: new Date(createdAtMs).toISOString(),
      event: structuredClone(event),
    };
  }

  replayAfter(cursor: number): JournalReplay {
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error("Invalid event journal cursor");
    this.cleanup();
    const bounds = this.database.prepare(`
      SELECT COALESCE(MIN(cursor), 0) AS minimum, COALESCE(MAX(cursor), 0) AS maximum FROM events
    `).get() as { minimum: number; maximum: number };
    const journalReset = cursor > bounds.maximum;
    const replayCursor = journalReset ? 0 : cursor;
    const gapBefore = replayCursor > 0 && bounds.minimum > replayCursor + 1;
    const rows = this.database.prepare(`
      SELECT cursor, event_id, operation_id, workspace_index, created_at, envelope
      FROM events
      WHERE cursor > ?
      ORDER BY cursor ASC
    `).all(replayCursor) as EventRow[];
    return {
      events: rows.map((row) => ({
        cursor: row.cursor,
        eventId: row.event_id,
        createdAt: new Date(row.created_at).toISOString(),
        event: this.open<Record<string, unknown>>(eventAad(row), row.envelope, MAX_EVENT_BYTES),
      })),
      gapBefore,
      journalReset,
      latestCursor: bounds.maximum,
    };
  }

  latestCursor(): number {
    const row = this.database.prepare("SELECT COALESCE(MAX(cursor), 0) AS cursor FROM events").get() as { cursor: number };
    return row.cursor;
  }

  close(): void {
    this.database.close();
  }

  private cleanup(): void {
    const cutoff = this.now() - this.retentionMs;
    const cleanup = this.database.transaction(() => {
      this.database.prepare(`
        DELETE FROM operations
        WHERE status != 'running' AND COALESCE(completed_at, started_at) < ?
      `).run(cutoff);
      this.database.prepare(`
        DELETE FROM operations
        WHERE id IN (
          SELECT id FROM operations
          WHERE status != 'running'
          ORDER BY COALESCE(completed_at, started_at) DESC
          LIMIT -1 OFFSET ?
        )
      `).run(this.maxOperations);
      this.database.prepare("DELETE FROM events WHERE created_at < ?").run(cutoff);
      this.database.prepare(`
        DELETE FROM events
        WHERE cursor IN (
          SELECT cursor FROM events ORDER BY cursor DESC LIMIT -1 OFFSET ?
        )
      `).run(this.maxEvents);
    });
    cleanup();
  }

  private workspaceIndex(cwd: string): string {
    return createHmac("sha256", this.key).update(`workspace\0${cwd}`).digest("hex");
  }

  private seal(aad: string, plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(aad));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [iv, tag, ciphertext].map((part) => part.toString("base64url")).join(".");
  }

  private open<T>(aad: string, envelope: string, maximumPlaintextBytes: number): T {
    if (Buffer.byteLength(envelope) > maximumPlaintextBytes * 2 + 256) {
      throw new Error("Encrypted event journal record exceeds its size limit");
    }
    const parts = envelope.split(".");
    if (parts.length !== 3) throw new Error("Encrypted event journal record is malformed");
    try {
      const [encodedIv, encodedTag, encodedCiphertext] = parts;
      const iv = Buffer.from(encodedIv!, "base64url");
      const tag = Buffer.from(encodedTag!, "base64url");
      const ciphertext = Buffer.from(encodedCiphertext!, "base64url");
      if (iv.length !== 12 || tag.length !== 16) throw new Error("invalid envelope");
      const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
      decipher.setAAD(Buffer.from(aad));
      decipher.setAuthTag(tag);
      const plaintextBuffer = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      if (plaintextBuffer.length > maximumPlaintextBytes) throw new Error("oversized plaintext");
      const plaintext = plaintextBuffer.toString("utf8");
      return JSON.parse(plaintext) as T;
    } catch {
      throw new Error("Encrypted event journal record cannot be authenticated");
    }
  }
}

function initializeSchema(database: Database.Database): void {
  const version = database.pragma("user_version", { simple: true }) as number;
  if (version !== 0 && version !== SCHEMA_VERSION) {
    throw new Error(`Unsupported event journal schema version: ${version}`);
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS operations (
      id TEXT PRIMARY KEY NOT NULL,
      workspace_index TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      envelope TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS operations_workspace_status
      ON operations(workspace_index, status, started_at DESC);
    CREATE TABLE IF NOT EXISTS events (
      cursor INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT UNIQUE NOT NULL,
      operation_id TEXT NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
      workspace_index TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      envelope TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS events_workspace_cursor
      ON events(workspace_index, cursor);
  `);
  database.pragma(`user_version = ${SCHEMA_VERSION}`);
}

async function loadOrCreateKey(path: string): Promise<Buffer> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await assertPrivateDirectory(dirname(path), "Event journal key directory");
  let text: string;
  try {
    text = await readPrivateKey(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const generated = randomBytes(KEY_BYTES).toString("base64url");
    try {
      await writeFile(path, `${generated}\n`, { mode: 0o600, flag: "wx" });
      text = generated;
    } catch (writeError) {
      if ((writeError as NodeJS.ErrnoException).code !== "EEXIST") throw writeError;
      text = await readPrivateKey(path);
    }
  }
  const encoded = text.trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(encoded)) throw new Error("Event journal key is invalid");
  const key = Buffer.from(encoded, "base64url");
  if (key.length !== KEY_BYTES) throw new Error("Event journal key is invalid");
  return key;
}

async function readPrivateKey(path: string): Promise<string> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Event journal key must be a regular file");
  if (info.nlink !== 1) throw new Error("Event journal key must not be hard-linked");
  if ((info.mode & 0o077) !== 0) throw new Error("Event journal key permissions must be 0600");
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error("Event journal key owner does not match the Companion user");
  }
  return readFile(path, "utf8");
}

async function assertSafeExistingFile(path: string, label: string): Promise<void> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
  if (info.nlink !== 1) throw new Error(`${label} must not be hard-linked`);
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error(`${label} owner does not match the Companion user`);
  }
}

async function assertPrivateDirectory(path: string, label: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} must be a regular directory`);
  if ((info.mode & 0o077) !== 0) throw new Error(`${label} permissions must not allow group or other access`);
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error(`${label} owner does not match the Companion user`);
  }
}

function operationAad(row: Pick<OperationRow, "id" | "workspace_index" | "status" | "started_at" | "completed_at">): string {
  return JSON.stringify([
    "operation",
    row.id,
    row.workspace_index,
    row.status,
    row.started_at,
    row.completed_at,
  ]);
}

function eventAad(row: Pick<EventRow, "event_id" | "operation_id" | "workspace_index" | "created_at">): string {
  return JSON.stringify(["event", row.event_id, row.operation_id, row.workspace_index, row.created_at]);
}

function assertOperationMetadata(operation: RunOperation, row: OperationRow, workspaceIndex: string): void {
  if (
    row.workspace_index !== workspaceIndex
    || row.status !== operation.status
    || row.started_at !== requiredTimestamp(operation.startedAt, "startedAt")
    || row.completed_at !== (operation.completedAt ? requiredTimestamp(operation.completedAt, "completedAt") : null)
  ) throw new Error("Encrypted event journal operation metadata cannot be authenticated");
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Event journal ${name} must be a positive integer`);
  return value;
}

function safeEpochMilliseconds(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Event journal ${name} is invalid`);
  return value;
}

function assertStoredOperation(value: StoredOperationPayload, expectedId: string): void {
  if (!value || typeof value !== "object" || !value.operation) {
    throw new Error("Encrypted event journal operation is invalid");
  }
  const operation = value.operation as unknown as Record<string, unknown>;
  const validStatus = operation.status === "running" || operation.status === "unknown"
    || operation.status === "completed" || operation.status === "interrupted" || operation.status === "failed";
  const validResult = operation.result === undefined
    || (typeof operation.result === "object" && operation.result !== null && !Array.isArray(operation.result));
  if (
    !boundedString(operation.id, 200) || operation.id !== expectedId
    || !boundedString(operation.providerId, 80)
    || !boundedString(operation.conversationId, 500)
    || !boundedString(operation.runId, 500)
    || !boundedString(operation.cwd, 4_096)
    || typeof operation.prompt !== "string" || operation.prompt.length > 100_000
    || (operation.accountId !== undefined && !boundedString(operation.accountId, 100))
    || (operation.model !== undefined && !boundedString(operation.model, 200))
    || (operation.effort !== undefined && !boundedString(operation.effort, 40))
    || (operation.networkAccess !== undefined && typeof operation.networkAccess !== "boolean")
    || !validWorkspaceIdentity(operation.workspaceIdentity)
    || !validStatus
    || !boundedTimestamp(operation.startedAt)
    || (operation.completedAt !== undefined && !boundedTimestamp(operation.completedAt))
    || (operation.acknowledgedAt !== undefined && !boundedTimestamp(operation.acknowledgedAt))
    || (operation.error !== undefined && (typeof operation.error !== "string" || operation.error.length > 20_000))
    || !validResult
  ) throw new Error("Encrypted event journal operation is invalid");
  if (value.idempotency && (
    !boundedString(value.idempotency.key, 500)
    || !/^[a-f0-9]{64}$/.test(value.idempotency.fingerprint)
    || value.idempotency.operationId !== expectedId
  )) throw new Error("Encrypted event journal idempotency record is invalid");
}

function validWorkspaceIdentity(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const identity = value as Record<string, unknown>;
  if (identity.kind !== "git" && identity.kind !== "directory") return false;
  const strings = [identity.branch, identity.head, identity.upstream];
  const counts = [identity.ahead, identity.behind, identity.changedFiles];
  const flags = [identity.dirty, identity.detached, identity.linkedWorktree];
  return strings.every((entry) => entry === undefined || boundedString(entry, 4_096))
    && counts.every((entry) => entry === undefined || (Number.isSafeInteger(entry) && (entry as number) >= 0))
    && flags.every((entry) => entry === undefined || typeof entry === "boolean");
}

function requiredTimestamp(value: string, name: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`Run operation ${name} is invalid`);
  return timestamp;
}

function asSafeInteger(value: number | bigint): number {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric)) throw new Error("Event journal cursor exceeds the safe integer range");
  return numeric;
}

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function boundedTimestamp(value: unknown): value is string {
  return boundedString(value, 40) && Number.isFinite(Date.parse(value));
}
