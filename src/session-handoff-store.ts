import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const STATE_VERSION = 1;
const DEFAULT_LIFETIME_MS = 7 * 24 * 60 * 60_000;

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
  version: number;
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
    const state = await readState(stateFile) ?? { version: STATE_VERSION, handoff: null };
    const store = new SessionHandoffStore(
      stateFile,
      state,
      options.now ?? Date.now,
      options.lifetimeMs ?? DEFAULT_LIFETIME_MS,
    );
    await store.persist();
    return store;
  }

  current(): SessionHandoff | null {
    const handoff = this.state.handoff;
    if (!handoff || Date.parse(handoff.expiresAt) <= this.now()) return null;
    return structuredClone(handoff);
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
    this.state.handoff = handoff;
    await this.persist();
    return structuredClone(handoff);
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
  if (!isStoredState(value)) throw new Error(`Session handoff state has an unsupported format: ${path}`);
  return value;
}

function isStoredState(value: unknown): value is StoredHandoffState {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.version === STATE_VERSION && (record.handoff === null || isHandoff(record.handoff));
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
