import assert from "node:assert/strict";
import test from "node:test";
import {
  RunForkManager,
  RunForkManagerError,
  type RunForkSelection,
} from "../src/run-fork-manager.js";
import type { RunOperation } from "../src/run-coordinator.js";
import type { RunPolicySnapshot } from "../src/run-policy.js";

const source: RunOperation = {
  id: "source-operation",
  providerId: "codex",
  conversationId: "source-thread",
  runId: "source-turn",
  cwd: process.cwd(),
  prompt: "inspect the mobile overflow",
  steers: [{
    requestId: "client:steer-1",
    requestFingerprint: "a".repeat(64),
    prompt: "focus on the composer",
    attachmentCount: 0,
    requestedAt: "2026-08-24T10:00:00.000Z",
    acceptedAt: "2026-08-24T10:00:01.000Z",
  }],
  status: "completed",
  startedAt: "2026-08-24T10:00:00.000Z",
  completedAt: "2026-08-24T10:01:00.000Z",
  result: {
    finalResponse: "The mobile composer now stays inside 320px.",
    commands: [{ command: "private command", output: "private output" }],
  },
};

const selection: RunForkSelection = {
  targetProviderId: "openai",
  accountId: "api-default",
  model: "gpt-fixture",
  effort: "medium",
  networkAccess: false,
  prompt: "review the result independently",
  attachmentIds: ["media-1"],
};

const policy: RunPolicySnapshot = {
  schema: 1,
  providerId: "openai",
  model: "gpt-fixture",
  privacyProfile: "openai-store-false",
  evaluatedAt: "2026-08-24T10:02:00.000Z",
  configRevision: "0123456789abcdef",
  attachmentCount: 1,
  limits: { maxOutputTokens: 4_096, maxTotalTokens: 50_000, maxRunCostMicrosUsd: 1_000_000 },
  pricing: { status: "unknown", source: "unavailable" },
  usageWindow: {
    rollingDayTokens: 0,
    monthCostMicrosUsd: 0,
    dailyWarningReached: false,
    monthlySoftLimitReached: false,
  },
  warnings: [],
  confirmationRequired: false,
};

test("RunForkManager previews only bounded reviewed context and binds one request", () => {
  let now = Date.parse("2026-08-24T10:02:00.000Z");
  const manager = new RunForkManager(() => now, () => "fork-preview-1");
  const preview = manager.create({
    clientId: "paired-client",
    source,
    selection,
    attachments: { promptContext: "\n\n[attachment summary]", imagePaths: ["/private/media.png"] },
    policy,
  });

  assert.equal(preview.source.operationId, source.id);
  assert.equal(preview.target.providerId, "openai");
  assert.deepEqual(preview.context.items.map((item) => item.label), [
    "원본 사용자 요청", "방향 수정 1", "최종 assistant 답변",
  ]);
  assert.doesNotMatch(JSON.stringify(preview), /private command|private output|private\/media/);
  assert.ok(preview.context.excluded.includes("원시 diff"));
  assert.equal(preview.context.attachmentCount, 1);

  now += 1_000;
  const prepared = manager.claim({
    previewId: preview.id,
    clientId: "paired-client",
    requestId: "fork-request-1",
    source,
    selection,
  });
  assert.match(prepared.providerPrompt, /참고 데이터/);
  assert.match(prepared.providerPrompt, /review the result independently/);
  assert.deepEqual(prepared.imagePaths, ["/private/media.png"]);
  assert.equal(prepared.provenance.sourceOperationId, source.id);
  assert.match(prepared.provenance.contextDigest, /^[a-f0-9]{64}$/);

  const retry = manager.claim({
    previewId: preview.id,
    clientId: "paired-client",
    requestId: "fork-request-1",
    source,
    selection,
  });
  assert.equal(retry.provenance.confirmedAt, prepared.provenance.confirmedAt);
  assert.throws(
    () => manager.claim({
      previewId: preview.id,
      clientId: "paired-client",
      requestId: "fork-request-2",
      source,
      selection,
    }),
    (error: unknown) => error instanceof RunForkManagerError && error.statusCode === 409,
  );
});

test("RunForkManager rejects stale, cross-client, changed, active, and same-provider forks", () => {
  let now = Date.parse("2026-08-24T10:02:00.000Z");
  let id = 0;
  const manager = new RunForkManager(() => now, () => `fork-preview-${++id}`);
  const preview = manager.create({
    clientId: "paired-client",
    source,
    selection,
    attachments: { promptContext: "", imagePaths: [] },
    policy: { ...policy, attachmentCount: 0 },
  });
  assert.throws(
    () => manager.claim({ ...claimInput(preview.id), clientId: "another-client" }),
    (error: unknown) => error instanceof RunForkManagerError && error.statusCode === 403,
  );
  assert.throws(
    () => manager.claim({ ...claimInput(preview.id), source: { ...source, result: { finalResponse: "changed" } } }),
    (error: unknown) => error instanceof RunForkManagerError && error.statusCode === 409,
  );
  assert.throws(
    () => manager.create({
      clientId: "paired-client",
      source: { ...source, status: "running", completedAt: undefined },
      selection,
      attachments: { promptContext: "", imagePaths: [] },
      policy: { ...policy, attachmentCount: 0 },
    }),
    (error: unknown) => error instanceof RunForkManagerError && error.statusCode === 409,
  );
  assert.throws(
    () => manager.create({
      clientId: "paired-client",
      source,
      selection: { ...selection, targetProviderId: "codex", attachmentIds: [] },
      attachments: { promptContext: "", imagePaths: [] },
      policy: { ...policy, providerId: "codex", model: selection.model, attachmentCount: 0 },
    }),
    (error: unknown) => error instanceof RunForkManagerError && error.statusCode === 409,
  );

  now += 10 * 60_000;
  assert.throws(
    () => manager.claim(claimInput(preview.id)),
    (error: unknown) => error instanceof RunForkManagerError && error.statusCode === 409,
  );
});

function claimInput(previewId: string) {
  return {
    previewId,
    clientId: "paired-client",
    requestId: "fork-request",
    source,
    selection: { ...selection, attachmentIds: [] },
  };
}
