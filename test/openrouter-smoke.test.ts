import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { parseProviderModelGradeReport } from "../src/providers/model-grades.js";

const execFileAsync = promisify(execFile);

test("protected OpenRouter smoke stays allowlisted, bounded, strict, and redacted", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-pocket-openrouter-smoke-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const reportPath = join(directory, "report.json");
  const secret = "sk-or-v1-smoke-fixture-secret";
  const requests: Array<{ path: string; authorization?: string; metadata?: string; body?: any }> = [];
  let marker = "";
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    requests.push({
      path: request.url ?? "",
      authorization: request.headers.authorization,
      metadata: request.headers["x-openrouter-metadata"] as string | undefined,
      body,
    });
    if (request.url === "/api/v1/key") return json(response, { data: { limit_remaining: 1 } });
    if (request.url === "/api/v1/endpoints/zdr") return json(response, { data: [{
      model_id: "vendor/eval-model",
      tag: "strict-eval",
      provider_name: "Strict Eval",
      supported_parameters: ["tools", "tool_choice", "max_tokens"],
      pricing: { prompt: "0.000001", completion: "0.000002", request: "0" },
    }] });
    if (request.url === "/api/v1/chat/completions" && body?.tools) {
      marker = body.tools[0].function.parameters.properties.token.enum[0];
      return json(response, {
        model: "vendor/eval-model",
        provider: "Strict Eval",
        choices: [{ message: { content: null, tool_calls: [{
          id: "call-smoke",
          type: "function",
          function: { name: "contract_probe", arguments: JSON.stringify({ token: marker }) },
        }] } }],
        usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25, cost: 0.001 },
        openrouter_metadata: routingMetadata(),
      });
    }
    if (request.url === "/api/v1/chat/completions") return json(response, {
      model: "vendor/eval-model",
      provider: "Strict Eval",
      choices: [{ message: { content: marker } }],
      usage: { prompt_tokens: 30, completion_tokens: 4, total_tokens: 34, cost: 0.001 },
      openrouter_metadata: routingMetadata(),
    });
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server did not bind");

  const result = await execFileAsync(process.execPath, ["scripts/openrouter-smoke.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      OPENROUTER_API_KEY: secret,
      OPENROUTER_SMOKE_MODELS: "vendor/eval-model",
      OPENROUTER_SMOKE_MODEL: "vendor/eval-model",
      OPENROUTER_SMOKE_UPSTREAM: "strict-eval",
      OPENROUTER_SMOKE_MAX_USD: "0.02",
      OPENROUTER_SMOKE_REPORT: reportPath,
      OPENROUTER_SMOKE_API_BASE: `http://127.0.0.1:${address.port}/api/v1`,
      OPENROUTER_SMOKE_TEST_MODE: "1",
    },
  });
  const reportText = await readFile(reportPath, "utf8");
  const report = JSON.parse(reportText);
  assert.equal(parseProviderModelGradeReport(reportText).verification.projectRead, "not_tested");
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.calls, 2);
  assert.equal(report.actualCostCredits, 0.002);
  assert.equal(report.creditBaseCurrency, "USD");
  assert.deepEqual(report.pricingBasis, {
    currency: "USD",
    inputUsdPerMillion: 1,
    outputUsdPerMillion: 2,
    requestUsd: 0,
    source: "zdr_endpoint_catalog",
  });
  assert.deepEqual(report.actualProviders, ["Strict Eval"]);
  assert.deepEqual(report.grades, {
    conversation: "pass",
    toolCalling: "pass",
    projectRead: "not_tested",
    coding: "not_tested",
  });
  assert.equal(requests.filter((item) => item.path === "/api/v1/chat/completions").length, 2);
  for (const request of requests.filter((item) => item.body)) {
    assert.deepEqual(request.body.provider, {
      order: ["strict-eval"],
      only: ["strict-eval"],
      allow_fallbacks: false,
      require_parameters: true,
      data_collection: "deny",
      zdr: true,
    });
    assert.equal(request.body.max_tokens, 64);
    assert.equal(request.metadata, "enabled");
  }
  assert.equal(requests.every((item) => item.authorization === `Bearer ${secret}`), true);
  assert.doesNotMatch(`${result.stdout}${result.stderr}${reportText}`, new RegExp(`${secret}|${marker}`));
  assert.equal((await stat(reportPath)).mode & 0o777, 0o600);
});

test("protected OpenRouter smoke rejects incomplete endpoint contracts before inference", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-pocket-openrouter-preflight-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let chatCalls = 0;
  const server = createServer((request, response) => {
    if (request.url === "/api/v1/key") return json(response, { data: { limit_remaining: 1 } });
    if (request.url === "/api/v1/endpoints/zdr") return json(response, { data: [{
      model_id: "vendor/eval-model",
      tag: "strict-eval",
      provider_name: "Strict Eval",
      supported_parameters: ["tools"],
      pricing: { prompt: "0.000001", completion: "0.000002" },
    }] });
    if (request.url === "/api/v1/chat/completions") chatCalls += 1;
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server did not bind");
  await assert.rejects(runSmoke(address.port, join(directory, "report.json")), /does not advertise tool_choice/);
  assert.equal(chatCalls, 0);
});

test("protected OpenRouter smoke rejects routing metadata that cannot prove the upstream", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-pocket-openrouter-routing-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const reportPath = join(directory, "report.json");
  let marker = "";
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    if (request.url === "/api/v1/key") return json(response, { data: { limit_remaining: 1 } });
    if (request.url === "/api/v1/endpoints/zdr") return json(response, { data: [{
      model_id: "vendor/eval-model",
      tag: "strict-eval",
      provider_name: "Strict Eval",
      supported_parameters: ["tools", "tool_choice", "max_tokens"],
      pricing: { prompt: "0.000001", completion: "0.000002" },
    }] });
    if (request.url === "/api/v1/chat/completions") {
      marker = body.tools[0].function.parameters.properties.token.enum[0];
      return json(response, {
        model: "vendor/eval-model",
        choices: [{ message: { content: null, tool_calls: [] } }],
        usage: { prompt_tokens: 20, completion_tokens: 1, total_tokens: 21, cost: 0.001 },
        openrouter_metadata: {
          ...routingMetadata(),
          endpoints: { available: [{ provider: "Unexpected Provider", model: "vendor/eval-model", selected: true }] },
        },
      });
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server did not bind");
  await assert.rejects(runSmoke(address.port, reportPath), /did not prove the selected strict upstream/);
  await assert.rejects(readFile(reportPath, "utf8"), /ENOENT/);
  assert.notEqual(marker, "");
});

test("protected OpenRouter smoke rejects a direct-run budget above two cents", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-pocket-openrouter-budget-cap-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const reportPath = join(directory, "report.json");
  await assert.rejects(runSmoke(1, reportPath, "0.020001"), /budget is invalid/);
  await assert.rejects(readFile(reportPath, "utf8"), /ENOENT/);
});

function routingMetadata(): Record<string, unknown> {
  return {
    requested: "vendor/eval-model",
    strategy: "direct",
    attempt: 1,
    endpoints: { available: [{ provider: "Strict Eval", model: "vendor/eval-model", selected: true }] },
    attempts: [{ provider: "Strict Eval", model: "vendor/eval-model", status: 200 }],
  };
}

async function runSmoke(
  port: number,
  reportPath: string,
  budget = "0.02",
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, ["scripts/openrouter-smoke.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      OPENROUTER_API_KEY: "sk-or-v1-negative-fixture-secret",
      OPENROUTER_SMOKE_MODELS: "vendor/eval-model",
      OPENROUTER_SMOKE_MODEL: "vendor/eval-model",
      OPENROUTER_SMOKE_UPSTREAM: "strict-eval",
      OPENROUTER_SMOKE_MAX_USD: budget,
      OPENROUTER_SMOKE_REPORT: reportPath,
      OPENROUTER_SMOKE_API_BASE: `http://127.0.0.1:${port}/api/v1`,
      OPENROUTER_SMOKE_TEST_MODE: "1",
    },
  });
}

function json(response: import("node:http").ServerResponse, value: unknown): void {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}
