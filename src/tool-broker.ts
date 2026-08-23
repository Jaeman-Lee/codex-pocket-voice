import { createHash } from "node:crypto";
import type {
  ApprovalBroker,
  ApprovalRequestInput,
  ApprovalRisk,
} from "./approval-broker.js";
import type { PathPolicy } from "./path-policy.js";

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  risk: ApprovalRisk;
}

export interface ToolCall {
  providerId: string;
  conversationId: string;
  runId: string;
  toolCallId: string;
  name: string;
  input: unknown;
}

export interface ToolExecutionContext {
  cwd: string;
  signal?: AbortSignal;
}

export interface ToolExecutionResult {
  toolCallId: string;
  status: "completed" | "denied" | "failed";
  output?: unknown;
  error?: string;
}

export interface RegisteredTool<Input = unknown> {
  definition: ToolDefinition;
  validate(input: unknown): Input;
  approval(input: Input, context: ToolExecutionContext): Pick<
    ApprovalRequestInput,
    "redactedSummary" | "redactedDetails" | "requiresTouch"
  >;
  execute(input: Input, context: ToolExecutionContext): Promise<unknown>;
}

export interface ToolBroker {
  definitions(): ToolDefinition[];
  execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolExecutionResult>;
  clearRun(providerId: string, runId: string): void;
}

interface ExecutionEntry {
  fingerprint: string;
  runKey: string;
  promise: Promise<ToolExecutionResult>;
}

export class ToolBrokerError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

export class LocalToolBroker implements ToolBroker {
  private readonly tools = new Map<string, RegisteredTool>();
  private readonly executions = new Map<string, ExecutionEntry>();

  constructor(
    tools: RegisteredTool[],
    private readonly approvals: ApprovalBroker,
    private readonly paths: PathPolicy,
  ) {
    for (const tool of tools) {
      if (this.tools.has(tool.definition.name)) {
        throw new ToolBrokerError(500, `Duplicate local tool: ${tool.definition.name}`);
      }
      this.tools.set(tool.definition.name, tool);
    }
  }

  definitions(): ToolDefinition[] {
    return [...this.tools.values()].map((tool) => structuredClone(tool.definition));
  }

  execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    this.paths.assertAllowed(context.cwd);
    const key = toolCallKey(call);
    const fingerprint = toolCallFingerprint(call, context.cwd);
    const existing = this.executions.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new ToolBrokerError(409, "같은 tool-call ID로 다른 로컬 도구를 실행할 수 없습니다.");
      }
      return existing.promise;
    }

    const promise = this.executeNew(call, context);
    this.executions.set(key, { fingerprint, runKey: runKey(call.providerId, call.runId), promise });
    return promise;
  }

  clearRun(providerId: string, runId: string): void {
    const expected = runKey(providerId, runId);
    for (const [key, entry] of this.executions) {
      if (entry.runKey === expected) this.executions.delete(key);
    }
  }

  private async executeNew(call: ToolCall, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const tool = this.tools.get(call.name);
    if (!tool) throw new ToolBrokerError(400, `허용되지 않은 로컬 도구입니다: ${call.name}`);
    const input = tool.validate(call.input);

    if (tool.definition.risk !== "observation") {
      const approval = tool.approval(input, context);
      const handle = this.approvals.requestApproval({
        providerId: call.providerId,
        conversationId: call.conversationId,
        runId: call.runId,
        toolCallId: call.toolCallId,
        risk: tool.definition.risk,
        redactedSummary: approval.redactedSummary,
        redactedDetails: approval.redactedDetails,
        requiresTouch: approval.requiresTouch,
      });
      const resolution = await handle.decision;
      if (resolution.decision !== "approved") {
        return { toolCallId: call.toolCallId, status: "denied" };
      }
    }

    if (context.signal?.aborted) {
      return { toolCallId: call.toolCallId, status: "failed", error: "도구 실행이 중단됐습니다." };
    }
    try {
      const output = await tool.execute(input, context);
      return { toolCallId: call.toolCallId, status: "completed", output };
    } catch {
      return { toolCallId: call.toolCallId, status: "failed", error: "도구 실행에 실패했습니다." };
    }
  }
}

function toolCallKey(call: ToolCall): string {
  return JSON.stringify([call.providerId, call.runId, call.toolCallId]);
}

function runKey(providerId: string, runId: string): string {
  return JSON.stringify([providerId, runId]);
}

function toolCallFingerprint(call: ToolCall, cwd: string): string {
  return createHash("sha256").update(JSON.stringify({
    conversationId: call.conversationId,
    name: call.name,
    input: call.input,
    cwd,
  })).digest("hex");
}
