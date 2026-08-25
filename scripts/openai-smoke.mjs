#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { lstat, writeFile } from "node:fs/promises";
import OpenAI from "openai";

const OFFICIAL_API_BASE = "https://api.openai.com/v1";
const MAX_CALLS = 2;
const MAX_INPUT_TOKENS_PER_CALL = 4_096;
const MAX_OUTPUT_TOKENS = 256;
const MAX_RESPONSE_BYTES = 256 * 1_024;
const MAX_STREAM_EVENTS = 10_000;
const MAX_TEXT_BYTES = 4_096;
const MAX_SMOKE_BUDGET_USD = 0.02;

class SmokeFailure extends Error {}

const apiKey = requiredEnvironment("OPENAI_API_KEY", 8_192);
const model = safeModelId(requiredEnvironment("OPENAI_SMOKE_MODEL", 200));
const reportPath = requiredEnvironment("OPENAI_SMOKE_REPORT", 4_096);
await requireUnusedReportPath();
const allowedModels = new Set(requiredEnvironment("OPENAI_SMOKE_MODELS", 4_096)
  .split(",").map((item) => item.trim()).filter(Boolean).map(safeModelId));
if (!allowedModels.has(model)) fail("Selected model is not in OPENAI_SMOKE_MODELS");
const budgetUsd = boundedNumber(
  requiredEnvironment("OPENAI_SMOKE_MAX_USD", 20),
  0.0001,
  MAX_SMOKE_BUDGET_USD,
  "budget",
);
const inputUsdPerMillion = boundedNumber(
  requiredEnvironment("OPENAI_SMOKE_INPUT_USD_PER_MTOK", 20),
  0.000001,
  100,
  "input price",
);
const outputUsdPerMillion = boundedNumber(
  requiredEnvironment("OPENAI_SMOKE_OUTPUT_USD_PER_MTOK", 20),
  0.000001,
  100,
  "output price",
);
const estimatedMaximumUsd = MAX_CALLS * (
  MAX_INPUT_TOKENS_PER_CALL * inputUsdPerMillion
  + MAX_OUTPUT_TOKENS * outputUsdPerMillion
) / 1_000_000;
if (estimatedMaximumUsd > budgetUsd) fail("Configured token ceiling exceeds the smoke budget");

const client = new OpenAI({
  apiKey,
  baseURL: smokeApiBase(),
  maxRetries: 0,
  timeout: 30_000,
});
await verifyModelAccess();

const marker = `cpv-contract-${randomUUID()}`;
const tool = {
  type: "function",
  name: "contract_probe",
  description: "Return the exact synthetic contract token.",
  parameters: {
    type: "object",
    properties: { token: { type: "string", enum: [marker] } },
    required: ["token"],
    additionalProperties: false,
  },
  strict: true,
};
const first = await streamResponse({
  ...baseRequest(),
  input: [{
    role: "user",
    content: [{
      type: "input_text",
      text: `Call contract_probe exactly once with token ${marker}. Do not answer in text.`,
    }],
  }],
  tool_choice: { type: "function", name: "contract_probe" },
});
const firstUsage = safeUsage(first.response);
const actualModel = safeActualModel(first.response.model);
const output = safeOutput(first.response.output);
const calls = output.filter((item) => item.type === "function_call");
if (calls.length !== 1) fail("Model did not return exactly one forced function call");
const call = calls[0];
if (call.name !== "contract_probe") fail("Model returned an unexpected function call");
const callId = safeIdentifier(call.call_id, 200, "function call ID");
let argumentsValue;
try {
  argumentsValue = JSON.parse(String(call.arguments));
} catch {
  fail("Model returned malformed function arguments");
}
if (!record(argumentsValue) || argumentsValue.token !== marker || Object.keys(argumentsValue).length !== 1) {
  fail("Model did not preserve the synthetic function contract token");
}

const second = await streamResponse({
  ...baseRequest(),
  input: [
    ...structuredClone(output),
    {
      type: "function_call_output",
      call_id: callId,
      output: JSON.stringify({ status: "completed", token: marker }),
    },
    {
      role: "user",
      content: [{ type: "input_text", text: `Reply with only ${marker}.` }],
    },
  ],
  tool_choice: "none",
});
const secondUsage = safeUsage(second.response);
if (safeActualModel(second.response.model) !== actualModel) fail("OpenAI smoke model changed between calls");
if (safeOutput(second.response.output).some((item) => item.type === "function_call")) {
  fail("Model returned an unexpected second function call");
}
const finalText = typeof second.response.output_text === "string" && second.response.output_text
  ? second.response.output_text
  : second.text;
if (finalText.trim() !== marker) fail("Model did not complete the synthetic stateless conversation contract");

const usage = [firstUsage, secondUsage];
const actualEstimatedUsd = usage.reduce((sum, item) => (
  sum
  + item.inputTokens * inputUsdPerMillion / 1_000_000
  + item.outputTokens * outputUsdPerMillion / 1_000_000
), 0);
if (actualEstimatedUsd > budgetUsd) fail("Reported token usage exceeded the configured smoke budget");
const report = {
  schemaVersion: 1,
  provider: "openai",
  requestedModel: model,
  actualModel,
  privacyProfile: { store: false, serviceTier: "default" },
  calls: MAX_CALLS,
  budgetUsd,
  estimatedMaximumUsd,
  actualEstimatedUsd,
  pricingBasis: {
    currency: "USD",
    inputUsdPerMillion,
    outputUsdPerMillion,
    source: "operator_reviewed",
  },
  usage,
  grades: {
    streaming: "pass",
    conversation: "pass",
    functionCalling: "pass",
    statelessReplay: "pass",
    projectRead: "not_tested",
    coding: "not_tested",
  },
  checkedAt: new Date().toISOString(),
};
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
process.stdout.write(`OpenAI Responses smoke passed for ${model}; report contains no prompt or response text.\n`);

function baseRequest() {
  return {
    model,
    store: false,
    stream: true,
    include: ["reasoning.encrypted_content"],
    max_output_tokens: MAX_OUTPUT_TOKENS,
    service_tier: "default",
    parallel_tool_calls: false,
    tools: [tool],
  };
}

async function verifyModelAccess() {
  let selected;
  try {
    selected = await client.models.retrieve(model);
  } catch {
    fail("OpenAI model preflight request failed");
  }
  if (!record(selected) || selected.id !== model) fail("OpenAI model preflight did not match the exact selection");
}

async function streamResponse(request) {
  let stream;
  try {
    stream = await client.responses.create(request);
  } catch {
    fail("OpenAI Responses smoke request failed");
  }
  let completed;
  let text = "";
  let events = 0;
  let previousSequence = -1;
  try {
    for await (const event of stream) {
      events += 1;
      if (events > MAX_STREAM_EVENTS) fail("OpenAI Responses stream exceeded the event limit");
      if (!Number.isSafeInteger(event.sequence_number) || event.sequence_number <= previousSequence) {
        fail("OpenAI Responses stream sequence is invalid");
      }
      previousSequence = event.sequence_number;
      if (event.type === "response.output_text.delta") {
        text += event.delta;
        if (Buffer.byteLength(text) > MAX_TEXT_BYTES) fail("OpenAI Responses text exceeded the smoke limit");
      } else if (event.type === "response.completed") {
        if (completed) fail("OpenAI Responses stream returned multiple terminal responses");
        completed = event.response;
      } else if (event.type === "response.failed" || event.type === "response.incomplete" || event.type === "error") {
        fail("OpenAI Responses stream ended without a completed response");
      }
    }
  } catch (error) {
    if (error instanceof SmokeFailure) throw error;
    fail("OpenAI Responses smoke stream failed");
  }
  if (!record(completed) || completed.status !== "completed") {
    fail("OpenAI Responses stream omitted its completed response");
  }
  const serialized = JSON.stringify(completed);
  if (Buffer.byteLength(serialized) > MAX_RESPONSE_BYTES) fail("OpenAI Responses object exceeded the smoke limit");
  if (typeof completed.output_text === "string" && text && completed.output_text !== text) {
    fail("OpenAI Responses streamed and completed text did not match");
  }
  return { response: completed, text };
}

function safeOutput(value) {
  if (!Array.isArray(value) || value.length > 32 || value.some((item) => !record(item))) {
    fail("OpenAI Responses output is invalid");
  }
  return value;
}

function safeUsage(response) {
  const usage = record(response.usage);
  const inputTokens = integer(usage?.input_tokens);
  const outputTokens = integer(usage?.output_tokens);
  const totalTokens = integer(usage?.total_tokens);
  const cachedInputTokens = integer(record(usage?.input_tokens_details)?.cached_tokens) ?? 0;
  const reasoningTokens = integer(record(usage?.output_tokens_details)?.reasoning_tokens) ?? 0;
  if (inputTokens === null || outputTokens === null || totalTokens === null
      || totalTokens !== inputTokens + outputTokens
      || inputTokens > MAX_INPUT_TOKENS_PER_CALL || outputTokens > MAX_OUTPUT_TOKENS
      || cachedInputTokens > inputTokens || reasoningTokens > outputTokens) {
    fail("OpenAI Responses smoke omitted bounded token usage");
  }
  return { inputTokens, cachedInputTokens, outputTokens, reasoningTokens, totalTokens };
}

function safeActualModel(value) {
  const actual = typeof value === "string" ? safeModelId(value) : fail("OpenAI response model is invalid");
  if (actual !== model && !actual.startsWith(`${model}-`)) fail("OpenAI response model did not match the selection");
  return actual;
}

function smokeApiBase() {
  const configured = process.env.OPENAI_SMOKE_API_BASE;
  if (!configured) return OFFICIAL_API_BASE;
  if (process.env.OPENAI_SMOKE_TEST_MODE !== "1") fail("Custom OpenAI smoke API base is test-only");
  const url = new URL(configured);
  if (url.protocol !== "http:" || (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")
      || url.username || url.password || !/^\/v1\/?$/.test(url.pathname) || url.search || url.hash) {
    fail("Custom OpenAI smoke API base must be loopback HTTP with the /v1 path");
  }
  return configured.replace(/\/$/, "");
}

async function requireUnusedReportPath() {
  try {
    await lstat(reportPath);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return;
    fail("OpenAI smoke report path cannot be inspected");
  }
  fail("OpenAI smoke report path already exists");
}

function requiredEnvironment(name, maximum) {
  const value = process.env[name];
  if (!value || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) fail(`${name} is missing or invalid`);
  return value;
}

function safeModelId(value) {
  if (!/^[a-z0-9][a-z0-9._:/-]{0,199}$/.test(value)) fail("OpenAI smoke model ID is invalid");
  return value;
}

function safeIdentifier(value, maximum, name) {
  if (typeof value !== "string" || value.length > maximum || !/^[A-Za-z0-9._:/-]+$/.test(value)) fail(`${name} is invalid`);
  return value;
}

function boundedNumber(value, minimum, maximum, name) {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) fail(`${name} is invalid`);
  return parsed;
}

function integer(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}

function fail(message) {
  throw new SmokeFailure(message);
}
