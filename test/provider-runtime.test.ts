import assert from "node:assert/strict";
import test from "node:test";
import type { Thread } from "../generated/app-server/v2/Thread.js";
import type { Turn } from "../generated/app-server/v2/Turn.js";
import type { AppServerNotification, BeginTurnResult, RunTurnOptions } from "../src/app-server-client.js";
import { CodexProviderAdapter, type CodexProviderClient } from "../src/providers/codex-provider.js";
import { ProviderRegistry } from "../src/providers/registry.js";

test("provider runtime normalizes Codex runs, events, completion, and cancellation", async () => {
  const client = new FakeCodexProviderClient();
  const registry = new ProviderRegistry(client, [new CodexProviderAdapter(client)]);
  const events: Array<{ providerId: string; conversationId?: string; method: string }> = [];
  const unsubscribe = registry.subscribe((event) => events.push({
    providerId: event.providerId,
    conversationId: event.conversationId,
    method: event.method,
  }));

  const run = await registry.startRun("codex", "cli-default", {
    conversationId: "thread-runtime",
    cwd: process.cwd(),
    prompt: "inspect the provider boundary",
    networkAccess: false,
    model: "test-codex",
    effort: "high",
  });
  assert.equal(run.providerId, "codex");
  assert.equal(run.conversationId, "thread-runtime");
  assert.equal(run.runId, "turn-runtime");
  assert.equal(client.lastRun?.threadId, "thread-runtime");
  assert.equal(client.lastRun?.networkAccess, false);

  client.emit("item/agentMessage/delta", { threadId: "thread-runtime", delta: "working" });
  assert.deepEqual(events, [{
    providerId: "codex",
    conversationId: "thread-runtime",
    method: "item/agentMessage/delta",
  }]);

  client.finish("completed");
  const completed = await run.completion;
  assert.equal(completed.status, "completed");
  assert.equal(completed.result.threadId, "thread-runtime");
  assert.equal(completed.result.finalResponse, "runtime complete");

  await registry.cancelRun("codex", run.conversationId, run.runId);
  assert.deepEqual(client.cancelled, ["thread-runtime", "turn-runtime"]);
  unsubscribe();
});

test("provider runtime rejects unknown accounts before starting a run", async () => {
  const client = new FakeCodexProviderClient();
  const registry = new ProviderRegistry(client, [new CodexProviderAdapter(client)]);
  await assert.rejects(
    registry.startRun("codex", "unknown-account", {
      cwd: process.cwd(),
      prompt: "must not start",
    }),
    /계정 프로필/,
  );
  assert.equal(client.lastRun, undefined);
});

class FakeCodexProviderClient implements CodexProviderClient {
  lastRun?: RunTurnOptions;
  cancelled?: [string, string];
  private completion?: (turn: Turn) => void;
  private readonly listeners = new Set<(notification: AppServerNotification) => void>();

  async start() {
    return { userAgent: "fake-runtime", codexHome: process.cwd(), platformFamily: "unix", platformOs: "linux" };
  }

  async listModels() {
    return { data: [], nextCursor: null };
  }

  async beginTurn(options: RunTurnOptions): Promise<BeginTurnResult> {
    this.lastRun = options;
    const thread = runtimeThread();
    const turn = runtimeTurn("inProgress");
    const completion = new Promise<Turn>((resolve) => {
      this.completion = resolve;
    });
    return { thread, turn, completion };
  }

  async interrupt(threadId: string, turnId: string): Promise<void> {
    this.cancelled = [threadId, turnId];
  }

  subscribe(listener: (notification: AppServerNotification) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(method: string, params: unknown): void {
    for (const listener of this.listeners) listener({ method, params });
  }

  finish(status: Turn["status"]): void {
    this.completion?.(runtimeTurn(status));
  }
}

function runtimeThread(): Thread {
  return {
    id: "thread-runtime",
    extra: null,
    sessionId: "session-runtime",
    forkedFromId: null,
    parentThreadId: null,
    preview: "provider runtime test",
    ephemeral: false,
    section: null,
    sectionEnteredAt: null,
    historyMode: "legacy",
    modelProvider: "openai",
    createdAt: 1,
    updatedAt: 2,
    recencyAt: 2,
    status: { type: "idle" },
    path: null,
    cwd: process.cwd(),
    cliVersion: "test",
    source: "appServer",
    canAcceptDirectInput: true,
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: "Provider runtime",
    turns: [],
  };
}

function runtimeTurn(status: Turn["status"]): Turn {
  return {
    id: "turn-runtime",
    items: status === "completed"
      ? [{ type: "agentMessage", id: "message-runtime", text: "runtime complete", phase: "final_answer", memoryCitation: null }]
      : [],
    itemsView: "full",
    status,
    error: null,
    startedAt: 1,
    completedAt: status === "inProgress" ? null : 2,
    durationMs: status === "inProgress" ? null : 1_000,
  };
}
