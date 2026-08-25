import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderModel } from "../src/providers/types.js";
import {
  CostAndPolicyGuard,
  DEFAULT_RUN_POLICY_CONFIG,
  RunPolicyError,
  type RunPolicyConfig,
  type RunPolicyHistoryOperation,
  type RunPolicySelection,
} from "../src/run-policy.js";

const now = Date.parse("2026-08-24T12:00:00.000Z");

test("run policy uses the most expensive selected route and never guesses missing prices", async () => {
  const config = source();
  const guard = new CostAndPolicyGuard(catalog([
    model("vendor/model", {
      inputPerMillionUsd: 1,
      outputPerMillionUsd: 2,
      requestUsd: 0.001,
      imageUsd: 0.002,
    }, [
      route("primary", 1, 2),
      route("backup", 2, 3),
    ]),
    model("gpt-priced", {
      inputPerMillionUsd: 1,
      outputPerMillionUsd: 2,
      requestUsd: 0.001,
      imageUsd: 0.002,
    }),
    model("gpt-no-price"),
  ]), config, () => now);

  const routed = await guard.preflight({
    providerId: "openrouter",
    model: "vendor/model",
    routing: { upstreams: ["primary", "backup"], allowFallbacks: true },
    attachmentCount: 2,
  }, []);
  assert.equal(routed.snapshot.pricing.status, "known");
  assert.equal(routed.snapshot.pricing.inputPerMillionUsd, 2);
  assert.equal(routed.snapshot.pricing.outputPerMillionUsd, 3);
  assert.equal(routed.snapshot.pricing.maximumRunCostMicrosUsd, 150_000);
  assert.equal(routed.snapshot.privacyProfile, "openrouter-strict-zdr");
  assert.deepEqual(routed.snapshot.limits, {
    maxOutputTokens: 4_096,
    maxTotalTokens: 50_000,
    maxRunCostMicrosUsd: 1_000_000,
  });
  assert.deepEqual(guard.accountResult(routed.snapshot, {
    usage: { requestCount: 2, inputTokens: 100, outputTokens: 20, costCredits: 0.003 },
  }).policyUsage, {
    status: "provider-reported",
    currency: "USD",
    requestCount: 2,
    costMicrosUsd: 3_000,
  });
  const routerEstimated = await guard.preflight({
    providerId: "openrouter",
    model: "vendor/model",
    attachmentCount: 2,
  }, []);
  assert.deepEqual(guard.accountResult(routerEstimated.snapshot, {
    usage: { requestCount: 2, inputTokens: 100, outputTokens: 20 },
  }).policyUsage, {
    status: "catalog-estimate",
    currency: "USD",
    requestCount: 2,
    costMicrosUsd: 10_140,
  });

  const estimated = await guard.preflight({
    providerId: "openai",
    model: "gpt-priced",
    attachmentCount: 2,
  }, []);
  assert.deepEqual(guard.accountResult(estimated.snapshot, {
    usage: { requestCount: 2, inputTokens: 100, outputTokens: 20 },
  }).policyUsage, {
    status: "catalog-estimate",
    currency: "USD",
    requestCount: 2,
    costMicrosUsd: 6_140,
  });

  const unknown = await guard.preflight({
    providerId: "openai",
    model: "gpt-no-price",
    attachmentCount: 0,
  }, []);
  assert.equal(unknown.snapshot.pricing.status, "unknown");
  assert.match(unknown.snapshot.warnings.join(" "), /가격 확인 필요/);
  assert.equal(unknown.snapshot.confirmationRequired, false);
  assert.deepEqual(guard.accountResult(unknown.snapshot, {
    usage: { requestCount: 1, inputTokens: 100, outputTokens: 20 },
  }).policyUsage, {
    status: "unknown",
    currency: "USD",
    requestCount: 1,
  });
});

test("run policy hard-blocks emergency stop and a known worst-case cost above the cap", async () => {
  const mutable = source({ maxRunCostMicrosUsd: 10_000 });
  const guard = new CostAndPolicyGuard(catalog([
    model("vendor/expensive", { inputPerMillionUsd: 100, outputPerMillionUsd: 100 }),
  ]), mutable, () => now);
  await assert.rejects(guard.preflight({
    providerId: "openrouter",
    model: "vendor/expensive",
    attachmentCount: 0,
  }, []), (error: unknown) => error instanceof RunPolicyError
    && error.statusCode === 409 && /hard limit/.test(error.message));

  mutable.value = { ...mutable.value, emergencyStop: true };
  await assert.rejects(guard.preflight({
    providerId: "openai",
    model: "gpt-any",
    attachmentCount: 0,
  }, []), (error: unknown) => error instanceof RunPolicyError
    && error.statusCode === 423 && /긴급 중단/.test(error.message));

  const codex = await guard.preflight({ providerId: "codex", attachmentCount: 0 }, []);
  assert.equal(codex.snapshot.privacyProfile, "codex-managed");
  assert.equal(codex.snapshot.limits, undefined);
});

test("monthly soft-limit confirmations are one-time and bound to model, routing, usage, and config", async () => {
  const mutable = source();
  let tokenNumber = 0;
  const guard = new CostAndPolicyGuard(catalog([
    model("vendor/a", { inputPerMillionUsd: 1, outputPerMillionUsd: 2 }, [route("primary", 1, 2)]),
    model("vendor/b", { inputPerMillionUsd: 1, outputPerMillionUsd: 2 }, [route("primary", 1, 2)]),
  ]), mutable, () => now, () => `confirmation-${++tokenNumber}`);
  const history: RunPolicyHistoryOperation[] = [{
    providerId: "openrouter",
    startedAt: "2026-08-20T00:00:00.000Z",
    result: { usage: { totalTokens: 210_000, costCredits: 10 } },
  }];
  const selection: RunPolicySelection = {
    providerId: "openrouter",
    model: "vendor/a",
    routing: { upstreams: ["primary"], allowFallbacks: false },
    attachmentCount: 0,
  };
  const preflight = await guard.preflight(selection, history);
  assert.equal(preflight.snapshot.usageWindow.dailyWarningReached, false);
  assert.equal(preflight.snapshot.usageWindow.monthlySoftLimitReached, true);
  assert.equal(preflight.snapshot.confirmationRequired, true);
  assert.equal(preflight.confirmationToken, "confirmation-1");
  await assert.rejects(guard.authorize(
    { providerId: "codex", attachmentCount: 0 },
    history,
    preflight.confirmationToken,
  ), (error: unknown) => error instanceof RunPolicyError && error.statusCode === 400);
  assert.equal((await guard.authorize(selection, history, preflight.confirmationToken)).limits?.maxOutputTokens, 4_096);
  await assert.rejects(guard.authorize(selection, history, preflight.confirmationToken), /soft limit/);

  const modelBound = await guard.preflight(selection, history);
  await assert.rejects(guard.authorize({ ...selection, model: "vendor/b" }, history, modelBound.confirmationToken), /soft limit/);

  const configBound = await guard.preflight(selection, history);
  mutable.value = { ...mutable.value, dailyTokenWarning: 300_000 };
  await assert.rejects(guard.authorize(selection, history, configBound.confirmationToken), /soft limit/);

  const historyBound = await guard.preflight(selection, history);
  const changedHistory = [...history, {
    providerId: "openrouter",
    startedAt: "2026-08-24T11:59:00.000Z",
    result: { usage: { totalTokens: 1, costCredits: 0.001 } },
  }];
  await assert.rejects(guard.authorize(selection, changedHistory, historyBound.confirmationToken), /soft limit/);
});

test("rolling-day usage produces a warning without fabricating a hard failure", async () => {
  const guard = new CostAndPolicyGuard(catalog([
    model("gpt-no-price"),
  ]), source(), () => now);
  const preflight = await guard.preflight({
    providerId: "openai",
    model: "gpt-no-price",
    attachmentCount: 0,
  }, [{
    providerId: "openai",
    startedAt: "2026-08-24T11:00:00.000Z",
    result: { usage: { totalTokens: 200_000 } },
  }, {
    providerId: "codex",
    startedAt: "2026-08-24T11:30:00.000Z",
    result: { usage: { totalTokens: 900_000 } },
  }]);
  assert.equal(preflight.snapshot.usageWindow.rollingDayTokens, 200_000);
  assert.equal(preflight.snapshot.usageWindow.dailyWarningReached, true);
  assert.match(preflight.snapshot.warnings.join(" "), /24시간 token/);
  assert.equal(preflight.snapshot.confirmationRequired, false);
});

function source(overrides: Partial<RunPolicyConfig> = {}) {
  return {
    value: { ...DEFAULT_RUN_POLICY_CONFIG, ...overrides },
    runPolicy() { return { ...this.value }; },
  };
}

function catalog(models: ProviderModel[]) {
  return { async models() { return structuredClone(models); } };
}

function model(
  id: string,
  pricing?: ProviderModel["pricing"],
  routingOptions?: ProviderModel["routingOptions"],
): ProviderModel {
  return {
    id,
    displayName: id,
    description: "fixture",
    isDefault: true,
    defaultEffort: "",
    efforts: [],
    ...(pricing ? { pricing } : {}),
    ...(routingOptions ? { routingOptions } : {}),
  };
}

function route(id: string, input: number, output: number) {
  return {
    id,
    displayName: id,
    pricing: { inputPerMillionUsd: input, outputPerMillionUsd: output },
  };
}
