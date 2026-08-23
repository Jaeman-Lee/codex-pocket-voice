import assert from "node:assert/strict";
import test from "node:test";
import {
  RunCoordinator,
  RunCoordinatorError,
  type RunCoordinatorEvent,
  type RunProviderRegistry,
} from "../src/run-coordinator.js";
import type {
  ProviderEvent,
  ProviderRun,
  ProviderRunCompletion,
  ProviderRunInput,
} from "../src/providers/types.js";

test("RunCoordinator owns lifecycle state and forwards only active provider events", async () => {
  const providers = new FakeRunProviders();
  const coordinator = new RunCoordinator(providers, { createId: () => "operation-1" });
  const events: RunCoordinatorEvent[] = [];
  coordinator.subscribe((event) => events.push(event));

  const operation = await coordinator.start({
    providerId: "fake",
    accountId: "account-1",
    prompt: "inspect",
    input: { cwd: process.cwd(), prompt: "inspect" },
  });
  assert.equal(operation.id, "operation-1");
  assert.equal(operation.status, "running");
  assert.equal(events[0]?.type, "operation");

  providers.emit({
    providerId: "fake",
    conversationId: "conversation-1",
    runId: "run-1",
    kind: "output.delta",
    delta: "working",
  });
  providers.emit({
    providerId: "fake",
    conversationId: "another-conversation",
    kind: "output.delta",
    delta: "ignored",
  });
  assert.equal(events.filter((event) => event.type === "provider").length, 1);

  providers.complete(0, { status: "completed", result: { finalResponse: "done" } });
  await waitFor(() => coordinator.get(operation.id)?.status === "completed");
  assert.equal(coordinator.get(operation.id)?.result?.finalResponse, "done");

  providers.emit({
    providerId: "fake",
    conversationId: "conversation-1",
    kind: "output.delta",
    delta: "too late",
  });
  assert.equal(events.filter((event) => event.type === "provider").length, 1);
  coordinator.close();
});

test("RunCoordinator deduplicates retried requests and rejects conflicting reuse", async () => {
  const providers = new FakeRunProviders();
  const coordinator = new RunCoordinator(providers, { createId: () => "operation-idempotent" });
  const command = {
    providerId: "fake",
    accountId: "account-1",
    prompt: "retry safely",
    input: { cwd: process.cwd(), prompt: "retry safely" },
    idempotencyKey: "client-1:queued-1",
  };

  const first = await coordinator.start(command);
  const retry = await coordinator.start(command);
  assert.equal(first.id, retry.id);
  assert.equal(providers.starts.length, 1);

  await assert.rejects(
    coordinator.start({ ...command, prompt: "different payload" }),
    (error: unknown) => error instanceof RunCoordinatorError && error.statusCode === 409,
  );
  assert.equal(providers.starts.length, 1);
  coordinator.close();
});

test("RunCoordinator blocks simultaneous work in one provider conversation", async () => {
  const providers = new FakeRunProviders();
  const coordinator = new RunCoordinator(providers);
  await coordinator.start({
    providerId: "fake",
    prompt: "first",
    input: { cwd: process.cwd(), prompt: "first" },
  });

  await assert.rejects(
    coordinator.start({
      providerId: "fake",
      prompt: "second",
      input: { conversationId: "conversation-1", cwd: process.cwd(), prompt: "second" },
    }),
    (error: unknown) => error instanceof RunCoordinatorError && error.statusCode === 409,
  );
  assert.equal(providers.starts.length, 1);
  coordinator.close();
});

test("RunCoordinator resumes only journal-owned API conversations and transfers the latest state", async () => {
  const providers = new FakeRunProviders();
  const coordinator = new RunCoordinator(providers, {
    createId: sequentialIds("operation-first", "operation-second"),
  });
  const first = await coordinator.start({
    providerId: "fake",
    accountId: "account-1",
    prompt: "first",
    input: { cwd: process.cwd(), prompt: "first", model: "model-a" },
  });
  providers.complete(0, {
    status: "completed",
    result: { finalResponse: "one" },
    resumeState: resumeState("first-state"),
  });
  await waitFor(() => coordinator.get(first.id)?.status === "completed");

  await assert.rejects(
    coordinator.start({
      providerId: "fake",
      accountId: "account-1",
      prompt: "wrong model",
      input: { cwd: process.cwd(), prompt: "wrong model", model: "model-b", conversationId: first.conversationId },
    }),
    (error: unknown) => error instanceof RunCoordinatorError && error.statusCode === 409,
  );
  await assert.rejects(
    coordinator.start({
      providerId: "fake",
      accountId: "account-2",
      prompt: "wrong account",
      input: { cwd: process.cwd(), prompt: "wrong account", conversationId: first.conversationId },
    }),
    (error: unknown) => error instanceof RunCoordinatorError && error.statusCode === 409,
  );
  await assert.rejects(
    coordinator.start({
      providerId: "fake",
      accountId: "account-1",
      prompt: "wrong workspace",
      input: { cwd: "/another/workspace", prompt: "wrong workspace", conversationId: first.conversationId },
    }),
    (error: unknown) => error instanceof RunCoordinatorError && error.statusCode === 409,
  );

  const second = await coordinator.start({
    providerId: "fake",
    accountId: "account-1",
    prompt: "second",
    input: { cwd: process.cwd(), prompt: "second", conversationId: first.conversationId },
  });
  assert.equal(second.conversationId, first.conversationId);
  assert.equal(providers.starts[1]?.accountId, "account-1");
  assert.equal(providers.starts[1]?.input.model, "model-a");
  assert.deepEqual(providers.starts[1]?.input.resumeState, resumeState("first-state"));

  providers.complete(1, {
    status: "completed",
    result: { finalResponse: "two" },
    resumeState: resumeState("second-state"),
  });
  await waitFor(() => coordinator.get(second.id)?.status === "completed");
  assert.equal(coordinator.get(first.id)?.resumeState, undefined);
  assert.deepEqual(coordinator.get(second.id)?.resumeState, resumeState("second-state"));
  coordinator.close();
});

test("RunCoordinator refuses API resume when the latest state is unresolved", async () => {
  const restored = {
    id: "operation-unknown",
    providerId: "fake",
    conversationId: "conversation-unknown",
    runId: "run-unknown",
    cwd: process.cwd(),
    prompt: "uncertain",
    accountId: "account-1",
    model: "model-a",
    status: "unknown" as const,
    startedAt: "2026-08-24T00:00:00.000Z",
    completedAt: "2026-08-24T00:00:01.000Z",
    resumeState: resumeState("unresolved-state"),
  };
  const coordinator = new RunCoordinator(new FakeRunProviders(), {
    stateStore: {
      load: () => ({ operations: [restored], idempotency: [] }),
      saveOperation: () => undefined,
      deleteOperation: () => undefined,
      deleteOperations: () => undefined,
    },
  });
  await assert.rejects(
    coordinator.start({
      providerId: "fake",
      accountId: "account-1",
      prompt: "continue",
      input: {
        cwd: process.cwd(),
        prompt: "continue",
        conversationId: restored.conversationId,
      },
    }),
    (error: unknown) => error instanceof RunCoordinatorError && error.statusCode === 409,
  );
  coordinator.close();
});

test("RunCoordinator converts provider stream failures into terminal failed operations", async () => {
  const providers = new FakeRunProviders();
  const coordinator = new RunCoordinator(providers, { createId: () => "operation-failed" });
  const operation = await coordinator.start({
    providerId: "fake",
    prompt: "stream",
    input: { cwd: process.cwd(), prompt: "stream" },
  });

  providers.fail(0, new Error("provider stream ended before completion"));
  await waitFor(() => coordinator.get(operation.id)?.status === "failed");
  assert.match(coordinator.get(operation.id)?.error ?? "", /stream ended/);
  coordinator.close();
});

test("RunCoordinator cancels a provider run that escapes the allowed workspace", async () => {
  const providers = new FakeRunProviders();
  providers.cwd = "/outside/allowed/root";
  const coordinator = new RunCoordinator(providers, {
    assertWorkspace: () => {
      throw new Error("workspace blocked");
    },
  });

  await assert.rejects(
    coordinator.start({
      providerId: "fake",
      prompt: "escape",
      input: { cwd: process.cwd(), prompt: "escape" },
    }),
    /workspace blocked/,
  );
  assert.deepEqual(providers.cancellations, [["fake", "conversation-1", "run-1"]]);
  assert.deepEqual(coordinator.list(), []);
  coordinator.close();
});

test("RunCoordinator deletes only terminal workspace history and protects active or unknown work", async () => {
  const providers = new FakeRunProviders();
  const coordinator = new RunCoordinator(providers, { createId: () => "operation-delete" });
  const running = await coordinator.start({
    providerId: "fake",
    prompt: "keep while active",
    input: { cwd: process.cwd(), prompt: "keep while active" },
  });
  assert.throws(
    () => coordinator.deleteWorkspaceHistory(process.cwd()),
    (error: unknown) => error instanceof RunCoordinatorError && error.statusCode === 409,
  );
  providers.complete(0, { status: "completed", result: { finalResponse: "done" } });
  await waitFor(() => coordinator.get(running.id)?.status === "completed");
  assert.deepEqual(coordinator.deleteWorkspaceHistory(process.cwd()), {
    deletedOperationIds: [running.id],
  });
  assert.deepEqual(coordinator.list(), []);
  coordinator.close();

  const deleted: string[] = [];
  const unknown = {
    ...running,
    id: "operation-unknown",
    status: "unknown" as const,
    completedAt: new Date().toISOString(),
  };
  const otherWorkspace = {
    ...unknown,
    id: "operation-other-workspace",
    cwd: "/another/workspace",
    status: "completed" as const,
  };
  const restoredCoordinator = new RunCoordinator(new FakeRunProviders(), {
    stateStore: {
      load: () => ({ operations: [unknown, otherWorkspace], idempotency: [] }),
      saveOperation: () => undefined,
      deleteOperation: (operationId) => deleted.push(operationId),
      deleteOperations: (operationIds) => deleted.push(...operationIds),
    },
  });
  assert.throws(
    () => restoredCoordinator.deleteWorkspaceHistory(process.cwd()),
    (error: unknown) => error instanceof RunCoordinatorError && error.statusCode === 409,
  );
  restoredCoordinator.acknowledge(unknown.id);
  assert.deepEqual(restoredCoordinator.deleteWorkspaceHistory(process.cwd()), {
    deletedOperationIds: [unknown.id],
  });
  assert.deepEqual(deleted, [unknown.id]);
  assert.deepEqual(restoredCoordinator.list().map((operation) => operation.id), [otherWorkspace.id]);
  restoredCoordinator.close();
});

test("RunCoordinator validates and persists operation names, pins, and archives", async () => {
  const providers = new FakeRunProviders();
  const saved: Array<{ goalName?: string; pinnedAt?: string; archivedAt?: string }> = [];
  const events: RunCoordinatorEvent[] = [];
  let now = Date.parse("2026-08-24T03:00:00.000Z");
  const coordinator = new RunCoordinator(providers, {
    now: () => now,
    createId: () => "operation-organized",
    stateStore: {
      load: () => ({ operations: [], idempotency: [] }),
      saveOperation: (operation) => saved.push(structuredClone(operation)),
      deleteOperation: () => undefined,
      deleteOperations: () => undefined,
    },
  });
  coordinator.subscribe((event) => events.push(event));
  const running = await coordinator.start({
    providerId: "fake",
    prompt: "audit the project",
    input: { cwd: process.cwd(), prompt: "audit the project" },
  });

  const named = coordinator.updateMetadata(running.id, { goalName: "  Release audit  ", pinned: true });
  assert.equal(named.goalName, "Release audit");
  assert.equal(named.pinnedAt, "2026-08-24T03:00:00.000Z");
  assert.throws(
    () => coordinator.updateMetadata(running.id, { goalName: "should roll back", archived: true }),
    (error: unknown) => error instanceof RunCoordinatorError && error.statusCode === 409,
  );
  assert.equal(coordinator.get(running.id)?.goalName, "Release audit");
  assert.throws(
    () => coordinator.updateMetadata(running.id, { goalName: "line one\nline two" }),
    (error: unknown) => error instanceof RunCoordinatorError && error.statusCode === 400,
  );

  providers.complete(0, { status: "completed", result: { finalResponse: "done" } });
  await waitFor(() => coordinator.get(running.id)?.status === "completed");
  now += 1_000;
  const archived = coordinator.updateMetadata(running.id, { archived: true });
  assert.equal(archived.archivedAt, "2026-08-24T03:00:01.000Z");
  assert.equal(archived.pinnedAt, undefined);
  now += 1_000;
  const repinned = coordinator.updateMetadata(running.id, { pinned: true });
  assert.equal(repinned.archivedAt, undefined);
  assert.equal(repinned.pinnedAt, "2026-08-24T03:00:02.000Z");
  assert.equal(saved.at(-1)?.goalName, "Release audit");
  const lastEvent = events.at(-1);
  assert.equal(lastEvent?.type, "operation");
  assert.equal(lastEvent?.type === "operation" ? lastEvent.action : undefined, "metadata_updated");
  coordinator.close();
});

class FakeRunProviders implements RunProviderRegistry {
  readonly starts: Array<{ providerId: unknown; accountId: unknown; input: ProviderRunInput }> = [];
  readonly cancellations: Array<[unknown, string, string]> = [];
  cwd = process.cwd();
  private readonly listeners = new Set<(event: ProviderEvent) => void>();
  private readonly deferred: Array<{
    resolve(value: ProviderRunCompletion): void;
    reject(error: Error): void;
  }> = [];

  async startRun(providerId: unknown, accountId: unknown, input: ProviderRunInput): Promise<ProviderRun> {
    this.starts.push({ providerId, accountId, input });
    const index = this.starts.length;
    const completion = new Promise<ProviderRunCompletion>((resolve, reject) => {
      this.deferred.push({ resolve, reject });
    });
    return {
      providerId: String(providerId),
      conversationId: input.conversationId ?? `conversation-${index}`,
      runId: `run-${index}`,
      cwd: this.cwd,
      completion,
    };
  }

  async cancelRun(providerId: unknown, conversationId: string, runId: string): Promise<void> {
    this.cancellations.push([providerId, conversationId, runId]);
  }

  subscribe(listener: (event: ProviderEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: ProviderEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  complete(index: number, completion: ProviderRunCompletion): void {
    this.deferred[index]?.resolve(completion);
  }

  fail(index: number, error: Error): void {
    this.deferred[index]?.reject(error);
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition was not met");
}

function resumeState(value: string) {
  return {
    version: 1 as const,
    providerId: "fake",
    model: "model-a",
    data: { value },
  };
}

function sequentialIds(...values: string[]): () => string {
  return () => values.shift() ?? "unexpected-id";
}
