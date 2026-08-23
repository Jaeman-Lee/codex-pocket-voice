import assert from "node:assert/strict";
import test from "node:test";
import {
  ApprovalBrokerError,
  InMemoryApprovalBroker,
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
