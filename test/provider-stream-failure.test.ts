import assert from "node:assert/strict";
import test from "node:test";
import type {
  ResponseCreateParamsStreaming,
  ResponseStreamEvent,
} from "openai/resources/responses/responses";
import {
  OpenAIProviderAdapter,
  type OpenAIResponsesClient,
} from "../src/providers/openai-provider.js";
import {
  OpenRouterHttpClient,
  OpenRouterProviderAdapter,
} from "../src/providers/openrouter-provider.js";
import type { ProviderEvent, ProviderRunCompletion } from "../src/providers/types.js";

const secret = "provider-failure-fixture-secret";

for (const fixture of [
  { status: 401, expected: 401 },
  { status: 403, expected: 403 },
  { status: 429, expected: 429 },
  { status: 503, expected: 502 },
] as const) {
  test(`OpenAI stream failure fixture classifies HTTP ${fixture.status} without rejecting the common completion`, async () => {
    const adapter = openAIAdapter(new ThrowingOpenAIClient(fixture.status));
    const { completion, events } = await runFailure(adapter, "gpt-failure-fixture");
    assert.equal(completion.result.errorStatus, fixture.expected);
    assert.equal(completion.result.finalResponse, "partial");
    assertFailureContract(completion, events);
  });

  test(`OpenRouter stream failure fixture classifies HTTP ${fixture.status} without rejecting the common completion`, async () => {
    const fetchImpl = openRouterFetch(() => new Response(null, { status: fixture.status }));
    const adapter = openRouterAdapter(fetchImpl);
    const { completion, events } = await runFailure(adapter, "vendor/failure-fixture");
    assert.equal(completion.result.errorStatus, fixture.expected);
    assertFailureContract(completion, events);
  });
}

for (const fixture of [
  {
    name: "malformed JSON after a partial delta",
    stream: [
      `data: ${JSON.stringify({
        id: "generation-partial",
        choices: [{ delta: { content: "partial" }, finish_reason: null }],
      })}\n\n`,
      "data: {not-json}\n\n",
    ].join(""),
    partial: true,
  },
  { name: "truncated SSE frame", stream: "data: {\"id\":\"truncated", partial: false },
  { name: "empty done-only stream", stream: "data: [DONE]\n\n", partial: false },
] as const) {
  test(`OpenRouter HTTP/SSE fixture fails safely on ${fixture.name}`, async () => {
    const fetchImpl = openRouterFetch(() => new Response(fixture.stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }));
    const adapter = openRouterAdapter(fetchImpl);
    const { completion, events } = await runFailure(adapter, "vendor/failure-fixture");
    assert.equal(completion.result.errorStatus, 502);
    assert.equal(events.some((event) => event.kind === "output.delta"), fixture.partial);
    if (fixture.partial) assert.equal(completion.result.finalResponse, "partial");
    assertFailureContract(completion, events);
  });
}

class ThrowingOpenAIClient implements OpenAIResponsesClient {
  constructor(private readonly status: number) {}

  async listModels() { return [{ id: "gpt-failure-fixture" }]; }

  async createResponse(_request: ResponseCreateParamsStreaming, _signal: AbortSignal) {
    const status = this.status;
    return (async function* (): AsyncIterable<ResponseStreamEvent> {
      yield {
        type: "response.output_text.delta",
        sequence_number: 1,
        item_id: "failure-message",
        output_index: 0,
        content_index: 0,
        delta: "partial",
        logprobs: [],
      } as ResponseStreamEvent;
      throw Object.assign(new Error(`Authorization: Bearer ${secret}`), { status });
    })();
  }
}

function openAIAdapter(client: OpenAIResponsesClient): OpenAIProviderAdapter {
  return new OpenAIProviderAdapter({
    credentials: staticCredential(),
    clientFactory: () => client,
    createId: sequentialIds("failure-conversation", "failure-run"),
    modelAllowlist: ["gpt-failure-fixture"],
  });
}

function openRouterAdapter(fetchImpl: typeof fetch): OpenRouterProviderAdapter {
  return new OpenRouterProviderAdapter({
    credentials: staticCredential(),
    clientFactory: () => new OpenRouterHttpClient(secret, fetchImpl),
    createId: sequentialIds("failure-conversation", "failure-run"),
    modelAllowlist: ["vendor/failure-fixture"],
  });
}

function openRouterFetch(chatResponse: () => Response): typeof fetch {
  return async (input) => {
    const url = String(input);
    if (url.includes("/models/user")) return jsonResponse({ data: [rawModel()] });
    if (url.includes("/models?zdr=true")) return jsonResponse({ data: [rawModel()] });
    if (url.includes("/endpoints/zdr")) return jsonResponse({ data: [{
      model_id: "vendor/failure-fixture",
      provider_name: "Failure Fixture",
      tag: "failure-fixture",
    }] });
    if (url.endsWith("/chat/completions")) return chatResponse();
    if (url.endsWith("/key")) return jsonResponse({ data: {} });
    return new Response(null, { status: 404 });
  };
}

function rawModel() {
  return {
    id: "vendor/failure-fixture",
    name: "Failure Fixture",
    supported_parameters: [],
    architecture: { input_modalities: ["text"] },
  };
}

async function runFailure(
  adapter: OpenAIProviderAdapter | OpenRouterProviderAdapter,
  model: string,
): Promise<{ completion: ProviderRunCompletion; events: ProviderEvent[] }> {
  const events: ProviderEvent[] = [];
  const unsubscribe = adapter.subscribe((event) => events.push(event));
  const run = await adapter.startRun({
    cwd: process.cwd(),
    prompt: "exercise the partial stream fixture",
    model,
  });
  const completion = await run.completion;
  unsubscribe();
  return { completion, events };
}

function assertFailureContract(completion: ProviderRunCompletion, events: readonly ProviderEvent[]): void {
  assert.equal(completion.status, "failed");
  assert.equal(events[0]?.kind, "run.started");
  assert.equal(events.at(-1)?.kind, "run.failed");
  assert.equal(events.filter((event) => event.kind === "run.failed").length, 1);
  if (completion.result.providerId === "openrouter") {
    assert.deepEqual(completion.result.routing, {
      profile: "strict-zdr",
      requestedUpstreams: [],
      allowFallbacks: false,
    });
  }
  if (completion.result.providerId === "openai" || completion.result.providerId === "openrouter") {
    assert.equal((completion.result.modelVerification as { coding?: unknown } | undefined)?.coding, "not_tested");
  }
  assert.doesNotMatch(JSON.stringify({ completion, events }), new RegExp(`${secret}|Authorization|Bearer`));
}

function staticCredential() {
  return { async load() { return { apiKey: secret, source: "environment" as const }; } };
}

function sequentialIds(...values: string[]): () => string {
  return () => values.shift() ?? "unexpected-failure-fixture-id";
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
