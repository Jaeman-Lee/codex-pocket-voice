import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import OpenAI from "openai";
import type {
  FunctionTool,
  Response,
  ResponseCreateParamsStreaming,
  ResponseFunctionToolCall,
  ResponseInput,
  ResponseInputItem,
  ResponseOutputItem,
  ResponseStreamEvent,
  ResponseUsage,
} from "openai/resources/responses/responses";
import type { ToolBroker, ToolExecutionResult } from "../tool-broker.js";
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
  type ProviderResumeState,
  type ProviderRuntime,
  type ProviderUsage,
} from "./types.js";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TOOL_CALLS_PER_RUN = 8;
const MAX_TOOL_OUTPUT_CHARS = 80_000;
const MAX_RESUME_STATE_BYTES = 900 * 1024;
const MAX_RESUME_TURNS = 12;
const PROJECT_TOOL_INSTRUCTIONS = [
  "Project tools are restricted to the selected workspace and cannot access credentials.",
  "Observation tools may run immediately; every file-changing or execution tool pauses for explicit on-screen user approval.",
  "Never claim that a change or command ran until the corresponding tool result reports completed.",
].join(" ");

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
  toolBroker?: ToolBroker;
  maxToolCallsPerRun?: number;
}

interface ActiveOpenAIRun {
  controller: AbortController;
  cancelled: boolean;
  timedOut: boolean;
}

interface OpenAIResumeTurn {
  input: ResponseInput;
  output: ResponseInputItem[];
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
  private readonly toolBroker?: ToolBroker;
  private readonly hasReadTools: boolean;
  private readonly hasApprovalTools: boolean;
  private readonly hasWriteTools: boolean;
  private readonly hasCommandTools: boolean;
  private readonly maxToolCallsPerRun: number;

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
    this.toolBroker = options.toolBroker;
    const definitions = options.toolBroker?.definitions() ?? [];
    this.hasReadTools = definitions.some((definition) => definition.risk === "observation");
    this.hasApprovalTools = definitions.some((definition) => definition.risk !== "observation");
    this.hasWriteTools = definitions.some((definition) => definition.risk === "change");
    this.hasCommandTools = definitions.some((definition) => definition.risk === "execution" || definition.risk === "high_risk");
    this.maxToolCallsPerRun = options.maxToolCallsPerRun ?? MAX_TOOL_CALLS_PER_RUN;
  }

  async describe(): Promise<ProviderDescriptor> {
    let configured = false;
    let detail = "Linux Companion에 systemd credential, OPENAI_API_KEY 또는 0600 key 파일을 설정해 주세요.";
    try {
      const credential = await this.credentials.load();
      configured = credential !== null;
      if (configured) {
        if (credential?.source === "systemd_credential") {
          detail = "systemd가 런타임에 전달한 credential을 사용합니다. 요청 본문은 기본적으로 저장하지 않습니다.";
        } else if (credential?.source === "protected_file") {
          detail = "Companion의 보호된 key 파일을 사용합니다. 요청 본문은 기본적으로 저장하지 않습니다.";
        } else {
          detail = "Companion 환경변수의 API key를 사용합니다. 요청 본문은 기본적으로 저장하지 않습니다.";
        }
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
        resume: true,
        models: configured,
        attachments: true,
        streaming: true,
        toolCalling: this.hasReadTools || this.hasApprovalTools,
        approvals: this.hasApprovalTools,
        workspaceRead: this.hasReadTools,
        workspaceWrite: this.hasWriteTools,
        commandExecution: this.hasCommandTools,
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
    const model = input.model || this.defaultModel;
    if (!model) throw new ProviderError(400, "OpenAI API 모델을 선택해 주세요.");
    if (!this.modelAllowlist.has(model)) {
      throw new ProviderError(400, "허용 목록에 없는 OpenAI API 모델입니다.");
    }
    const credential = await this.requireCredential();
    const currentInput = await buildResponseInput(input.prompt, input.imagePaths ?? [], this.maxImageBytes);
    const priorTurns = readOpenAIResumeState(input.resumeState, model, Boolean(input.conversationId));
    const conversationId = input.conversationId ?? `openai-conversation-${this.createId()}`;
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
          cwd: input.cwd,
          currentInput,
          priorTurns,
          historyTruncated: input.resumeState?.truncated === true,
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
    cwd: string;
    currentInput: ResponseInput;
    priorTurns: OpenAIResumeTurn[];
    historyTruncated: boolean;
    timeoutMs?: number;
    active: ActiveOpenAIRun;
  }): Promise<ProviderRunCompletion> {
    let sequence = 0;
    let finalResponse = "";
    let remoteResponseId: string | undefined;
    let totalUsage: ProviderUsage | undefined;
    let toolCallCount = 0;
    const completedTools: Array<{ name: string; status: string; paths?: string[] }> = [];
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
      const client = this.clientFactory(options.credential);
      const tools = providerTools(this.toolBroker);
      const allowedToolNames = new Set(tools.map((tool) => tool.name));
      const responseInput: ResponseInput = [
        ...flattenOpenAIResumeTurns(options.priorTurns),
        ...options.currentInput,
      ];
      const turnOutput: ResponseInputItem[] = [];
      while (true) {
        let completedResponse: Response | undefined;
        let roundText = "";
        const request: ResponseCreateParamsStreaming = {
          model: options.model,
          input: responseInput,
          store: false,
          stream: true,
          include: ["reasoning.encrypted_content" as const],
          ...(tools.length > 0 ? {
            tools,
            tool_choice: "auto" as const,
            parallel_tool_calls: false,
            instructions: PROJECT_TOOL_INSTRUCTIONS,
          } : {}),
        };
        const stream = await client.createResponse(request, options.active.controller.signal);
        let lastUpstreamSequence: number | undefined;
        for await (const event of stream) {
          if (!Number.isSafeInteger(event.sequence_number) || event.sequence_number < 0) {
            throw new ProviderError(502, "OpenAI 응답 스트림의 event 순서가 올바르지 않습니다.");
          }
          // Responses stream events expose a per-response sequence number. A
          // retried/replayed frame must not duplicate text, usage, or tools.
          if (lastUpstreamSequence !== undefined && event.sequence_number <= lastUpstreamSequence) continue;
          lastUpstreamSequence = event.sequence_number;
          if (event.type === "response.created") remoteResponseId = event.response.id;
          if (event.type === "response.output_text.delta") {
            roundText += event.delta;
            finalResponse += event.delta;
            emit({ kind: "output.delta", delta: event.delta, itemId: event.item_id });
          } else if (event.type === "response.completed") {
            completedResponse = event.response;
            remoteResponseId = event.response.id;
            if (!roundText && event.response.output_text) finalResponse += event.response.output_text;
            totalUsage = addUsage(totalUsage, providerUsage(event.response.usage));
            if (totalUsage) emit({ kind: "usage.updated", usage: totalUsage });
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
        if (!completedResponse) {
          throw new ProviderError(502, "OpenAI 응답 스트림이 완료 이벤트 없이 종료되었습니다.");
        }
        const responseOutput = completedResponse.output ?? [];
        const toolCalls = responseOutput.filter(isFunctionCall);
        if (toolCalls.length === 0) {
          const finalItems = cloneResponseItems(continuationItems(responseOutput));
          turnOutput.push(...finalItems);
          const resumeState = finalItems.length > 0
            ? buildOpenAIResumeState(
                options.model,
                options.priorTurns,
                options.currentInput,
                turnOutput,
                options.historyTruncated,
              )
            : undefined;
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
              resumeAvailable: resumeState !== undefined,
              ...(resumeState?.truncated ? { resumeTruncated: true } : {}),
              ...(totalUsage ? { usage: totalUsage } : {}),
              ...(completedTools.length > 0 ? { tools: completedTools } : {}),
            },
            ...(resumeState ? { resumeState } : {}),
          };
        }
        if (!this.toolBroker || tools.length === 0) {
          const message = "OpenAI가 활성화되지 않은 로컬 도구를 요청했습니다.";
          emit({ kind: "run.failed", message });
          return { status: "failed", result: { providerId: this.id, model: options.model, error: message } };
        }
        if (toolCalls.length > 1 || toolCallCount + toolCalls.length > this.maxToolCallsPerRun) {
          const message = "OpenAI 프로젝트 도구 호출이 안전 상한을 초과했습니다.";
          emit({ kind: "run.failed", message });
          return { status: "failed", result: { providerId: this.id, model: options.model, error: message } };
        }
        const continued = cloneResponseItems(continuationItems(responseOutput));
        responseInput.push(...continued);
        turnOutput.push(...continued);
        for (const toolCall of toolCalls) {
          toolCallCount += 1;
          const paths = safeToolPaths(toolCall.arguments);
          emit({
            kind: "tool.started",
            tool: { type: toolCall.name, id: toolCall.call_id, status: "in_progress", ...(paths ? { paths } : {}) },
          });
          const execution = await executeFunctionCall(this.toolBroker, allowedToolNames, toolCall, {
            providerId: this.id,
            conversationId: options.conversationId,
            runId: options.runId,
            cwd: options.cwd,
            signal: options.active.controller.signal,
          });
          completedTools.push({ name: toolCall.name, status: execution.status, ...(paths ? { paths } : {}) });
          emit({
            kind: "tool.completed",
            tool: { type: toolCall.name, id: toolCall.call_id, status: execution.status, ...(paths ? { paths } : {}) },
          });
          const output: ResponseInputItem = {
            type: "function_call_output",
            call_id: toolCall.call_id,
            output: toolOutput(execution),
          };
          responseInput.push(output);
          turnOutput.push(structuredClone(output));
        }
      }
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
      return {
        status: "failed",
        result: {
          providerId: this.id,
          model: options.model,
          error: classified.message,
          errorStatus: classified.statusCode,
          finalResponse,
        },
      };
    } finally {
      if (timer) clearTimeout(timer);
      this.toolBroker?.clearRun(this.id, options.runId);
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

function addUsage(current: ProviderUsage | undefined, next: ProviderUsage | undefined): ProviderUsage | undefined {
  if (!next) return current;
  if (!current) return next;
  return {
    inputTokens: (current.inputTokens ?? 0) + (next.inputTokens ?? 0),
    cachedInputTokens: (current.cachedInputTokens ?? 0) + (next.cachedInputTokens ?? 0),
    outputTokens: (current.outputTokens ?? 0) + (next.outputTokens ?? 0),
    reasoningTokens: (current.reasoningTokens ?? 0) + (next.reasoningTokens ?? 0),
    totalTokens: (current.totalTokens ?? 0) + (next.totalTokens ?? 0),
  };
}

function providerTools(broker: ToolBroker | undefined): FunctionTool[] {
  return broker?.definitions().map((definition) => ({
    type: "function",
    name: definition.name,
    description: definition.description,
    parameters: definition.inputSchema,
    strict: true,
  })) ?? [];
}

function isFunctionCall(item: ResponseOutputItem): item is ResponseFunctionToolCall {
  return item.type === "function_call";
}

function continuationItems(items: readonly ResponseOutputItem[]): ResponseInputItem[] {
  return items.filter((item) =>
    item.type === "message" || item.type === "reasoning" || item.type === "function_call",
  ) as ResponseInputItem[];
}

function readOpenAIResumeState(
  state: ProviderResumeState | undefined,
  model: string,
  required: boolean,
): OpenAIResumeTurn[] {
  if (!state) {
    if (required) throw new ProviderError(409, "OpenAI 대화의 암호화된 replay context가 없습니다.");
    return [];
  }
  if (state.version !== 1 || state.providerId !== "openai" || state.model !== model
      || !Array.isArray(state.data.turns)) {
    throw new ProviderError(409, "OpenAI 대화 replay context가 현재 Provider·모델과 일치하지 않습니다.");
  }
  const turns: OpenAIResumeTurn[] = [];
  for (const value of state.data.turns) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new ProviderError(409, "OpenAI 대화 replay context가 손상되었습니다.");
    }
    const turn = value as Record<string, unknown>;
    if (!Array.isArray(turn.input) || !Array.isArray(turn.output)) {
      throw new ProviderError(409, "OpenAI 대화 replay context가 손상되었습니다.");
    }
    turns.push(cloneJson({ input: turn.input, output: turn.output }) as OpenAIResumeTurn);
  }
  return turns;
}

function flattenOpenAIResumeTurns(turns: readonly OpenAIResumeTurn[]): ResponseInputItem[] {
  return turns.flatMap((turn) => [
    ...cloneResponseItems(turn.input as ResponseInputItem[]),
    ...cloneResponseItems(turn.output),
  ]);
}

function buildOpenAIResumeState(
  model: string,
  priorTurns: readonly OpenAIResumeTurn[],
  currentInput: ResponseInput,
  currentOutput: readonly ResponseInputItem[],
  wasTruncated: boolean,
): ProviderResumeState | undefined {
  const turns = [
    ...priorTurns.map((turn) => cloneJson(turn) as OpenAIResumeTurn),
    {
      input: replayableOpenAIInput(currentInput),
      output: cloneResponseItems(currentOutput),
    },
  ];
  let truncated = wasTruncated;
  while (turns.length > MAX_RESUME_TURNS) {
    turns.shift();
    truncated = true;
  }
  let state: ProviderResumeState = {
    version: 1,
    providerId: "openai",
    model,
    data: { turns },
    ...(truncated ? { truncated: true } : {}),
  };
  while (Buffer.byteLength(JSON.stringify(state)) > MAX_RESUME_STATE_BYTES && turns.length > 1) {
    turns.shift();
    truncated = true;
    state = { ...state, data: { turns }, truncated: true };
  }
  return Buffer.byteLength(JSON.stringify(state)) <= MAX_RESUME_STATE_BYTES ? state : undefined;
}

function replayableOpenAIInput(input: ResponseInput): ResponseInput {
  const value = cloneJson(input) as Array<Record<string, unknown>>;
  for (const item of value) {
    if (!Array.isArray(item.content)) continue;
    item.content = item.content.map((part: unknown) => {
      if (!part || typeof part !== "object" || Array.isArray(part)) return part;
      const record = part as Record<string, unknown>;
      return record.type === "input_image"
        ? { type: "input_text", text: "[이전 이미지 입력은 보안상 대화 replay에서 제외됨]" }
        : record;
    });
  }
  return value as unknown as ResponseInput;
}

function cloneResponseItems(items: readonly ResponseInputItem[]): ResponseInputItem[] {
  return cloneJson(items) as ResponseInputItem[];
}

function cloneJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

async function executeFunctionCall(
  broker: ToolBroker,
  allowedToolNames: ReadonlySet<string>,
  toolCall: ResponseFunctionToolCall,
  context: {
    providerId: string;
    conversationId: string;
    runId: string;
    cwd: string;
    signal: AbortSignal;
  },
): Promise<ToolExecutionResult> {
  if (!allowedToolNames.has(toolCall.name)) {
    return { toolCallId: toolCall.call_id, status: "failed", error: "허용되지 않은 프로젝트 도구입니다." };
  }
  if (toolCall.status && toolCall.status !== "completed") {
    return { toolCallId: toolCall.call_id, status: "failed", error: "완성되지 않은 도구 요청입니다." };
  }
  if (toolCall.arguments.length > 16_384) {
    return { toolCallId: toolCall.call_id, status: "failed", error: "도구 인자가 안전한 크기 상한을 초과했습니다." };
  }
  let input: unknown;
  try {
    input = JSON.parse(toolCall.arguments) as unknown;
  } catch {
    return { toolCallId: toolCall.call_id, status: "failed", error: "도구 인자가 올바른 JSON이 아닙니다." };
  }
  try {
    return await broker.execute({
      providerId: context.providerId,
      conversationId: context.conversationId,
      runId: context.runId,
      toolCallId: toolCall.call_id,
      name: toolCall.name,
      input,
    }, { cwd: context.cwd, signal: context.signal });
  } catch {
    return { toolCallId: toolCall.call_id, status: "failed", error: "허용되지 않거나 잘못된 프로젝트 도구 요청입니다." };
  }
}

function toolOutput(result: ToolExecutionResult): string {
  const serialized = JSON.stringify({
    status: result.status,
    ...(result.output === undefined ? {} : { output: result.output }),
    ...(result.error ? { error: result.error } : {}),
  });
  if (serialized.length <= MAX_TOOL_OUTPUT_CHARS) return serialized;
  return JSON.stringify({ status: "failed", error: "도구 결과가 안전한 출력 상한을 초과했습니다." });
}

function safeToolPaths(argumentsJson: string): string[] | undefined {
  try {
    const value = JSON.parse(argumentsJson) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const requested = (value as Record<string, unknown>).path;
    if (
      typeof requested !== "string"
      || requested.length > 500
      || requested.startsWith("/")
      || requested.includes("\\")
      || requested.split("/").includes("..")
      || requested === ".env"
      || requested.startsWith(".env.")
      || requested.split("/").includes(".git")
    ) return undefined;
    return [requested];
  } catch {
    return undefined;
  }
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
