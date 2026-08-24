import { createHash, randomUUID } from "node:crypto";
import type {
  ProviderModel,
  ProviderRoutingSelection,
  ProviderRunInput,
  ProviderRunLimits,
} from "./providers/types.js";

const CONFIRMATION_TTL_MS = 10 * 60_000;
const MAX_PROVIDER_REQUESTS_PER_RUN = 9;

export const DEFAULT_RUN_POLICY_CONFIG: RunPolicyConfig = Object.freeze({
  emergencyStop: false,
  maxOutputTokens: 4_096,
  maxTotalTokens: 50_000,
  maxRunCostMicrosUsd: 1_000_000,
  dailyTokenWarning: 200_000,
  monthlyCostSoftLimitMicrosUsd: 10_000_000,
});

export const RUN_POLICY_CONFIG_LIMITS = Object.freeze({
  maxOutputTokens: { minimum: 64, maximum: 32_768 },
  maxTotalTokens: { minimum: 256, maximum: 1_000_000 },
  maxRunCostMicrosUsd: { minimum: 10_000, maximum: 100_000_000 },
  dailyTokenWarning: { minimum: 1_000, maximum: 100_000_000 },
  monthlyCostSoftLimitMicrosUsd: { minimum: 100_000, maximum: 1_000_000_000 },
});

export interface RunPolicyConfig {
  emergencyStop: boolean;
  maxOutputTokens: number;
  maxTotalTokens: number;
  maxRunCostMicrosUsd: number;
  dailyTokenWarning: number;
  monthlyCostSoftLimitMicrosUsd: number;
}

export interface RunPolicyConfigSource {
  runPolicy(): RunPolicyConfig;
}

export interface RunPolicyCatalog {
  models(providerId: string | null): Promise<ProviderModel[]>;
}

export interface RunPolicySelection {
  providerId: string;
  accountId?: string;
  model?: string;
  routing?: ProviderRoutingSelection;
  attachmentCount: number;
}

export interface RunPolicyHistoryOperation {
  providerId: string;
  startedAt: string;
  result?: Record<string, unknown>;
}

export interface RunPolicyPricingSnapshot {
  status: "known" | "unknown";
  source: "catalog" | "unavailable";
  inputPerMillionUsd?: number;
  outputPerMillionUsd?: number;
  requestUsd?: number;
  imageUsd?: number;
  maximumRunCostMicrosUsd?: number;
}

export interface RunPolicyUsageWindow {
  rollingDayTokens: number;
  monthCostMicrosUsd: number;
  dailyWarningReached: boolean;
  monthlySoftLimitReached: boolean;
}

export interface RunPolicySnapshot {
  schema: 1;
  providerId: string;
  model?: string;
  routing?: ProviderRoutingSelection;
  privacyProfile: "codex-managed" | "openai-store-false" | "openrouter-strict-zdr" | "provider-defined";
  evaluatedAt: string;
  configRevision: string;
  attachmentCount: number;
  limits?: ProviderRunLimits & { maxRunCostMicrosUsd: number };
  pricing: RunPolicyPricingSnapshot;
  usageWindow: RunPolicyUsageWindow;
  warnings: string[];
  confirmationRequired: boolean;
}

export interface RunPolicyUsageAccounting {
  status: "provider-reported" | "catalog-estimate" | "unknown";
  currency: "USD";
  requestCount: number;
  costMicrosUsd?: number;
}

export interface RunPolicyPreflight {
  snapshot: RunPolicySnapshot;
  confirmationToken?: string;
  confirmationExpiresAt?: string;
}

export class RunPolicyError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

interface ConfirmationRecord {
  digest: string;
  expiresAt: number;
}

export class CostAndPolicyGuard {
  private readonly confirmations = new Map<string, ConfirmationRecord>();

  constructor(
    private readonly catalog: RunPolicyCatalog,
    private readonly configSource: RunPolicyConfigSource,
    private readonly now: () => number = Date.now,
    private readonly createToken: () => string = randomUUID,
  ) {}

  config(): RunPolicyConfig {
    return validateRunPolicyConfig(this.configSource.runPolicy());
  }

  async preflight(
    selection: RunPolicySelection,
    history: readonly RunPolicyHistoryOperation[],
  ): Promise<RunPolicyPreflight> {
    this.cleanupConfirmations();
    const snapshot = await this.evaluate(selection, history);
    if (!snapshot.confirmationRequired) return { snapshot };
    const confirmationToken = this.createToken();
    if (!/^[A-Za-z0-9._~-]{8,200}$/.test(confirmationToken)) {
      throw new RunPolicyError(500, "Run policy confirmation token generation failed");
    }
    const expiresAt = this.now() + CONFIRMATION_TTL_MS;
    this.confirmations.set(confirmationToken, {
      digest: snapshotDigest(snapshot, selection),
      expiresAt,
    });
    return {
      snapshot,
      confirmationToken,
      confirmationExpiresAt: new Date(expiresAt).toISOString(),
    };
  }

  async authorize(
    selection: RunPolicySelection,
    history: readonly RunPolicyHistoryOperation[],
    confirmationToken?: string,
  ): Promise<{ snapshot: RunPolicySnapshot; limits?: ProviderRunLimits }> {
    this.cleanupConfirmations();
    const snapshot = await this.evaluate(selection, history);
    if (snapshot.confirmationRequired) {
      const confirmation = confirmationToken ? this.confirmations.get(confirmationToken) : undefined;
      if (!confirmation || confirmation.expiresAt < this.now()
          || confirmation.digest !== snapshotDigest(snapshot, selection)) {
        throw new RunPolicyError(409, "월간 API 비용 soft limit을 확인한 뒤 다시 실행해 주세요.");
      }
      this.confirmations.delete(confirmationToken!);
    } else if (confirmationToken) {
      throw new RunPolicyError(400, "이 API 실행에는 비용 확인 token이 필요하지 않습니다.");
    }
    return {
      snapshot,
      ...(snapshot.limits ? {
        limits: {
          maxOutputTokens: snapshot.limits.maxOutputTokens,
          maxTotalTokens: snapshot.limits.maxTotalTokens,
        },
      } : {}),
    };
  }

  accountResult(snapshot: RunPolicySnapshot, result: Record<string, unknown>): Record<string, unknown> {
    return {
      ...result,
      policyUsage: usageAccounting(snapshot, result),
    };
  }

  private async evaluate(
    selection: RunPolicySelection,
    history: readonly RunPolicyHistoryOperation[],
  ): Promise<RunPolicySnapshot> {
    const config = this.config();
    const evaluatedAt = new Date(this.now()).toISOString();
    const apiProvider = selection.providerId === "openai" || selection.providerId === "openrouter";
    if (apiProvider && config.emergencyStop) {
      throw new RunPolicyError(423, "Companion의 API 실행 긴급 중단 스위치가 켜져 있습니다.");
    }
    if (apiProvider && !selection.model) {
      throw new RunPolicyError(400, "API Provider 실행 전에 모델을 선택해 주세요.");
    }
    if (!Number.isSafeInteger(selection.attachmentCount)
        || selection.attachmentCount < 0 || selection.attachmentCount > 32) {
      throw new RunPolicyError(400, "Run policy attachment count is invalid");
    }

    const usageWindow = usageSnapshot(history, config, this.now());
    const warnings: string[] = [];
    if (usageWindow.dailyWarningReached) warnings.push("최근 24시간 token 경고 기준을 넘었습니다.");
    if (usageWindow.monthlySoftLimitReached) warnings.push("이번 달 API 비용 soft limit을 넘었습니다.");

    let pricing: RunPolicyPricingSnapshot = { status: "unknown", source: "unavailable" };
    if (apiProvider) {
      const models = await this.catalog.models(selection.providerId);
      const model = models.find((candidate) => candidate.id === selection.model);
      if (!model) throw new RunPolicyError(409, "선택한 모델이 현재 Provider catalog에 없습니다.");
      pricing = pricingSnapshot(model, selection, config);
      if (pricing.status === "unknown") warnings.push("가격 확인 필요 · 비용을 추측하지 않습니다.");
      if (pricing.maximumRunCostMicrosUsd !== undefined
          && pricing.maximumRunCostMicrosUsd > config.maxRunCostMicrosUsd) {
        throw new RunPolicyError(409, "선택한 모델의 최대 run 비용이 Companion hard limit을 초과합니다.");
      }
    }

    return {
      schema: 1,
      providerId: selection.providerId,
      ...(selection.model ? { model: selection.model } : {}),
      ...(selection.routing ? { routing: structuredClone(selection.routing) } : {}),
      privacyProfile: privacyProfile(selection.providerId),
      evaluatedAt,
      configRevision: configRevision(config),
      attachmentCount: selection.attachmentCount,
      ...(apiProvider ? {
        limits: {
          maxOutputTokens: config.maxOutputTokens,
          maxTotalTokens: config.maxTotalTokens,
          maxRunCostMicrosUsd: config.maxRunCostMicrosUsd,
        },
      } : {}),
      pricing,
      usageWindow,
      warnings,
      confirmationRequired: apiProvider && usageWindow.monthlySoftLimitReached,
    };
  }

  private cleanupConfirmations(): void {
    const now = this.now();
    for (const [token, record] of this.confirmations) {
      if (record.expiresAt < now) this.confirmations.delete(token);
    }
    while (this.confirmations.size > 64) this.confirmations.delete(this.confirmations.keys().next().value!);
  }
}

export function validateRunPolicyConfig(config: RunPolicyConfig): RunPolicyConfig {
  const validated = {
    emergencyStop: config.emergencyStop,
    maxOutputTokens: boundedInteger(config.maxOutputTokens, RUN_POLICY_CONFIG_LIMITS.maxOutputTokens, "maxOutputTokens"),
    maxTotalTokens: boundedInteger(config.maxTotalTokens, RUN_POLICY_CONFIG_LIMITS.maxTotalTokens, "maxTotalTokens"),
    maxRunCostMicrosUsd: boundedInteger(
      config.maxRunCostMicrosUsd,
      RUN_POLICY_CONFIG_LIMITS.maxRunCostMicrosUsd,
      "maxRunCostMicrosUsd",
    ),
    dailyTokenWarning: boundedInteger(
      config.dailyTokenWarning,
      RUN_POLICY_CONFIG_LIMITS.dailyTokenWarning,
      "dailyTokenWarning",
    ),
    monthlyCostSoftLimitMicrosUsd: boundedInteger(
      config.monthlyCostSoftLimitMicrosUsd,
      RUN_POLICY_CONFIG_LIMITS.monthlyCostSoftLimitMicrosUsd,
      "monthlyCostSoftLimitMicrosUsd",
    ),
  };
  if (typeof validated.emergencyStop !== "boolean") throw new RunPolicyError(400, "emergencyStop must be boolean");
  if (validated.maxTotalTokens < validated.maxOutputTokens) {
    throw new RunPolicyError(400, "maxTotalTokens must be at least maxOutputTokens");
  }
  return validated;
}

function pricingSnapshot(
  model: ProviderModel,
  selection: RunPolicySelection,
  config: RunPolicyConfig,
): RunPolicyPricingSnapshot {
  let candidates = model.pricing ? [model.pricing] : [];
  if (selection.providerId === "openrouter" && selection.routing) {
    candidates = selection.routing.upstreams.map((upstreamId) => {
      const route = model.routingOptions?.find((option) => option.id === upstreamId);
      if (!route) throw new RunPolicyError(409, "선택한 upstream이 현재 Provider catalog에 없습니다.");
      return route.pricing ?? {};
    });
  }
  if (candidates.length === 0 || candidates.some((pricing) => (
    !finitePrice(pricing.inputPerMillionUsd) || !finitePrice(pricing.outputPerMillionUsd)
  ))) return { status: "unknown", source: "unavailable" };

  const inputPerMillionUsd = Math.max(...candidates.map((item) => item.inputPerMillionUsd!));
  const outputPerMillionUsd = Math.max(...candidates.map((item) => item.outputPerMillionUsd!));
  const requestUsd = Math.max(0, ...candidates.map((item) => finitePrice(item.requestUsd) ? item.requestUsd! : 0));
  const imageUsd = Math.max(0, ...candidates.map((item) => finitePrice(item.imageUsd) ? item.imageUsd! : 0));
  const maximumTokenCostMicros = Math.ceil(
    Math.max(inputPerMillionUsd, outputPerMillionUsd) * config.maxTotalTokens,
  );
  const imageRequestCount = selection.providerId === "openrouter" ? MAX_PROVIDER_REQUESTS_PER_RUN : 1;
  const fixedCostMicros = Math.ceil((
    requestUsd * MAX_PROVIDER_REQUESTS_PER_RUN
    + imageUsd * selection.attachmentCount * imageRequestCount
  ) * 1_000_000);
  return {
    status: "known",
    source: "catalog",
    inputPerMillionUsd,
    outputPerMillionUsd,
    ...(requestUsd > 0 ? { requestUsd } : {}),
    ...(imageUsd > 0 ? { imageUsd } : {}),
    maximumRunCostMicrosUsd: maximumTokenCostMicros + fixedCostMicros,
  };
}

function usageSnapshot(
  history: readonly RunPolicyHistoryOperation[],
  config: RunPolicyConfig,
  now: number,
): RunPolicyUsageWindow {
  const dayCutoff = now - 24 * 60 * 60_000;
  const current = new Date(now);
  const monthStart = Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), 1);
  let rollingDayTokens = 0;
  let monthCostMicrosUsd = 0;
  for (const operation of history) {
    const startedAt = Date.parse(operation.startedAt);
    const usage = record(operation.result?.usage);
    const apiProvider = operation.providerId === "openai" || operation.providerId === "openrouter";
    if (apiProvider && startedAt >= dayCutoff) {
      const tokens = usage?.totalTokens;
      if (typeof tokens === "number" && Number.isSafeInteger(tokens) && tokens >= 0) rollingDayTokens += tokens;
    }
    if (apiProvider && startedAt >= monthStart) {
      const accounted = record(operation.result?.policyUsage);
      const costMicrosUsd = accounted?.costMicrosUsd;
      if (safeNonNegativeInteger(costMicrosUsd)) {
        monthCostMicrosUsd += costMicrosUsd;
      } else if (operation.providerId === "openrouter") {
        const cost = usage?.costCredits;
        if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) {
          monthCostMicrosUsd += Math.ceil(cost * 1_000_000);
        }
      }
    }
  }
  rollingDayTokens = Math.min(rollingDayTokens, Number.MAX_SAFE_INTEGER);
  monthCostMicrosUsd = Math.min(monthCostMicrosUsd, Number.MAX_SAFE_INTEGER);
  return {
    rollingDayTokens,
    monthCostMicrosUsd,
    dailyWarningReached: rollingDayTokens >= config.dailyTokenWarning,
    monthlySoftLimitReached: monthCostMicrosUsd >= config.monthlyCostSoftLimitMicrosUsd,
  };
}

function usageAccounting(
  snapshot: RunPolicySnapshot,
  result: Record<string, unknown>,
): RunPolicyUsageAccounting {
  const usage = record(result.usage);
  const requestCount = safeNonNegativeInteger(usage?.requestCount)
    ? Math.min(usage.requestCount, MAX_PROVIDER_REQUESTS_PER_RUN)
    : 0;
  const providerCost = usage?.costCredits;
  if (snapshot.providerId === "openrouter"
      && typeof providerCost === "number" && Number.isFinite(providerCost) && providerCost >= 0) {
    return {
      status: "provider-reported",
      currency: "USD",
      requestCount,
      costMicrosUsd: Math.min(Number.MAX_SAFE_INTEGER, Math.ceil(providerCost * 1_000_000)),
    };
  }
  const inputTokens = usage?.inputTokens;
  const outputTokens = usage?.outputTokens;
  if (snapshot.pricing.status === "known"
      && finitePrice(snapshot.pricing.inputPerMillionUsd)
      && finitePrice(snapshot.pricing.outputPerMillionUsd)
      && safeNonNegativeInteger(inputTokens)
      && safeNonNegativeInteger(outputTokens)) {
    const tokenCostMicros = inputTokens * snapshot.pricing.inputPerMillionUsd
      + outputTokens * snapshot.pricing.outputPerMillionUsd;
    const imageRequestCount = snapshot.providerId === "openrouter" ? requestCount : Math.min(requestCount, 1);
    const fixedCostMicros = (
      (snapshot.pricing.requestUsd ?? 0) * requestCount
      + (snapshot.pricing.imageUsd ?? 0) * snapshot.attachmentCount * imageRequestCount
    ) * 1_000_000;
    return {
      status: "catalog-estimate",
      currency: "USD",
      requestCount,
      costMicrosUsd: Math.min(Number.MAX_SAFE_INTEGER, Math.ceil(tokenCostMicros + fixedCostMicros)),
    };
  }
  return { status: "unknown", currency: "USD", requestCount };
}

function privacyProfile(providerId: string): RunPolicySnapshot["privacyProfile"] {
  if (providerId === "codex") return "codex-managed";
  if (providerId === "openai") return "openai-store-false";
  if (providerId === "openrouter") return "openrouter-strict-zdr";
  return "provider-defined";
}

function configRevision(config: RunPolicyConfig): string {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex").slice(0, 16);
}

function snapshotDigest(snapshot: RunPolicySnapshot, selection: RunPolicySelection): string {
  const { evaluatedAt: _evaluatedAt, ...stableSnapshot } = snapshot;
  return createHash("sha256").update(JSON.stringify({ snapshot: stableSnapshot, selection })).digest("hex");
}

function boundedInteger(
  value: number,
  limits: { minimum: number; maximum: number },
  name: string,
): number {
  if (!Number.isSafeInteger(value) || value < limits.minimum || value > limits.maximum) {
    throw new RunPolicyError(400, `${name} must be an integer between ${limits.minimum} and ${limits.maximum}`);
  }
  return value;
}

function finitePrice(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1_000_000;
}

function safeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
