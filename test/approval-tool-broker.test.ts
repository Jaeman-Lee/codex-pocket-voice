import assert from "node:assert/strict";
import test from "node:test";
import {
  ApprovalBrokerError,
  InMemoryApprovalBroker,
  MAX_APPROVAL_FEEDBACK_COMMENT_LENGTH,
  MAX_APPROVAL_FEEDBACK_LINES,
  parseApprovalFeedback,
  type ApprovalBrokerEvent,
} from "../src/approval-broker.js";
import { PathPolicy } from "../src/path-policy.js";
import {
  LocalToolBroker,
  ToolBrokerError,
  type RegisteredTool,
} from "../src/tool-broker.js";

test("ApprovalBroker deduplicates tool calls and requires touch for high-risk approval", async () => {
  const approvals = new InMemoryApprovalBroker({ createId: () => "approval-1" });
  const events: ApprovalBrokerEvent[] = [];
  approvals.subscribe((event) => events.push(event));
  const input = {
    providerId: "fake",
    conversationId: "conversation-1",
    runId: "run-1",
    toolCallId: "tool-call-1",
    risk: "high_risk" as const,
    redactedSummary: "delete one generated file",
  };

  const first = approvals.requestApproval(input);
  const duplicate = approvals.requestApproval(input);
  assert.equal(first.request.id, duplicate.request.id);
  assert.equal(approvals.listPending().length, 1);
  assert.equal(events.filter((event) => event.type === "requested").length, 1);
  assert.throws(
    () => approvals.resolve(first.request.id, "approved", "voice"),
    (error: unknown) => error instanceof ApprovalBrokerError && error.statusCode === 403,
  );

  const resolution = approvals.resolve(first.request.id, "approved", "touch");
  assert.equal(resolution.decision, "approved");
  assert.equal((await first.decision).decision, "approved");
  assert.equal((await duplicate.decision).source, "touch");
  assert.deepEqual(approvals.listPending(), []);
  assert.equal(approvals.get(first.request.id)?.status, "approved");
  approvals.close();
});

test("ApprovalBroker rejects unbounded or non-JSON review details", () => {
  const approvals = new InMemoryApprovalBroker();
  const base = {
    providerId: "fake",
    conversationId: "conversation-1",
    runId: "run-1",
    toolCallId: "tool-1",
    risk: "change" as const,
    redactedSummary: "review change",
  };
  assert.throws(
    () => approvals.requestApproval({ ...base, redactedDetails: { value: "x".repeat(33 * 1024) } }),
    (error: unknown) => error instanceof ApprovalBrokerError && error.statusCode === 400,
  );
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(
    () => approvals.requestApproval({ ...base, redactedDetails: cyclic }),
    (error: unknown) => error instanceof ApprovalBrokerError && error.statusCode === 400,
  );
  approvals.close();
});

test("ApprovalBroker accepts bounded line feedback only for a touch decline", async () => {
  const approvals = new InMemoryApprovalBroker({ createId: () => "approval-feedback" });
  const handle = approvals.requestApproval({
    providerId: "openai",
    conversationId: "conversation-feedback",
    runId: "run-feedback",
    toolCallId: "tool-feedback",
    risk: "change",
    redactedSummary: "review a file change",
  });
  const feedback = parseApprovalFeedback({
    lines: [{
      path: "src/review.ts",
      oldLine: 7,
      newLine: 8,
      code: "return next;",
      comment: "기존 null 처리도 유지해 주세요.\r\n테스트도 추가해 주세요.",
    }],
  });
  assert.throws(
    () => approvals.resolve(handle.request.id, "approved", "touch", feedback),
    (error: unknown) => error instanceof ApprovalBrokerError && error.statusCode === 400,
  );
  assert.throws(
    () => approvals.resolve(handle.request.id, "declined", "voice", feedback),
    (error: unknown) => error instanceof ApprovalBrokerError && error.statusCode === 400,
  );

  const resolution = approvals.resolve(handle.request.id, "declined", "touch", feedback);
  assert.equal(resolution.decision, "declined");
  assert.equal(resolution.source, "touch");
  assert.equal(resolution.feedback?.lines[0]?.comment, "기존 null 처리도 유지해 주세요.\n테스트도 추가해 주세요.");
  assert.deepEqual(await handle.decision, resolution);
  assert.deepEqual(approvals.resolve(handle.request.id, "declined", "touch", feedback), resolution);
  assert.throws(
    () => approvals.resolve(handle.request.id, "declined", "touch", parseApprovalFeedback({
      lines: [{ ...feedback.lines[0], comment: "다른 의견" }],
    })),
    (error: unknown) => error instanceof ApprovalBrokerError && error.statusCode === 409,
  );
  approvals.close();
});

test("Approval line feedback rejects unsafe, duplicate, and unbounded input", () => {
  const valid = {
    path: "src/review.ts",
    newLine: 1,
    code: "safe();",
    comment: "수정해 주세요.",
  };
  const invalid: unknown[] = [
    null,
    { lines: [] },
    { lines: Array.from({ length: MAX_APPROVAL_FEEDBACK_LINES + 1 }, (_, index) => ({ ...valid, newLine: index + 1 })) },
    { lines: [{ ...valid, path: "/etc/passwd" }] },
    { lines: [{ ...valid, path: "../outside.ts" }] },
    { lines: [{ ...valid, path: "src\\windows.ts" }] },
    { lines: [{ ...valid, oldLine: undefined, newLine: undefined }] },
    { lines: [{ ...valid, comment: "x".repeat(MAX_APPROVAL_FEEDBACK_COMMENT_LENGTH + 1) }] },
    { lines: [valid, { ...valid }] },
    { lines: [{ ...valid, secret: "must not pass" }] },
  ];
  for (const value of invalid) {
    assert.throws(
      () => parseApprovalFeedback(value),
      (error: unknown) => error instanceof ApprovalBrokerError && error.statusCode === 400,
    );
  }
});

test("ApprovalBroker expires offline requests without ever auto-approving them", async () => {
  let now = 1_000;
  const approvals = new InMemoryApprovalBroker({ now: () => now, createId: () => "approval-expiring" });
  const handle = approvals.requestApproval({
    providerId: "fake",
    conversationId: "conversation-1",
    runId: "run-1",
    toolCallId: "tool-call-expiring",
    risk: "change",
    redactedSummary: "apply a patch",
    expiresInMs: 1_000,
  });
  now = 2_001;
  assert.equal(approvals.sweepExpired(), 1);
  assert.equal((await handle.decision).decision, "expired");
  assert.throws(
    () => approvals.resolve(handle.request.id, "approved", "touch"),
    (error: unknown) => error instanceof ApprovalBrokerError && error.statusCode === 409,
  );
  approvals.close();
});

test("LocalToolBroker validates locally, gates changes, and deduplicates execution", async () => {
  const paths = await PathPolicy.fromEnvironment(process.cwd());
  const approvals = new InMemoryApprovalBroker({ createId: () => "approval-change" });
  let readExecutions = 0;
  let writeExecutions = 0;
  const readTool: RegisteredTool<string> = {
    definition: {
      name: "read_text",
      description: "Read an allowed text fixture",
      inputSchema: { type: "string" },
      risk: "observation",
    },
    validate(input) {
      if (typeof input !== "string") throw new ToolBrokerError(400, "text required");
      return input;
    },
    approval: () => ({ redactedSummary: "read text" }),
    async execute(input) {
      readExecutions += 1;
      return input.toUpperCase();
    },
  };
  const writeTool: RegisteredTool<number> = {
    definition: {
      name: "apply_count",
      description: "Apply a validated numeric change",
      inputSchema: { type: "number" },
      risk: "change",
    },
    validate(input) {
      if (typeof input !== "number") throw new ToolBrokerError(400, "number required");
      return input;
    },
    approval: (input) => ({ redactedSummary: `apply ${input} validated changes` }),
    async execute(input) {
      writeExecutions += 1;
      return input + 1;
    },
  };
  const broker = new LocalToolBroker([readTool, writeTool], approvals, paths);

  const readCall = {
    providerId: "fake",
    conversationId: "conversation-1",
    runId: "run-1",
    toolCallId: "read-1",
    name: "read_text",
    input: "safe",
  };
  const firstRead = await broker.execute(readCall, { cwd: process.cwd() });
  const duplicateRead = await broker.execute(readCall, { cwd: process.cwd() });
  assert.equal(firstRead.output, "SAFE");
  assert.equal(duplicateRead.output, "SAFE");
  assert.equal(readExecutions, 1);
  assert.throws(
    () => broker.execute({ ...readCall, input: "different" }, { cwd: process.cwd() }),
    (error: unknown) => error instanceof ToolBrokerError && error.statusCode === 409,
  );

  const writePromise = broker.execute({
    ...readCall,
    toolCallId: "write-1",
    name: "apply_count",
    input: 4,
  }, { cwd: process.cwd() });
  await Promise.resolve();
  const pending = approvals.listPending()[0];
  assert.equal(pending?.risk, "change");
  approvals.resolve(pending!.id, "approved", "voice");
  const write = await writePromise;
  assert.equal(write.status, "completed");
  assert.equal(write.output, 5);
  assert.equal(writeExecutions, 1);
  approvals.close();
});

test("LocalToolBroker blocks workspaces outside PathPolicy before tool execution", async () => {
  const paths = await PathPolicy.fromEnvironment(process.cwd());
  const approvals = new InMemoryApprovalBroker();
  const tool: RegisteredTool<string> = {
    definition: {
      name: "read_text",
      description: "Read text",
      inputSchema: { type: "string" },
      risk: "observation",
    },
    validate: (input) => String(input),
    approval: () => ({ redactedSummary: "read text" }),
    execute: async (input) => input,
  };
  const broker = new LocalToolBroker([tool], approvals, paths);
  assert.throws(
    () => broker.execute({
      providerId: "fake",
      conversationId: "conversation-1",
      runId: "run-1",
      toolCallId: "outside-1",
      name: "read_text",
      input: "blocked",
    }, { cwd: "/outside/allowed/root" }),
    /not allowed/,
  );
  approvals.close();
});

test("LocalToolBroker resolves a pending approval as declined when the run is cancelled", async () => {
  const paths = await PathPolicy.fromEnvironment(process.cwd());
  const approvals = new InMemoryApprovalBroker({ createId: () => "approval-cancelled" });
  const resolutions: string[] = [];
  approvals.subscribe((event) => {
    if (event.type === "resolved") resolutions.push(`${event.resolution.decision}:${event.resolution.source}`);
  });
  const tool: RegisteredTool<Record<string, never>> = {
    definition: {
      name: "change_after_review",
      description: "Change only after review",
      inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
      risk: "change",
    },
    validate: () => ({}),
    approval: () => ({ redactedSummary: "Change after review", requiresTouch: true }),
    async execute() { throw new Error("cancelled approval must never execute"); },
  };
  const broker = new LocalToolBroker([tool], approvals, paths);
  const controller = new AbortController();
  const result = broker.execute({
    providerId: "openai",
    conversationId: "cancel-conversation",
    runId: "cancel-run",
    toolCallId: "cancel-tool",
    name: "change_after_review",
    input: {},
  }, { cwd: process.cwd(), signal: controller.signal });
  await Promise.resolve();
  assert.equal(approvals.listPending().length, 1);
  controller.abort();
  assert.equal((await result).status, "denied");
  assert.deepEqual(resolutions, ["declined:system"]);
  assert.equal(approvals.listPending().length, 0);
  approvals.close();
});

test("LocalToolBroker returns touch decline feedback to the same provider run without executing", async () => {
  const paths = await PathPolicy.fromEnvironment(process.cwd());
  const approvals = new InMemoryApprovalBroker({ createId: () => "approval-reviewed-decline" });
  let executions = 0;
  const tool: RegisteredTool<Record<string, never>> = {
    definition: {
      name: "apply_reviewed_change",
      description: "Apply only after line review",
      inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
      risk: "change",
    },
    validate: () => ({}),
    approval: () => ({ redactedSummary: "Review proposed change", requiresTouch: true }),
    async execute() {
      executions += 1;
      return { changed: true };
    },
  };
  const broker = new LocalToolBroker([tool], approvals, paths);
  const resultPromise = broker.execute({
    providerId: "openai",
    conversationId: "feedback-conversation",
    runId: "feedback-run",
    toolCallId: "feedback-tool",
    name: "apply_reviewed_change",
    input: {},
  }, { cwd: process.cwd() });
  await Promise.resolve();
  const pending = approvals.listPending()[0]!;
  approvals.resolve(pending.id, "declined", "touch", parseApprovalFeedback({
    lines: [{
      path: "src/review.ts",
      newLine: 9,
      code: "unsafe();",
      comment: "안전한 helper를 사용해 주세요.",
    }],
  }));
  const result = await resultPromise;
  assert.equal(result.status, "denied");
  assert.match(result.error ?? "", /같은 run에서 수정안을 다시 만들고 새 승인을 요청/u);
  assert.match(result.error ?? "", /src\/review\.ts \(new 9\)/u);
  assert.match(result.error ?? "", /안전한 helper를 사용해 주세요/u);
  assert.equal(executions, 0);
  approvals.close();
});
