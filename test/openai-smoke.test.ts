import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { parseProviderModelGradeReport } from "../src/providers/model-grades.js";

const execFileAsync = promisify(execFile);

test("protected OpenAI smoke streams a bounded store:false function replay and writes a redacted report", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-pocket-openai-smoke-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const reportPath = join(directory, "report.json");
  const secret = "fixture-openai-smoke-secret";
  const requests: Array<{ path: string; authorization?: string; body?: any }> = [];
  let marker = "";
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    requests.push({ path: request.url ?? "", authorization: request.headers.authorization, body });
    if (request.method === "GET" && request.url === "/v1/models/gpt-eval-model") {
      return json(response, { id: "gpt-eval-model", object: "model", created: 1, owned_by: "fixture" });
    }
    if (request.method === "POST" && request.url === "/v1/responses" && body?.tool_choice?.name) {
      marker = body.tools[0].parameters.properties.token.enum[0];
      return stream(response, [{
        type: "response.completed",
        sequence_number: 0,
        response: completedResponse({
          id: "resp-tool",
          output: [
            { type: "reasoning", id: "reasoning-tool", summary: [], encrypted_content: "encrypted-tool-context" },
            {
              type: "function_call",
              id: "function-tool",
              call_id: "call-contract-probe",
              name: "contract_probe",
              arguments: JSON.stringify({ token: marker }),
              status: "completed",
            },
          ],
          outputText: "",
          usage: usage(20, 5, 2),
        }),
      }]);
    }
    if (request.method === "POST" && request.url === "/v1/responses") {
      return stream(response, [
        {
          type: "response.output_text.delta",
          sequence_number: 0,
          item_id: "message-final",
          output_index: 0,
          content_index: 0,
          delta: marker,
          logprobs: [],
        },
        {
          type: "response.completed",
          sequence_number: 1,
          response: completedResponse({
            id: "resp-final",
            output: [{
              type: "message",
              id: "message-final",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: marker, annotations: [] }],
            }],
            outputText: marker,
            usage: usage(30, 4, 0),
          }),
        },
      ]);
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server did not bind");

  const result = await runSmoke(address.port, reportPath, { apiKey: secret });
  const reportText = await readFile(reportPath, "utf8");
  const report = JSON.parse(reportText);
  assert.equal(parseProviderModelGradeReport(reportText).verification.projectRead, "not_tested");
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.provider, "openai");
  assert.equal(report.requestedModel, "gpt-eval-model");
  assert.equal(report.actualModel, "gpt-eval-model");
  assert.equal(report.calls, 2);
  assert.deepEqual(report.privacyProfile, { store: false, serviceTier: "default" });
  assert.equal(report.budgetUsd, 0.02);
  assert.equal(report.estimatedMaximumUsd, 0.009216);
  assert.ok(Math.abs(report.actualEstimatedUsd - 0.000068) < 1e-12);
  assert.deepEqual(report.pricingBasis, {
    currency: "USD",
    inputUsdPerMillion: 1,
    outputUsdPerMillion: 2,
    source: "operator_reviewed",
  });
  assert.deepEqual(report.usage, [
    { inputTokens: 20, cachedInputTokens: 0, outputTokens: 5, reasoningTokens: 2, totalTokens: 25 },
    { inputTokens: 30, cachedInputTokens: 0, outputTokens: 4, reasoningTokens: 0, totalTokens: 34 },
  ]);
  assert.deepEqual(report.grades, {
    streaming: "pass",
    conversation: "pass",
    functionCalling: "pass",
    statelessReplay: "pass",
    projectRead: "not_tested",
    coding: "not_tested",
  });
  assert.equal(requests.filter((item) => item.path === "/v1/responses").length, 2);
  const responseRequests = requests.filter((item) => item.body).map((item) => item.body);
  for (const body of responseRequests) {
    assert.equal(body.model, "gpt-eval-model");
    assert.equal(body.store, false);
    assert.equal(body.stream, true);
    assert.equal(body.max_output_tokens, 256);
    assert.equal(body.service_tier, "default");
    assert.equal(body.parallel_tool_calls, false);
    assert.deepEqual(body.include, ["reasoning.encrypted_content"]);
    assert.equal(body.tools[0].name, "contract_probe");
    assert.equal(body.tools[0].strict, true);
  }
  assert.deepEqual(responseRequests[0].tool_choice, { type: "function", name: "contract_probe" });
  assert.equal(responseRequests[1].tool_choice, "none");
  assert.match(JSON.stringify(responseRequests[1].input), /encrypted-tool-context/);
  assert.match(JSON.stringify(responseRequests[1].input), /function_call_output/);
  assert.equal(requests.every((item) => item.authorization === `Bearer ${secret}`), true);
  assert.doesNotMatch(
    `${result.stdout}${result.stderr}${reportText}`,
    new RegExp(`${secret}|${marker}|encrypted-tool-context`),
  );
  assert.equal((await stat(reportPath)).mode & 0o777, 0o600);
});

test("protected OpenAI smoke rejects a model outside the exact allowlist before any request", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-pocket-openai-allowlist-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const reportPath = join(directory, "report.json");
  await assert.rejects(runSmoke(1, reportPath, {
    allowedModels: "gpt-other-model",
  }), /Selected model is not in OPENAI_SMOKE_MODELS/);
  await assert.rejects(readFile(reportPath, "utf8"), /ENOENT/);
});

test("protected OpenAI smoke rejects an operator price ceiling above budget before any request", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-pocket-openai-budget-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const reportPath = join(directory, "report.json");
  await assert.rejects(runSmoke(1, reportPath, {
    inputPrice: "100",
    outputPrice: "100",
  }), /Configured token ceiling exceeds the smoke budget/);
  await assert.rejects(readFile(reportPath, "utf8"), /ENOENT/);
});

test("protected OpenAI smoke rejects a direct-run budget above two cents", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-pocket-openai-budget-cap-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const reportPath = join(directory, "report.json");
  await assert.rejects(runSmoke(1, reportPath, { budget: "0.020001" }), /budget is invalid/);
  await assert.rejects(readFile(reportPath, "utf8"), /ENOENT/);
});

test("protected OpenAI smoke rejects unbounded reported usage without writing model output", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-pocket-openai-usage-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const reportPath = join(directory, "report.json");
  let marker = "";
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    if (request.method === "GET") {
      return json(response, { id: "gpt-eval-model", object: "model", created: 1, owned_by: "fixture" });
    }
    marker = body.tools[0].parameters.properties.token.enum[0];
    return stream(response, [{
      type: "response.completed",
      sequence_number: 0,
      response: completedResponse({
        id: "resp-unbounded",
        output: [{
          type: "function_call",
          id: "function-unbounded",
          call_id: "call-unbounded",
          name: "contract_probe",
          arguments: JSON.stringify({ token: marker }),
          status: "completed",
        }],
        outputText: "",
        usage: usage(4_097, 1, 0),
      }),
    }]);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server did not bind");

  await assert.rejects(runSmoke(address.port, reportPath), /omitted bounded token usage/);
  await assert.rejects(readFile(reportPath, "utf8"), /ENOENT/);
  assert.notEqual(marker, "");
});

async function runSmoke(
  port: number,
  reportPath: string,
  overrides: {
    apiKey?: string;
    allowedModels?: string;
    budget?: string;
    inputPrice?: string;
    outputPrice?: string;
  } = {},
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, ["scripts/openai-smoke.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      OPENAI_API_KEY: overrides.apiKey ?? "fixture-openai-negative-secret",
      OPENAI_SMOKE_MODELS: overrides.allowedModels ?? "gpt-eval-model",
      OPENAI_SMOKE_MODEL: "gpt-eval-model",
      OPENAI_SMOKE_MAX_USD: overrides.budget ?? "0.02",
      OPENAI_SMOKE_INPUT_USD_PER_MTOK: overrides.inputPrice ?? "1",
      OPENAI_SMOKE_OUTPUT_USD_PER_MTOK: overrides.outputPrice ?? "2",
      OPENAI_SMOKE_REPORT: reportPath,
      OPENAI_SMOKE_API_BASE: `http://127.0.0.1:${port}/v1`,
      OPENAI_SMOKE_TEST_MODE: "1",
    },
  });
}

function completedResponse(options: {
  id: string;
  output: unknown[];
  outputText: string;
  usage: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    id: options.id,
    object: "response",
    created_at: 1,
    completed_at: 2,
    status: "completed",
    model: "gpt-eval-model",
    output: options.output,
    output_text: options.outputText,
    usage: options.usage,
    service_tier: "default",
  };
}

function usage(inputTokens: number, outputTokens: number, reasoningTokens: number): Record<string, unknown> {
  return {
    input_tokens: inputTokens,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: outputTokens,
    output_tokens_details: { reasoning_tokens: reasoningTokens },
    total_tokens: inputTokens + outputTokens,
  };
}

function json(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}

function stream(response: ServerResponse, events: unknown[]): void {
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const event of events) {
    const type = (event as { type?: string }).type ?? "message";
    response.write(`event: ${type}\ndata: ${JSON.stringify(event)}\n\n`);
  }
  response.end("data: [DONE]\n\n");
}
