import type { InitializeResponse } from "../../generated/app-server/InitializeResponse";
import type { ModelListResponse } from "../../generated/app-server/v2/ModelListResponse";
import type { AppServerNotification, BeginTurnResult, RunTurnOptions } from "../app-server-client.js";
import { summarizeTurn } from "../result.js";
import {
  ProviderError,
  type ModelProviderAdapter,
  type ProviderConnectionTest,
  type ProviderDescriptor,
  type ProviderEvent,
  type ProviderLoginSpec,
  type ProviderModel,
  type ProviderRun,
  type ProviderRunInput,
  type ProviderRunStatus,
  type ProviderRuntime,
} from "./types.js";

export interface CodexProviderClient {
  start(): Promise<InitializeResponse>;
  listModels(): Promise<ModelListResponse>;
  beginTurn(options: RunTurnOptions): Promise<BeginTurnResult>;
  interrupt(threadId: string, turnId: string): Promise<void>;
  subscribe(listener: (notification: AppServerNotification) => void): () => void;
}

export class CodexProviderAdapter implements ModelProviderAdapter, ProviderRuntime {
  readonly id = "codex" as const;
  readonly canRun = true;
  readonly runtime: ProviderRuntime = this;

  constructor(private readonly client: CodexProviderClient) {}

  async describe(): Promise<ProviderDescriptor> {
    const initialized = await this.client.start();
    return {
      id: this.id,
      name: "OpenAI Codex",
      available: true,
      status: "connected",
      detail: "이 단말의 Codex CLI 로그인 사용",
      accounts: [{
        id: "cli-default",
        label: process.env.CODEX_ACCOUNT_LABEL ?? "현재 CLI 로그인",
        connected: true,
      }],
      loginCommand: "codex login --device-auth",
      installed: true,
      version: initialized.userAgent,
      canLogin: true,
      canTest: true,
      capabilities: {
        run: true,
        resume: true,
        models: true,
        attachments: true,
        streaming: true,
        approvals: false,
        workspaceRead: true,
        workspaceWrite: true,
        commandExecution: true,
        usageAccounting: false,
      },
      installGuide: {
        summary: "Linux 공식 설치 스크립트",
        command: "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
        docsUrl: "https://developers.openai.com/codex/cli/",
      },
    };
  }

  async listModels(): Promise<ProviderModel[]> {
    const catalog = await this.client.listModels();
    return catalog.data.filter((model) => !model.hidden).map((model) => ({
      id: model.model,
      displayName: model.displayName,
      description: model.description,
      isDefault: model.isDefault,
      defaultEffort: model.defaultReasoningEffort,
      efforts: model.supportedReasoningEfforts.map((option) => ({
        id: option.reasoningEffort,
        description: option.description,
      })),
    }));
  }

  assertAccount(accountId: unknown): void {
    if (accountId !== undefined && accountId !== null && accountId !== "cli-default") {
      throw new ProviderError(400, "선택한 Codex CLI 계정 프로필을 찾을 수 없습니다.");
    }
  }

  async testConnection(): Promise<ProviderConnectionTest> {
    const visible = await this.listModels();
    return {
      ok: true,
      detail: `CLI 로그인과 모델 ${visible.length}개를 확인했습니다. AI 요청은 보내지 않았습니다.`,
      checkedAt: new Date().toISOString(),
      modelCount: visible.length,
    };
  }

  async loginSpec(): Promise<ProviderLoginSpec> {
    return { command: process.env.CODEX_BIN ?? "codex", args: ["login", "--device-auth"] };
  }

  async startRun(input: ProviderRunInput): Promise<ProviderRun> {
    const begun = await this.client.beginTurn({
      threadId: input.conversationId,
      cwd: input.cwd,
      prompt: input.prompt,
      imagePaths: input.imagePaths,
      networkAccess: input.networkAccess,
      model: input.model,
      effort: input.effort,
      timeoutMs: input.timeoutMs,
    });
    return {
      providerId: this.id,
      conversationId: begun.thread.id,
      runId: begun.turn.id,
      cwd: begun.thread.cwd,
      completion: begun.completion.then((turn) => ({
        status: providerRunStatus(turn.status),
        result: summarizeTurn(begun.thread, turn),
      })),
    };
  }

  cancelRun(conversationId: string, runId: string): Promise<void> {
    return this.client.interrupt(conversationId, runId);
  }

  subscribe(listener: (event: ProviderEvent) => void): () => void {
    return this.client.subscribe((event) => {
      const params = isRecord(event.params) ? event.params : {};
      const turn = isRecord(params.turn) ? params.turn : {};
      const conversationId = typeof params.threadId === "string" ? params.threadId : undefined;
      if (!conversationId) return;
      const normalized = normalizeCodexEvent(event.method, params, {
        providerId: this.id,
        conversationId,
        runId: typeof params.turnId === "string"
          ? params.turnId
          : typeof turn.id === "string"
            ? turn.id
            : undefined,
      });
      if (normalized) listener(normalized);
    });
  }
}

function normalizeCodexEvent(
  method: string,
  params: Record<string, unknown>,
  base: Pick<ProviderEvent, "providerId" | "conversationId" | "runId">,
): ProviderEvent | null {
  switch (method) {
    case "item/agentMessage/delta":
      return {
        ...base,
        kind: "output.delta",
        delta: typeof params.delta === "string" ? params.delta : "",
        itemId: typeof params.itemId === "string" ? params.itemId : undefined,
      };
    case "turn/diff/updated":
      return { ...base, kind: "workspace.diff", diff: typeof params.diff === "string" ? params.diff : "" };
    case "turn/started":
      return { ...base, kind: "run.started", status: turnStatus(params) };
    case "turn/completed":
      return { ...base, kind: "run.completed", status: providerRunStatus(turnStatus(params) ?? "failed") };
    case "item/started":
    case "item/completed": {
      const item = isRecord(params.item) ? params.item : {};
      return {
        ...base,
        kind: method === "item/started" ? "tool.started" : "tool.completed",
        tool: {
          type: typeof item.type === "string" ? item.type : "unknown",
          id: typeof item.id === "string" ? item.id : undefined,
          command: typeof item.command === "string" ? item.command : undefined,
          status: typeof item.status === "string" ? item.status : undefined,
          paths: Array.isArray(item.changes)
            ? item.changes
                .filter(isRecord)
                .map((change) => change.path)
                .filter((path): path is string => typeof path === "string")
            : undefined,
        },
      };
    }
    case "error":
      return { ...base, kind: "run.failed", message: eventMessage(params, "Codex 처리 중 오류가 발생했습니다.") };
    case "warning":
      return { ...base, kind: "warning", message: eventMessage(params, "Codex 경고가 발생했습니다.") };
    default:
      return null;
  }
}

function turnStatus(params: Record<string, unknown>): string | undefined {
  const turn = isRecord(params.turn) ? params.turn : {};
  return typeof turn.status === "string" ? turn.status : undefined;
}

function eventMessage(params: Record<string, unknown>, fallback: string): string {
  if (typeof params.message === "string") return params.message;
  const error = isRecord(params.error) ? params.error : {};
  return typeof error.message === "string" ? error.message : fallback;
}

function providerRunStatus(status: string): ProviderRunStatus {
  if (status === "completed" || status === "interrupted") return status;
  return "failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
