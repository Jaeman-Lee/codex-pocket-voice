import { createHash, randomUUID } from "node:crypto";
import type {
  ProviderEvent,
  ProviderRun,
  ProviderRunInput,
  ProviderRunStatus,
} from "./providers/types.js";
import type { WorkspaceIdentity } from "./workspace-identity.js";

const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60_000;
const DEFAULT_MAX_OPERATIONS = 500;

export type RunOperationStatus = "running" | "unknown" | ProviderRunStatus;

export interface RunOperation {
  id: string;
  providerId: string;
  conversationId: string;
  runId: string;
  cwd: string;
  prompt: string;
  accountId?: string;
  model?: string;
  effort?: string;
  networkAccess?: boolean;
  workspaceIdentity?: WorkspaceIdentity;
  status: RunOperationStatus;
  startedAt: string;
  completedAt?: string;
  acknowledgedAt?: string;
  result?: Record<string, unknown>;
  error?: string;
}

export interface StartRunCommand {
  providerId: string;
  accountId?: string;
  prompt: string;
  input: ProviderRunInput;
  workspaceIdentity?: WorkspaceIdentity;
  idempotencyKey?: string;
}

export interface RunListFilter {
  status?: string;
  workspace?: string;
}

export interface RunIdempotencyRecord {
  key: string;
  fingerprint: string;
  operationId: string;
}

export interface RestoredRunState {
  operations: readonly RunOperation[];
  idempotency: readonly RunIdempotencyRecord[];
}

export interface RunStateStore {
  load(): RestoredRunState;
  saveOperation(operation: RunOperation, idempotency?: RunIdempotencyRecord): void;
  deleteOperation(operationId: string): void;
  deleteOperations(operationIds: readonly string[]): void;
}

export type RunCoordinatorEvent =
  | {
      type: "operation";
      action: "started" | "completed" | "failed" | "acknowledged";
      operation: RunOperation;
    }
  | {
      type: "provider";
      operationId: string;
      cwd: string;
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
  stateStore?: RunStateStore;
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
  private readonly idempotencyByOperation = new Map<string, RunIdempotencyRecord>();
  private readonly listeners = new Set<(event: RunCoordinatorEvent) => void>();
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly retentionMs: number;
  private readonly maxOperations: number;
  private readonly assertWorkspace: (cwd: string) => void;
  private readonly stateStore?: RunStateStore;
  private readonly unsubscribeProvider: () => void;
  private closed = false;

  constructor(
    private readonly providers: RunProviderRegistry,
    options: RunCoordinatorOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
    this.retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
    this.maxOperations = options.maxOperations ?? DEFAULT_MAX_OPERATIONS;
    this.assertWorkspace = options.assertWorkspace ?? (() => undefined);
    this.stateStore = options.stateStore;
    const restored = this.stateStore?.load();
    for (const operation of restored?.operations ?? []) {
      this.assertWorkspace(operation.cwd);
      this.operations.set(operation.id, cloneOperation(operation));
    }
    for (const entry of restored?.idempotency ?? []) {
      if (this.operations.has(entry.operationId)) {
        this.idempotencyByOperation.set(entry.operationId, { ...entry });
        this.idempotency.set(entry.key, {
          fingerprint: entry.fingerprint,
          operationId: entry.operationId,
        });
      }
    }
    this.cleanup();
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

    const pending = this.startNew(command, { key, fingerprint, operationId: "" });
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

  findByProviderRun(providerId: string, conversationId: string, runId: string): RunOperation | undefined {
    this.cleanup();
    const operation = [...this.operations.values()].find((item) => item.providerId === providerId
      && item.conversationId === conversationId && item.runId === runId);
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

  acknowledge(operationId: string): RunOperation {
    const operation = this.operations.get(operationId);
    if (!operation) throw new RunCoordinatorError(404, "Operation not found");
    if (operation.status !== "unknown") {
      throw new RunCoordinatorError(409, "최종 상태를 확인할 수 없는 작업만 확인 처리할 수 있습니다.");
    }
    if (operation.acknowledgedAt) return cloneOperation(operation);
    operation.acknowledgedAt = new Date(this.now()).toISOString();
    try {
      this.stateStore?.saveOperation(operation, this.idempotencyForOperation(operation.id));
    } catch (error) {
      delete operation.acknowledgedAt;
      throw error;
    }
    this.emit({ type: "operation", action: "acknowledged", operation: cloneOperation(operation) });
    return cloneOperation(operation);
  }

  deleteWorkspaceHistory(workspace: string): { deletedOperationIds: string[] } {
    this.cleanup();
    const matching = [...this.operations.values()].filter((operation) => operation.cwd === workspace);
    const protectedOperation = matching.find((operation) => operation.status === "running"
      || (operation.status === "unknown" && !operation.acknowledgedAt));
    if (protectedOperation) {
      throw new RunCoordinatorError(
        409,
        "실행 중이거나 아직 확인하지 않은 작업이 있어 이 프로젝트 기록을 삭제할 수 없습니다.",
      );
    }
    const deletedOperationIds = matching.map((operation) => operation.id);
    this.stateStore?.deleteOperations(deletedOperationIds);
    for (const operationId of deletedOperationIds) this.removeOperation(operationId, false);
    return { deletedOperationIds };
  }

  close(): void {
    this.closed = true;
    this.unsubscribeProvider();
    this.listeners.clear();
  }

  private async startNew(
    command: StartRunCommand,
    idempotency?: RunIdempotencyRecord,
  ): Promise<RunOperation> {
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
        accountId: command.accountId,
        model: command.input.model,
        effort: command.input.effort,
        networkAccess: command.input.networkAccess === true,
        ...(command.workspaceIdentity ? { workspaceIdentity: structuredClone(command.workspaceIdentity) } : {}),
        status: "running",
        startedAt: new Date(this.now()).toISOString(),
      };
      this.operations.set(operation.id, operation);
      this.activeByConversation.set(actualConversation, operation.id);
      const operationIdempotency = idempotency ? { ...idempotency, operationId: operation.id } : undefined;
      if (operationIdempotency) this.idempotencyByOperation.set(operation.id, operationIdempotency);
      try {
        this.stateStore?.saveOperation(operation, operationIdempotency);
      } catch (error) {
        this.operations.delete(operation.id);
        this.activeByConversation.delete(actualConversation);
        this.idempotencyByOperation.delete(operation.id);
        throw error;
      }
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
      if (this.closed) return;
      operation.status = completed.status;
      operation.completedAt = new Date(this.now()).toISOString();
      operation.result = completed.result;
      this.stateStore?.saveOperation(operation, this.idempotencyForOperation(operation.id));
      this.emit({
        type: "operation",
        action: completed.status === "failed" ? "failed" : "completed",
        operation: cloneOperation(operation),
      });
    } catch (error) {
      if (this.closed) return;
      operation.status = "failed";
      operation.completedAt = new Date(this.now()).toISOString();
      operation.error = error instanceof Error ? error.message : String(error);
      try {
        this.stateStore?.saveOperation(operation, this.idempotencyForOperation(operation.id));
      } catch (journalError) {
        operation.error = `작업 상태와 event journal을 저장하지 못했습니다: ${safeError(journalError)}`;
      }
      this.emit({ type: "operation", action: "failed", operation: cloneOperation(operation) });
    } finally {
      const key = conversationKey(operation.providerId, operation.conversationId);
      if (this.activeByConversation.get(key) === operation.id) this.activeByConversation.delete(key);
    }
  }

  private forwardProviderEvent(event: ProviderEvent): void {
    if (!event.conversationId) return;
    const key = conversationKey(event.providerId, event.conversationId);
    const operationId = this.activeByConversation.get(key);
    const operation = operationId ? this.operations.get(operationId) : undefined;
    if (!operationId || !operation) return;
    this.emit({ type: "provider", operationId, cwd: operation.cwd, event });
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

  private removeOperation(operationId: string, persist = true): void {
    this.operations.delete(operationId);
    this.idempotencyByOperation.delete(operationId);
    if (persist) this.stateStore?.deleteOperation(operationId);
    for (const [key, entry] of this.idempotency) {
      if (entry.operationId === operationId) this.idempotency.delete(key);
    }
  }

  private idempotencyForOperation(operationId: string): RunIdempotencyRecord | undefined {
    const entry = this.idempotencyByOperation.get(operationId);
    return entry ? { ...entry } : undefined;
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

function safeError(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message.slice(0, 500)
    : "알 수 없는 저장 오류";
}
