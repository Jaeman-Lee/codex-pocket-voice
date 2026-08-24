#!/usr/bin/env -S node --import tsx

import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { InMemoryApprovalBroker } from "../src/approval-broker.js";
import { PathPolicy } from "../src/path-policy.js";
import { createReadOnlyWorkspaceTools } from "../src/read-only-tools.js";
import {
  parseProviderModelGradeReport,
  StaticProviderModelGradeSource,
  type ProviderModelGradeRecord,
} from "../src/providers/model-grades.js";
import { EnvironmentOpenAICredentialSource } from "../src/providers/openai-credentials.js";
import { OpenAIProviderAdapter } from "../src/providers/openai-provider.js";
import { EnvironmentOpenRouterCredentialSource } from "../src/providers/openrouter-credentials.js";
import { OpenRouterProviderAdapter } from "../src/providers/openrouter-provider.js";
import type {
  ProviderModel,
  ProviderRun,
  ProviderRuntime,
  ProviderUsage,
} from "../src/providers/types.js";
import {
  LocalToolBroker,
  type ToolBroker,
  type ToolCall,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolExecutionResult,
} from "../src/tool-broker.js";
import { createWorkspaceChangeTools } from "../src/workspace-change-tools.js";

const CODING_CONFIRMATION = "APPROVE_SYNTHETIC_CODING_EVAL";
const MAX_REPORT_BYTES = 64 * 1024;
const MAX_SMOKE_AGE_MS = 24 * 60 * 60_000;
const MAX_FUTURE_SKEW_MS = 5 * 60_000;
const MAX_INPUT_TOKENS_PER_REQUEST = 8_192;
const MAX_OUTPUT_TOKENS_PER_REQUEST = 256;
const MAX_EVAL_BUDGET_USD = 0.05;
const EVAL_TIMEOUT_MS = 90_000;
const MODEL_PATTERN = /^[a-z0-9][a-z0-9._:/-]{0,199}$/;
const UPSTREAM_PATTERN = /^[a-z0-9][a-z0-9._/-]{0,119}$/;

export type ProviderProjectEvalScope = "read" | "coding";
export type ProviderProjectEvalProvider = "openai" | "openrouter";

export interface ProviderProjectEvalConfig {
  provider: ProviderProjectEvalProvider;
  scope: ProviderProjectEvalScope;
  model: string;
  upstream?: string;
  smokeReportPath: string;
  reportPath: string;
  budgetUsd: number;
  inputUsdPerMillion?: number;
  outputUsdPerMillion?: number;
  codingConfirmation?: string;
}

interface EvalAdapter extends ProviderRuntime {
  listModels(): Promise<ProviderModel[]>;
}

export interface ProviderProjectEvalAdapterContext {
  provider: ProviderProjectEvalProvider;
  scope: ProviderProjectEvalScope;
  model: string;
  upstream?: string;
  broker: ToolBroker;
  gradeSource: StaticProviderModelGradeSource;
}

export interface ProviderProjectEvalDependencies {
  createAdapter?: (context: ProviderProjectEvalAdapterContext) => EvalAdapter;
  createId?: () => string;
  now?: () => number;
}

export interface ProviderProjectEvalResult {
  passed: boolean;
  report: Record<string, unknown>;
}

interface SmokeContract {
  provider: ProviderProjectEvalProvider;
  model: string;
  actualModel?: string;
  upstream?: string;
  actualProvider?: string;
  contractGrades: Record<string, "pass">;
}

interface ToolRecord {
  name: string;
  status: ToolExecutionResult["status"];
}

interface SafeUsage {
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  costCredits?: number;
}

export class ProviderProjectEvalError extends Error {}

export async function runProviderProjectEval(
  config: ProviderProjectEvalConfig,
  dependencies: ProviderProjectEvalDependencies = {},
): Promise<ProviderProjectEvalResult> {
  validateConfig(config);
  await requireUnusedReportPath(config.reportPath);
  const now = dependencies.now?.() ?? Date.now();
  const smoke = await loadSmokeContract(config, now);
  const maximumRequests = config.scope === "read" ? 2 : 3;
  const maximumTokens = maximumRequests
    * (MAX_INPUT_TOKENS_PER_REQUEST + MAX_OUTPUT_TOKENS_PER_REQUEST);
  const marker = `cpv-eval-${dependencies.createId?.() ?? randomUUID()}`;
  const root = await mkdtemp(join(tmpdir(), "codex-pocket-provider-project-eval-"));
  const workspace = join(root, "workspace");
  const transactions = join(root, "transactions");
  const taskPath = join(workspace, "task.txt");
  const initialContent = config.scope === "read"
    ? `project-eval-marker=${marker}\n`
    : "project-eval-state=before\n";
  const targetContent = `project-eval-state=${marker}\n`;

  try {
    await mkdir(workspace, { mode: 0o700 });
    await writeFile(taskPath, initialContent, { encoding: "utf8", mode: 0o600, flag: "wx" });
    const paths = await PathPolicy.fromEnvironment(workspace, workspace);
    const approvals = new InMemoryApprovalBroker();
    let approvalCount = 0;
    let approvalValid = true;
    const unsubscribeApprovals = approvals.subscribe((event) => {
      if (event.type !== "requested") return;
      approvalCount += 1;
      const details = record(event.request.redactedDetails);
      const valid = config.scope === "coding"
        && approvalCount === 1
        && event.request.risk === "change"
        && event.request.requiresTouch === true
        && event.request.redactedSummary === "Replace text in task.txt"
        && details?.path === "task.txt"
        && details.expectedSha256 === sha256(initialContent)
        && details.nextSha256 === sha256(targetContent);
      approvalValid &&= valid;
      try {
        approvals.resolve(event.request.id, valid ? "approved" : "declined", valid ? "touch" : "system");
      } catch {
        approvalValid = false;
      }
    });

    const readTool = createReadOnlyWorkspaceTools(paths)
      .find((tool) => tool.definition.name === "workspace_read");
    const changeTool = (await createWorkspaceChangeTools(paths, { transactionDirectory: transactions }))
      .find((tool) => tool.definition.name === "workspace_replace_text");
    if (!readTool || !changeTool) throw new ProviderProjectEvalError("Project eval tools are unavailable");
    const local = new LocalToolBroker(
      config.scope === "read" ? [readTool] : [readTool, changeTool],
      approvals,
      paths,
    );
    const broker = new RecordingToolBroker(local);
    const gradeSource = new StaticProviderModelGradeSource([
      evaluationGrade(config, now),
    ]);
    const adapter = dependencies.createAdapter?.({
      provider: config.provider,
      scope: config.scope,
      model: config.model,
      upstream: config.upstream,
      broker,
      gradeSource,
    }) ?? createProductionAdapter(config, broker, gradeSource);

    let selectedModel: ProviderModel;
    try {
      const models = await adapter.listModels();
      selectedModel = exactModel(models, config.model);
      assertExpectedToolCapability(config.scope, selectedModel, config.upstream);
    } catch {
      throw new ProviderProjectEvalError("Provider model preflight failed");
    }
    const pricing = evalPricing(config, selectedModel);
    const estimatedMaximumUsd = maximumRequests * (
      MAX_INPUT_TOKENS_PER_REQUEST * pricing.inputUsdPerMillion / 1_000_000
      + MAX_OUTPUT_TOKENS_PER_REQUEST * pricing.outputUsdPerMillion / 1_000_000
      + pricing.requestUsd
    );
    if (!Number.isFinite(estimatedMaximumUsd) || estimatedMaximumUsd > config.budgetUsd) {
      throw new ProviderProjectEvalError("Configured project eval token ceiling exceeds the budget");
    }

    const prompt = config.scope === "read"
      ? [
          "Use workspace_read exactly once to read task.txt.",
          "Then reply with only the value after project-eval-marker= and no other text.",
        ].join(" ")
      : [
          "Use workspace_read exactly once to read task.txt and obtain its current sha256.",
          `Then use workspace_replace_text exactly once with that sha256 and the complete content ${JSON.stringify(targetContent)}.`,
          "After the tool reports completed, reply with only DONE.",
        ].join(" ");
    let completion: Awaited<ProviderRun["completion"]> | undefined;
    const usageFrames: ProviderUsage[] = [];
    const unsubscribeUsage = adapter.subscribe((event) => {
      if (event.kind === "usage.updated") usageFrames.push(structuredClone(event.usage));
    });
    try {
      const run = await adapter.startRun({
        cwd: workspace,
        prompt,
        model: config.model,
        timeoutMs: EVAL_TIMEOUT_MS,
        limits: {
          maxOutputTokens: MAX_OUTPUT_TOKENS_PER_REQUEST,
          maxTotalTokens: maximumTokens,
        },
        ...(config.provider === "openrouter"
          ? { routing: { upstreams: [config.upstream!], allowFallbacks: false } }
          : {}),
      });
      completion = await run.completion;
    } catch {
      completion = undefined;
    } finally {
      unsubscribeUsage();
      unsubscribeApprovals();
      approvals.close();
    }

    const readToolPassed = exactToolSequencePrefix(broker.records, ["workspace_read"]);
    const codingToolPassed = config.scope === "coding"
      && exactToolSequence(broker.records, ["workspace_read", "workspace_replace_text"])
      && approvalCount === 1
      && approvalValid
      && await exactFile(taskPath, targetContent);
    const usage = safeUsage(completion?.result?.usage, maximumRequests);
    const usageFramesPassed = usage !== null && validateUsageFrames(usageFrames, usage);
    const routingPassed = validateCompletionIdentity(config, smoke, completion);
    const responsePassed = config.scope === "read"
      ? completion?.status === "completed"
        && completion.result.finalResponse === marker
      : completion?.status === "completed";
    const cost = usage ? actualCost(config, pricing, usage) : null;
    const costPassed = cost !== null
      && usageFramesPassed
      && cost.estimatedUsd <= config.budgetUsd
      && (config.provider !== "openrouter" || cost.costCredits !== undefined)
      && (cost.costCredits === undefined || cost.costCredits <= config.budgetUsd);
    const baseEvidencePassed = completion?.status === "completed" && routingPassed && costPassed;
    const readPassed = baseEvidencePassed
      && readToolPassed
      && (config.scope !== "read" || completion?.result.finalResponse === marker);
    const codingPassed = baseEvidencePassed && codingToolPassed;
    const passed = responsePassed && (config.scope === "read" ? readPassed : codingPassed);
    const grades = {
      ...smoke.contractGrades,
      projectRead: readPassed ? "pass" : completion ? "fail" : "not_tested",
      coding: config.scope === "coding"
        ? codingPassed ? "pass" : completion ? "fail" : "not_tested"
        : "not_tested",
    };
    const report = buildReport({
      config,
      smoke,
      grades,
      checkedAt: new Date(now).toISOString(),
      maximumRequests,
      estimatedMaximumUsd,
      usage,
      cost,
      outcome: passed ? "pass" : completion ? "contract_failed" : "infrastructure_failed",
      tools: broker.records,
    });
    const reportText = `${JSON.stringify(report, null, 2)}\n`;
    if (Buffer.byteLength(reportText) > MAX_REPORT_BYTES) {
      throw new ProviderProjectEvalError("Project eval report exceeded its size limit");
    }
    await writeFile(config.reportPath, reportText, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return { passed, report };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

class RecordingToolBroker implements ToolBroker {
  readonly records: ToolRecord[] = [];

  constructor(private readonly delegate: ToolBroker) {}

  definitions(): ToolDefinition[] {
    return this.delegate.definitions();
  }

  async execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const result = await this.delegate.execute(call, context);
    this.records.push({ name: call.name, status: result.status });
    return result;
  }

  clearRun(providerId: string, runId: string): void {
    this.delegate.clearRun(providerId, runId);
  }
}

function createProductionAdapter(
  config: ProviderProjectEvalConfig,
  broker: ToolBroker,
  gradeSource: StaticProviderModelGradeSource,
): EvalAdapter {
  if (config.provider === "openai") {
    return new OpenAIProviderAdapter({
      credentials: new EnvironmentOpenAICredentialSource(process.env),
      defaultModel: config.model,
      modelAllowlist: [config.model],
      toolBroker: broker,
      maxToolCallsPerRun: config.scope === "read" ? 1 : 2,
      modelGrades: gradeSource,
    });
  }
  return new OpenRouterProviderAdapter({
    credentials: new EnvironmentOpenRouterCredentialSource(process.env),
    defaultModel: config.model,
    modelAllowlist: [config.model],
    toolBroker: broker,
    maxToolCallsPerRun: config.scope === "read" ? 1 : 2,
    modelGrades: gradeSource,
  });
}

function evaluationGrade(config: ProviderProjectEvalConfig, now: number): ProviderModelGradeRecord {
  const checkedAt = new Date(now).toISOString();
  const expiresAt = new Date(now + 30 * 24 * 60 * 60_000).toISOString();
  return {
    providerId: config.provider,
    modelId: config.model,
    ...(config.upstream ? { upstreamId: config.upstream } : {}),
    checkedAt,
    expiresAt,
    verification: {
      scope: config.upstream ? "upstream" : "model",
      conversation: "pass",
      projectRead: "pass",
      coding: config.scope === "coding" ? "pass" : "not_tested",
      checkedAt,
      expiresAt,
    },
  };
}

function exactModel(models: readonly ProviderModel[], model: string): ProviderModel {
  const matches = models.filter((item) => item.id === model);
  if (matches.length !== 1) throw new ProviderProjectEvalError("Exact eval model is unavailable");
  return matches[0]!;
}

function assertExpectedToolCapability(
  scope: ProviderProjectEvalScope,
  model: ProviderModel,
  upstream: string | undefined,
): void {
  const capability = upstream
    ? model.routingOptions?.find((item) => item.id === upstream)?.verification
    : model.verification;
  if (capability?.projectRead !== "pass" || (scope === "coding" && capability.coding !== "pass")) {
    throw new ProviderProjectEvalError("Temporary eval capability was not bound to the exact model route");
  }
}

function evalPricing(
  config: ProviderProjectEvalConfig,
  model: ProviderModel,
): { inputUsdPerMillion: number; outputUsdPerMillion: number; requestUsd: number } {
  if (config.provider === "openai") {
    return {
      inputUsdPerMillion: boundedPrice(config.inputUsdPerMillion, "OpenAI input price"),
      outputUsdPerMillion: boundedPrice(config.outputUsdPerMillion, "OpenAI output price"),
      requestUsd: 0,
    };
  }
  const route = model.routingOptions?.filter((item) => item.id === config.upstream);
  if (route?.length !== 1 || route[0]?.supportsTools !== true) {
    throw new ProviderProjectEvalError("Exact OpenRouter eval route is not tool-capable");
  }
  return {
    inputUsdPerMillion: boundedPrice(route[0].pricing?.inputPerMillionUsd, "OpenRouter input price"),
    outputUsdPerMillion: boundedPrice(route[0].pricing?.outputPerMillionUsd, "OpenRouter output price"),
    requestUsd: boundedRequestPrice(route[0].pricing?.requestUsd),
  };
}

function actualCost(
  config: ProviderProjectEvalConfig,
  pricing: { inputUsdPerMillion: number; outputUsdPerMillion: number; requestUsd: number },
  usage: SafeUsage,
): { estimatedUsd: number; costCredits?: number } {
  const estimatedUsd = usage.inputTokens * pricing.inputUsdPerMillion / 1_000_000
    + usage.outputTokens * pricing.outputUsdPerMillion / 1_000_000
    + usage.requestCount * pricing.requestUsd;
  return {
    estimatedUsd,
    ...(config.provider === "openrouter" && usage.costCredits !== undefined
      ? { costCredits: usage.costCredits }
      : {}),
  };
}

function validateCompletionIdentity(
  config: ProviderProjectEvalConfig,
  smoke: SmokeContract,
  completion: Awaited<ProviderRun["completion"]> | undefined,
): boolean {
  if (!completion || completion.result.model !== config.model) return false;
  if (config.provider === "openai") return true;
  const routing = record(completion.result.routing);
  return routing?.profile === "strict-zdr"
    && routing.allowFallbacks === false
    && Array.isArray(routing.requestedUpstreams)
    && routing.requestedUpstreams.length === 1
    && routing.requestedUpstreams[0] === config.upstream
    && routing.actualUpstream === config.upstream
    && routing.actualProvider === smoke.actualProvider;
}

function safeUsage(value: unknown, maximumRequests: number): SafeUsage | null {
  const usage = record(value);
  const requestCount = boundedInteger(usage?.requestCount, 1, maximumRequests);
  const inputTokens = boundedInteger(
    usage?.inputTokens,
    0,
    maximumRequests * MAX_INPUT_TOKENS_PER_REQUEST,
  );
  const outputTokens = boundedInteger(
    usage?.outputTokens,
    0,
    maximumRequests * MAX_OUTPUT_TOKENS_PER_REQUEST,
  );
  const totalTokens = boundedInteger(
    usage?.totalTokens,
    0,
    maximumRequests * (MAX_INPUT_TOKENS_PER_REQUEST + MAX_OUTPUT_TOKENS_PER_REQUEST),
  );
  if (requestCount === null || inputTokens === null || outputTokens === null || totalTokens === null
      || totalTokens !== inputTokens + outputTokens) return null;
  const cachedInputTokens = optionalBoundedInteger(usage?.cachedInputTokens, 0, inputTokens);
  const reasoningTokens = optionalBoundedInteger(usage?.reasoningTokens, 0, outputTokens);
  const costCredits = optionalBoundedNumber(usage?.costCredits, 0, MAX_EVAL_BUDGET_USD);
  if (cachedInputTokens === false || reasoningTokens === false || costCredits === false) return null;
  return {
    requestCount,
    inputTokens,
    outputTokens,
    totalTokens,
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    ...(costCredits === undefined ? {} : { costCredits }),
  };
}

function validateUsageFrames(frames: readonly ProviderUsage[], finalUsage: SafeUsage): boolean {
  if (frames.length !== finalUsage.requestCount) return false;
  let previousInput = 0;
  let previousOutput = 0;
  let previousTotal = 0;
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index]!;
    if (frame.requestCount !== index + 1
        || !Number.isSafeInteger(frame.inputTokens) || !Number.isSafeInteger(frame.outputTokens)
        || !Number.isSafeInteger(frame.totalTokens)) return false;
    const input = frame.inputTokens!;
    const output = frame.outputTokens!;
    const total = frame.totalTokens!;
    const inputDelta = input - previousInput;
    const outputDelta = output - previousOutput;
    const totalDelta = total - previousTotal;
    if (inputDelta < 0 || inputDelta > MAX_INPUT_TOKENS_PER_REQUEST
        || outputDelta < 0 || outputDelta > MAX_OUTPUT_TOKENS_PER_REQUEST
        || totalDelta !== inputDelta + outputDelta) return false;
    previousInput = input;
    previousOutput = output;
    previousTotal = total;
  }
  const last = frames.at(-1);
  return last?.requestCount === finalUsage.requestCount
    && last.inputTokens === finalUsage.inputTokens
    && last.outputTokens === finalUsage.outputTokens
    && last.totalTokens === finalUsage.totalTokens
    && (finalUsage.costCredits === undefined || last.costCredits === finalUsage.costCredits);
}

function buildReport(input: {
  config: ProviderProjectEvalConfig;
  smoke: SmokeContract;
  grades: Record<string, string>;
  checkedAt: string;
  maximumRequests: number;
  estimatedMaximumUsd: number;
  usage: SafeUsage | null;
  cost: { estimatedUsd: number; costCredits?: number } | null;
  outcome: "pass" | "contract_failed" | "infrastructure_failed";
  tools: readonly ToolRecord[];
}): Record<string, unknown> {
  const common = {
    budgetUsd: input.config.budgetUsd,
    estimatedMaximumUsd: input.estimatedMaximumUsd,
    calls: input.usage?.requestCount ?? 0,
    usage: input.usage,
    actualEstimatedUsd: input.cost?.estimatedUsd ?? null,
    grades: input.grades,
    evaluation: {
      scope: input.config.scope,
      fixture: "ephemeral_synthetic_workspace",
      approval: input.config.scope === "coding"
        ? "protected_workflow_and_exact_confirmation"
        : "not_required",
      maximumRequests: input.maximumRequests,
      outcome: input.outcome,
      tools: input.tools.map((tool) => ({ name: tool.name, status: tool.status })),
    },
    checkedAt: input.checkedAt,
  };
  if (input.config.provider === "openai") {
    return {
      schemaVersion: 1,
      provider: "openai",
      requestedModel: input.config.model,
      actualModel: input.smoke.actualModel,
      privacyProfile: { store: false, serviceTier: "default" },
      pricingBasis: {
        currency: "USD",
        inputUsdPerMillion: input.config.inputUsdPerMillion,
        outputUsdPerMillion: input.config.outputUsdPerMillion,
        source: "operator_reviewed",
      },
      ...common,
    };
  }
  return {
    schemaVersion: 2,
    provider: "openrouter",
    model: input.config.model,
    requestedUpstream: input.config.upstream,
    actualProviders: [input.smoke.actualProvider],
    privacyProfile: { zdr: true, dataCollection: "deny", allowFallbacks: false },
    creditBaseCurrency: "USD",
    actualCostCredits: input.cost?.costCredits ?? null,
    ...common,
  };
}

async function loadSmokeContract(
  config: ProviderProjectEvalConfig,
  now: number,
): Promise<SmokeContract> {
  let raw: string;
  try {
    raw = await readPrivateReport(config.smokeReportPath);
  } catch {
    throw new ProviderProjectEvalError("Protected smoke report could not be read safely");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ProviderProjectEvalError("Protected smoke report is invalid");
  }
  try {
    const validated = parseProviderModelGradeReport(raw, now);
    if (validated.providerId !== config.provider) {
      throw new ProviderProjectEvalError("Protected smoke report provider does not match");
    }
  } catch (error) {
    if (error instanceof ProviderProjectEvalError) throw error;
    throw new ProviderProjectEvalError("Protected smoke report is invalid");
  }
  const report = record(parsed);
  if (!report || report.provider !== config.provider) {
    throw new ProviderProjectEvalError("Protected smoke report provider does not match");
  }
  const checkedAt = exactTimestamp(report.checkedAt, now);
  if (now - Date.parse(checkedAt) > MAX_SMOKE_AGE_MS) {
    throw new ProviderProjectEvalError("Protected smoke report is stale");
  }
  const grades = record(report.grades);
  if (config.provider === "openai") {
    if (report.schemaVersion !== 1 || report.requestedModel !== config.model
        || record(report.privacyProfile)?.store !== false
        || record(report.privacyProfile)?.serviceTier !== "default"
        || grades?.streaming !== "pass" || grades.conversation !== "pass"
        || grades.functionCalling !== "pass" || grades.statelessReplay !== "pass") {
      throw new ProviderProjectEvalError("OpenAI smoke contract did not pass exactly");
    }
    const actualModel = exactModelSnapshot(report.actualModel, config.model);
    return {
      provider: "openai",
      model: config.model,
      actualModel,
      contractGrades: {
        streaming: "pass",
        conversation: "pass",
        functionCalling: "pass",
        statelessReplay: "pass",
      },
    };
  }
  const providers = Array.isArray(report.actualProviders) ? report.actualProviders : [];
  const privacy = record(report.privacyProfile);
  if (report.schemaVersion !== 2 || report.model !== config.model
      || report.requestedUpstream !== config.upstream
      || providers.length !== 1 || !safeLabel(providers[0])
      || privacy?.zdr !== true || privacy.dataCollection !== "deny" || privacy.allowFallbacks !== false
      || grades?.conversation !== "pass" || grades.toolCalling !== "pass") {
    throw new ProviderProjectEvalError("OpenRouter smoke contract did not pass exactly");
  }
  return {
    provider: "openrouter",
    model: config.model,
    upstream: config.upstream,
    actualProvider: providers[0] as string,
    contractGrades: { conversation: "pass", toolCalling: "pass" },
  };
}

async function readPrivateReport(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    const mode = info.mode & 0o777;
    if (!info.isFile() || info.nlink !== 1 || info.size > MAX_REPORT_BYTES
        || (mode !== 0o600 && mode !== 0o400)
        || (typeof process.getuid === "function" && info.uid !== process.getuid())) {
      throw new ProviderProjectEvalError("Protected smoke report file metadata is invalid");
    }
    const bytes = Buffer.alloc(MAX_REPORT_BYTES + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > MAX_REPORT_BYTES) {
      throw new ProviderProjectEvalError("Protected smoke report is too large");
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

function validateConfig(config: ProviderProjectEvalConfig): void {
  if (config.provider !== "openai" && config.provider !== "openrouter") {
    throw new ProviderProjectEvalError("Project eval provider is invalid");
  }
  if (config.scope !== "read" && config.scope !== "coding") {
    throw new ProviderProjectEvalError("Project eval scope is invalid");
  }
  if (!MODEL_PATTERN.test(config.model)) throw new ProviderProjectEvalError("Project eval model is invalid");
  if (config.provider === "openrouter") {
    if (!config.upstream || !UPSTREAM_PATTERN.test(config.upstream)) {
      throw new ProviderProjectEvalError("OpenRouter project eval upstream is invalid");
    }
  } else if (config.upstream !== undefined) {
    throw new ProviderProjectEvalError("OpenAI project eval cannot select an upstream");
  }
  if (!isAbsolute(config.smokeReportPath) || !isAbsolute(config.reportPath)
      || /[\u0000-\u001f\u007f]/.test(config.smokeReportPath + config.reportPath)) {
    throw new ProviderProjectEvalError("Project eval report paths must be absolute and safe");
  }
  if (!Number.isFinite(config.budgetUsd) || config.budgetUsd < 0.0001
      || config.budgetUsd > MAX_EVAL_BUDGET_USD) {
    throw new ProviderProjectEvalError("Project eval budget is invalid");
  }
  if (config.scope === "coding" && config.codingConfirmation !== CODING_CONFIRMATION) {
    throw new ProviderProjectEvalError("Synthetic coding eval confirmation is missing");
  }
}

async function requireUnusedReportPath(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (record(error)?.code === "ENOENT") return;
    throw new ProviderProjectEvalError("Project eval report path cannot be inspected");
  }
  throw new ProviderProjectEvalError("Project eval report path already exists");
}

function exactToolSequence(records: readonly ToolRecord[], names: readonly string[]): boolean {
  return records.length === names.length && records.every((item, index) => (
    item.name === names[index] && item.status === "completed"
  ));
}

function exactToolSequencePrefix(records: readonly ToolRecord[], names: readonly string[]): boolean {
  return records.length >= names.length && names.every((name, index) => (
    records[index]?.name === name && records[index]?.status === "completed"
  ));
}

async function exactFile(path: string, expected: string): Promise<boolean> {
  try {
    return await readFile(path, "utf8") === expected;
  } catch {
    return false;
  }
}

function exactTimestamp(value: unknown, now: number): string {
  if (typeof value !== "string" || value.length > 40) {
    throw new ProviderProjectEvalError("Protected smoke report timestamp is invalid");
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value || parsed > now + MAX_FUTURE_SKEW_MS) {
    throw new ProviderProjectEvalError("Protected smoke report timestamp is invalid");
  }
  return value;
}

function exactModelSnapshot(value: unknown, model: string): string {
  if (typeof value !== "string" || !MODEL_PATTERN.test(value)) {
    throw new ProviderProjectEvalError("OpenAI smoke actual model is invalid");
  }
  if (value !== model && !new RegExp(`^${escapeRegExp(model)}-\\d{4}-\\d{2}-\\d{2}$`).test(value)) {
    throw new ProviderProjectEvalError("OpenAI smoke actual model does not match");
  }
  return value;
}

function boundedPrice(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0.000001 || value > 1_000) {
    throw new ProviderProjectEvalError(`${label} is invalid`);
  }
  return value;
}

function boundedRequestPrice(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 10) {
    throw new ProviderProjectEvalError("OpenRouter request price is invalid");
  }
  return value;
}

function boundedInteger(value: unknown, minimum: number, maximum: number): number | null {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum
    ? value as number
    : null;
}

function optionalBoundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): number | undefined | false {
  if (value === undefined) return undefined;
  return boundedInteger(value, minimum, maximum) ?? false;
}

function optionalBoundedNumber(
  value: unknown,
  minimum: number,
  maximum: number,
): number | undefined | false {
  if (value === undefined) return undefined;
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum
    ? value
    : false;
}

function safeLabel(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 120
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function record(value: unknown): Record<string, any> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, any>
    : null;
}

function configFromEnvironment(environment: NodeJS.ProcessEnv): ProviderProjectEvalConfig {
  const provider = requiredEnvironment(environment, "PROVIDER_PROJECT_EVAL_PROVIDER") as ProviderProjectEvalProvider;
  return {
    provider,
    scope: requiredEnvironment(environment, "PROVIDER_PROJECT_EVAL_SCOPE") as ProviderProjectEvalScope,
    model: requiredEnvironment(environment, "PROVIDER_PROJECT_EVAL_MODEL"),
    ...(provider === "openrouter"
      ? { upstream: requiredEnvironment(environment, "PROVIDER_PROJECT_EVAL_UPSTREAM") }
      : {}),
    smokeReportPath: requiredEnvironment(environment, "PROVIDER_PROJECT_EVAL_SMOKE_REPORT"),
    reportPath: requiredEnvironment(environment, "PROVIDER_PROJECT_EVAL_REPORT"),
    budgetUsd: numberEnvironment(environment, "PROVIDER_PROJECT_EVAL_MAX_USD"),
    ...(provider === "openai" ? {
      inputUsdPerMillion: numberEnvironment(environment, "PROVIDER_PROJECT_EVAL_INPUT_USD_PER_MTOK"),
      outputUsdPerMillion: numberEnvironment(environment, "PROVIDER_PROJECT_EVAL_OUTPUT_USD_PER_MTOK"),
    } : {}),
    codingConfirmation: environment.PROVIDER_PROJECT_EVAL_CODING_CONFIRMATION,
  };
}

function requiredEnvironment(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (!value || value.length > 4_096 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ProviderProjectEvalError(`${name} is missing or invalid`);
  }
  return value;
}

function numberEnvironment(environment: NodeJS.ProcessEnv, name: string): number {
  const raw = requiredEnvironment(environment, name);
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new ProviderProjectEvalError(`${name} is invalid`);
  return value;
}

async function main(): Promise<void> {
  const result = await runProviderProjectEval(configFromEnvironment(process.env));
  if (!result.passed) {
    process.stderr.write("Provider project eval did not pass; inspect the redacted grade report.\n");
    process.exitCode = 1;
    return;
  }
  process.stdout.write("Provider project eval passed; report contains no prompt, marker, file content, or model output.\n");
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (entry === import.meta.url) {
  void main().catch((error) => {
    const message = error instanceof ProviderProjectEvalError ? error.message : "Unexpected protected eval failure";
    process.stderr.write(`Provider project eval failed: ${message}\n`);
    process.exitCode = 1;
  });
}
