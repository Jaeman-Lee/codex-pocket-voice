import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  ResponseCreateParamsStreaming,
  ResponseStreamEvent,
} from "openai/resources/responses/responses";
import {
  EnvironmentOpenAICredentialSource,
  redactProviderSecrets,
  type OpenAICredentialSource,
} from "../src/providers/openai-credentials.js";
import {
  OpenAIProviderAdapter,
  type OpenAIResponsesClient,
} from "../src/providers/openai-provider.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import type { CodexProviderClient } from "../src/providers/codex-provider.js";
import type { ProviderEvent } from "../src/providers/types.js";

test("OpenAI provider streams a store:false response through the common runtime contract", async () => {
  const credentials = staticCredentials("sk-test-super-secret");
  const client = new FakeOpenAIClient([
    event({ type: "response.created", sequence_number: 1, response: { id: "resp-test" } }),
    event({
      type: "response.output_text.delta",
      sequence_number: 2,
      item_id: "message-test",
      output_index: 0,
      content_index: 0,
      delta: "안녕하세요",
      logprobs: [],
    }),
    completedEvent("안녕하세요"),
  ]);
  const adapter = new OpenAIProviderAdapter({
    credentials,
    clientFactory: (apiKey) => {
      assert.equal(apiKey, "sk-test-super-secret");
      return client;
    },
    createId: sequentialIds("conversation", "run"),
    modelAllowlist: ["gpt-test"],
  });
  const registry = new ProviderRegistry(fakeCodex(), [adapter]);
  const events: ProviderEvent[] = [];
  registry.subscribe((providerEvent) => events.push(providerEvent));

  const run = await registry.startRun("openai", "api-default", {
    cwd: process.cwd(),
    prompt: "인사해 주세요",
    model: "gpt-test",
    timeoutMs: 5_000,
  });
  const completion = await run.completion;

  assert.equal(run.providerId, "openai");
  assert.equal(run.conversationId, "openai-conversation-conversation");
  assert.equal(run.runId, "openai-run-run");
  assert.equal(completion.status, "completed");
  assert.equal(completion.result.finalResponse, "안녕하세요");
  assert.deepEqual(completion.result.usage, {
    inputTokens: 12,
    cachedInputTokens: 2,
    outputTokens: 4,
    reasoningTokens: 1,
    totalTokens: 16,
  });
  assert.deepEqual(events.map((providerEvent) => providerEvent.kind), [
    "run.started",
    "output.delta",
    "usage.updated",
    "run.completed",
  ]);
  assert.equal(events.some((providerEvent) => "response" in providerEvent || "params" in providerEvent), false);
  assert.equal(client.requests.length, 1);
  assert.equal(client.requests[0]?.store, false);
  assert.equal(client.requests[0]?.stream, true);
  assert.equal(client.requests[0]?.model, "gpt-test");
  assert.doesNotMatch(JSON.stringify(client.requests[0]), /sk-test-super-secret/);
});

test("OpenAI connection test lists models without creating a paid response", async () => {
  const client = new FakeOpenAIClient([], [
    { id: "text-embedding-3-large" },
    { id: "gpt-test" },
    { id: "gpt-other" },
  ]);
  const adapter = new OpenAIProviderAdapter({
    credentials: staticCredentials("sk-test-models"),
    clientFactory: () => client,
    modelAllowlist: ["gpt-test"],
    defaultModel: "gpt-test",
  });

  const descriptor = await adapter.describe();
  const connection = await adapter.testConnection();
  assert.equal(descriptor.available, true);
  assert.equal(descriptor.canLogin, false);
  assert.equal(descriptor.capabilities.workspaceRead, false);
  assert.doesNotMatch(JSON.stringify(descriptor), /sk-test-models/);
  assert.equal(connection.ok, true);
  assert.equal(connection.modelCount, 1);
  assert.equal(client.listCalls, 1);
  assert.equal(client.requests.length, 0);
});

test("OpenAI provider requires an explicit verified model allowlist", async () => {
  const client = new FakeOpenAIClient([], [{ id: "gpt-unverified" }]);
  const adapter = new OpenAIProviderAdapter({
    credentials: staticCredentials("sk-test-allowlist"),
    clientFactory: () => client,
    defaultModel: "",
    modelAllowlist: [],
  });
  const descriptor = await adapter.describe();
  assert.equal(descriptor.status, "connected");
  assert.equal(descriptor.available, false);
  assert.match(descriptor.detail, /CODEX_POCKET_OPENAI_MODELS/);
  assert.deepEqual(await adapter.listModels(), []);
  await assert.rejects(
    adapter.startRun({ cwd: process.cwd(), prompt: "do not run", model: "gpt-unverified" }),
    /허용 목록/,
  );
  assert.equal(client.requests.length, 0);
});

test("OpenAI image input is encoded on the Companion without exposing its local path", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-pocket-openai-image-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const imagePath = join(directory, "screen.png");
  await writeFile(imagePath, new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), { mode: 0o600 });
  const client = new FakeOpenAIClient([completedEvent("image received")]);
  const adapter = new OpenAIProviderAdapter({
    credentials: staticCredentials("sk-test-image"),
    clientFactory: () => client,
    modelAllowlist: ["gpt-image-test"],
  });
  const run = await adapter.startRun({
    cwd: process.cwd(),
    prompt: "inspect this image",
    model: "gpt-image-test",
    imagePaths: [imagePath],
  });
  assert.equal((await run.completion).status, "completed");
  const request = JSON.stringify(client.requests[0]);
  assert.match(request, /data:image\/png;base64,/);
  assert.doesNotMatch(request, new RegExp(imagePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("OpenAI provider cancellation aborts the stream and completes as interrupted", async () => {
  const client = new BlockingOpenAIClient();
  const adapter = new OpenAIProviderAdapter({
    credentials: staticCredentials("sk-test-cancel"),
    clientFactory: () => client,
    createId: sequentialIds("cancel-conversation", "cancel-run"),
    modelAllowlist: ["gpt-test"],
  });
  const events: ProviderEvent[] = [];
  adapter.subscribe((providerEvent) => events.push(providerEvent));
  const run = await adapter.startRun({ cwd: process.cwd(), prompt: "wait", model: "gpt-test" });
  await waitFor(() => events.some((providerEvent) => providerEvent.kind === "run.started"));
  await adapter.cancelRun(run.conversationId, run.runId);
  const completion = await run.completion;
  assert.equal(completion.status, "interrupted");
  assert.equal(client.aborted, true);
  assert.equal(events.at(-1)?.kind, "run.completed");
});

test("OpenAI credentials require a private file and secret redaction covers common forms", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-pocket-openai-key-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const keyFile = join(directory, "api-key");
  await writeFile(keyFile, "sk-test-file-secret\n", { mode: 0o600 });
  const source = new EnvironmentOpenAICredentialSource({ CODEX_POCKET_OPENAI_API_KEY_FILE: keyFile });
  assert.deepEqual(await source.load(), { apiKey: "sk-test-file-secret", source: "protected_file" });

  await chmod(keyFile, 0o644);
  await assert.rejects(source.load(), /0600/);
  const redacted = redactProviderSecrets(
    "Authorization: Bearer sk-test-file-secret OPENAI_API_KEY=sk-another-secret-value",
    ["sk-test-file-secret"],
  );
  assert.doesNotMatch(redacted, /sk-test-file-secret|sk-another-secret-value/);
  assert.match(redacted, /\[REDACTED\]/);
});

class FakeOpenAIClient implements OpenAIResponsesClient {
  readonly requests: ResponseCreateParamsStreaming[] = [];
  listCalls = 0;

  constructor(
    private readonly events: readonly ResponseStreamEvent[],
    private readonly models: readonly { id: string }[] = [{ id: "gpt-test" }],
  ) {}

  async listModels() {
    this.listCalls += 1;
    return this.models;
  }

  async createResponse(request: ResponseCreateParamsStreaming, signal: AbortSignal) {
    this.requests.push(request);
    const events = this.events;
    return (async function* () {
      for (const responseEvent of events) {
        if (signal.aborted) throw abortError();
        yield responseEvent;
      }
    })();
  }
}

class BlockingOpenAIClient implements OpenAIResponsesClient {
  aborted = false;

  async listModels() {
    return [{ id: "gpt-test" }];
  }

  async createResponse(_request: ResponseCreateParamsStreaming, signal: AbortSignal) {
    const owner = this;
    return (async function* () {
      await new Promise<void>((_resolve, reject) => {
        if (signal.aborted) {
          owner.aborted = true;
          reject(abortError());
          return;
        }
        signal.addEventListener("abort", () => {
          owner.aborted = true;
          reject(abortError());
        }, { once: true });
      });
      yield event({ type: "response.created", sequence_number: 1, response: { id: "never" } });
    })();
  }
}

function completedEvent(outputText: string): ResponseStreamEvent {
  return event({
    type: "response.completed",
    sequence_number: 3,
    response: {
      id: "resp-test",
      output_text: outputText,
      usage: {
        input_tokens: 12,
        input_tokens_details: { cached_tokens: 2, cache_write_tokens: 0 },
        output_tokens: 4,
        output_tokens_details: { reasoning_tokens: 1 },
        total_tokens: 16,
      },
    },
  });
}

function event(value: Record<string, unknown>): ResponseStreamEvent {
  return value as unknown as ResponseStreamEvent;
}

function staticCredentials(apiKey: string): OpenAICredentialSource {
  return { async load() { return { apiKey, source: "environment" }; } };
}

function sequentialIds(...ids: string[]): () => string {
  return () => ids.shift() ?? "unexpected-id";
}

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition was not met");
}

function fakeCodex(): CodexProviderClient {
  return {
    async start() { throw new Error("not used"); },
    async listModels() { throw new Error("not used"); },
    async beginTurn() { throw new Error("not used"); },
    async interrupt() { throw new Error("not used"); },
    subscribe() { return () => undefined; },
  };
}
