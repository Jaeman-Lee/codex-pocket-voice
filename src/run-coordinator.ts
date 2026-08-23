import { createHash, randomUUID } from "node:crypto";
import type {
  ProviderEvent,
  ProviderRun,
  ProviderRunInput,
  ProviderRunStatus,
} from "./providers/types.js";

const DEFAULT_RETENTION_MS = 6 * 60 * 60_000;
const DEFAULT_MAX_OPERATIONS = 100;

export type RunOperationStatus = "running" | ProviderRunStatus;

export interface RunOperation {
  id: string;
  providerId: string;
  conversationId: string;
  runId: string;
  cwd: string;
  prompt: string;
  status: RunOperationStatus;
  startedAt: string;
  completedAt?: string;
  result?: Record<string, unknown>;
  error?: string;
}

export interface StartRunCommand {
  providerId: string;
  accountId?: string;
  prompt: string;
  input: ProviderRunInput;
  idempotencyKey?: string;
}

export interface RunListFilter {
  status?: string;
  workspace?: string;
}

export type RunCoordinatorEvent =
  | {
      type: "operation";
      action: "started" | "completed" | "failed";
      operation: RunOperation;
    }
  | {
      type: "provider";
      event: ProviderEvent;
    };

export interface RunProviderRegistry {
  startRun(providerId: unknown, accountId: unknown, input: ProviderRunInput): Promise<ProviderRun>;
  cancelRun(providerId: unknown, conversationId: string, runId: string): Promise<void>;
  subscribe(listener: (event: ProviderEvent) => void): () => void;
}

export interface RunCoordinatorOptions {
  now?: () => number;
  createId?: () => string;
  retentionMs?: number;
  maxOperations?: number;
  assertWorkspace?: (cwd: string) => void;
}

interface IdempotencyEntry {
  fingerprint: string;
  operationId?: string;
  pending?: Promise<RunOperation>;
}

export class RunCoordinatorError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

export class RunCoordinator {
  private readonly operations = new Map<string, RunOperation>();
  private readonly activeByConversation = new Map<string, string>();
  private readonly pendingConversations = new Set<string>();
  private readonly idempotency = new Map<string, IdempotencyEntry>();
  private readonly listeners = new Set<(event: RunCoordinatorEvent) => void>();
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly retentionMs: number;
  private readonly maxOperations: number;
  private readonly assertWorkspace: (cwd: string) => void;
  private readonly unsubscribeProvider: () => void;

  constructor(
    private readonly providers: RunProviderRegistry,
    options: RunCoordinatorOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
    this.retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
    this.maxOperations = options.maxOperations ?? DEFAULT_MAX_OPERATIONS;
    this.assertWorkspace = options.assertWorkspace ?? (() => undefined);
    this.unsubscribeProvider = providers.subscribe((event) => this.forwardProviderEvent(event));
  }

  subscribe(listener: (event: RunCoordinatorEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(command: StartRunCommand): Promise<RunOperation> {
    this.cleanup();
    const fingerprint = fingerprintCommand(command);
    const key = command.idempotencyKey;
    if (!key) return cloneOperation(await this.startNew(command));

    const existing = this.idempotency.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new RunCoordinatorError(409, "같은 requestId를 다른 실행 요청에 다시 사용할 수 없습니다.");
      }
      if (existing.operationId) {
        const operation = this.operations.get(existing.operationId);
        if (operation) return cloneOperation(operation);
        this.idempotency.delete(key);
      } else if (existing.pending) {
        return cloneOperation(await existing.pending);
      }
    }

    const pending = this.startNew(command);
    const entry: IdempotencyEntry = { fingerprint, pending };
    this.idempotency.set(key, entry);
    try {
      const operation = await pending;
      entry.operationId = operation.id;
      entry.pending = undefined;
      return cloneOperation(operation);
    } catch (error) {
      if (this.idempotency.get(key) === entry) this.idempotency.delete(key);
      throw error;
    }
  }

  get(operationId: string): RunOperation | undefined {
    this.cleanup();
    const operation = this.operations.get(operationId);
    return operation ? cloneOperation(operation) : undefined;
  }

  list(filter: RunListFilter = {}): RunOperation[] {
    this.cleanup();
    return [...this.operations.values()]
      .filter((operation) => (!filter.status || operation.status === filter.status)
        && (!filter.workspace || operation.cwd === filter.workspace))
      .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))
      .map(cloneOperation);
  }

  async cancel(operationId: string): Promise<{ operation: RunOperation; interruptRequested: boolean }> {
    const operation = this.operations.get(operationId);
    if (!operation) throw new RunCoordinatorError(404, "Operation not found");
    const interruptRequested = operation.status === "running";
    if (interruptRequested) {
      await this.providers.cancelRun(operation.providerId, operation.conversationId, operation.runId);
    }
    return { operation: cloneOperation(operation), interruptRequested };
  }

  close(): void {
    this.unsubscribeProvider();
    this.listeners.clear();
  }

  private async startNew(command: StartRunCommand): Promise<RunOperation> {
    const requestedConversation = command.input.conversationId
      ? conversationKey(command.providerId, command.input.conversationId)
      : undefined;
    if (requestedConversation) this.reserveConversation(requestedConversation);

    let begun: ProviderRun;
    try {
      begun = await this.providers.startRun(command.providerId, command.accountId, command.input);
    } finally {
      if (requestedConversation) this.pendingConversations.delete(requestedConversation);
    }

    try {
      this.assertWorkspace(begun.cwd);
      const actualConversation = conversationKey(begun.providerId, begun.conversationId);
      if (this.activeByConversation.has(actualConversation)) {
        await this.providers.cancelRun(begun.providerId, begun.conversationId, begun.runId).catch(() => undefined);
        throw new RunCoordinatorError(409, "이 대화에는 이미 실행 중인 작업이 있습니다.");
      }

      const operation: RunOperation = {
        id: this.createId(),
        providerId: begun.providerId,
        conversationId: begun.conversationId,
        runId: begun.runId,
        cwd: begun.cwd,
        prompt: command.prompt,
        status: "running",
        startedAt: new Date(this.now()).toISOString(),
      };
      this.operations.set(operation.id, operation);
      this.activeByConversation.set(actualConversation, operation.id);
      this.emit({ type: "operation", action: "started", operation: cloneOperation(operation) });
      void this.settle(operation, begun);
      return operation;
    } catch (error) {
      if (!(error instanceof RunCoordinatorError && error.statusCode === 409)) {
        await this.providers.cancelRun(begun.providerId, begun.conversationId, begun.runId).catch(() => undefined);
      }
      throw error;
    }
  }

  private reserveConversation(key: string): void {
    if (this.activeByConversation.has(key) || this.pendingConversations.has(key)) {
      throw new RunCoordinatorError(409, "이 대화에는 이미 실행 중인 작업이 있습니다.");
    }
    this.pendingConversations.add(key);
  }

  private async settle(operation: RunOperation, begun: ProviderRun): Promise<void> {
    try {
      const completed = await begun.completion;
      operation.status = completed.status;
      operation.completedAt = new Date(this.now()).toISOString();
      operation.result = completed.result;
      this.emit({
        type: "operation",
        action: completed.status === "failed" ? "failed" : "completed",
        operation: cloneOperation(operation),
      });
    } catch (error) {
      operation.status = "failed";
      operation.completedAt = new Date(this.now()).toISOString();
      operation.error = error instanceof Error ? error.message : String(error);
      this.emit({ type: "operation", action: "failed", operation: cloneOperation(operation) });
    } finally {
      const key = conversationKey(operation.providerId, operation.conversationId);
      if (this.activeByConversation.get(key) === operation.id) this.activeByConversation.delete(key);
    }
  }

  private forwardProviderEvent(event: ProviderEvent): void {
    if (!event.conversationId) return;
    const key = conversationKey(event.providerId, event.conversationId);
    if (!this.activeByConversation.has(key)) return;
    this.emit({ type: "provider", event });
  }

  private emit(event: RunCoordinatorEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        process.stderr.write(`[codex-run-coordinator] Listener failed: ${String(error)}\n`);
      }
    }
  }

  private cleanup(): void {
    const cutoff = this.now() - this.retentionMs;
    for (const [id, operation] of this.operations) {
      if (operation.status !== "running" && Date.parse(operation.completedAt ?? operation.startedAt) < cutoff) {
        this.removeOperation(id);
      }
    }
    while (this.operations.size > this.maxOperations) {
      const removable = [...this.operations.entries()].find(([, item]) => item.status !== "running");
      if (!removable) break;
      this.removeOperation(removable[0]);
    }
  }

  private removeOperation(operationId: string): void {
    this.operations.delete(operationId);
    for (const [key, entry] of this.idempotency) {
      if (entry.operationId === operationId) this.idempotency.delete(key);
    }
  }
}

function conversationKey(providerId: string, conversationId: string): string {
  return JSON.stringify([providerId, conversationId]);
}

function fingerprintCommand(command: StartRunCommand): string {
  return createHash("sha256")
    .update(JSON.stringify({
      providerId: command.providerId,
      accountId: command.accountId ?? null,
      prompt: command.prompt,
      input: command.input,
    }))
    .digest("hex");
}

function cloneOperation(operation: RunOperation): RunOperation {
  return structuredClone(operation);
}
