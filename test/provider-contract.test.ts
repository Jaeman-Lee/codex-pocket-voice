import assert from "node:assert/strict";
import test from "node:test";
import type { Thread } from "../generated/app-server/v2/Thread.js";
import type { Turn } from "../generated/app-server/v2/Turn.js";
import type { AppServerNotification, BeginTurnResult, RunTurnOptions } from "../src/app-server-client.js";
import { CodexProviderAdapter, type CodexProviderClient } from "../src/providers/codex-provider.js";
import {
  OpenAIProviderAdapter,
  type OpenAIResponsesClient,
} from "../src/providers/openai-provider.js";
import {
  OpenRouterProviderAdapter,
  type OpenRouterChatChunk,
  type OpenRouterClient,
} from "../src/providers/openrouter-provider.js";
import type {
  ProviderEvent,
  ProviderRunInput,
  ProviderRuntime,
} from "../src/providers/types.js";
import type {
  ResponseCreateParamsStreaming,
  ResponseStreamEvent,
} from "openai/resources/responses/responses";

type ContractScenario = "success" | "stream_failure" | "timeout" | "cancellation";

interface ContractHarness {
  runtime: ProviderRuntime;
  input: ProviderRunInput;
}

interface ContractFactory {
  name: string;
  providerId: string;
  create(scenario: ContractScenario): ContractHarness;
}

const factories: ContractFactory[] = [
  { name: "Codex CLI", providerId: "codex", create: createCodexHarness },
  { name: "OpenAI Responses", providerId: "openai", create: createOpenAIHarness },
  { name: "OpenRouter", providerId: "openrouter", create: createOpenRouterHarness },
];

for (const factory of factories) {
  test(`${factory.name} satisfies the shared successful-run contract`, async () => {
    const { runtime, input } = factory.create("success");
    const events: ProviderEvent[] = [];
    const unsubscribe = runtime.subscribe((event) => events.push(event));
    const run = await runtime.startRun(input);
    const completion = await run.completion;
    unsubscribe();

    assert.equal(run.providerId, factory.providerId);
    assert.equal(run.cwd, input.cwd);
    assert.equal(completion.status, "completed");
    assert.equal(completion.result.finalResponse, "contract complete");
    assertRunEventContract(run, events, "completed");
    assert.equal(events.some((event) => event.kind === "output.delta"), true);
  });

  test(`${factory.name} satisfies the shared partial-stream failure contract`, async () => {
    const { runtime, input } = factory.create("stream_failure");
    const events: ProviderEvent[] = [];
    const unsubscribe = runtime.subscribe((event) => events.push(event));
    const run = await runtime.startRun(input);
    const completion = await run.completion;
    unsubscribe();

    assert.equal(completion.status, "failed");
    assert.equal(events.some((event) => event.kind === "output.delta"), true);
    assertRunEventContract(run, events, "failed");
    assert.doesNotMatch(JSON.stringify({ completion, events }), /provider-contract-secret|Authorization|Bearer/);
  });

  test(`${factory.name} satisfies the shared cancellation contract`, async () => {
    const { runtime, input } = factory.create("cancellation");
    const events: ProviderEvent[] = [];
    const unsubscribe = runtime.subscribe((event) => events.push(event));
    const run = await runtime.startRun(input);
    await waitFor(() => events.some((event) => event.kind === "run.started"));
    await runtime.cancelRun(run.conversationId, run.runId);
    const completion = await run.completion;
    unsubscribe();

    assert.equal(completion.status, "interrupted");
    assertRunEventContract(run, events, "interrupted");
  });

  test(`${factory.name} satisfies the shared timeout contract`, async () => {
    const { runtime, input } = factory.create("timeout");
    const events: ProviderEvent[] = [];
    const unsubscribe = runtime.subscribe((event) => events.push(event));
    const run = await runtime.startRun({ ...input, timeoutMs: 5 });
    const completion = await withDeadline(run.completion);
    unsubscribe();

    assert.equal(completion.status, "failed");
    assertRunEventContract(run, events, "failed");
    assert.match(JSON.stringify(completion.result), /시간|timeout|timed out/i);
  });
}

function assertRunEventContract(
  run: { providerId: string; conversationId: string; runId: string },
  events: readonly ProviderEvent[],
  terminalStatus: "completed" | "interrupted" | "failed",
): void {
  assert.equal(events[0]?.kind, "run.started");
  const terminalEvent = events.at(-1);
  assert.equal(terminalEvent?.kind, terminalStatus === "failed" ? "run.failed" : "run.completed");
  if (terminalEvent?.kind === "run.completed") assert.equal(terminalEvent.status, terminalStatus);
  for (const event of events) {
    assert.equal(event.providerId, run.providerId);
    assert.equal(event.conversationId, run.conversationId);
    assert.equal(event.runId, run.runId);
    assert.equal(typeof event.eventId, "string");
    assert.equal(Number.isSafeInteger(event.sequence), true);
  }
  assert.deepEqual(events.map((event) => event.sequence), events.map((_event, index) => index + 1));
  assert.equal(new Set(events.map((event) => event.eventId)).size, events.length);
  const terminalEvents = events.filter((event) => event.kind === "run.completed" || event.kind === "run.failed");
  assert.equal(terminalEvents.length, 1);
}

function createCodexHarness(scenario: ContractScenario): ContractHarness {
  const client = new ContractCodexClient(scenario);
  return {
    runtime: new CodexProviderAdapter(client),
    input: { cwd: process.cwd(), prompt: "exercise provider contract", model: "codex-contract" },
  };
}

class ContractCodexClient implements CodexProviderClient {
  private readonly listeners = new Set<(notification: AppServerNotification) => void>();
  private resolveCompletion?: (turn: Turn) => void;

  constructor(private readonly scenario: ContractScenario) {}

  async start() {
    return { userAgent: "contract", codexHome: process.cwd(), platformFamily: "unix", platformOs: "linux" };
  }

  async listModels() { return { data: [], nextCursor: null }; }

  async beginTurn(_options: RunTurnOptions): Promise<BeginTurnResult> {
    const completion = new Promise<Turn>((resolve) => { this.resolveCompletion = resolve; });
    setImmediate(() => {
      this.emit("turn/started", { threadId: "codex-contract-conversation", turn: codexTurn("inProgress") });
      if (this.scenario === "cancellation") return;
      if (this.scenario === "timeout") {
        setTimeout(() => {
          this.emit("error", {
            threadId: "codex-contract-conversation",
            turnId: "codex-contract-run",
            error: { message: "Codex contract timeout" },
          });
          this.resolveCompletion?.(codexTurn("failed", "Codex contract timeout"));
        }, 5);
        return;
      }
      this.emit("item/agentMessage/delta", {
        threadId: "codex-contract-conversation",
        turnId: "codex-contract-run",
        itemId: "codex-contract-message",
        delta: this.scenario === "success" ? "contract complete" : "partial",
      });
      if (this.scenario === "stream_failure") {
        this.emit("error", {
          threadId: "codex-contract-conversation",
          turnId: "codex-contract-run",
          error: { message: "Codex stream failed safely" },
        });
        this.resolveCompletion?.(codexTurn("failed", "Codex stream failed safely"));
        return;
      }
      this.emit("turn/completed", { threadId: "codex-contract-conversation", turn: codexTurn("completed") });
      this.resolveCompletion?.(codexTurn("completed"));
    });
    return { thread: codexThread(), turn: codexTurn("inProgress"), completion };
  }

  async interrupt(): Promise<void> {
    this.emit("turn/completed", { threadId: "codex-contract-conversation", turn: codexTurn("interrupted") });
    this.resolveCompletion?.(codexTurn("interrupted"));
  }

  subscribe(listener: (notification: AppServerNotification) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(method: string, params: unknown): void {
    for (const listener of this.listeners) listener({ method, params });
  }
}

function createOpenAIHarness(scenario: ContractScenario): ContractHarness {
  const client = new ContractOpenAIClient(scenario);
  return {
    runtime: new OpenAIProviderAdapter({
      credentials: staticCredential(),
      clientFactory: () => client,
      createId: sequentialIds("contract-conversation", "contract-run"),
      modelAllowlist: ["gpt-contract"],
    }),
    input: { cwd: process.cwd(), prompt: "exercise provider contract", model: "gpt-contract" },
  };
}

class ContractOpenAIClient implements OpenAIResponsesClient {
  constructor(private readonly scenario: ContractScenario) {}

  async listModels() { return [{ id: "gpt-contract" }]; }

  async createResponse(_request: ResponseCreateParamsStreaming, signal: AbortSignal) {
    const scenario = this.scenario;
    return (async function* (): AsyncIterable<ResponseStreamEvent> {
      if (scenario === "cancellation" || scenario === "timeout") {
        await abortPromise(signal);
        return;
      }
      const delta = responseEvent({
        type: "response.output_text.delta",
        sequence_number: 1,
        item_id: "openai-contract-message",
        output_index: 0,
        content_index: 0,
        delta: scenario === "success" ? "contract complete" : "partial",
        logprobs: [],
      });
      yield delta;
      if (scenario === "success") yield structuredClone(delta);
      if (scenario === "stream_failure") throw transportFailure(503);
      yield responseEvent({
        type: "response.completed",
        sequence_number: 2,
        response: {
          id: "openai-contract-response",
          output_text: "contract complete",
          output: [{
            type: "message",
            id: "openai-contract-message",
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text: "contract complete", annotations: [], logprobs: [] }],
          }],
          usage: {
            input_tokens: 1,
            input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
            output_tokens: 1,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 2,
          },
        },
      });
    })();
  }
}

function createOpenRouterHarness(scenario: ContractScenario): ContractHarness {
  const client = new ContractOpenRouterClient(scenario);
  return {
    runtime: new OpenRouterProviderAdapter({
      credentials: staticCredential(),
      clientFactory: () => client,
      createId: sequentialIds("contract-conversation", "contract-run"),
      modelAllowlist: ["vendor/contract"],
    }),
    input: { cwd: process.cwd(), prompt: "exercise provider contract", model: "vendor/contract" },
  };
}

class ContractOpenRouterClient implements OpenRouterClient {
  constructor(private readonly scenario: ContractScenario) {}

  async testKey() { return {}; }

  async listModels() {
    return [{
      id: "vendor/contract",
      name: "Contract Model",
      supportedParameters: [],
      inputModalities: ["text"],
    }];
  }

  async createChat(_request: unknown, signal: AbortSignal) {
    const scenario = this.scenario;
    return (async function* (): AsyncIterable<OpenRouterChatChunk> {
      if (scenario === "cancellation" || scenario === "timeout") {
        await abortPromise(signal);
        return;
      }
      yield {
        id: "openrouter-contract-response",
        provider: "Contract Provider",
        choices: [{
          delta: { content: scenario === "success" ? "contract complete" : "partial" },
          finish_reason: scenario === "success" ? "stop" : null,
        }],
      };
      if (scenario === "stream_failure") throw transportFailure(503);
    })();
  }
}

function codexThread(): Thread {
  return {
    id: "codex-contract-conversation",
    extra: null,
    sessionId: "codex-contract-session",
    forkedFromId: null,
    parentThreadId: null,
    preview: "contract",
    ephemeral: false,
    section: null,
    sectionEnteredAt: null,
    projectId: null,
    historyMode: "legacy",
    modelProvider: "openai",
    createdAt: 1,
    updatedAt: 2,
    recencyAt: 2,
    status: { type: "idle" },
    path: null,
    cwd: process.cwd(),
    cliVersion: "contract",
    source: "appServer",
    canAcceptDirectInput: true,
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: "Contract",
    turns: [],
  };
}

function codexTurn(status: Turn["status"], failure?: string): Turn {
  return {
    id: "codex-contract-run",
    items: status === "completed"
      ? [{
          type: "agentMessage",
          id: "codex-contract-message",
          text: "contract complete",
          phase: "final_answer",
          memoryCitation: null,
          delivery: null,
        }]
      : [],
    itemsView: "full",
    status,
    error: failure ? { message: failure, codexErrorInfo: null, additionalDetails: null } : null,
    startedAt: 1,
    completedAt: status === "inProgress" ? null : 2,
    durationMs: status === "inProgress" ? null : 1_000,
  };
}

function responseEvent(value: Record<string, unknown>): ResponseStreamEvent {
  return value as unknown as ResponseStreamEvent;
}

function staticCredential() {
  return { async load() { return { apiKey: "provider-contract-secret", source: "environment" as const }; } };
}

function sequentialIds(...values: string[]): () => string {
  return () => values.shift() ?? "unexpected-contract-id";
}

function transportFailure(status: number): Error & { status: number } {
  return Object.assign(new Error("Authorization: Bearer provider-contract-secret"), { status });
}

async function abortPromise(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    const rejectAbort = () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      reject(error);
    };
    if (signal.aborted) rejectAbort();
    else signal.addEventListener("abort", rejectAbort, { once: true });
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("provider contract condition was not met");
}

async function withDeadline<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("provider contract timed out")), 1_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
