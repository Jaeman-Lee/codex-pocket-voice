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
    input: { conversationId: "conversation-1", cwd: process.cwd(), prompt: "inspect" },
  });
  assert.equal(operation.id, "operation-1");
  assert.equal(operation.status, "running");
  assert.equal(events[0]?.type, "operation");

  providers.emit({
    providerId: "fake",
    conversationId: "conversation-1",
    runId: "run-1",
    method: "output.delta",
    params: { delta: "working" },
  });
  providers.emit({
    providerId: "fake",
    conversationId: "another-conversation",
    method: "output.delta",
  });
  assert.equal(events.filter((event) => event.type === "provider").length, 1);

  providers.complete(0, { status: "completed", result: { finalResponse: "done" } });
  await waitFor(() => coordinator.get(operation.id)?.status === "completed");
  assert.equal(coordinator.get(operation.id)?.result?.finalResponse, "done");

  providers.emit({
    providerId: "fake",
    conversationId: "conversation-1",
    method: "output.delta",
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
    input: { conversationId: "shared", cwd: process.cwd(), prompt: "first" },
  });

  await assert.rejects(
    coordinator.start({
      providerId: "fake",
      prompt: "second",
      input: { conversationId: "shared", cwd: process.cwd(), prompt: "second" },
    }),
    (error: unknown) => error instanceof RunCoordinatorError && error.statusCode === 409,
  );
  assert.equal(providers.starts.length, 1);
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
