import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  combinedModelVerification,
  modelToolAccess,
  modelVerification,
  parseProviderModelGradeReport,
  ProtectedProviderModelGradeSource,
  safeLoadModelGrades,
} from "../src/providers/model-grades.js";

const checkedAt = "2026-08-24T00:00:00.000Z";
const currentTime = Date.parse("2026-08-25T00:00:00.000Z");

test("protected model grade reports grant only normalized provider/model/upstream access", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-pocket-model-grades-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "grades");
  await mkdir(directory, { mode: 0o700 });
  await writeFile(join(directory, "openai-project.json"), JSON.stringify(openAIReport()), { mode: 0o600 });
  await writeFile(join(directory, "openrouter-project.json"), JSON.stringify(openRouterReport()), { mode: 0o400 });
  const source = new ProtectedProviderModelGradeSource(
    { CODEX_POCKET_PROVIDER_GRADE_DIR: directory },
    () => currentTime,
  );

  const openAI = await source.load("openai");
  assert.equal(openAI.length, 1);
  assert.equal(modelToolAccess(modelVerification(openAI, "gpt-eval-model")), "coding");
  assert.equal(modelToolAccess(modelVerification(openAI, "gpt-other")), "none");

  const openRouter = await source.load("openrouter");
  assert.equal(openRouter.length, 1);
  assert.equal(openRouter[0]?.actualProvider, "Strict Eval");
  assert.equal(modelToolAccess(modelVerification(openRouter, "vendor/eval-model", "strict-eval")), "coding");
  assert.equal(modelToolAccess(modelVerification(openRouter, "vendor/eval-model", "other-upstream")), "none");
  assert.equal(combinedModelVerification([
    modelVerification(openRouter, "vendor/eval-model", "strict-eval"),
    modelVerification(openRouter, "vendor/eval-model", "other-upstream"),
  ]).coding, "not_tested");
});

test("expired reports and incomplete contract grades never grant project tools", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-pocket-expired-grades-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "expired.json"), JSON.stringify(openAIReport()), { mode: 0o600 });
  const expired = new ProtectedProviderModelGradeSource(
    { CODEX_POCKET_PROVIDER_GRADE_DIR: root },
    () => Date.parse("2026-10-01T00:00:00.000Z"),
  );
  const expiredRecords = await expired.load("openai");
  assert.equal(modelVerification(expiredRecords, "gpt-eval-model").coding, "expired");
  assert.equal(modelToolAccess(modelVerification(expiredRecords, "gpt-eval-model")), "none");

  await writeFile(join(root, "expired.json"), JSON.stringify(openAIReport({ functionCalling: "fail" })), { mode: 0o600 });
  const incomplete = new ProtectedProviderModelGradeSource(
    { CODEX_POCKET_PROVIDER_GRADE_DIR: root },
    () => currentTime,
  );
  const incompleteRecords = await incomplete.load("openai");
  assert.equal(modelVerification(incompleteRecords, "gpt-eval-model").conversation, "fail");
  assert.equal(modelVerification(incompleteRecords, "gpt-eval-model").projectRead, "fail");
  assert.equal(modelToolAccess(modelVerification(incompleteRecords, "gpt-eval-model")), "none");
});

test("model grade loading fails closed on broad modes, symlinks, and identity mismatch", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-pocket-invalid-grades-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const report = join(root, "grade.json");
  await writeFile(report, JSON.stringify(openAIReport()), { mode: 0o644 });
  const source = new ProtectedProviderModelGradeSource(
    { CODEX_POCKET_PROVIDER_GRADE_DIR: root },
    () => currentTime,
  );
  assert.equal((await safeLoadModelGrades(source, "openai")).invalid, true);

  await chmod(report, 0o600);
  await writeFile(report, JSON.stringify({ ...openAIReport(), actualModel: "gpt-eval-model-mini" }), { mode: 0o600 });
  assert.equal((await safeLoadModelGrades(source, "openai")).invalid, true);

  await rm(report);
  const target = join(root, "target");
  await writeFile(target, JSON.stringify(openAIReport()), { mode: 0o600 });
  await symlink(target, report);
  assert.equal((await safeLoadModelGrades(source, "openai")).invalid, true);
});

test("model grade directories and reports accept only documented owner modes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-pocket-grade-modes-"));
  const directory = join(root, "grades");
  t.after(async () => {
    await chmod(directory, 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(directory, { mode: 0o700 });
  const report = join(directory, "grade.json");
  await writeFile(report, JSON.stringify(openAIReport()), { mode: 0o700 });
  const source = new ProtectedProviderModelGradeSource(
    { CODEX_POCKET_PROVIDER_GRADE_DIR: directory },
    () => currentTime,
  );
  assert.equal((await safeLoadModelGrades(source, "openai")).invalid, true);

  await chmod(report, 0o600);
  await chmod(directory, 0o600);
  assert.equal((await safeLoadModelGrades(source, "openai")).invalid, true);

  await chmod(directory, 0o500);
  assert.equal((await safeLoadModelGrades(source, "openai")).invalid, false);
});

test("same-time conflicting reports invalidate the provider grade set", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-pocket-grade-conflict-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "first.json"), JSON.stringify(openAIReport()), { mode: 0o600 });
  await writeFile(join(root, "second.json"), JSON.stringify(openAIReport({ coding: "fail" })), { mode: 0o600 });
  const source = new ProtectedProviderModelGradeSource(
    { CODEX_POCKET_PROVIDER_GRADE_DIR: root },
    () => currentTime,
  );
  assert.equal((await safeLoadModelGrades(source, "openai")).invalid, true);
});

test("project tool grades require exact protected evaluation, usage, and cost evidence", () => {
  const missingEvaluation = openAIReport();
  delete (missingEvaluation as Partial<typeof missingEvaluation>).evaluation;
  assert.throws(
    () => parseProviderModelGradeReport(JSON.stringify(missingEvaluation), currentTime),
    /보호된 평가 증거가 없습니다/,
  );

  const wrongRequestLimit = openAIReport();
  wrongRequestLimit.evaluation.maximumRequests = 2;
  assert.throws(
    () => parseProviderModelGradeReport(JSON.stringify(wrongRequestLimit), currentTime),
    /요청 상한이 잘못됐습니다/,
  );

  const excessiveBudget = openRouterReport();
  excessiveBudget.budgetUsd = 0.050001;
  assert.throws(
    () => parseProviderModelGradeReport(JSON.stringify(excessiveBudget), currentTime),
    /비용 상한이 잘못됐습니다/,
  );

  const mismatchedUsageCost = openAIReport();
  mismatchedUsageCost.actualEstimatedUsd = 0.01;
  assert.throws(
    () => parseProviderModelGradeReport(JSON.stringify(mismatchedUsageCost), currentTime),
    /비용 계산이 일치하지 않습니다/,
  );

  const mismatchedPreflightCost = openAIReport();
  mismatchedPreflightCost.estimatedMaximumUsd = 0.01;
  assert.throws(
    () => parseProviderModelGradeReport(JSON.stringify(mismatchedPreflightCost), currentTime),
    /사전 비용 계산이 일치하지 않습니다/,
  );

  const mismatchedRouterPreflightCost = openRouterReport();
  mismatchedRouterPreflightCost.pricingBasis.requestUsd = 0.001;
  assert.throws(
    () => parseProviderModelGradeReport(JSON.stringify(mismatchedRouterPreflightCost), currentTime),
    /OpenRouter project grade 사전 비용 계산이 일치하지 않습니다/,
  );

  const mismatchedRouterActualCost = openRouterReport();
  mismatchedRouterActualCost.actualEstimatedUsd = 0.000141;
  assert.throws(
    () => parseProviderModelGradeReport(JSON.stringify(mismatchedRouterActualCost), currentTime),
    /OpenRouter project grade 비용 계산이 일치하지 않습니다/,
  );

  const wrongServiceTier = openAIReport();
  wrongServiceTier.privacyProfile.serviceTier = "flex";
  assert.throws(
    () => parseProviderModelGradeReport(JSON.stringify(wrongServiceTier), currentTime),
    /privacy profile이 잘못됐습니다/,
  );

  const privateTopLevel = openAIReport() as ReturnType<typeof openAIReport> & { prompt: string };
  privateTopLevel.prompt = "private prompt";
  assert.throws(
    () => parseProviderModelGradeReport(JSON.stringify(privateTopLevel), currentTime),
    /redacted schema가 잘못됐습니다/,
  );

  const privateUsage = openRouterReport();
  (privateUsage.usage as typeof privateUsage.usage & { modelOutput: string }).modelOutput = "private output";
  assert.throws(
    () => parseProviderModelGradeReport(JSON.stringify(privateUsage), currentTime),
    /usage 증거가 잘못됐습니다/,
  );
});

test("a complete read-only evaluation grants read tools but never coding tools", () => {
  const report = openAIReport({ coding: "not_tested" });
  report.calls = 2;
  report.estimatedMaximumUsd = 0.017408;
  report.evaluation = {
    scope: "read",
    fixture: "ephemeral_synthetic_workspace",
    approval: "not_required",
    maximumRequests: 2,
    outcome: "pass",
    tools: [{ name: "workspace_read", status: "completed" }],
  };
  report.usage.requestCount = 2;
  const parsed = parseProviderModelGradeReport(JSON.stringify(report), currentTime);
  assert.equal(modelToolAccess(parsed.verification), "read");
});

function openAIReport(overrides: Record<string, string> = {}) {
  const codingPassed = overrides.coding !== "fail" && overrides.coding !== "not_tested";
  return {
    schemaVersion: 1,
    provider: "openai",
    requestedModel: "gpt-eval-model",
    actualModel: "gpt-eval-model-2026-08-01",
    privacyProfile: { store: false, serviceTier: "default" },
    grades: {
      streaming: "pass",
      conversation: "pass",
      functionCalling: "pass",
      statelessReplay: "pass",
      projectRead: "pass",
      coding: "pass",
      ...overrides,
    },
    budgetUsd: 0.05,
    estimatedMaximumUsd: 0.026112,
    calls: 3,
    usage: {
      requestCount: 3,
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      cachedInputTokens: 0,
      reasoningTokens: 0,
    },
    actualEstimatedUsd: 0.00014,
    pricingBasis: {
      currency: "USD",
      inputUsdPerMillion: 1,
      outputUsdPerMillion: 2,
      source: "operator_reviewed",
    },
    evaluation: {
      scope: "coding",
      fixture: "ephemeral_synthetic_workspace",
      approval: "protected_workflow_and_exact_confirmation",
      maximumRequests: 3,
      outcome: codingPassed ? "pass" : "contract_failed",
      tools: codingPassed
        ? [
            { name: "workspace_read", status: "completed" },
            { name: "workspace_replace_text", status: "completed" },
          ]
        : [{ name: "workspace_read", status: "completed" }],
    },
    checkedAt,
  };
}

function openRouterReport() {
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
      projectRead: "pass",
      coding: "pass",
    },
    budgetUsd: 0.05,
    estimatedMaximumUsd: 0.026112,
    calls: 3,
    usage: {
      requestCount: 3,
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      costCredits: 0.001,
    },
    actualEstimatedUsd: 0.00014,
    actualCostCredits: 0.001,
    creditBaseCurrency: "USD",
    pricingBasis: {
      currency: "USD",
      inputUsdPerMillion: 1,
      outputUsdPerMillion: 2,
      requestUsd: 0,
      source: "zdr_endpoint_catalog",
    },
    evaluation: {
      scope: "coding",
      fixture: "ephemeral_synthetic_workspace",
      approval: "protected_workflow_and_exact_confirmation",
      maximumRequests: 3,
      outcome: "pass",
      tools: [
        { name: "workspace_read", status: "completed" },
        { name: "workspace_replace_text", status: "completed" },
      ],
    },
    checkedAt,
  };
}
