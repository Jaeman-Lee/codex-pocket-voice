import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import OpenAI from "openai";
import type {
  ResponseCreateParamsStreaming,
  ResponseInput,
  ResponseStreamEvent,
  ResponseUsage,
} from "openai/resources/responses/responses";
import {
  EnvironmentOpenAICredentialSource,
  OpenAICredentialError,
  type OpenAICredentialSource,
} from "./openai-credentials.js";
import {
  ProviderError,
  type ModelProviderAdapter,
  type ProviderConnectionTest,
  type ProviderDescriptor,
  type ProviderEvent,
  type ProviderLoginSpec,
  type ProviderModel,
  type ProviderRun,
  type ProviderRunCompletion,
  type ProviderRunInput,
  type ProviderRuntime,
  type ProviderUsage,
} from "./types.js";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export interface OpenAIModelRecord { id: string }

export interface OpenAIResponsesClient {
  listModels(): Promise<readonly OpenAIModelRecord[]>;
  createResponse(
    request: ResponseCreateParamsStreaming,
    signal: AbortSignal,
  ): Promise<AsyncIterable<ResponseStreamEvent>>;
}

export interface OpenAIProviderOptions {
  credentials?: OpenAICredentialSource;
  clientFactory?: (apiKey: string) => OpenAIResponsesClient;
  createId?: () => string;
  defaultModel?: string;
  modelAllowlist?: readonly string[];
  maxImageBytes?: number;
}

interface ActiveOpenAIRun {
  controller: AbortController;
  cancelled: boolean;
  timedOut: boolean;
}

type ProviderEventPayload = ProviderEvent extends infer Event
  ? Event extends ProviderEvent
    ? Omit<Event, "providerId" | "conversationId" | "runId" | "eventId" | "sequence">
    : never
  : never;

export class OpenAIProviderAdapter implements ModelProviderAdapter, ProviderRuntime {
  readonly id = "openai" as const;
  readonly canRun = true;
  readonly runtime: ProviderRuntime = this;
  private readonly listeners = new Set<(event: ProviderEvent) => void>();
  private readonly activeRuns = new Map<string, ActiveOpenAIRun>();
  private readonly credentials: OpenAICredentialSource;
  private readonly clientFactory: (apiKey: string) => OpenAIResponsesClient;
  private readonly createId: () => string;
  private readonly defaultModel?: string;
  private readonly modelAllowlist: ReadonlySet<string>;
  private readonly maxImageBytes: number;

  constructor(options: OpenAIProviderOptions = {}) {
    this.credentials = options.credentials ?? new EnvironmentOpenAICredentialSource();
    this.clientFactory = options.clientFactory ?? ((apiKey) => new OfficialOpenAIResponsesClient(apiKey));
    this.createId = options.createId ?? randomUUID;
    this.defaultModel = options.defaultModel ?? process.env.CODEX_POCKET_OPENAI_DEFAULT_MODEL;
    const configuredModels = options.modelAllowlist ?? parseAllowlist(process.env.CODEX_POCKET_OPENAI_MODELS);
    this.modelAllowlist = new Set(configuredModels.length > 0
      ? configuredModels
      : this.defaultModel
        ? [this.defaultModel]
        : []);
    this.maxImageBytes = options.maxImageBytes ?? MAX_IMAGE_BYTES;
  }

  async describe(): Promise<ProviderDescriptor> {
    let configured = false;
    let detail = "Linux Companion에 OPENAI_API_KEY 또는 0600 key 파일을 설정해 주세요.";
    try {
      const credential = await this.credentials.load();
      configured = credential !== null;
      if (configured) {
        detail = credential?.source === "protected_file"
          ? "Companion의 보호된 key 파일을 사용합니다. 요청 본문은 기본적으로 저장하지 않습니다."
          : "Companion 환경변수의 API key를 사용합니다. 요청 본문은 기본적으로 저장하지 않습니다.";
      }
    } catch (error) {
      detail = error instanceof OpenAICredentialError ? error.message : "OpenAI API key 설정을 확인할 수 없습니다.";
    }
    const runnable = configured && this.modelAllowlist.size > 0;
    if (configured && !runnable) {
      detail = "API key를 확인했습니다. CODEX_POCKET_OPENAI_MODELS에 검증할 모델을 지정해 주세요.";
    }
    return {
      id: this.id,
      name: "OpenAI API",
      available: runnable,
      status: configured ? "connected" : "login_required",
      detail,
      accounts: configured ? [{ id: "api-default", label: "Companion API project", connected: true }] : [],
      loginCommand: "",
      installed: true,
      canLogin: false,
      canTest: configured,
      capabilities: {
        run: runnable,
        resume: false,
        models: configured,
        attachments: true,
        streaming: true,
        approvals: false,
        workspaceRead: false,
        workspaceWrite: false,
        commandExecution: false,
        usageAccounting: true,
      },
      installGuide: {
        summary: "API key는 Android가 아니라 Linux Companion에만 설정합니다.",
        command: "chmod 600 /path/to/openai-api-key",
        docsUrl: "https://platform.openai.com/api-keys",
      },
    };
  }

  async listModels(): Promise<ProviderModel[]> {
    const credential = await this.requireCredential();
    const models = await this.clientFactory(credential.apiKey).listModels().catch((error) => {
      throw classifyApiError(error);
    });
    const eligible = models
      .map((model) => model.id)
      .filter((id) => this.modelAllowlist.has(id))
      .filter((id, index, all) => all.indexOf(id) === index)
      .sort((left, right) => left.localeCompare(right));
    return eligible.map((id, index) => ({
      id,
      displayName: id,
      description: "OpenAI Responses API text model",
      isDefault: this.defaultModel ? id === this.defaultModel : index === 0,
      defaultEffort: "",
      efforts: [],
    }));
  }

  assertAccount(accountId: unknown): void {
    if (accountId !== undefined && accountId !== null && accountId !== "api-default") {
      throw new ProviderError(400, "선택한 OpenAI API project 프로필을 찾을 수 없습니다.");
    }
  }

  async testConnection(): Promise<ProviderConnectionTest> {
    const models = await this.listModels();
    return {
      ok: true,
      detail: `API 인증과 Responses용 모델 ${models.length}개를 확인했습니다. 유료 AI 요청은 보내지 않았습니다.`,
      checkedAt: new Date().toISOString(),
      modelCount: models.length,
    };
  }

  async loginSpec(): Promise<ProviderLoginSpec> {
    throw new ProviderError(409, "OpenAI API key는 Linux Companion의 서버 설정에서만 연결할 수 있습니다.");
  }

  async startRun(input: ProviderRunInput): Promise<ProviderRun> {
    if (input.conversationId) {
      throw new ProviderError(409, "OpenAI API 대화 재개는 로컬 저널 단계에서 활성화됩니다. 새 대화로 시작해 주세요.");
    }
    const model = input.model || this.defaultModel;
    if (!model) throw new ProviderError(400, "OpenAI API 모델을 선택해 주세요.");
    if (!this.modelAllowlist.has(model)) {
      throw new ProviderError(400, "허용 목록에 없는 OpenAI API 모델입니다.");
    }
    const credential = await this.requireCredential();
    const responseInput = await buildResponseInput(input.prompt, input.imagePaths ?? [], this.maxImageBytes);
    const conversationId = `openai-conversation-${this.createId()}`;
    const runId = `openai-run-${this.createId()}`;
    const active: ActiveOpenAIRun = { controller: new AbortController(), cancelled: false, timedOut: false };
    this.activeRuns.set(runKey(conversationId, runId), active);
    const completion = new Promise<ProviderRunCompletion>((resolve, reject) => {
      setImmediate(() => {
        void this.consumeRun({
          credential: credential.apiKey,
          conversationId,
          runId,
          model,
          responseInput,
          timeoutMs: input.timeoutMs,
          active,
        }).then(resolve, reject);
      });
    }).finally(() => {
      this.activeRuns.delete(runKey(conversationId, runId));
    });
    return { providerId: this.id, conversationId, runId, cwd: input.cwd, completion };
  }

  async cancelRun(conversationId: string, runId: string): Promise<void> {
    const active = this.activeRuns.get(runKey(conversationId, runId));
    if (!active) return;
    active.cancelled = true;
    active.controller.abort();
  }

  subscribe(listener: (event: ProviderEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async consumeRun(options: {
    credential: string;
    conversationId: string;
    runId: string;
    model: string;
    responseInput: ResponseInput;
    timeoutMs?: number;
    active: ActiveOpenAIRun;
  }): Promise<ProviderRunCompletion> {
    let sequence = 0;
    let finalResponse = "";
    let remoteResponseId: string | undefined;
    const emit = (event: ProviderEventPayload) => {
      sequence += 1;
      this.emit({
        ...event,
        providerId: this.id,
        conversationId: options.conversationId,
        runId: options.runId,
        eventId: `${options.runId}:${sequence}`,
        sequence,
      } as ProviderEvent);
    };
    const timer = options.timeoutMs
      ? setTimeout(() => {
          options.active.timedOut = true;
          options.active.controller.abort();
        }, options.timeoutMs)
      : undefined;
    timer?.unref();
    try {
      emit({ kind: "run.started", status: "in_progress" });
      const stream = await this.clientFactory(options.credential).createResponse({
        model: options.model,
        input: options.responseInput,
        store: false,
        stream: true,
      }, options.active.controller.signal);
      for await (const event of stream) {
        if (event.type === "response.created") remoteResponseId = event.response.id;
        if (event.type === "response.output_text.delta") {
          finalResponse += event.delta;
          emit({ kind: "output.delta", delta: event.delta, itemId: event.item_id });
        } else if (event.type === "response.completed") {
          remoteResponseId = event.response.id;
          finalResponse = event.response.output_text || finalResponse;
          const usage = providerUsage(event.response.usage);
          if (usage) emit({ kind: "usage.updated", usage });
          emit({ kind: "run.completed", status: "completed" });
          return {
            status: "completed",
            result: {
              providerId: this.id,
              conversationId: options.conversationId,
              runId: options.runId,
              remoteResponseId,
              model: options.model,
              finalResponse,
              ...(usage ? { usage } : {}),
            },
          };
        } else if (event.type === "response.failed" || event.type === "response.incomplete") {
          const message = event.type === "response.failed"
            ? safeResponseFailure(event.response.error?.code)
            : "OpenAI 응답이 완성되기 전에 종료되었습니다.";
          emit({ kind: "run.failed", message });
          return { status: "failed", result: { providerId: this.id, model: options.model, error: message } };
        } else if (event.type === "error") {
          const message = safeResponseFailure(event.code);
          emit({ kind: "run.failed", message });
          return { status: "failed", result: { providerId: this.id, model: options.model, error: message } };
        }
      }
      throw new ProviderError(502, "OpenAI 응답 스트림이 완료 이벤트 없이 종료되었습니다.");
    } catch (error) {
      if (options.active.cancelled) {
        emit({ kind: "run.completed", status: "interrupted" });
        return { status: "interrupted", result: { providerId: this.id, model: options.model, finalResponse } };
      }
      if (options.active.timedOut) {
        const message = "OpenAI 응답 시간이 초과되었습니다.";
        emit({ kind: "run.failed", message });
        return { status: "failed", result: { providerId: this.id, model: options.model, error: message } };
      }
      const classified = classifyApiError(error);
      emit({ kind: "run.failed", message: classified.message });
      throw classified;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async requireCredential() {
    try {
      const credential = await this.credentials.load();
      if (!credential) throw new ProviderError(409, "Linux Companion에 OpenAI API key를 설정해 주세요.");
      return credential;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (error instanceof OpenAICredentialError) throw new ProviderError(409, error.message);
      throw new ProviderError(409, "OpenAI API key 설정을 확인할 수 없습니다.");
    }
  }

  private emit(event: ProviderEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        process.stderr.write(`[openai-provider] Event listener failed: ${String(error)}\n`);
      }
    }
  }
}

class OfficialOpenAIResponsesClient implements OpenAIResponsesClient {
  private readonly client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  async listModels(): Promise<readonly OpenAIModelRecord[]> {
    const page = await this.client.models.list();
    return page.data.map((model) => ({ id: model.id }));
  }

  async createResponse(
    request: ResponseCreateParamsStreaming,
    signal: AbortSignal,
  ): Promise<AsyncIterable<ResponseStreamEvent>> {
    return this.client.responses.create(request, { signal });
  }
}

async function buildResponseInput(prompt: string, imagePaths: readonly string[], maxImageBytes: number): Promise<ResponseInput> {
  const content: Array<
    | { type: "input_text"; text: string }
    | { type: "input_image"; image_url: string; detail: "auto" }
  > = [{ type: "input_text", text: prompt }];
  for (const imagePath of imagePaths) {
    const mimeType = imageMimeType(imagePath);
    if (!mimeType) throw new ProviderError(400, "OpenAI API에는 PNG, JPEG, WebP 또는 GIF 이미지만 첨부할 수 있습니다.");
    const info = await stat(imagePath).catch(() => null);
    if (!info?.isFile() || info.size <= 0 || info.size > maxImageBytes) {
      throw new ProviderError(400, `이미지 첨부는 파일당 ${Math.floor(maxImageBytes / 1024 / 1024)}MB 이하여야 합니다.`);
    }
    const encoded = (await readFile(imagePath)).toString("base64");
    content.push({ type: "input_image", image_url: `data:${mimeType};base64,${encoded}`, detail: "auto" });
  }
  return [{ role: "user", content }];
}

function imageMimeType(path: string): string | null {
  switch (extname(path).toLowerCase()) {
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".webp": return "image/webp";
    case ".gif": return "image/gif";
    default: return null;
  }
}

function providerUsage(usage: ResponseUsage | null | undefined): ProviderUsage | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.input_tokens,
    cachedInputTokens: usage.input_tokens_details.cached_tokens,
    outputTokens: usage.output_tokens,
    reasoningTokens: usage.output_tokens_details.reasoning_tokens,
    totalTokens: usage.total_tokens,
  };
}

function safeResponseFailure(code: string | null | undefined): string {
  return code ? `OpenAI 응답이 실패했습니다 (${code}).` : "OpenAI 응답이 실패했습니다.";
}

function classifyApiError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  const status = typeof error === "object" && error !== null && "status" in error
    && typeof error.status === "number" ? error.status : undefined;
  if (status === 400 || status === 404 || status === 422) {
    return new ProviderError(400, "OpenAI가 모델 또는 입력을 거부했습니다. 모델 선택과 첨부를 확인해 주세요.");
  }
  if (status === 401) return new ProviderError(401, "OpenAI API key가 거부되었습니다.");
  if (status === 403) return new ProviderError(403, "OpenAI project에 이 요청 권한이 없습니다.");
  if (status === 429) return new ProviderError(429, "OpenAI API 사용량 또는 요청 속도 한도에 도달했습니다.");
  if (status && status >= 500) return new ProviderError(502, "OpenAI API가 일시적으로 응답하지 않습니다.");
  return new ProviderError(502, "OpenAI Responses API 연결이 중단되었습니다.");
}

function parseAllowlist(value: string | undefined): string[] {
  return value?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
}

function runKey(conversationId: string, runId: string): string {
  return JSON.stringify([conversationId, runId]);
}
