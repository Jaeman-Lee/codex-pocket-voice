#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";

const OFFICIAL_API_BASE = "https://openrouter.ai/api/v1";
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_OUTPUT_TOKENS = 64;
const ESTIMATED_INPUT_TOKENS_PER_CALL = 2_048;
const MAX_CALLS = 2;
const MAX_SMOKE_BUDGET_USD = 0.02;

const apiKey = requiredEnvironment("OPENROUTER_API_KEY", 512);
const model = safeModelId(requiredEnvironment("OPENROUTER_SMOKE_MODEL", 200));
const upstream = safeUpstreamId(requiredEnvironment("OPENROUTER_SMOKE_UPSTREAM", 120));
const reportPath = requiredEnvironment("OPENROUTER_SMOKE_REPORT", 4_096);
const allowedModels = new Set(requiredEnvironment("OPENROUTER_SMOKE_MODELS", 4_096)
  .split(",").map((item) => item.trim()).filter(Boolean).map(safeModelId));
if (!allowedModels.has(model)) fail("Selected model is not in OPENROUTER_SMOKE_MODELS");
const budgetUsd = boundedNumber(
  requiredEnvironment("OPENROUTER_SMOKE_MAX_USD", 20),
  0.0001,
  MAX_SMOKE_BUDGET_USD,
  "budget",
);
const apiBase = smokeApiBase();
const marker = `cpv-contract-${randomUUID()}`;

const [keyInfo, endpointCatalog] = await Promise.all([
  getJson("/key"),
  getJson("/endpoints/zdr"),
]);
const endpoint = array(endpointCatalog.data).map(record).find((item) => item?.model_id === model && item?.tag === upstream);
if (!endpoint) fail("Selected upstream is not a current ZDR endpoint for this model");
const supported = new Set(array(endpoint.supported_parameters).filter((item) => typeof item === "string"));
for (const required of ["tools", "tool_choice", "max_tokens"]) {
  if (!supported.has(required)) fail(`Selected ZDR endpoint does not advertise ${required}`);
}
const expectedProvider = safeDisplayName(endpoint.provider_name, 120, "endpoint provider name");
const pricing = endpointPricing(endpoint.pricing);

const toolRequest = requestBody([
  { role: "user", content: `Call contract_probe exactly once with token ${marker}. Do not answer in text.` },
], {
  tools: [{
    type: "function",
    function: {
      name: "contract_probe",
      description: "Return the exact synthetic contract token.",
      parameters: {
        type: "object",
        properties: { token: { type: "string", enum: [marker] } },
        required: ["token"],
        additionalProperties: false,
      },
      strict: true,
    },
  }],
  tool_choice: { type: "function", function: { name: "contract_probe" } },
  parallel_tool_calls: false,
});
const estimatedMaximum = estimatedCost(pricing) * MAX_CALLS;
if (estimatedMaximum > budgetUsd) fail("Catalog ceiling estimate exceeds the configured smoke budget");
const remainingCredits = nullableNumber(record(keyInfo.data)?.limit_remaining);
if (remainingCredits !== null && remainingCredits < estimatedMaximum) {
  fail("API key remaining credit limit is below the smoke estimate");
}
const toolResponse = await postJson("/chat/completions", toolRequest);
const toolProvider = safeRoutingMetadata(toolResponse, expectedProvider);
const toolUsage = safeUsage(toolResponse);
if (toolUsage.costCredits > budgetUsd) fail("First smoke call consumed the configured credit budget");
const toolCall = record(array(record(array(toolResponse.choices)[0])?.message?.tool_calls)[0]);
const toolFunction = record(toolCall?.function);
if (toolCall?.type !== "function" || toolFunction?.name !== "contract_probe") fail("Model did not return the forced contract tool");
let toolArguments;
try {
  toolArguments = JSON.parse(String(toolFunction.arguments));
} catch {
  fail("Model returned malformed tool arguments");
}
if (!record(toolArguments) || toolArguments.token !== marker || Object.keys(toolArguments).length !== 1) {
  fail("Model did not preserve the synthetic tool contract token");
}

const toolCallId = safeIdentifier(toolCall.id, 200, "tool call ID");
const finalResponse = await postJson("/chat/completions", requestBody([
  ...toolRequest.messages,
  { role: "assistant", content: null, tool_calls: [{
    id: toolCallId,
    type: "function",
    function: { name: "contract_probe", arguments: JSON.stringify({ token: marker }) },
  }] },
  { role: "tool", tool_call_id: toolCallId, content: JSON.stringify({ status: "completed", token: marker }) },
  { role: "user", content: `Reply with only ${marker}.` },
]));
const finalProvider = safeRoutingMetadata(finalResponse, expectedProvider);
const finalText = record(array(finalResponse.choices)[0])?.message?.content;
if (typeof finalText !== "string" || finalText.trim() !== marker) fail("Model did not complete the synthetic conversation contract");

const usage = [toolUsage, safeUsage(finalResponse)];
const actualCostCredits = usage.reduce((total, item) => total + item.costCredits, 0);
if (actualCostCredits > budgetUsd) fail("Reported smoke credits exceeded the configured USD-denominated budget");
const report = {
  schemaVersion: 2,
  provider: "openrouter",
  model,
  requestedUpstream: upstream,
  actualProviders: [...new Set([toolProvider, finalProvider])],
  privacyProfile: { zdr: true, dataCollection: "deny", allowFallbacks: false },
  calls: MAX_CALLS,
  budgetUsd,
  estimatedMaximumUsd: estimatedMaximum,
  actualCostCredits,
  creditBaseCurrency: "USD",
  pricingBasis: {
    currency: "USD",
    ...pricing,
    source: "zdr_endpoint_catalog",
  },
  usage,
  grades: {
    conversation: "pass",
    toolCalling: "pass",
    projectRead: "not_tested",
    coding: "not_tested",
  },
  checkedAt: new Date().toISOString(),
};
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
process.stdout.write(`OpenRouter smoke passed for ${model} on ${upstream}; report contains no prompt or response text.\n`);

function requestBody(messages, extra = {}) {
  return {
    model,
    messages,
    stream: false,
    max_tokens: MAX_OUTPUT_TOKENS,
    provider: {
      order: [upstream],
      only: [upstream],
      allow_fallbacks: false,
      require_parameters: true,
      data_collection: "deny",
      zdr: true,
    },
    ...extra,
  };
}

async function getJson(path) {
  return requestJson(path, { method: "GET" });
}

async function postJson(path, body) {
  return requestJson(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-OpenRouter-Metadata": "enabled" },
    body: JSON.stringify(body),
  });
}

async function requestJson(path, init) {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${apiKey}`, ...(init.headers ?? {}) },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) fail(`OpenRouter smoke request failed with HTTP ${response.status}`);
  const length = Number(response.headers.get("content-length") ?? "0");
  if (length > MAX_JSON_BYTES) fail("OpenRouter smoke response exceeded the JSON limit");
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_JSON_BYTES) fail("OpenRouter smoke response exceeded the JSON limit");
  try {
    return record(JSON.parse(text)) ?? fail("OpenRouter smoke response root is invalid");
  } catch {
    fail("OpenRouter smoke response is not valid JSON");
  }
}

function endpointPricing(value) {
  const pricing = record(value);
  if (!pricing) fail("Selected endpoint has no pricing metadata");
  const prompt = boundedNumber(pricing.prompt, 0, 1_000, "prompt price");
  const completion = boundedNumber(pricing.completion, 0, 1_000, "completion price");
  const request = pricing.request === undefined ? 0 : boundedNumber(pricing.request, 0, 1_000, "request price");
  return {
    inputUsdPerMillion: prompt * 1_000_000,
    outputUsdPerMillion: completion * 1_000_000,
    requestUsd: request,
  };
}

function estimatedCost(pricing) {
  return pricing.inputUsdPerMillion * ESTIMATED_INPUT_TOKENS_PER_CALL / 1_000_000
    + pricing.outputUsdPerMillion * MAX_OUTPUT_TOKENS / 1_000_000
    + pricing.requestUsd;
}

function safeUsage(value) {
  const usage = record(value.usage);
  const inputTokens = integer(usage?.prompt_tokens);
  const outputTokens = integer(usage?.completion_tokens);
  const totalTokens = integer(usage?.total_tokens);
  const costCredits = nullableNumber(usage?.cost);
  if (inputTokens === null || outputTokens === null || totalTokens === null || costCredits === null
      || totalTokens !== inputTokens + outputTokens || inputTokens > ESTIMATED_INPUT_TOKENS_PER_CALL
      || outputTokens > MAX_OUTPUT_TOKENS) {
    fail("OpenRouter smoke response omitted bounded usage or cost accounting");
  }
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    costCredits,
  };
}

function safeRoutingMetadata(value, expectedProvider) {
  if (value.model !== model) fail("OpenRouter smoke response model did not match the exact request");
  const metadata = record(value.openrouter_metadata);
  const endpoints = array(record(metadata?.endpoints)?.available).map(record);
  const selected = endpoints.filter((item) => item?.selected === true);
  if (metadata?.requested !== model || metadata?.attempt !== 1 || selected.length !== 1
      || selected[0]?.provider !== expectedProvider || selected[0]?.model !== model) {
    fail("OpenRouter router metadata did not prove the selected strict upstream");
  }
  if (metadata.attempts !== undefined) {
    const attempts = array(metadata.attempts).map(record);
    if (attempts.length !== 1 || attempts[0]?.provider !== expectedProvider
        || attempts[0]?.model !== model || attempts[0]?.status !== 200) {
      fail("OpenRouter router metadata reported an unexpected routing attempt");
    }
  }
  return expectedProvider;
}

function smokeApiBase() {
  const configured = process.env.OPENROUTER_SMOKE_API_BASE;
  if (!configured) return OFFICIAL_API_BASE;
  if (process.env.OPENROUTER_SMOKE_TEST_MODE !== "1") fail("Custom smoke API base is test-only");
  const url = new URL(configured);
  if (url.protocol !== "http:" || (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")
      || url.username || url.password || !/^\/api\/v1\/?$/.test(url.pathname) || url.search || url.hash) {
    fail("Custom smoke API base must be loopback HTTP with the /api/v1 path");
  }
  return configured.replace(/\/$/, "");
}

function requiredEnvironment(name, maximum) {
  const value = process.env[name];
  if (!value || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) fail(`${name} is missing or invalid`);
  return value;
}

function safeModelId(value) {
  if (!/^[a-z0-9][a-z0-9._:/-]{0,199}$/.test(value)) fail("OpenRouter smoke model ID is invalid");
  return value;
}

function safeUpstreamId(value) {
  if (!/^[a-z0-9][a-z0-9._/-]{0,119}$/.test(value)) fail("OpenRouter smoke upstream ID is invalid");
  return value;
}

function safeIdentifier(value, maximum, name) {
  if (typeof value !== "string" || value.length > maximum || !/^[A-Za-z0-9._:/-]+$/.test(value)) fail(`${name} is invalid`);
  return value;
}

function safeDisplayName(value, maximum, name) {
  if (typeof value !== "string" || value.length > maximum || !value.trim()
      || /[\u0000-\u001f\u007f]/.test(value)) fail(`${name} is invalid`);
  return value.trim();
}

function boundedNumber(value, minimum, maximum, name) {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) fail(`${name} is invalid`);
  return parsed;
}

function nullableNumber(value) {
  if (value === null || value === undefined) return null;
  return boundedNumber(value, 0, 1_000_000_000, "numeric response field");
}

function integer(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}

function array(value) {
  return Array.isArray(value) && value.length <= 10_000 ? value : [];
}

function fail(message) {
  throw new Error(message);
}
