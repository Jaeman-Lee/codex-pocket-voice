import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { InMemoryApprovalBroker } from "../src/approval-broker.js";
import { PathPolicy } from "../src/path-policy.js";
import {
  EnvironmentOpenRouterCredentialSource,
  type OpenRouterCredentialSource,
} from "../src/providers/openrouter-credentials.js";
import {
  OpenRouterHttpClient,
  OpenRouterProviderAdapter,
  type OpenRouterChatChunk,
  type OpenRouterChatRequest,
  type OpenRouterClient,
  type OpenRouterModelRecord,
} from "../src/providers/openrouter-provider.js";
import type { ProviderEvent } from "../src/providers/types.js";
import { LocalToolBroker, type RegisteredTool } from "../src/tool-broker.js";
import { passingModelGrade, StaticProviderModelGradeSource } from "../src/providers/model-grades.js";

const secret = "sk-or-v1-test-super-secret-value";

test("OpenRouter resumes a bounded local conversation without retaining image data", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-pocket-openrouter-resume-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const imagePath = join(directory, "screen.png");
  await writeFile(imagePath, new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), { mode: 0o600 });
  const client = new FakeOpenRouterClient([
    [chunk({
      id: "generation-resume-one",
      provider: "Provider A",
      choices: [{ delta: { content: "첫 답변" }, finish_reason: "stop" }],
      usage: usage(3, 2, 0, 0.001),
    })],
    [chunk({
      id: "generation-resume-two",
      provider: "Provider A",
      choices: [{ delta: { content: "둘째 답변" }, finish_reason: "stop" }],
      usage: usage(5, 2, 0, 0.001),
    })],
  ], models());
  const adapter = new OpenRouterProviderAdapter({
    credentials: staticCredentials(secret),
    clientFactory: () => client,
    createId: sequentialIds("resume-conversation", "resume-run-one", "resume-run-two"),
    modelAllowlist: ["vendor/tool-model"],
    defaultModel: "vendor/tool-model",
  });
  assert.equal((await adapter.describe()).capabilities.resume, true);

  const first = await adapter.startRun({
    cwd: process.cwd(),
    prompt: "첫 질문",
    model: "vendor/tool-model",
    imagePaths: [imagePath],
  });
  const firstCompletion = await first.completion;
  assert.equal(firstCompletion.result.resumeAvailable, true);
  assert.match(JSON.stringify(client.requests[0]), /data:image\/png;base64,/);
  assert.doesNotMatch(JSON.stringify(firstCompletion.resumeState), /data:image\/png;base64,/);
  assert.match(JSON.stringify(firstCompletion.resumeState), /보안상 대화 replay에서 제외/);

  const second = await adapter.startRun({
    cwd: process.cwd(),
    prompt: "둘째 질문",
    model: "vendor/tool-model",
    conversationId: first.conversationId,
    resumeState: firstCompletion.resumeState,
  });
  assert.equal(second.conversationId, first.conversationId);
  assert.equal((await second.completion).result.finalResponse, "둘째 답변");
  const replay = JSON.stringify(client.requests[1]?.messages);
  assert.ok(replay.indexOf("첫 질문") < replay.indexOf("첫 답변"));
  assert.ok(replay.indexOf("첫 답변") < replay.indexOf("둘째 질문"));
  assert.doesNotMatch(replay, /data:image\/png;base64,/);
  assert.deepEqual(client.requests[1]?.provider, {
    allow_fallbacks: false,
    require_parameters: true,
    data_collection: "deny",
    zdr: true,
  });
});

test("OpenRouter enforces server-authored output and total-token hard limits", async () => {
  const client = new FakeOpenRouterClient([[chunk({
    id: "router-over-limit",
    choices: [{ delta: { content: "too much" }, finish_reason: "stop" }],
    usage: usage(60, 5, 0, 0.001),
  })]], models());
  const adapter = new OpenRouterProviderAdapter({
    credentials: staticCredentials("sk-or-limit"),
    clientFactory: () => client,
    modelAllowlist: ["vendor/chat-model"],
    defaultModel: "vendor/chat-model",
  });
  const run = await adapter.startRun({
    cwd: process.cwd(),
    prompt: "bounded",
    model: "vendor/chat-model",
    limits: { maxOutputTokens: 64, maxTotalTokens: 64 },
  });
  const completion = await run.completion;
  assert.equal(completion.status, "failed");
  assert.match(String(completion.result.error), /hard limit/);
  assert.deepEqual(completion.result.usage, {
    requestCount: 1,
    inputTokens: 60,
    cachedInputTokens: 0,
    outputTokens: 5,
    reasoningTokens: 0,
    totalTokens: 65,
    costCredits: 0.001,
  });
  assert.equal(client.requests.length, 1);
  assert.equal(client.requests[0]?.max_tokens, 64);
  await assert.rejects(adapter.startRun({
    cwd: process.cwd(),
    prompt: "invalid",
    model: "vendor/chat-model",
    limits: { maxOutputTokens: 63, maxTotalTokens: 64 },
  }), /limit/);
  assert.equal(client.requests.length, 1);
});

test("OpenRouter runs strict ZDR project tools and keeps unsupported models chat-only", async (t) => {
  const paths = await PathPolicy.fromEnvironment(process.cwd());
  const approvals = new InMemoryApprovalBroker();
  t.after(() => approvals.close());
  let readExecutions = 0;
  const readTool: RegisteredTool<{ path: string }> = {
    definition: {
      name: "workspace_read",
      description: "Read a safe project fixture",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
      risk: "observation",
    },
    validate(input) {
      const requested = typeof input === "object" && input !== null
        ? (input as { path?: unknown }).path
        : undefined;
      if (typeof requested !== "string") throw new Error("path required");
      return { path: requested };
    },
    approval: () => ({ redactedSummary: "read fixture" }),
    async execute(input) {
      readExecutions += 1;
      return { path: input.path, content: "safe OpenRouter context" };
    },
  };
  const hiddenWrite: RegisteredTool<Record<string, never>> = {
    definition: {
      name: "workspace_write",
      description: "Approval-gated write fixture",
      inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
      risk: "change",
    },
    validate: () => ({}),
    approval: () => ({ redactedSummary: "write" }),
    async execute() { throw new Error("must not execute"); },
  };
  const hiddenCommand: RegisteredTool<Record<string, never>> = {
    definition: {
      name: "project_verify",
      description: "Approval-gated verification fixture",
      inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
      risk: "execution",
    },
    validate: () => ({}),
    approval: () => ({ redactedSummary: "verify fixture", requiresTouch: true }),
    async execute() { throw new Error("must not execute"); },
  };
  const broker = new LocalToolBroker([readTool, hiddenWrite, hiddenCommand], approvals, paths);
  const client = new FakeOpenRouterClient([
    [
      chunk({
        id: "generation-tool",
        provider: "Provider A",
        choices: [{ delta: { tool_calls: [{
          index: 0,
          id: "call-read",
          type: "function",
          function: { name: "workspace_read", arguments: "{\"path\":" },
        }] }, finish_reason: null }],
      }),
      chunk({
        id: "generation-tool",
        choices: [{ delta: { tool_calls: [{
          index: 0,
          function: { arguments: "\"package.json\"}" },
        }] }, finish_reason: "tool_calls" }],
        usage: usage(3, 2, 1, 0.001),
      }),
    ],
    [
      chunk({
        id: "generation-final",
        provider: "Provider A",
        choices: [{ delta: { content: "확인 완료" }, finish_reason: null }],
      }),
      chunk({
        id: "generation-final",
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: usage(4, 3, 0, 0.002),
      }),
    ],
    [chunk({
      id: "generation-chat",
      provider: "Provider B",
      choices: [{ delta: { content: "대화 전용" }, finish_reason: "stop" }],
      usage: usage(2, 2, 0, 0.0005),
    })],
    [chunk({
      id: "generation-unverified-backup",
      provider: "Provider A",
      choices: [{ delta: { content: "백업 검증 필요" }, finish_reason: "stop" }],
      usage: usage(2, 2, 0, 0.0005),
    })],
  ], models());
  const adapter = new OpenRouterProviderAdapter({
    credentials: staticCredentials(secret),
    clientFactory: (apiKey) => {
      assert.equal(apiKey, secret);
      return client;
    },
    createId: sequentialIds("tool-conversation", "tool-run", "chat-conversation", "chat-run"),
    modelAllowlist: ["vendor/tool-model", "vendor/chat-model"],
    defaultModel: "vendor/tool-model",
    toolBroker: broker,
    modelGrades: openRouterGrades("vendor/tool-model", "provider-a"),
    now: () => Date.parse("2026-08-24T00:00:00.000Z"),
  });
  const events: ProviderEvent[] = [];
  adapter.subscribe((event) => events.push(event));

  const descriptor = await adapter.describe();
  assert.equal(descriptor.available, true);
  assert.equal(descriptor.capabilities.toolCalling, true);
  assert.equal(descriptor.capabilities.workspaceRead, true);
  assert.equal(descriptor.capabilities.approvals, true);
  assert.equal(descriptor.capabilities.workspaceWrite, true);
  assert.equal(descriptor.capabilities.commandExecution, true);
  const connection = await adapter.testConnection();
  assert.equal(connection.modelCount, 2);
  assert.match(connection.detail, /남은 key 한도 10 credits/);
  assert.equal(client.keyCalls, 1);
  assert.equal(client.chatCalls, 0);
  const listed = await adapter.listModels();
  assert.match(listed.find((model) => model.id === "vendor/tool-model")!.description, /verified coding/);
  assert.match(listed.find((model) => model.id === "vendor/chat-model")!.description, /chat-only/);
  assert.deepEqual(listed.find((model) => model.id === "vendor/tool-model")!.pricing, {
    inputPerMillionUsd: 1,
    outputPerMillionUsd: 2,
  });
  assert.equal(listed.find((model) => model.id === "vendor/tool-model")!.capabilities?.tools, true);
  assert.equal(listed.find((model) => model.id === "vendor/tool-model")!.routingOptions?.[0]?.verification?.coding, "pass");

  const run = await adapter.startRun({
    cwd: process.cwd(),
    prompt: "Inspect the project",
    model: "vendor/tool-model",
    routing: { upstreams: ["provider-a"], allowFallbacks: false },
    limits: { maxOutputTokens: 128, maxTotalTokens: 1_000 },
  });
  const completion = await run.completion;
  assert.equal(completion.status, "completed");
  assert.equal(completion.result.finalResponse, "확인 완료");
  assert.equal(completion.result.routedProvider, "Provider A");
  assert.deepEqual(completion.result.usage, {
    requestCount: 2,
    inputTokens: 7,
    cachedInputTokens: 0,
    outputTokens: 5,
    reasoningTokens: 1,
    totalTokens: 12,
    costCredits: 0.003,
  });
  assert.equal(readExecutions, 1);
  assert.equal(approvals.listPending().length, 0);
  assert.deepEqual(events.map((event) => event.kind), [
    "run.started",
    "usage.updated",
    "tool.started",
    "tool.completed",
    "output.delta",
    "usage.updated",
    "run.completed",
  ]);

  assert.equal(client.requests.length, 2);
  const first = client.requests[0]!;
  assert.deepEqual(first.provider, {
    allow_fallbacks: false,
    require_parameters: true,
    data_collection: "deny",
    zdr: true,
    order: ["provider-a"],
    only: ["provider-a"],
  });
  assert.equal(first.model, "vendor/tool-model");
  assert.equal(first.max_tokens, 128);
  assert.equal(client.requests[1]?.max_tokens, 128);
  assert.equal(first.parallel_tool_calls, false);
  assert.equal(first.tools?.length, 3);
  assert.equal(first.tools?.[0]?.function.name, "workspace_read");
  assert.equal(first.tools?.[1]?.function.name, "workspace_write");
  assert.equal(first.tools?.[2]?.function.name, "project_verify");
  assert.equal(first.tools?.[0]?.function.strict, true);
  const continuation = JSON.stringify(client.requests[1]?.messages);
  assert.match(continuation, /tool_calls|safe OpenRouter context/);
  assert.doesNotMatch(continuation, /workspace_write|project_verify|sk-or-v1/);

  events.length = 0;
  const chatRun = await adapter.startRun({
    cwd: process.cwd(),
    prompt: "Just chat",
    model: "vendor/chat-model",
  });
  assert.equal((await chatRun.completion).result.finalResponse, "대화 전용");
  const chatRequest = client.requests[2]!;
  assert.equal(chatRequest.tools, undefined);
  assert.deepEqual(chatRequest.messages, [{ role: "user", content: "Just chat" }]);

  const mixedGradeRun = await adapter.startRun({
    cwd: process.cwd(),
    prompt: "Do not expose tools to an unverified backup",
    model: "vendor/tool-model",
    routing: { upstreams: ["provider-a", "provider-b"], allowFallbacks: true },
  });
  assert.equal((await mixedGradeRun.completion).result.finalResponse, "백업 검증 필요");
  assert.equal(client.requests[3]?.tools, undefined);
  assert.equal(client.requests[3]?.parallel_tool_calls, undefined);
});

test("OpenRouter pauses a change tool until touch approval and reports the result to the same model", async (t) => {
  const paths = await PathPolicy.fromEnvironment(process.cwd());
  const approvals = new InMemoryApprovalBroker({ createId: () => "approval-openrouter-change" });
  t.after(() => approvals.close());
  let changes = 0;
  const changeTool: RegisteredTool<Record<string, never>> = {
    definition: {
      name: "workspace_replace_text",
      description: "Apply one reviewed change",
      inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
      risk: "change",
    },
    validate: () => ({}),
    approval: () => ({ redactedSummary: "Replace text in fixture", requiresTouch: true }),
    async execute() {
      changes += 1;
      return { changed: true };
    },
  };
  const broker = new LocalToolBroker([changeTool], approvals, paths);
  const client = new FakeOpenRouterClient([
    [chunk({
      id: "router-change-call",
      provider: "Provider A",
      choices: [{
        delta: { tool_calls: [{
          index: 0,
          id: "router-change-tool",
          type: "function",
          function: { name: "workspace_replace_text", arguments: "{}" },
        }] },
        finish_reason: "tool_calls",
      }],
      usage: usage(2, 1, 0, 0.001),
    })],
    [chunk({
      id: "router-change-done",
      provider: "Provider A",
      choices: [{ delta: { content: "변경 완료" }, finish_reason: "stop" }],
      usage: usage(2, 1, 0, 0.001),
    })],
  ], models());
  const adapter = new OpenRouterProviderAdapter({
    credentials: staticCredentials(secret),
    clientFactory: () => client,
    createId: sequentialIds("router-change-conversation", "router-change-run"),
    modelAllowlist: ["vendor/tool-model"],
    toolBroker: broker,
    modelGrades: openRouterGrades("vendor/tool-model", "provider-a"),
  });
  const run = await adapter.startRun({
    cwd: process.cwd(),
    prompt: "Apply the reviewed change",
    model: "vendor/tool-model",
    routing: { upstreams: ["provider-a"], allowFallbacks: false },
  });
  await waitFor(() => approvals.listPending().length === 1);
  assert.equal(changes, 0);
  const pending = approvals.listPending()[0]!;
  assert.equal(pending.toolCallId, "router-change-tool");
  approvals.resolve(pending.id, "approved", "touch");
  const completion = await run.completion;
  assert.equal(completion.status, "completed");
  assert.equal(changes, 1);
  assert.match(JSON.stringify(client.requests[1]?.messages), /completed|changed/);
});

test("OpenRouter locks routing to the user-approved strict ZDR upstream order", async () => {
  const client = new FakeOpenRouterClient([[
    chunk({
      provider: "Legacy Provider Field",
      openrouter_metadata: {
        requested: "vendor/tool-model",
        attempt: 1,
        endpoints: { available: [{ provider: "Provider B", model: "vendor/tool-model", selected: true }] },
      },
      choices: [{ delta: { content: "routed" }, finish_reason: "stop" }],
      usage: usage(2, 1, 0, 0.001),
    }),
  ]], models());
  const adapter = new OpenRouterProviderAdapter({
    credentials: staticCredentials(secret),
    clientFactory: () => client,
    modelAllowlist: ["vendor/tool-model"],
    defaultModel: "vendor/tool-model",
  });
  const run = await adapter.startRun({
    cwd: process.cwd(),
    prompt: "route safely",
    model: "vendor/tool-model",
    routing: { upstreams: ["provider-a", "provider-b"], allowFallbacks: true },
  });
  const completion = await run.completion;
  assert.deepEqual(client.requests[0]?.provider, {
    allow_fallbacks: true,
    require_parameters: true,
    data_collection: "deny",
    zdr: true,
    order: ["provider-a", "provider-b"],
    only: ["provider-a", "provider-b"],
  });
  assert.deepEqual(completion.result.routing, {
    profile: "strict-zdr",
    requestedUpstreams: ["provider-a", "provider-b"],
    allowFallbacks: true,
    actualProvider: "Provider B",
    actualUpstream: "provider-b",
  });
  await assert.rejects(
    adapter.startRun({
      cwd: process.cwd(),
      prompt: "untrusted route",
      model: "vendor/tool-model",
      routing: { upstreams: ["untrusted-provider"], allowFallbacks: false },
    }),
    /strict ZDR 목록/,
  );
  await assert.rejects(
    adapter.startRun({
      cwd: process.cwd(),
      prompt: "invalid fallback",
      model: "vendor/tool-model",
      routing: { upstreams: ["provider-a"], allowFallbacks: true },
    }),
    /두 개 이상/,
  );

  const unverifiable = new FakeOpenRouterClient([[
    chunk({
      provider: "Provider A",
      openrouter_metadata: {
        requested: "vendor/other-model",
        attempt: 1,
        endpoints: { available: [{ provider: "Provider A", model: "vendor/other-model", selected: true }] },
      },
      choices: [{ delta: { content: "unverified metadata" }, finish_reason: "stop" }],
    }),
  ]], models());
  const unverifiableAdapter = new OpenRouterProviderAdapter({
    credentials: staticCredentials(secret),
    clientFactory: () => unverifiable,
    modelAllowlist: ["vendor/tool-model"],
    defaultModel: "vendor/tool-model",
  });
  const unverifiableRun = await unverifiableAdapter.startRun({
    cwd: process.cwd(),
    prompt: "do not claim an unverified route",
    model: "vendor/tool-model",
    routing: { upstreams: ["provider-a"], allowFallbacks: false },
  });
  assert.deepEqual((await unverifiableRun.completion).result.routing, {
    profile: "strict-zdr",
    requestedUpstreams: ["provider-a"],
    allowFallbacks: false,
  });
});

test("OpenRouter rejects models outside the allowlist or current strict ZDR catalog", async () => {
  const client = new FakeOpenRouterClient([], models());
  const adapter = new OpenRouterProviderAdapter({
    credentials: staticCredentials(secret),
    clientFactory: () => client,
    modelAllowlist: ["vendor/missing-model"],
  });
  await assert.rejects(
    adapter.startRun({ cwd: process.cwd(), prompt: "do not bill", model: "vendor/unknown" }),
    /허용 목록/,
  );
  await assert.rejects(
    adapter.startRun({ cwd: process.cwd(), prompt: "do not bill", model: "vendor/missing-model" }),
    /strict ZDR routing/,
  );
  assert.equal(client.chatCalls, 0);
});

test("OpenRouter model cache is isolated across credential rotation", async () => {
  let activeKey = "sk-or-v1-first-test-key";
  const first = new FakeOpenRouterClient([], [{
    id: "vendor/first-model",
    name: "First Model",
    supportedParameters: [],
    inputModalities: ["text"],
  }]);
  const second = new FakeOpenRouterClient([], [{
    id: "vendor/second-model",
    name: "Second Model",
    supportedParameters: [],
    inputModalities: ["text"],
  }]);
  const adapter = new OpenRouterProviderAdapter({
    credentials: { async load() { return { apiKey: activeKey, source: "environment" }; } },
    clientFactory: (apiKey) => apiKey === activeKey && activeKey.includes("first") ? first : second,
    modelAllowlist: ["vendor/first-model", "vendor/second-model"],
  });

  assert.deepEqual((await adapter.listModels()).map((model) => model.id), ["vendor/first-model"]);
  activeKey = "sk-or-v1-second-test-key";
  assert.deepEqual((await adapter.listModels()).map((model) => model.id), ["vendor/second-model"]);
  assert.equal(first.modelCalls, 1);
  assert.equal(second.modelCalls, 1);
});

test("OpenRouter cancellation aborts streaming and API errors never expose credentials", async () => {
  const blocking = new BlockingOpenRouterClient();
  const adapter = new OpenRouterProviderAdapter({
    credentials: staticCredentials(secret),
    clientFactory: () => blocking,
    createId: sequentialIds("cancel-conversation", "cancel-run"),
    modelAllowlist: ["vendor/chat-model"],
  });
  const events: ProviderEvent[] = [];
  adapter.subscribe((event) => events.push(event));
  const run = await adapter.startRun({
    cwd: process.cwd(),
    prompt: "wait",
    model: "vendor/chat-model",
  });
  await waitFor(() => events.some((event) => event.kind === "run.started"));
  await adapter.cancelRun(run.conversationId, run.runId);
  const completion = await run.completion;
  assert.equal(completion.status, "interrupted");
  assert.equal(blocking.aborted, true);
  assert.equal(events.at(-1)?.kind, "run.completed");

  const rejected = new OpenRouterProviderAdapter({
    credentials: staticCredentials(secret),
    clientFactory: () => ({
      async testKey() { throw Object.assign(new Error(`Bearer ${secret}`), { status: 401 }); },
      async listModels() { return []; },
      async createChat() { throw new Error("not used"); },
    }),
    modelAllowlist: ["vendor/chat-model"],
  });
  await assert.rejects(
    rejected.testConnection(),
    (error: unknown) => {
      assert.match(String(error), /API key가 거부/);
      assert.doesNotMatch(String(error), /sk-or-v1|Bearer/);
      return true;
    },
  );
});

test("OpenRouter credentials require a private file", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-pocket-openrouter-key-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const keyFile = join(directory, "api-key");
  await writeFile(keyFile, `${secret}\n`, { mode: 0o600 });
  const source = new EnvironmentOpenRouterCredentialSource({
    CODEX_POCKET_OPENROUTER_API_KEY_FILE: keyFile,
  });
  assert.deepEqual(await source.load(), { apiKey: secret, source: "protected_file" });
  await chmod(keyFile, 0o644);
  await assert.rejects(source.load(), /0600/);
});

test("OpenRouter HTTP client intersects user models with ZDR and parses SSE without exposing the key", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.endsWith("/key")) return jsonResponse({ data: {
      label: "safe-key",
      limit: 20,
      limit_remaining: 8,
      usage: 12,
      limit_reset: "monthly",
      expires_at: "2027-12-31T23:59:59Z",
    } });
    if (url.includes("/models/user")) return jsonResponse({ data: [
      rawModel("vendor/tool-model", ["tools"], ["text"]),
      rawModel("vendor/non-zdr", [], ["text"]),
    ] });
    if (url.includes("/models?zdr=true")) return jsonResponse({ data: [rawModel("vendor/tool-model", ["tools"], ["text"])] });
    if (url.includes("/endpoints/zdr")) return jsonResponse({ data: [{
      model_id: "vendor/tool-model",
      provider_name: "Strict Provider",
      tag: "strict-provider",
      pricing: { prompt: "0.0000015", completion: "0.000003", request: "0.01", image: "0" },
      latency_last_30m: { p50: 0.25 },
      throughput_last_30m: { p50: 45.2 },
      uptime_last_30m: 99.5,
      quantization: "fp16",
      supported_parameters: ["tools", "max_tokens"],
    }] });
    if (url.endsWith("/chat/completions")) {
      const stream = [
        `data: ${JSON.stringify({ id: "generation-http", choices: [{ delta: { content: "hello" }, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({
          id: "generation-http",
          choices: [{ delta: {}, finish_reason: "stop" }],
          usage: usage(1, 1, 0, 0.1),
          openrouter_metadata: {
            requested: "vendor/tool-model",
            attempt: 1,
            endpoints: { available: [{ provider: "Strict Provider", model: "vendor/tool-model", selected: true }] },
          },
        })}\n\n`,
        "data: [DONE]\n\n",
      ].join("");
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }
    return new Response(null, { status: 404 });
  };
  const client = new OpenRouterHttpClient(secret, fakeFetch);
  assert.deepEqual(await client.testKey(), {
    label: "safe-key",
    limit: 20,
    limitRemaining: 8,
    usage: 12,
    limitReset: "monthly",
    expiresAt: "2027-12-31T23:59:59.000Z",
  });
  const listed = await client.listModels();
  assert.deepEqual(listed.map((model) => model.id), ["vendor/tool-model"]);
  assert.deepEqual(listed[0]?.pricing, { inputPerMillionUsd: 1, outputPerMillionUsd: 2 });
  assert.equal(listed[0]?.expiresAt, "2027-12-31T23:59:59.000Z");
  assert.deepEqual(listed[0]?.upstreams, [{
    id: "strict-provider",
    name: "Strict Provider",
    pricing: { inputPerMillionUsd: 1.5, outputPerMillionUsd: 3, requestUsd: 0.01, imageUsd: 0 },
    latencyP50Ms: 250,
    throughputP50: 45.2,
    uptime30m: 99.5,
    quantization: "fp16",
    supportsTools: true,
  }]);
  const request: OpenRouterChatRequest = {
    model: "vendor/tool-model",
    messages: [{ role: "user", content: "hello" }],
    stream: true,
    provider: { allow_fallbacks: false, require_parameters: true, data_collection: "deny", zdr: true },
  };
  const chunks: OpenRouterChatChunk[] = [];
  for await (const item of await client.createChat(request, new AbortController().signal)) chunks.push(item);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0]?.choices?.[0]?.delta?.content, "hello");
  assert.equal(requests.every((item) => item.init?.headers !== undefined), true);
  const chatRequest = requests.find((item) => item.url.endsWith("/chat/completions"));
  assert.equal(new Headers(chatRequest?.init?.headers).get("X-OpenRouter-Metadata"), "enabled");
  assert.equal(requests.some((item) => String(item.init?.body ?? "").includes(secret)), false);
});

class FakeOpenRouterClient implements OpenRouterClient {
  readonly requests: OpenRouterChatRequest[] = [];
  keyCalls = 0;
  modelCalls = 0;
  chatCalls = 0;

  constructor(
    private readonly rounds: Array<readonly OpenRouterChatChunk[]>,
    private readonly catalog: readonly OpenRouterModelRecord[],
  ) {}

  async testKey() {
    this.keyCalls += 1;
    return { label: "test-key", limitRemaining: 10 };
  }

  async listModels() {
    this.modelCalls += 1;
    return this.catalog;
  }

  async createChat(request: OpenRouterChatRequest, signal: AbortSignal) {
    this.requests.push(structuredClone(request));
    this.chatCalls += 1;
    const round = this.rounds.shift();
    if (!round) throw new Error("unexpected OpenRouter chat call");
    return (async function* () {
      for (const item of round) {
        if (signal.aborted) throw abortError();
        yield item;
      }
    })();
  }
}

class BlockingOpenRouterClient implements OpenRouterClient {
  aborted = false;

  async testKey() { return {}; }

  async listModels() {
    return [{
      id: "vendor/chat-model",
      name: "Chat Model",
      supportedParameters: [],
      inputModalities: ["text"],
    }];
  }

  async createChat(_request: OpenRouterChatRequest, signal: AbortSignal) {
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
      yield chunk({ id: "never", choices: [] });
    })();
  }
}

function models(): OpenRouterModelRecord[] {
  return [
    {
      id: "vendor/tool-model",
      name: "Tool Model",
      contextLength: 100_000,
      supportedParameters: ["tools", "tool_choice"],
      inputModalities: ["text", "image"],
      pricing: { inputPerMillionUsd: 1, outputPerMillionUsd: 2 },
      expiresAt: "2027-12-31T23:59:59.000Z",
      upstreams: [
        { id: "provider-a", name: "Provider A", latencyP50Ms: 250, supportsTools: true },
        { id: "provider-b", name: "Provider B" },
      ],
    },
    {
      id: "vendor/chat-model",
      name: "Chat Model",
      supportedParameters: [],
      inputModalities: ["text"],
      upstreams: [{ id: "provider-a", name: "Provider A" }],
    },
  ];
}

function staticCredentials(apiKey: string): OpenRouterCredentialSource {
  return { async load() { return { apiKey, source: "environment" }; } };
}

function openRouterGrades(model: string, ...upstreams: string[]): StaticProviderModelGradeSource {
  return new StaticProviderModelGradeSource(upstreams.map((upstream) => (
    passingModelGrade("openrouter", model, upstream)
  )));
}

function sequentialIds(...ids: string[]): () => string {
  return () => ids.shift() ?? "unexpected-id";
}

function chunk(value: OpenRouterChatChunk): OpenRouterChatChunk {
  return value;
}

function usage(prompt: number, completion: number, reasoning: number, cost: number) {
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    prompt_tokens_details: { cached_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: reasoning },
    cost,
  };
}

function rawModel(id: string, supportedParameters: string[], inputModalities: string[]) {
  return {
    id,
    name: id,
    supported_parameters: supportedParameters,
    architecture: { input_modalities: inputModalities },
    pricing: { prompt: "0.000001", completion: "0.000002" },
    expiration_date: "2027-12-31T23:59:59Z",
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
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
