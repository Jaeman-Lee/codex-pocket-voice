import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  ResponseCreateParamsStreaming,
  ResponseStreamEvent,
} from "openai/resources/responses/responses";
import {
  ProviderProjectEvalError,
  runProviderProjectEval,
  type ProviderProjectEvalAdapterContext,
  type ProviderProjectEvalConfig,
} from "../scripts/provider-project-eval.js";
import type {
  ProviderEvent,
  ProviderModel,
  ProviderRun,
  ProviderRunCompletion,
  ProviderRunInput,
} from "../src/providers/types.js";
import { ProtectedProviderModelGradeSource } from "../src/providers/model-grades.js";
import {
  OpenAIProviderAdapter,
  type OpenAIResponsesClient,
} from "../src/providers/openai-provider.js";

const now = Date.parse("2026-08-24T12:00:00.000Z");

test("protected OpenAI project read eval uses the real read tool and emits only a redacted grade", async (t) => {
  const fixture = await evalFixture(t, "openai", "read");
  const result = await runProviderProjectEval(fixture.config, {
    now: () => now,
    createId: () => "read-marker",
    createAdapter: (context) => new FakeEvalAdapter(context),
  });
  assert.equal(result.passed, true);
  assert.deepEqual(result.report.grades, {
    streaming: "pass",
    conversation: "pass",
    functionCalling: "pass",
    statelessReplay: "pass",
    projectRead: "pass",
    coding: "not_tested",
  });
  const report = await readFile(fixture.config.reportPath, "utf8");
  assert.doesNotMatch(report, /read-marker|project-eval-marker|project-eval-state/);
  assert.match(report, /ephemeral_synthetic_workspace/);
});

test("protected project eval drives the production OpenAI runtime and Tool Broker loop", async (t) => {
  const fixture = await evalFixture(t, "openai", "read");
  const client = new ProjectEvalOpenAIClient();
  const result = await runProviderProjectEval(fixture.config, {
    now: () => now,
    createId: () => "runtime-marker",
    createAdapter: (context) => new OpenAIProviderAdapter({
      credentials: { async load() { return { apiKey: "sk-eval-fixture", source: "environment" as const }; } },
      clientFactory: () => client,
      defaultModel: context.model,
      modelAllowlist: [context.model],
      toolBroker: context.broker,
      maxToolCallsPerRun: 1,
      modelGrades: context.gradeSource,
    }),
  });
  assert.equal(result.passed, true);
  assert.equal(client.requests.length, 2);
  assert.deepEqual(client.requests[0]?.tools?.map((tool) => record(tool)?.name), ["workspace_read"]);
  assert.match(JSON.stringify(client.requests[1]?.input), /function_call_output/);
  assert.doesNotMatch(await readFile(fixture.config.reportPath, "utf8"), /runtime-marker|sk-eval-fixture/);
});

test("protected OpenRouter coding eval requires one reviewed production replacement", async (t) => {
  const fixture = await evalFixture(t, "openrouter", "coding");
  const result = await runProviderProjectEval(fixture.config, {
    now: () => now,
    createId: () => "coding-marker",
    createAdapter: (context) => new FakeEvalAdapter(context),
  });
  assert.equal(result.passed, true);
  assert.deepEqual(result.report.grades, {
    conversation: "pass",
    toolCalling: "pass",
    projectRead: "pass",
    coding: "pass",
  });
  assert.deepEqual(result.report.actualProviders, ["Strict Eval"]);
  assert.equal(result.report.actualCostCredits, 0.001);
  const report = await readFile(fixture.config.reportPath, "utf8");
  assert.doesNotMatch(report, /coding-marker|project-eval-marker|project-eval-state|before/);
  assert.match(report, /protected_workflow_and_exact_confirmation/);
  assert.match(report, /workspace_replace_text/);
  const gradeDirectory = join(fixture.config.reportPath, "..", "installed-grades");
  await mkdir(gradeDirectory, { mode: 0o700 });
  await writeFile(join(gradeDirectory, "openrouter-reviewed.json"), report, { mode: 0o600 });
  const installed = await new ProtectedProviderModelGradeSource(
    { CODEX_POCKET_PROVIDER_GRADE_DIR: gradeDirectory },
    () => now,
  ).load("openrouter");
  assert.equal(installed.length, 1);
  assert.equal(installed[0]?.verification.projectRead, "pass");
  assert.equal(installed[0]?.verification.coding, "pass");
});

test("coding eval preserves a verified read grade when the model does not perform the change", async (t) => {
  const fixture = await evalFixture(t, "openai", "coding");
  const result = await runProviderProjectEval(fixture.config, {
    now: () => now,
    createId: () => "partial-marker",
    createAdapter: (context) => new FakeEvalAdapter(context, "read-only"),
  });
  assert.equal(result.passed, false);
  assert.equal((result.report.grades as Record<string, unknown>).projectRead, "pass");
  assert.equal((result.report.grades as Record<string, unknown>).coding, "fail");
  assert.equal((result.report.evaluation as Record<string, unknown>).outcome, "contract_failed");
  assert.doesNotMatch(await readFile(fixture.config.reportPath, "utf8"), /partial-marker/);
});

test("coding eval rejects a missing exact confirmation before model preflight", async (t) => {
  const fixture = await evalFixture(t, "openai", "coding");
  fixture.config.codingConfirmation = "yes";
  let adapterCreated = false;
  await assert.rejects(
    runProviderProjectEval(fixture.config, {
      now: () => now,
      createAdapter: (context) => {
        adapterCreated = true;
        return new FakeEvalAdapter(context);
      },
    }),
    (error: unknown) => error instanceof ProviderProjectEvalError
      && /confirmation is missing/.test(error.message),
  );
  assert.equal(adapterCreated, false);
  await assert.rejects(readFile(fixture.config.reportPath, "utf8"), /ENOENT/);
});

test("project eval rejects a world-readable smoke artifact", async (t) => {
  const fixture = await evalFixture(t, "openrouter", "read");
  await chmod(fixture.config.smokeReportPath, 0o644);
  await assert.rejects(
    runProviderProjectEval(fixture.config, {
      now: () => now,
      createAdapter: (context) => new FakeEvalAdapter(context),
    }),
    /could not be read safely/,
  );
});

test("OpenRouter project grade fails closed when Provider cost evidence is missing", async (t) => {
  const fixture = await evalFixture(t, "openrouter", "read");
  const result = await runProviderProjectEval(fixture.config, {
    now: () => now,
    createId: () => "missing-cost-marker",
    createAdapter: (context) => new FakeEvalAdapter(context, "missing-cost"),
  });
  assert.equal(result.passed, false);
  assert.equal((result.report.grades as Record<string, unknown>).projectRead, "fail");
  assert.equal(result.report.actualCostCredits, null);
  assert.doesNotMatch(await readFile(fixture.config.reportPath, "utf8"), /missing-cost-marker/);
});

test("project grade rejects a single Provider request above its input-token ceiling", async (t) => {
  const fixture = await evalFixture(t, "openai", "read");
  const result = await runProviderProjectEval(fixture.config, {
    now: () => now,
    createId: () => "oversize-input-marker",
    createAdapter: (context) => new FakeEvalAdapter(context, "input-overflow"),
  });
  assert.equal(result.passed, false);
  assert.equal((result.report.grades as Record<string, unknown>).projectRead, "fail");
  assert.doesNotMatch(await readFile(fixture.config.reportPath, "utf8"), /oversize-input-marker/);
});

type FakeBehavior = "pass" | "read-only" | "missing-cost" | "input-overflow";

class FakeEvalAdapter {
  private readonly listeners = new Set<(event: ProviderEvent) => void>();

  constructor(
    private readonly context: ProviderProjectEvalAdapterContext,
    private readonly behavior: FakeBehavior = "pass",
  ) {}

  async listModels(): Promise<ProviderModel[]> {
    const verification = {
      scope: this.context.upstream ? "upstream" as const : "model" as const,
      conversation: "pass" as const,
      projectRead: "pass" as const,
      coding: this.context.scope === "coding" ? "pass" as const : "not_tested" as const,
    };
    return [{
      id: this.context.model,
      displayName: this.context.model,
      description: "fixture",
      isDefault: true,
      defaultEffort: "",
      efforts: [],
      capabilities: {
        tools: true,
        imageInput: false,
        workspaceRead: true,
        workspaceWrite: this.context.scope === "coding",
      },
      verification,
      ...(this.context.upstream ? {
        routingOptions: [{
          id: this.context.upstream,
          displayName: "Strict Eval",
          supportsTools: true,
          pricing: {
            inputPerMillionUsd: 1,
            outputPerMillionUsd: 2,
            requestUsd: 0,
          },
          verification,
        }],
      } : {}),
    }];
  }

  async startRun(input: ProviderRunInput): Promise<ProviderRun> {
    const conversationId = "eval-conversation";
    const runId = "eval-run";
    return {
      providerId: this.context.provider,
      conversationId,
      runId,
      cwd: input.cwd,
      completion: this.complete(input, conversationId, runId),
    };
  }

  async cancelRun(): Promise<void> {}

  subscribe(listener: (event: ProviderEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async complete(
    input: ProviderRunInput,
    conversationId: string,
    runId: string,
  ): Promise<ProviderRunCompletion> {
    const read = await this.context.broker.execute({
      providerId: this.context.provider,
      conversationId,
      runId,
      toolCallId: "read-call",
      name: "workspace_read",
      input: { path: "task.txt", start_line: null, end_line: null },
    }, { cwd: input.cwd });
    const output = record(read.output);
    const content = String(output?.content ?? "");
    let finalResponse = content.split("=")[1]?.trim() ?? "";
    this.emitUsage(conversationId, runId, 1, this.behavior === "input-overflow" ? 9_000 : 40, 8);
    if (this.context.scope === "coding" && this.behavior === "pass") {
      const match = input.prompt.match(/complete content ("(?:[^"\\]|\\.)*")\./);
      const target = match?.[1] ? JSON.parse(match[1]) as string : "";
      await this.context.broker.execute({
        providerId: this.context.provider,
        conversationId,
        runId,
        toolCallId: "replace-call",
        name: "workspace_replace_text",
        input: {
          path: "task.txt",
          expected_sha256: output?.sha256,
          content: target,
        },
      }, { cwd: input.cwd });
      finalResponse = "DONE";
      this.emitUsage(conversationId, runId, 2, 75, 14);
    }
    const requestCount = this.context.scope === "read" ? 2 : this.behavior === "pass" ? 3 : 2;
    this.emitUsage(
      conversationId,
      runId,
      requestCount,
      this.behavior === "input-overflow" ? 9_100 : 100,
      20,
    );
    return {
      status: "completed",
      result: {
        providerId: this.context.provider,
        model: this.context.model,
        finalResponse,
        usage: {
          requestCount,
          inputTokens: this.behavior === "input-overflow" ? 9_100 : 100,
          outputTokens: 20,
          totalTokens: this.behavior === "input-overflow" ? 9_120 : 120,
          ...(this.context.provider === "openrouter" && this.behavior !== "missing-cost"
            ? { costCredits: 0.001 }
            : {}),
        },
        ...(this.context.provider === "openrouter" ? {
          routing: {
            profile: "strict-zdr",
            requestedUpstreams: [this.context.upstream],
            allowFallbacks: false,
            actualProvider: "Strict Eval",
            actualUpstream: this.context.upstream,
          },
        } : {}),
      },
    };
  }

  private emitUsage(
    conversationId: string,
    runId: string,
    requestCount: number,
    inputTokens: number,
    outputTokens: number,
  ): void {
    const usage = {
      requestCount,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      ...(this.context.provider === "openrouter" && this.behavior !== "missing-cost"
        ? { costCredits: requestCount === 1 ? 0.0003 : requestCount === 2 ? 0.0007 : 0.001 }
        : {}),
    };
    for (const listener of this.listeners) listener({
      providerId: this.context.provider,
      conversationId,
      runId,
      kind: "usage.updated",
      usage,
    });
  }
}

class ProjectEvalOpenAIClient implements OpenAIResponsesClient {
  readonly requests: ResponseCreateParamsStreaming[] = [];

  async listModels() {
    return [{ id: "gpt-eval-model" }];
  }

  async createResponse(request: ResponseCreateParamsStreaming, signal: AbortSignal) {
    this.requests.push(request);
    const responseEvent = this.requests.length === 1
      ? openAIEvent({
          type: "response.completed",
          sequence_number: 1,
          response: {
            id: "response-read-tool",
            output_text: "",
            output: [{
              type: "function_call",
              id: "function-read-tool",
              call_id: "call-read-tool",
              name: "workspace_read",
              arguments: JSON.stringify({ path: "task.txt", start_line: null, end_line: null }),
              status: "completed",
            }],
            usage: openAIUsage(40, 8),
          },
        })
      : openAIEvent({
          type: "response.completed",
          sequence_number: 1,
          response: {
            id: "response-read-final",
            output_text: markerFromToolOutput(request),
            output: [openAIMessage("message-read-final", markerFromToolOutput(request))],
            usage: openAIUsage(60, 12),
          },
        });
    return (async function* () {
      if (signal.aborted) throw new Error("aborted");
      yield responseEvent;
    })();
  }
}

async function evalFixture(
  t: test.TestContext,
  provider: "openai" | "openrouter",
  scope: "read" | "coding",
): Promise<{ config: ProviderProjectEvalConfig }> {
  const directory = await mkdtemp(join(tmpdir(), "codex-pocket-provider-project-eval-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const smokeReportPath = join(directory, "smoke.json");
  await writeFile(
    smokeReportPath,
    `${JSON.stringify(provider === "openai" ? openAISmoke() : openRouterSmoke())}\n`,
    { mode: 0o600 },
  );
  return {
    config: {
      provider,
      scope,
      model: provider === "openai" ? "gpt-eval-model" : "vendor/eval-model",
      ...(provider === "openrouter" ? { upstream: "strict-eval" } : {}),
      smokeReportPath,
      reportPath: join(directory, "grade.json"),
      budgetUsd: 0.05,
      ...(provider === "openai" ? { inputUsdPerMillion: 1, outputUsdPerMillion: 2 } : {}),
      ...(scope === "coding" ? { codingConfirmation: "APPROVE_SYNTHETIC_CODING_EVAL" } : {}),
    },
  };
}

function openAISmoke(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    provider: "openai",
    requestedModel: "gpt-eval-model",
    actualModel: "gpt-eval-model",
    privacyProfile: { store: false, serviceTier: "default" },
    grades: {
      streaming: "pass",
      conversation: "pass",
      functionCalling: "pass",
      statelessReplay: "pass",
      projectRead: "not_tested",
      coding: "not_tested",
    },
    checkedAt: new Date(now).toISOString(),
  };
}

function openRouterSmoke(): Record<string, unknown> {
  return {
    schemaVersion: 2,
    provider: "openrouter",
    model: "vendor/eval-model",
    requestedUpstream: "strict-eval",
    actualProviders: ["Strict Eval"],
    privacyProfile: { zdr: true, dataCollection: "deny", allowFallbacks: false },
    grades: {
      conversation: "pass",
      toolCalling: "pass",
      projectRead: "not_tested",
      coding: "not_tested",
    },
    checkedAt: new Date(now).toISOString(),
  };
}

function record(value: unknown): Record<string, any> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, any>
    : null;
}

function markerFromToolOutput(request: ResponseCreateParamsStreaming): string {
  const items = Array.isArray(request.input) ? request.input : [];
  const output = items.find((item) => record(item)?.type === "function_call_output");
  const envelope = record(JSON.parse(String(record(output)?.output ?? "{}")));
  const toolOutput = record(envelope?.output);
  const content = String(toolOutput?.content ?? "");
  return content.split("=")[1]?.trim() ?? "";
}

function openAIUsage(inputTokens: number, outputTokens: number) {
  return {
    input_tokens: inputTokens,
    input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
    output_tokens: outputTokens,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: inputTokens + outputTokens,
  };
}

function openAIMessage(id: string, text: string) {
  return {
    type: "message",
    id,
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text, annotations: [], logprobs: [] }],
  };
}

function openAIEvent(value: Record<string, unknown>): ResponseStreamEvent {
  return value as unknown as ResponseStreamEvent;
}
