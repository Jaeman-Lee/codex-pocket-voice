import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import type { ResponseCreateParamsStreaming, ResponseStreamEvent } from "openai/resources/responses/responses";
import { GatewayAuth } from "../src/gateway-auth.js";
import { MediaManager } from "../src/media-manager.js";
import { PathPolicy } from "../src/path-policy.js";
import { ProjectManager } from "../src/project-manager.js";
import type { CodexProviderClient } from "../src/providers/codex-provider.js";
import {
  OpenAIProviderAdapter,
  type OpenAIResponsesClient,
} from "../src/providers/openai-provider.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { startWebServer, type WebCodexClient } from "../src/web-server.js";

const cwd = process.cwd();
const secret = "sk-gateway-must-never-leak";

test("gateway injects OpenAI runtime and exposes only common safe events", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "codex-pocket-openai-gateway-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const paths = await PathPolicy.fromEnvironment(cwd);
  const projects = await ProjectManager.fromEnvironment(paths, stateDir);
  const auth = await GatewayAuth.create({
    stateFile: join(stateDir, "auth.json"),
    pairingCode: "87654321",
    deviceKind: "linux",
    deviceName: "OpenAI Gateway Test",
  });
  const apiClient = new GatewayOpenAIClient();
  const adapter = new OpenAIProviderAdapter({
    credentials: { async load() { return { apiKey: secret, source: "environment" }; } },
    clientFactory: () => apiClient,
    modelAllowlist: ["gpt-gateway-test"],
    defaultModel: "gpt-gateway-test",
  });
  const codex = unusedCodexClient();
  const providers = new ProviderRegistry(codex, [adapter]);
  const running = await startWebServer({
    client: codex,
    paths,
    staticDir: resolve(cwd, "client/dist"),
    media: new MediaManager({ rootDir: join(stateDir, "media") }),
    projects,
    auth,
    providers,
    port: 0,
  });
  t.after(() => running.close());
  const base = `http://127.0.0.1:${running.port}`;
  const paired = await jsonFetch(`${base}/api/pairing/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost" },
    body: JSON.stringify({ code: "87654321", label: "OpenAI test app" }),
  });
  const headers = { Authorization: `Bearer ${paired.token}` };
  const connection = await jsonFetch(`${base}/api/providers/openai/test`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json", Origin: "http://localhost" },
    body: "{}",
  });
  assert.equal(connection.test.modelCount, 1);
  assert.equal(apiClient.responseCalls, 0);
  const mixedConversation = await fetch(`${base}/api/runs`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json", Origin: "http://localhost" },
    body: JSON.stringify({
      prompt: "must not borrow a Codex thread",
      cwd,
      threadId: "thread-from-codex",
      provider: "openai",
      accountId: "api-default",
      model: "gpt-gateway-test",
    }),
  });
  assert.equal(mixedConversation.status, 409);
  assert.match(JSON.stringify(await mixedConversation.json()), /threadId is reserved/);
  assert.equal(apiClient.responseCalls, 0);

  const streamAbort = new AbortController();
  const stream = await fetch(`${base}/api/events`, { headers, signal: streamAbort.signal });
  const reader = stream.body!.getReader();
  await reader.read();

  const completedRun = await startRun(base, headers, "gateway response");
  assert.equal(completedRun.operation.providerId, "openai");
  assert.equal(completedRun.operation.threadId, undefined);
  const frames = await readUntil(reader, (value) => value.includes(`\"id\":\"${completedRun.operation.id}\"`)
    && value.includes('"action":"completed"'));
  assert.match(frames, /"type":"provider"/);
  assert.match(frames, /"kind":"output\.delta"/);
  assert.match(frames, /"kind":"usage\.updated"/);
  assert.doesNotMatch(frames, /response\.created|sequence_number|sk-gateway|"params"/);

  const completed = await waitForOperation(base, headers, completedRun.operation.id, "completed");
  assert.equal(completed.result.finalResponse, "gateway response");
  assert.equal(completed.result.usage.totalTokens, 9);
  assert.equal(apiClient.requests[0]?.store, false);
  assert.equal(apiClient.requests[0]?.stream, true);

  const cancellable = await startRun(base, headers, "block until cancelled");
  await waitFor(() => apiClient.responseCalls >= 2);
  const interrupted = await jsonFetch(`${base}/api/runs/${cancellable.operation.id}/interrupt`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json", Origin: "http://localhost" },
    body: "{}",
  });
  assert.equal(interrupted.interruptRequested, true);
  await waitForOperation(base, headers, cancellable.operation.id, "interrupted");

  const rejected = await startRun(base, headers, "reject safely");
  const failed = await waitForOperation(base, headers, rejected.operation.id, "failed");
  assert.equal(failed.error, "OpenAI API key가 거부되었습니다.");
  assert.doesNotMatch(JSON.stringify(failed), /sk-gateway|Bearer/);
  streamAbort.abort();
});

class GatewayOpenAIClient implements OpenAIResponsesClient {
  readonly requests: ResponseCreateParamsStreaming[] = [];
  responseCalls = 0;

  async listModels() {
    return [{ id: "gpt-gateway-test" }];
  }

  async createResponse(request: ResponseCreateParamsStreaming, signal: AbortSignal) {
    this.requests.push(request);
    this.responseCalls += 1;
    const call = this.responseCalls;
    if (call === 1) {
      return streamEvents([
        responseEvent({ type: "response.created", sequence_number: 1, response: { id: "resp-gateway" } }),
        responseEvent({
          type: "response.output_text.delta",
          sequence_number: 2,
          item_id: "message-gateway",
          output_index: 0,
          content_index: 0,
          delta: "gateway response",
          logprobs: [],
        }),
        responseEvent({
          type: "response.completed",
          sequence_number: 3,
          response: {
            id: "resp-gateway",
            output_text: "gateway response",
            usage: {
              input_tokens: 5,
              input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
              output_tokens: 4,
              output_tokens_details: { reasoning_tokens: 0 },
              total_tokens: 9,
            },
          },
        }),
      ], signal);
    }
    if (call === 2) return blockingStream(signal);
    throw Object.assign(new Error(`Authorization: Bearer ${secret}`), { status: 401 });
  }
}

async function startRun(base: string, headers: Record<string, string>, prompt: string) {
  return jsonFetch(`${base}/api/runs`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json", Origin: "http://localhost" },
    body: JSON.stringify({
      requestId: `request-${prompt}`,
      prompt,
      cwd,
      provider: "openai",
      accountId: "api-default",
      model: "gpt-gateway-test",
    }),
  });
}

async function waitForOperation(
  base: string,
  headers: Record<string, string>,
  operationId: string,
  status: string,
) {
  let latest: any;
  await waitFor(async () => {
    latest = await jsonFetch(`${base}/api/runs/${operationId}`, { headers });
    return latest.operation.status === status;
  });
  return latest.operation;
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (value: string) => boolean,
): Promise<string> {
  let value = "";
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await reader.read();
    if (result.done) break;
    value += new TextDecoder().decode(result.value);
    if (predicate(value)) return value;
  }
  throw new Error(`SSE condition was not met: ${value}`);
}

function streamEvents(events: readonly ResponseStreamEvent[], signal: AbortSignal): AsyncIterable<ResponseStreamEvent> {
  return (async function* () {
    for (const event of events) {
      if (signal.aborted) throw abortError();
      yield event;
    }
  })();
}

function blockingStream(signal: AbortSignal): AsyncIterable<ResponseStreamEvent> {
  return (async function* () {
    await new Promise<void>((_resolve, reject) => {
      if (signal.aborted) return reject(abortError());
      signal.addEventListener("abort", () => reject(abortError()), { once: true });
    });
    yield responseEvent({ type: "response.created", sequence_number: 1, response: { id: "never" } });
  })();
}

function responseEvent(value: Record<string, unknown>): ResponseStreamEvent {
  return value as unknown as ResponseStreamEvent;
}

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("condition was not met");
}

async function jsonFetch(url: string, init?: RequestInit): Promise<any> {
  const response = await fetch(url, init);
  const body = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(body)}`);
  return body;
}

function unusedCodexClient(): WebCodexClient & CodexProviderClient {
  return {
    async start() {
      return { userAgent: "unused-codex", codexHome: cwd, platformFamily: "unix", platformOs: "linux" };
    },
    async listModels() { return { data: [], nextCursor: null }; },
    async listThreads() { return { data: [], nextCursor: null, backwardsCursor: null }; },
    async readThread() { throw new Error("not used"); },
    async beginTurn() { throw new Error("not used"); },
    async interrupt() { throw new Error("not used"); },
    subscribe() { return () => undefined; },
  };
}
