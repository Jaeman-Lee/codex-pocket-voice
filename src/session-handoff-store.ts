import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const STATE_VERSION = 2;
const DEFAULT_LIFETIME_MS = 7 * 24 * 60 * 60_000;
const MAX_HANDOFFS = 50;

export interface SessionHandoff {
  id: string;
  workspace: string;
  threadId: string;
  operationId?: string;
  releasedBy: { id: string; label: string };
  releasedAt: string;
  expiresAt: string;
}

interface StoredHandoffState {
  version: 2;
  handoffs: SessionHandoff[];
}

interface LegacyStoredHandoffState {
  version: 1;
  handoff: SessionHandoff | null;
}

export interface CreateSessionHandoff {
  workspace: string;
  threadId: string;
  operationId?: string;
  releasedBy: { id: string; label: string };
}

export class SessionHandoffStore {
  private state: StoredHandoffState;

  private constructor(
    readonly stateFile: string,
    state: StoredHandoffState,
    private readonly now: () => number,
    private readonly lifetimeMs: number,
  ) {
    this.state = state;
  }

  static async create(
    stateFile: string,
    options: { now?: () => number; lifetimeMs?: number } = {},
  ): Promise<SessionHandoffStore> {
    const state = await readState(stateFile) ?? { version: STATE_VERSION, handoffs: [] };
    const store = new SessionHandoffStore(
      stateFile,
      state,
      options.now ?? Date.now,
      options.lifetimeMs ?? DEFAULT_LIFETIME_MS,
    );
    await store.persist();
    return store;
  }

  current(filter: { workspace?: string; threadId?: string } = {}): SessionHandoff | null {
    return this.list(filter)[0] ?? null;
  }

  list(filter: { workspace?: string; threadId?: string } = {}): SessionHandoff[] {
    const now = this.now();
    return this.state.handoffs
      .filter((handoff) => Date.parse(handoff.expiresAt) > now)
      .filter((handoff) => !filter.workspace || handoff.workspace === filter.workspace)
      .filter((handoff) => !filter.threadId || handoff.threadId === filter.threadId)
      .sort((left, right) => Date.parse(right.releasedAt) - Date.parse(left.releasedAt))
      .map((handoff) => structuredClone(handoff));
  }

  async release(input: CreateSessionHandoff): Promise<SessionHandoff> {
    const releasedAt = new Date(this.now()).toISOString();
    const handoff: SessionHandoff = {
      id: randomUUID(),
      workspace: input.workspace,
      threadId: input.threadId,
      ...(input.operationId ? { operationId: input.operationId } : {}),
      releasedBy: { ...input.releasedBy },
      releasedAt,
      expiresAt: new Date(this.now() + this.lifetimeMs).toISOString(),
    };
    this.state.handoffs = [
      handoff,
      ...this.list().filter((item) => item.workspace !== handoff.workspace || item.threadId !== handoff.threadId),
    ].slice(0, MAX_HANDOFFS);
    await this.persist();
    return structuredClone(handoff);
  }

  async claim(handoffId: string): Promise<SessionHandoff | null> {
    const handoff = this.list().find((item) => item.id === handoffId) ?? null;
    if (!handoff) return null;
    this.state.handoffs = this.state.handoffs.filter((item) => item.id !== handoffId);
    await this.persist();
    return handoff;
  }

  private async persist(): Promise<void> {
    const directory = dirname(this.stateFile);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.stateFile}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, this.stateFile);
  }
}

async function readState(path: string): Promise<StoredHandoffState | undefined> {
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
    throw new Error(`Session handoff state is not valid JSON: ${path}`);
  }
  if (isStoredState(value)) return value;
  if (isLegacyStoredState(value)) {
    return {
      version: STATE_VERSION,
      handoffs: value.handoff ? [value.handoff] : [],
    };
  }
  throw new Error(`Session handoff state has an unsupported format: ${path}`);
}

function isStoredState(value: unknown): value is StoredHandoffState {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.version === STATE_VERSION
    && Array.isArray(record.handoffs)
    && record.handoffs.length <= MAX_HANDOFFS
    && record.handoffs.every(isHandoff);
}

function isLegacyStoredState(value: unknown): value is LegacyStoredHandoffState {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.version === 1 && (record.handoff === null || isHandoff(record.handoff));
}

function isHandoff(value: unknown): value is SessionHandoff {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const releasedBy = record.releasedBy as Record<string, unknown> | undefined;
  return typeof record.id === "string"
    && typeof record.workspace === "string"
    && typeof record.threadId === "string"
    && (record.operationId === undefined || typeof record.operationId === "string")
    && Boolean(releasedBy && typeof releasedBy.id === "string" && typeof releasedBy.label === "string")
    && typeof record.releasedAt === "string"
    && typeof record.expiresAt === "string";
}
