import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { InMemoryApprovalBroker } from "../src/approval-broker.js";
import { GatewayAuth } from "../src/gateway-auth.js";
import { MediaManager } from "../src/media-manager.js";
import { PathPolicy } from "../src/path-policy.js";
import { ProjectManager } from "../src/project-manager.js";
import type { CodexProviderClient } from "../src/providers/codex-provider.js";
import {
  OpenRouterProviderAdapter,
  type OpenRouterChatChunk,
  type OpenRouterChatRequest,
  type OpenRouterClient,
} from "../src/providers/openrouter-provider.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { createReadOnlyWorkspaceTools } from "../src/read-only-tools.js";
import { LocalToolBroker } from "../src/tool-broker.js";
import { startWebServer, type WebCodexClient } from "../src/web-server.js";

const cwd = process.cwd();
const secret = "sk-or-v1-gateway-secret-value";

test("gateway exposes OpenRouter only through safe common events and strict routing", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "codex-pocket-openrouter-gateway-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const paths = await PathPolicy.fromEnvironment(cwd);
  const projects = await ProjectManager.fromEnvironment(paths, stateDir);
  const auth = await GatewayAuth.create({
    stateFile: join(stateDir, "auth.json"),
    pairingCode: "13572468",
    deviceKind: "linux",
    deviceName: "OpenRouter Gateway Test",
  });
  const approvals = new InMemoryApprovalBroker();
  t.after(() => approvals.close());
  const toolBroker = new LocalToolBroker(createReadOnlyWorkspaceTools(paths), approvals, paths);
  const apiClient = new GatewayOpenRouterClient();
  const adapter = new OpenRouterProviderAdapter({
    credentials: { async load() { return { apiKey: secret, source: "environment" }; } },
    clientFactory: () => apiClient,
    modelAllowlist: ["vendor/gateway-tool"],
    defaultModel: "vendor/gateway-tool",
    toolBroker,
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
    body: JSON.stringify({ code: "13572468", label: "OpenRouter test app" }),
  });
  const headers = { Authorization: `Bearer ${paired.token}` };
  const connection = await jsonFetch(`${base}/api/providers/openrouter/test`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json", Origin: "http://localhost" },
    body: "{}",
  });
  assert.equal(connection.test.modelCount, 1);
  assert.equal(apiClient.chatCalls, 0);
  const modelCatalog = await jsonFetch(`${base}/api/models?provider=openrouter`, { headers });
  assert.deepEqual(modelCatalog.models[0].pricing, { inputPerMillionUsd: 2, outputPerMillionUsd: 6 });
  assert.deepEqual(modelCatalog.models[0].capabilities, { tools: true, imageInput: false });
  assert.equal(modelCatalog.models[0].routingOptions[0].latencyP50Ms, 180);
  assert.equal(modelCatalog.models[0].routingOptions[0].supportsTools, true);

  const duplicateRouting = await fetch(`${base}/api/runs`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json", Origin: "http://localhost" },
    body: JSON.stringify({
      prompt: "invalid duplicate route",
      cwd,
      provider: "openrouter",
      accountId: "api-default",
      model: "vendor/gateway-tool",
      routing: { upstreams: ["strict-primary", "strict-primary"], allowFallbacks: true },
    }),
  });
  assert.equal(duplicateRouting.status, 400);
  const untrustedRouting = await fetch(`${base}/api/runs`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json", Origin: "http://localhost" },
    body: JSON.stringify({
      prompt: "invalid untrusted route",
      cwd,
      provider: "openrouter",
      accountId: "api-default",
      model: "vendor/gateway-tool",
      routing: { upstreams: ["untrusted-provider"], allowFallbacks: false },
    }),
  });
  assert.equal(untrustedRouting.status, 409);
  assert.equal(apiClient.chatCalls, 0);

  const streamAbort = new AbortController();
  const stream = await fetch(`${base}/api/events`, { headers, signal: streamAbort.signal });
  const reader = stream.body!.getReader();
  await reader.read();

  const started = await jsonFetch(`${base}/api/runs`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json", Origin: "http://localhost" },
    body: JSON.stringify({
      requestId: "openrouter-gateway-run",
      prompt: "Inspect Git status",
      cwd,
      provider: "openrouter",
      accountId: "api-default",
      model: "vendor/gateway-tool",
      routing: { upstreams: ["strict-primary", "strict-backup"], allowFallbacks: true },
    }),
  });
  assert.deepEqual(started.operation.routing, {
    upstreams: ["strict-primary", "strict-backup"],
    allowFallbacks: true,
  });
  const frames = await readUntil(reader, (value) => value.includes(`\"id\":\"${started.operation.id}\"`)
    && value.includes('"action":"completed"'));
  assert.match(frames, /"type":"provider"/);
  assert.match(frames, /"kind":"tool\.started"/);
  assert.match(frames, /"kind":"tool\.completed"/);
  assert.match(frames, /"kind":"output\.delta"/);
  assert.match(frames, /"kind":"usage\.updated"/);
  assert.doesNotMatch(frames, /sk-or-v1|hiddenSensitivePaths|choices|tool_calls|prompt_tokens/);

  const operation = await waitForOperation(base, headers, started.operation.id, "completed");
  assert.equal(operation.result.finalResponse, "OpenRouter gateway complete");
  assert.equal(operation.result.routedProvider, "Strict Backup");
  assert.equal(operation.result.routing.actualUpstream, "strict-backup");
  assert.equal(operation.result.usage.totalTokens, 9);
  assert.equal(operation.result.usage.costCredits, 0.0015);
  assert.equal(operation.resumable, true);
  assert.equal(operation.resumeState, undefined);
  assert.doesNotMatch(frames, /resumeState/);
  assert.equal(apiClient.requests.length, 2);
  assert.deepEqual(apiClient.requests[0]?.provider, {
    allow_fallbacks: true,
    require_parameters: true,
    data_collection: "deny",
    zdr: true,
    order: ["strict-primary", "strict-backup"],
    only: ["strict-primary", "strict-backup"],
  });
  assert.match(JSON.stringify(apiClient.requests[1]?.messages), /function_call_output|hiddenSensitivePaths/);

  const changedConversationRouting = await fetch(`${base}/api/runs`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json", Origin: "http://localhost" },
    body: JSON.stringify({
      requestId: "openrouter-gateway-changed-routing",
      prompt: "Change the upstream mid-conversation",
      cwd,
      provider: "openrouter",
      accountId: "api-default",
      model: "vendor/gateway-tool",
      conversationId: operation.conversationId,
      routing: { upstreams: ["strict-backup"], allowFallbacks: false },
    }),
  });
  assert.equal(changedConversationRouting.status, 409);
  assert.equal(apiClient.requests.length, 2);

  const continued = await jsonFetch(`${base}/api/runs`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json", Origin: "http://localhost" },
    body: JSON.stringify({
      requestId: "openrouter-gateway-continued",
      prompt: "Summarize that result",
      cwd,
      provider: "openrouter",
      accountId: "api-default",
      model: "vendor/gateway-tool",
      conversationId: operation.conversationId,
    }),
  });
  assert.equal(continued.operation.conversationId, operation.conversationId);
  assert.deepEqual(continued.operation.routing, started.operation.routing);
  const continuedOperation = await waitForOperation(base, headers, continued.operation.id, "completed");
  assert.equal(continuedOperation.resumable, true);
  const replayedMessages = JSON.stringify(apiClient.requests[2]?.messages);
  assert.match(replayedMessages, /Inspect Git status/);
  assert.match(replayedMessages, /OpenRouter gateway complete/);
  assert.match(replayedMessages, /Summarize that result/);
  assert.deepEqual(apiClient.requests[2]?.provider, apiClient.requests[0]?.provider);
  const listed = await jsonFetch(`${base}/api/runs`, { headers });
  const conversationRuns = listed.operations.filter((item: any) => item.conversationId === operation.conversationId);
  assert.equal(conversationRuns.filter((item: any) => item.resumable).length, 1);
  assert.equal(conversationRuns.some((item: any) => item.resumeState !== undefined), false);
  streamAbort.abort();
});

class GatewayOpenRouterClient implements OpenRouterClient {
  readonly requests: OpenRouterChatRequest[] = [];
  chatCalls = 0;

  async testKey() {
    return { label: "gateway-key", limitRemaining: 1 };
  }

  async listModels() {
    return [{
      id: "vendor/gateway-tool",
      name: "Gateway Tool Model",
      supportedParameters: ["tools"],
      inputModalities: ["text"],
      pricing: { inputPerMillionUsd: 2, outputPerMillionUsd: 6 },
      upstreams: [
        {
          id: "strict-primary",
          name: "Strict Primary",
          pricing: { inputPerMillionUsd: 2, outputPerMillionUsd: 6 },
          latencyP50Ms: 180,
          throughputP50: 80,
          uptime30m: 99.9,
          quantization: "fp16",
          supportsTools: true,
        },
        { id: "strict-backup", name: "Strict Backup" },
      ],
    }];
  }

  async createChat(request: OpenRouterChatRequest, signal: AbortSignal) {
    this.requests.push(structuredClone(request));
    this.chatCalls += 1;
    const events: OpenRouterChatChunk[] = this.chatCalls === 1 ? [{
      id: "generation-gateway-tool",
      provider: "Strict Backup",
      choices: [{
        delta: { tool_calls: [{
          index: 0,
          id: "call-gateway-git",
          type: "function",
          function: { name: "git_status", arguments: "{}" },
        }] },
        finish_reason: "tool_calls",
      }],
      usage: usage(2, 1, 0.0005),
    }] : [{
      id: "generation-gateway-final",
      provider: "Strict Backup",
      choices: [{ delta: { content: "OpenRouter gateway complete" }, finish_reason: "stop" }],
      usage: usage(3, 3, 0.001),
    }];
    return streamEvents(events, signal);
  }
}

function usage(prompt: number, completion: number, cost: number) {
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    prompt_tokens_details: { cached_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: 0 },
    cost,
  };
}

function streamEvents(events: readonly OpenRouterChatChunk[], signal: AbortSignal): AsyncIterable<OpenRouterChatChunk> {
  return (async function* () {
    for (const event of events) {
      if (signal.aborted) throw new Error("aborted");
      yield event;
    }
  })();
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
    async unsubscribeThread() { return { status: "notLoaded" }; },
    subscribe() { return () => undefined; },
  };
}
