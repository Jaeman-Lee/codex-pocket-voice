import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import type { ToolBroker, ToolExecutionResult } from "../tool-broker.js";
import {
  EnvironmentOpenRouterCredentialSource,
  OpenRouterCredentialError,
  type OpenRouterCredentialSource,
} from "./openrouter-credentials.js";
import {
  ProviderError,
  type ModelProviderAdapter,
  type ProviderCatalogPricing,
  type ProviderConnectionTest,
  type ProviderDescriptor,
  type ProviderEvent,
  type ProviderLoginSpec,
  type ProviderModel,
  type ProviderRun,
  type ProviderRunCompletion,
  type ProviderRunInput,
  type ProviderRoutingSelection,
  type ProviderResumeState,
  type ProviderRuntime,
  type ProviderUsage,
} from "./types.js";
import {
  combinedModelVerification,
  modelToolAccess,
  modelVerification,
  ProtectedProviderModelGradeSource,
  safeLoadModelGrades,
  type ProviderModelGradeSource,
} from "./model-grades.js";
import type { ProviderModelVerification } from "./types.js";

const OPENROUTER_API_BASE = "https://openrouter.ai/api/v1";
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_HTTP_JSON_BYTES = 6 * 1024 * 1024;
const MAX_SSE_FRAME_BYTES = 1024 * 1024;
const MAX_TOOL_ARGUMENT_CHARS = 16_384;
const MAX_TOOL_OUTPUT_CHARS = 80_000;
const MAX_RESPONSE_TEXT_CHARS = 2 * 1024 * 1024;
const MAX_TOOL_CALLS_PER_RUN = 8;
const MAX_RESUME_STATE_BYTES = 900 * 1024;
const MAX_RESUME_TURNS = 12;
const MODEL_CACHE_MS = 10 * 60_000;
const PROJECT_TOOL_INSTRUCTIONS = [
  "Project tools are restricted to the selected workspace and cannot access credentials.",
  "Observation tools may run immediately; every file-changing or execution tool pauses for explicit on-screen user approval.",
  "Never claim that a change or command ran until the corresponding tool result reports completed.",
].join(" ");

export interface OpenRouterModelRecord {
  id: string;
  name: string;
  description?: string;
  contextLength?: number;
  supportedParameters: readonly string[];
  inputModalities: readonly string[];
  pricing?: ProviderCatalogPricing;
  expiresAt?: string;
  upstreams?: readonly OpenRouterUpstreamRecord[];
}

export interface OpenRouterUpstreamRecord {
  id: string;
  name: string;
  pricing?: ProviderCatalogPricing;
  latencyP50Ms?: number;
  throughputP50?: number;
  uptime30m?: number;
  quantization?: string;
  supportsTools?: boolean;
}

export interface OpenRouterKeyInfo {
  label?: string;
  limit?: number | null;
  limitRemaining?: number | null;
  usage?: number;
  limitReset?: string | null;
  expiresAt?: string | null;
}

export interface OpenRouterUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
  cost?: number;
}

export interface OpenRouterToolCallDelta {
  index: number;
  id?: string;
  type?: "function";
  function?: { name?: string; arguments?: string };
}

export interface OpenRouterChatChunk {
  id?: string;
  model?: string;
  provider?: string;
  openrouter_metadata?: {
    requested?: string;
    attempt?: number;
    endpoints?: {
      available?: Array<{
        provider?: string;
        model?: string;
        selected?: boolean;
      }>;
    };
  };
  choices?: Array<{
    delta?: { content?: string | null; tool_calls?: OpenRouterToolCallDelta[] };
    finish_reason?: string | null;
  }>;
  usage?: OpenRouterUsage | null;
  error?: { code?: string | number; message?: string };
}

export type OpenRouterChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | OpenRouterUserContent[] }
  | { role: "assistant"; content: string | null; tool_calls: OpenRouterToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type OpenRouterUserContent =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface OpenRouterToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface OpenRouterChatRequest {
  model: string;
  messages: OpenRouterChatMessage[];
  stream: true;
  provider: {
    allow_fallbacks: boolean;
    require_parameters: true;
    data_collection: "deny";
    zdr: true;
    order?: string[];
    only?: string[];
  };
  tools?: Array<{
    type: "function";
    function: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
      strict: true;
    };
  }>;
  tool_choice?: "auto";
  parallel_tool_calls?: false;
}

export interface OpenRouterClient {
  testKey(): Promise<OpenRouterKeyInfo>;
  listModels(): Promise<readonly OpenRouterModelRecord[]>;
  createChat(request: OpenRouterChatRequest, signal: AbortSignal): Promise<AsyncIterable<OpenRouterChatChunk>>;
}

export interface OpenRouterProviderOptions {
  credentials?: OpenRouterCredentialSource;
  clientFactory?: (apiKey: string) => OpenRouterClient;
  createId?: () => string;
  defaultModel?: string;
  modelAllowlist?: readonly string[];
  maxImageBytes?: number;
  maxToolCallsPerRun?: number;
  toolBroker?: ToolBroker;
  now?: () => number;
  modelGrades?: ProviderModelGradeSource;
}

interface ActiveOpenRouterRun {
  controller: AbortController;
  cancelled: boolean;
  timedOut: boolean;
}

interface ToolCallBuilder {
  index: number;
  id: string;
  name: string;
  arguments: string;
}

type ProviderEventPayload = ProviderEvent extends infer Event
  ? Event extends ProviderEvent
    ? Omit<Event, "providerId" | "conversationId" | "runId" | "eventId" | "sequence">
    : never
  : never;

export class OpenRouterProviderAdapter implements ModelProviderAdapter, ProviderRuntime {
  readonly id = "openrouter" as const;
  readonly canRun = true;
  readonly runtime: ProviderRuntime = this;
  private readonly listeners = new Set<(event: ProviderEvent) => void>();
  private readonly activeRuns = new Map<string, ActiveOpenRouterRun>();
  private readonly credentials: OpenRouterCredentialSource;
  private readonly clientFactory: (apiKey: string) => OpenRouterClient;
  private readonly createId: () => string;
  private readonly defaultModel?: string;
  private readonly modelAllowlist: ReadonlySet<string>;
  private readonly maxImageBytes: number;
  private readonly maxToolCallsPerRun: number;
  private readonly toolBroker?: ToolBroker;
  private readonly hasReadTools: boolean;
  private readonly hasApprovalTools: boolean;
  private readonly hasWriteTools: boolean;
  private readonly hasCommandTools: boolean;
  private readonly now: () => number;
  private readonly modelGrades: ProviderModelGradeSource;
  private modelCache?: {
    credentialFingerprint: string;
    loadedAt: number;
    models: readonly OpenRouterModelRecord[];
  };

  constructor(options: OpenRouterProviderOptions = {}) {
    this.credentials = options.credentials ?? new EnvironmentOpenRouterCredentialSource();
    this.clientFactory = options.clientFactory ?? ((apiKey) => new OpenRouterHttpClient(apiKey));
    this.createId = options.createId ?? randomUUID;
    this.defaultModel = options.defaultModel ?? process.env.CODEX_POCKET_OPENROUTER_DEFAULT_MODEL;
    const configuredModels = options.modelAllowlist ?? parseAllowlist(process.env.CODEX_POCKET_OPENROUTER_MODELS);
    this.modelAllowlist = new Set(configuredModels.length > 0
      ? configuredModels
      : this.defaultModel
        ? [this.defaultModel]
        : []);
    this.maxImageBytes = options.maxImageBytes ?? MAX_IMAGE_BYTES;
    this.maxToolCallsPerRun = options.maxToolCallsPerRun ?? MAX_TOOL_CALLS_PER_RUN;
    this.toolBroker = options.toolBroker;
    const definitions = options.toolBroker?.definitions() ?? [];
    this.hasReadTools = definitions.some((definition) => definition.risk === "observation");
    this.hasApprovalTools = definitions.some((definition) => definition.risk !== "observation");
    this.hasWriteTools = definitions.some((definition) => definition.risk === "change");
    this.hasCommandTools = definitions.some((definition) => definition.risk === "execution" || definition.risk === "high_risk");
    this.now = options.now ?? Date.now;
    this.modelGrades = options.modelGrades ?? new ProtectedProviderModelGradeSource(process.env, this.now);
  }

  async describe(): Promise<ProviderDescriptor> {
    let configured = false;
    let detail = "Linux Companion에 systemd credential, OPENROUTER_API_KEY 또는 0600 key 파일을 설정해 주세요.";
    try {
      const credential = await this.credentials.load();
      configured = credential !== null;
      if (configured) {
        detail = credential?.source === "systemd_credential"
          ? "systemd credential과 ZDR·data collection 거부·모델 고정 profile로 OpenRouter를 사용합니다."
          : "ZDR·data collection 거부·모델 고정 profile로 OpenRouter를 사용합니다.";
      }
    } catch (error) {
      detail = error instanceof OpenRouterCredentialError
        ? error.message
        : "OpenRouter API key 설정을 확인할 수 없습니다.";
    }
    const runnable = configured && this.modelAllowlist.size > 0;
    if (configured && !runnable) {
      detail = "API key를 확인했습니다. CODEX_POCKET_OPENROUTER_MODELS에 검증할 모델을 지정해 주세요.";
    }
    const gradeState = await safeLoadModelGrades(this.modelGrades, this.id);
    const allowedGrades = gradeState.records.filter((record) => this.modelAllowlist.has(record.modelId));
    const verifiedRead = allowedGrades.some((record) => modelToolAccess(record.verification) !== "none");
    const verifiedCoding = allowedGrades.some((record) => modelToolAccess(record.verification) === "coding");
    if (runnable && gradeState.invalid) {
      detail += " 모델 검증 보고서가 잘못되어 프로젝트 도구를 차단했습니다.";
    } else if (runnable && !verifiedRead && (this.hasReadTools || this.hasApprovalTools)) {
      detail += " exact upstream 모델 eval 전에는 chat-only로 실행합니다.";
    }
    return {
      id: this.id,
      name: "OpenRouter",
      available: runnable,
      status: configured ? "connected" : "login_required",
      detail,
      accounts: configured ? [{ id: "api-default", label: "Companion OpenRouter key", connected: true }] : [],
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
        toolCalling: (verifiedRead && this.hasReadTools) || (verifiedCoding && this.hasApprovalTools),
        approvals: verifiedCoding && this.hasApprovalTools,
        workspaceRead: verifiedRead && this.hasReadTools,
        workspaceWrite: verifiedCoding && this.hasWriteTools,
        commandExecution: verifiedCoding && this.hasCommandTools,
        usageAccounting: true,
      },
      installGuide: {
        summary: "API key는 Android가 아니라 Linux Companion에만 설정합니다.",
        command: "chmod 600 /path/to/openrouter-api-key",
        docsUrl: "https://openrouter.ai/settings/keys",
      },
    };
  }

  async listModels(): Promise<ProviderModel[]> {
    const credential = await this.requireCredential();
    const models = await this.loadModels(credential.apiKey);
    const gradeState = await safeLoadModelGrades(this.modelGrades, this.id);
    return models.map((model, index) => {
      const toolCapable = supportsTools(model);
      const routeVerifications = (model.upstreams ?? []).map((upstream) => ({
        upstream,
        verification: modelVerification(gradeState.records, model.id, upstream.id, gradeState.invalid),
      }));
      const bestAccess = routeVerifications.reduce<"none" | "read" | "coding">((best, item) => {
        const access = item.upstream.supportsTools === true ? modelToolAccess(item.verification) : "none";
        if (access === "coding" || (access === "read" && best === "none")) return access;
        return best;
      }, "none");
      const imageCapable = model.inputModalities.includes("image");
      return {
        id: model.id,
        displayName: model.name || model.id,
        description: [
          bestAccess === "coding" ? "verified coding tools on selected upstream"
            : bestAccess === "read" ? "verified read-only tools on selected upstream"
              : toolCapable ? "tool metadata only · eval required" : "chat-only",
          imageCapable ? "image input" : "text input",
          model.contextLength ? `${model.contextLength.toLocaleString()} context` : null,
        ].filter(Boolean).join(" · "),
        isDefault: this.defaultModel ? model.id === this.defaultModel : index === 0,
        defaultEffort: "",
        efforts: [],
        capabilities: {
          tools: toolCapable,
          imageInput: imageCapable,
          workspaceRead: bestAccess !== "none" && this.hasReadTools,
          workspaceWrite: bestAccess === "coding" && this.hasWriteTools,
          commandExecution: bestAccess === "coding" && this.hasCommandTools,
        },
        verification: {
          scope: "model",
          conversation: "not_tested",
          projectRead: "not_tested",
          coding: "not_tested",
        },
        ...(model.pricing ? { pricing: structuredClone(model.pricing) } : {}),
        ...(model.expiresAt ? { expiresAt: model.expiresAt } : {}),
        ...(model.upstreams?.length ? {
          routingOptions: routeVerifications.map(({ upstream, verification }) => ({
            id: upstream.id,
            displayName: upstream.name,
            ...(upstream.pricing ? { pricing: structuredClone(upstream.pricing) } : {}),
            ...(upstream.latencyP50Ms !== undefined ? { latencyP50Ms: upstream.latencyP50Ms } : {}),
            ...(upstream.throughputP50 !== undefined ? { throughputP50: upstream.throughputP50 } : {}),
            ...(upstream.uptime30m !== undefined ? { uptime30m: upstream.uptime30m } : {}),
            ...(upstream.quantization ? { quantization: upstream.quantization } : {}),
            ...(upstream.supportsTools !== undefined ? { supportsTools: upstream.supportsTools } : {}),
            verification,
          })),
        } : {}),
      };
    });
  }

  assertAccount(accountId: unknown): void {
    if (accountId !== undefined && accountId !== null && accountId !== "api-default") {
      throw new ProviderError(400, "선택한 OpenRouter API key 프로필을 찾을 수 없습니다.");
    }
  }

  async testConnection(): Promise<ProviderConnectionTest> {
    const credential = await this.requireCredential();
    const client = this.clientFactory(credential.apiKey);
    const keyInfo = await client.testKey().catch((error) => { throw classifyOpenRouterError(error); });
    const models = await this.loadModelsWithClient(client, true, credentialFingerprint(credential.apiKey));
    const quota = keyInfo.limitRemaining !== null && keyInfo.limitRemaining !== undefined
      ? ` 남은 key 한도 ${formatCreditAmount(keyInfo.limitRemaining)} credits.`
      : "";
    const expiration = keyInfo.expiresAt ? ` Key 만료 ${keyInfo.expiresAt.slice(0, 10)}.` : "";
    return {
      ok: true,
      detail: `API key와 strict ZDR 후보 모델 ${models.length}개를 확인했습니다.${quota}${expiration} 유료 AI 요청은 보내지 않았습니다.`,
      checkedAt: new Date(this.now()).toISOString(),
      modelCount: models.length,
    };
  }

  async loginSpec(): Promise<ProviderLoginSpec> {
    throw new ProviderError(409, "OpenRouter API key는 Linux Companion의 서버 설정에서만 연결할 수 있습니다.");
  }

  async startRun(input: ProviderRunInput): Promise<ProviderRun> {
    const modelId = input.model || this.defaultModel;
    if (!modelId) throw new ProviderError(400, "OpenRouter 모델을 선택해 주세요.");
    if (!this.modelAllowlist.has(modelId)) throw new ProviderError(400, "허용 목록에 없는 OpenRouter 모델입니다.");
    const credential = await this.requireCredential();
    const model = (await this.loadModels(credential.apiKey)).find((item) => item.id === modelId);
    if (!model) {
      throw new ProviderError(409, "선택한 모델은 현재 계정의 strict ZDR routing에서 사용할 수 없습니다.");
    }
    const routing = validateOpenRouterRouting(input.routing, model.upstreams ?? []);
    const gradeState = await safeLoadModelGrades(this.modelGrades, this.id);
    const selectedUpstreams = routing?.upstreams ?? [];
    const verification = combinedModelVerification(selectedUpstreams.map((upstreamId) => (
      modelVerification(gradeState.records, model.id, upstreamId, gradeState.invalid)
    )));
    const selectedSupportTools = selectedUpstreams.length > 0 && selectedUpstreams.every((upstreamId) => (
      model.upstreams?.find((upstream) => upstream.id === upstreamId)?.supportsTools === true
    ));
    const toolAccess = supportsTools(model) && selectedSupportTools
      ? modelToolAccess(verification)
      : "none";
    const currentMessages = await buildInitialMessages(
      input.prompt,
      input.imagePaths ?? [],
      model.inputModalities.includes("image"),
      toolAccess !== "none",
      this.maxImageBytes,
    );
    const priorMessages = readOpenRouterResumeState(input.resumeState, modelId, Boolean(input.conversationId));
    const messages = priorMessages.length > 0
      ? [...priorMessages, currentMessages[currentMessages.length - 1]!]
      : currentMessages;
    const conversationId = input.conversationId ?? `openrouter-conversation-${this.createId()}`;
    const runId = `openrouter-run-${this.createId()}`;
    const active: ActiveOpenRouterRun = { controller: new AbortController(), cancelled: false, timedOut: false };
    this.activeRuns.set(runKey(conversationId, runId), active);
    const completion = new Promise<ProviderRunCompletion>((resolve, reject) => {
      setImmediate(() => {
        void this.consumeRun({
          credential: credential.apiKey,
          conversationId,
          runId,
          cwd: input.cwd,
          model,
          messages,
          historyTruncated: input.resumeState?.truncated === true,
          toolAccess,
          modelVerification: verification,
          routing,
          timeoutMs: input.timeoutMs,
          active,
        }).then(resolve, reject);
      });
    }).finally(() => this.activeRuns.delete(runKey(conversationId, runId)));
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
    cwd: string;
    model: OpenRouterModelRecord;
    messages: OpenRouterChatMessage[];
    historyTruncated: boolean;
    toolAccess: "none" | "read" | "coding";
    modelVerification: ProviderModelVerification;
    routing?: ProviderRoutingSelection;
    timeoutMs?: number;
    active: ActiveOpenRouterRun;
  }): Promise<ProviderRunCompletion> {
    let sequence = 0;
    let finalResponse = "";
    let remoteResponseId: string | undefined;
    let routedProvider: string | undefined;
    let totalUsage: ProviderUsage | undefined;
    let toolCallCount = 0;
    const completedTools: Array<{ name: string; status: string; paths?: string[] }> = [];
    const failure = (message: string, statusCode?: number): ProviderRunCompletion => ({
      status: "failed",
      result: {
        providerId: this.id,
        model: options.model.id,
        modelVerification: options.modelVerification,
        error: message,
        ...(statusCode !== undefined ? { errorStatus: statusCode } : {}),
        ...(finalResponse ? { finalResponse } : {}),
        routing: routingResult(options.routing, routedProvider, options.model.upstreams),
      },
    });
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
      const tools = providerTools(this.toolBroker, options.toolAccess);
      const allowedToolNames = new Set(tools.map((tool) => tool.function.name));
      while (true) {
        const request: OpenRouterChatRequest = {
          model: options.model.id,
          messages: options.messages,
          stream: true,
          provider: {
            require_parameters: true,
            data_collection: "deny",
            zdr: true,
            ...openRouterRoutingPolicy(options.routing),
          },
          ...(tools.length > 0 ? {
            tools,
            tool_choice: "auto" as const,
            parallel_tool_calls: false as const,
          } : {}),
        };
        const stream = await client.createChat(request, options.active.controller.signal);
        const toolCalls = new Map<number, ToolCallBuilder>();
        let receivedChunk = false;
        let roundText = "";
        let finishReason: string | null | undefined;
        for await (const chunk of stream) {
          receivedChunk = true;
          if (chunk.error) {
            const message = safeOpenRouterFailure(chunk.error.code);
            emit({ kind: "run.failed", message });
            return failure(message);
          }
          if (chunk.id) remoteResponseId = safeIdentifier(chunk.id, 200);
          const metadataProvider = selectedRouterProvider(chunk.openrouter_metadata, options.model.id);
          if (metadataProvider) routedProvider = metadataProvider;
          else if (chunk.openrouter_metadata === undefined && chunk.provider) {
            routedProvider = safeLabel(chunk.provider, 120);
          }
          const choice = chunk.choices?.[0];
          const delta = choice?.delta;
          if (typeof delta?.content === "string" && delta.content) {
            roundText += delta.content;
            finalResponse += delta.content;
            if (finalResponse.length > MAX_RESPONSE_TEXT_CHARS) {
              const message = "OpenRouter 응답이 안전한 텍스트 상한을 초과했습니다.";
              emit({ kind: "run.failed", message });
              return failure(message);
            }
            emit({ kind: "output.delta", delta: delta.content });
          }
          for (const fragment of delta?.tool_calls ?? []) {
            const builder = toolCalls.get(fragment.index) ?? {
              index: fragment.index,
              id: "",
              name: "",
              arguments: "",
            };
            if (fragment.id) builder.id = fragment.id;
            if (fragment.function?.name) builder.name += fragment.function.name;
            if (fragment.function?.arguments) builder.arguments += fragment.function.arguments;
            if (builder.id.length > 200 || builder.name.length > 128 || builder.arguments.length > MAX_TOOL_ARGUMENT_CHARS) {
              const message = "OpenRouter 도구 인자가 안전한 크기 상한을 초과했습니다.";
              emit({ kind: "run.failed", message });
              return failure(message);
            }
            toolCalls.set(fragment.index, builder);
          }
          finishReason = choice?.finish_reason ?? finishReason;
          const nextUsage = providerUsage(chunk.usage);
          totalUsage = addUsage(totalUsage, nextUsage);
          if (nextUsage && totalUsage) emit({ kind: "usage.updated", usage: totalUsage });
        }
        if (!receivedChunk) throw new ProviderError(502, "OpenRouter 응답 스트림이 비어 있습니다.");
        const completedCalls = [...toolCalls.values()].sort((left, right) => left.index - right.index);
        if (completedCalls.length === 0) {
          if (finishReason === "tool_calls") {
            const message = "OpenRouter가 완성되지 않은 도구 호출을 반환했습니다.";
            emit({ kind: "run.failed", message });
            return failure(message);
          }
          options.messages.push({ role: "assistant", content: roundText, tool_calls: [] });
          const resumeState = buildOpenRouterResumeState(
            options.model.id,
            options.messages,
            options.historyTruncated,
          );
          emit({ kind: "run.completed", status: "completed" });
          return {
            status: "completed",
            result: {
              providerId: this.id,
              conversationId: options.conversationId,
              runId: options.runId,
              remoteResponseId,
              model: options.model.id,
              modelVerification: options.modelVerification,
              finalResponse,
              resumeAvailable: resumeState !== undefined,
              ...(resumeState?.truncated ? { resumeTruncated: true } : {}),
              ...(routedProvider ? { routedProvider } : {}),
              routing: routingResult(options.routing, routedProvider, options.model.upstreams),
              ...(totalUsage ? { usage: totalUsage } : {}),
              ...(completedTools.length > 0 ? { tools: completedTools } : {}),
            },
            ...(resumeState ? { resumeState } : {}),
          };
        }
        if (options.toolAccess === "none" || !this.toolBroker || tools.length === 0) {
          const message = "선택한 OpenRouter 모델에는 로컬 도구가 활성화되지 않았습니다.";
          emit({ kind: "run.failed", message });
          return failure(message);
        }
        if (completedCalls.length > 1 || toolCallCount + completedCalls.length > this.maxToolCallsPerRun) {
          const message = "OpenRouter 프로젝트 도구 호출이 안전 상한을 초과했습니다.";
          emit({ kind: "run.failed", message });
          return failure(message);
        }
        const assistantCalls: OpenRouterToolCall[] = [];
        for (const call of completedCalls) {
          if (!call.id || !call.name) {
            const message = "OpenRouter가 식별할 수 없는 도구 호출을 반환했습니다.";
            emit({ kind: "run.failed", message });
            return failure(message);
          }
          toolCallCount += 1;
          const paths = safeToolPaths(call.arguments);
          emit({
            kind: "tool.started",
            tool: { type: call.name, id: call.id, status: "in_progress", ...(paths ? { paths } : {}) },
          });
          const execution = await executeToolCall(this.toolBroker, allowedToolNames, call, {
            providerId: this.id,
            conversationId: options.conversationId,
            runId: options.runId,
            cwd: options.cwd,
            signal: options.active.controller.signal,
          });
          completedTools.push({ name: call.name, status: execution.status, ...(paths ? { paths } : {}) });
          emit({
            kind: "tool.completed",
            tool: { type: call.name, id: call.id, status: execution.status, ...(paths ? { paths } : {}) },
          });
          assistantCalls.push({
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: call.arguments },
          });
          options.messages.push({ role: "tool", tool_call_id: call.id, content: toolOutput(execution) });
        }
        const toolMessages = options.messages.splice(options.messages.length - assistantCalls.length);
        options.messages.push({ role: "assistant", content: roundText || null, tool_calls: assistantCalls });
        options.messages.push(...toolMessages);
      }
    } catch (error) {
      if (options.active.cancelled) {
        emit({ kind: "run.completed", status: "interrupted" });
        return {
          status: "interrupted",
          result: {
            providerId: this.id,
            model: options.model.id,
            modelVerification: options.modelVerification,
            finalResponse,
            routing: routingResult(options.routing, routedProvider, options.model.upstreams),
          },
        };
      }
      if (options.active.timedOut) {
        const message = "OpenRouter 응답 시간이 초과되었습니다.";
        emit({ kind: "run.failed", message });
        return failure(message);
      }
      const classified = classifyOpenRouterError(error);
      emit({ kind: "run.failed", message: classified.message });
      return failure(classified.message, classified.statusCode);
    } finally {
      if (timer) clearTimeout(timer);
      this.toolBroker?.clearRun(this.id, options.runId);
    }
  }

  private async loadModels(apiKey: string): Promise<readonly OpenRouterModelRecord[]> {
    const fingerprint = credentialFingerprint(apiKey);
    if (
      this.modelCache?.credentialFingerprint === fingerprint
      && this.now() - this.modelCache.loadedAt < MODEL_CACHE_MS
    ) return this.modelCache.models;
    return this.loadModelsWithClient(this.clientFactory(apiKey), false, fingerprint);
  }

  private async loadModelsWithClient(
    client: OpenRouterClient,
    force: boolean,
    fingerprint: string,
  ): Promise<readonly OpenRouterModelRecord[]> {
    if (
      !force
      && this.modelCache?.credentialFingerprint === fingerprint
      && this.now() - this.modelCache.loadedAt < MODEL_CACHE_MS
    ) {
      return this.modelCache.models;
    }
    const catalog = await client.listModels().catch((error) => { throw classifyOpenRouterError(error); });
    const models = catalog
      .filter((model) => this.modelAllowlist.has(model.id))
      .filter((model, index, all) => all.findIndex((candidate) => candidate.id === model.id) === index)
      .sort((left, right) => left.id.localeCompare(right.id));
    this.modelCache = { credentialFingerprint: fingerprint, loadedAt: this.now(), models };
    return models;
  }

  private async requireCredential() {
    try {
      const credential = await this.credentials.load();
      if (!credential) throw new ProviderError(409, "Linux Companion에 OpenRouter API key를 설정해 주세요.");
      return credential;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (error instanceof OpenRouterCredentialError) throw new ProviderError(409, error.message);
      throw new ProviderError(409, "OpenRouter API key 설정을 확인할 수 없습니다.");
    }
  }

  private emit(event: ProviderEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        process.stderr.write(`[openrouter-provider] Event listener failed: ${String(error)}\n`);
      }
    }
  }
}

export class OpenRouterHttpClient implements OpenRouterClient {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async testKey(): Promise<OpenRouterKeyInfo> {
    const value = await this.getJson(`${OPENROUTER_API_BASE}/key`);
    const data = record(value.data);
    return {
      label: typeof data?.label === "string" ? data.label : undefined,
      limit: nullableCatalogNumber(data?.limit, 1_000_000_000),
      limitRemaining: nullableCatalogNumber(data?.limit_remaining, 1_000_000_000),
      usage: boundedCatalogNumber(data?.usage, 1_000_000_000),
      limitReset: typeof data?.limit_reset === "string" && data.limit_reset.length <= 40
        ? safeLabel(data.limit_reset, 40)
        : null,
      expiresAt: catalogTimestamp(data?.expires_at),
    };
  }

  async listModels(): Promise<readonly OpenRouterModelRecord[]> {
    const [userValue, zdrValue, endpointValue] = await Promise.all([
      this.getJson(`${OPENROUTER_API_BASE}/models/user`),
      this.getJson(`${OPENROUTER_API_BASE}/models?zdr=true`),
      this.getJson(`${OPENROUTER_API_BASE}/endpoints/zdr`),
    ]);
    const zdrIds = new Set(array(zdrValue.data)
      .map((value) => record(value)?.id)
      .filter((id): id is string => typeof id === "string"));
    const upstreamsByModel = new Map<string, Map<string, OpenRouterUpstreamRecord>>();
    for (const value of array(endpointValue.data)) {
      const endpoint = record(value);
      if (!endpoint) continue;
      const modelId = typeof endpoint.model_id === "string" ? endpoint.model_id : "";
      const upstreamId = typeof endpoint.tag === "string" ? endpoint.tag : "";
      if (!validOpenRouterUpstreamId(upstreamId) || !zdrIds.has(modelId)) continue;
      const displayName = safeLabel(
        typeof endpoint?.provider_name === "string" ? endpoint.provider_name : upstreamId,
        120,
      ) ?? upstreamId;
      const supportedParameters = array(endpoint.supported_parameters)
        .filter((item): item is string => typeof item === "string" && item.length <= 80)
        .slice(0, 100);
      const pricing = catalogPricing(endpoint.pricing);
      const latencyP50Ms = catalogMilliseconds(record(endpoint.latency_last_30m)?.p50);
      const throughputP50 = boundedCatalogNumber(record(endpoint.throughput_last_30m)?.p50, 1_000_000);
      const uptime30m = boundedPercentage(endpoint.uptime_last_30m);
      const quantization = typeof endpoint.quantization === "string" && endpoint.quantization.length <= 40
        ? safeLabel(endpoint.quantization, 40)
        : undefined;
      const modelUpstreams = upstreamsByModel.get(modelId) ?? new Map<string, OpenRouterUpstreamRecord>();
      modelUpstreams.set(upstreamId, {
        id: upstreamId,
        name: displayName,
        ...(pricing ? { pricing } : {}),
        ...(latencyP50Ms !== undefined ? { latencyP50Ms } : {}),
        ...(throughputP50 !== undefined ? { throughputP50 } : {}),
        ...(uptime30m !== undefined ? { uptime30m } : {}),
        ...(quantization ? { quantization } : {}),
        supportsTools: supportedParameters.includes("tools"),
      });
      upstreamsByModel.set(modelId, modelUpstreams);
    }
    return array(userValue.data).flatMap((value) => {
      const model = record(value);
      if (!model || typeof model.id !== "string" || model.id.length > 200 || !zdrIds.has(model.id)) return [];
      const upstreams = [...(upstreamsByModel.get(model.id) ?? new Map<string, OpenRouterUpstreamRecord>()).values()]
        .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
      if (upstreams.length === 0) return [];
      const architecture = record(model.architecture);
      const pricing = catalogPricing(model.pricing);
      const expiresAt = catalogTimestamp(model.expiration_date);
      return [{
        id: model.id,
        name: safeLabel(typeof model.name === "string" ? model.name : model.id, 200) ?? model.id,
        description: typeof model.description === "string" ? safeLabel(model.description, 500) : undefined,
        contextLength: nonNegativeNumber(model.context_length),
        supportedParameters: array(model.supported_parameters)
          .filter((item): item is string => typeof item === "string" && item.length <= 80)
          .slice(0, 100),
        inputModalities: array(architecture?.input_modalities)
          .filter((item): item is string => typeof item === "string" && item.length <= 40)
          .slice(0, 20),
        ...(pricing ? { pricing } : {}),
        ...(expiresAt ? { expiresAt } : {}),
        upstreams,
      }];
    });
  }

  async createChat(request: OpenRouterChatRequest, signal: AbortSignal): Promise<AsyncIterable<OpenRouterChatChunk>> {
    const response = await this.fetchImpl(`${OPENROUTER_API_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "X-OpenRouter-Metadata": "enabled",
      },
      body: JSON.stringify(request),
      redirect: "error",
      signal,
    });
    if (!response.ok) throw new OpenRouterHttpError(response.status);
    if (!response.body) throw new OpenRouterHttpError(502);
    return parseEventStream(response.body);
  }

  private async getJson(url: string): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(url, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
      redirect: "error",
    });
    if (!response.ok) throw new OpenRouterHttpError(response.status);
    const contentLength = Number(response.headers.get("content-length") ?? "0");
    if (contentLength > MAX_HTTP_JSON_BYTES) throw new OpenRouterHttpError(502);
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_HTTP_JSON_BYTES) throw new OpenRouterHttpError(502);
    try {
      const value = JSON.parse(text) as unknown;
      return record(value) ?? {};
    } catch {
      throw new OpenRouterHttpError(502);
    }
  }
}

class OpenRouterHttpError extends Error {
  constructor(readonly status: number) {
    super(`OpenRouter HTTP ${status}`);
  }
}

async function* parseEventStream(body: ReadableStream<Uint8Array>): AsyncIterable<OpenRouterChatChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      if (Buffer.byteLength(buffer) > MAX_SSE_FRAME_BYTES && !/\r?\n\r?\n/.test(buffer)) {
        throw new OpenRouterHttpError(502);
      }
      while (true) {
        const boundary = /\r?\n\r?\n/.exec(buffer);
        if (!boundary || boundary.index === undefined) break;
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const data = frame.split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data) continue;
        if (data === "[DONE]") return;
        try {
          const parsed = JSON.parse(data) as unknown;
          const chunk = record(parsed);
          if (!chunk) throw new Error("invalid chunk");
          yield chunk as unknown as OpenRouterChatChunk;
        } catch {
          throw new OpenRouterHttpError(502);
        }
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) throw new OpenRouterHttpError(502);
  } finally {
    reader.releaseLock();
  }
}

async function buildInitialMessages(
  prompt: string,
  imagePaths: readonly string[],
  supportsImages: boolean,
  toolEnabled: boolean,
  maxImageBytes: number,
): Promise<OpenRouterChatMessage[]> {
  const messages: OpenRouterChatMessage[] = [];
  if (toolEnabled) messages.push({ role: "system", content: PROJECT_TOOL_INSTRUCTIONS });
  if (imagePaths.length === 0) {
    messages.push({ role: "user", content: prompt });
    return messages;
  }
  if (!supportsImages) throw new ProviderError(400, "선택한 OpenRouter 모델은 이미지 입력을 지원하지 않습니다.");
  const content: OpenRouterUserContent[] = [{ type: "text", text: prompt }];
  for (const imagePath of imagePaths) {
    const mimeType = imageMimeType(imagePath);
    if (!mimeType) throw new ProviderError(400, "OpenRouter에는 PNG, JPEG, WebP 또는 GIF 이미지만 첨부할 수 있습니다.");
    const info = await stat(imagePath).catch(() => null);
    if (!info?.isFile() || info.size <= 0 || info.size > maxImageBytes) {
      throw new ProviderError(400, `이미지 첨부는 파일당 ${Math.floor(maxImageBytes / 1024 / 1024)}MB 이하여야 합니다.`);
    }
    const encoded = (await readFile(imagePath)).toString("base64");
    content.push({ type: "image_url", image_url: { url: `data:${mimeType};base64,${encoded}` } });
  }
  messages.push({ role: "user", content });
  return messages;
}

function readOpenRouterResumeState(
  state: ProviderResumeState | undefined,
  model: string,
  required: boolean,
): OpenRouterChatMessage[] {
  if (!state) {
    if (required) throw new ProviderError(409, "OpenRouter 대화의 암호화된 replay context가 없습니다.");
    return [];
  }
  if (state.version !== 1 || state.providerId !== "openrouter" || state.model !== model
      || !Array.isArray(state.data.messages) || !state.data.messages.every(isOpenRouterChatMessage)) {
    throw new ProviderError(409, "OpenRouter 대화 replay context가 현재 Provider·모델과 일치하지 않습니다.");
  }
  return cloneJson(state.data.messages) as OpenRouterChatMessage[];
}

function buildOpenRouterResumeState(
  model: string,
  source: readonly OpenRouterChatMessage[],
  wasTruncated: boolean,
): ProviderResumeState | undefined {
  const messages = replayableOpenRouterMessages(source);
  let truncated = wasTruncated;
  while (userMessageCount(messages) > MAX_RESUME_TURNS) {
    if (!removeOldestOpenRouterTurn(messages)) break;
    truncated = true;
  }
  let state: ProviderResumeState = {
    version: 1,
    providerId: "openrouter",
    model,
    data: { messages },
    ...(truncated ? { truncated: true } : {}),
  };
  while (Buffer.byteLength(JSON.stringify(state)) > MAX_RESUME_STATE_BYTES) {
    if (!removeOldestOpenRouterTurn(messages)) return undefined;
    truncated = true;
    state = { ...state, data: { messages }, truncated: true };
  }
  return state;
}

function replayableOpenRouterMessages(source: readonly OpenRouterChatMessage[]): OpenRouterChatMessage[] {
  const messages = cloneJson(source) as OpenRouterChatMessage[];
  return messages.map((message) => {
    if (message.role !== "user" || !Array.isArray(message.content)) return message;
    return {
      role: "user",
      content: message.content.map((part) => part.type === "image_url"
        ? { type: "text", text: "[이전 이미지 입력은 보안상 대화 replay에서 제외됨]" }
        : part),
    };
  });
}

function removeOldestOpenRouterTurn(messages: OpenRouterChatMessage[]): boolean {
  const firstUser = messages.findIndex((message) => message.role === "user");
  if (firstUser < 0) return false;
  const nextUserOffset = messages.slice(firstUser + 1).findIndex((message) => message.role === "user");
  if (nextUserOffset < 0) return false;
  messages.splice(firstUser, nextUserOffset + 1);
  return true;
}

function userMessageCount(messages: readonly OpenRouterChatMessage[]): number {
  return messages.filter((message) => message.role === "user").length;
}

function isOpenRouterChatMessage(value: unknown): value is OpenRouterChatMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  if (message.role === "system") return typeof message.content === "string";
  if (message.role === "tool") {
    return typeof message.tool_call_id === "string" && typeof message.content === "string";
  }
  if (message.role === "assistant") {
    return (typeof message.content === "string" || message.content === null)
      && Array.isArray(message.tool_calls);
  }
  if (message.role !== "user") return false;
  if (typeof message.content === "string") return true;
  return Array.isArray(message.content) && message.content.every((part) => {
    if (!part || typeof part !== "object" || Array.isArray(part)) return false;
    const item = part as Record<string, unknown>;
    return item.type === "text" && typeof item.text === "string";
  });
}

function cloneJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function providerTools(
  broker: ToolBroker | undefined,
  access: "none" | "read" | "coding",
): NonNullable<OpenRouterChatRequest["tools"]> {
  if (!broker || access === "none") return [];
  return broker.definitions().filter((definition) => (
    access === "coding" || definition.risk === "observation"
  )).map((definition) => ({
    type: "function",
    function: {
      name: definition.name,
      description: definition.description,
      parameters: definition.inputSchema,
      strict: true,
    },
  }));
}

async function executeToolCall(
  broker: ToolBroker,
  allowedToolNames: ReadonlySet<string>,
  call: ToolCallBuilder,
  context: {
    providerId: string;
    conversationId: string;
    runId: string;
    cwd: string;
    signal: AbortSignal;
  },
): Promise<ToolExecutionResult> {
  if (!allowedToolNames.has(call.name)) {
    return { toolCallId: call.id, status: "failed", error: "허용되지 않은 프로젝트 도구입니다." };
  }
  let input: unknown;
  try {
    input = JSON.parse(call.arguments) as unknown;
  } catch {
    return { toolCallId: call.id, status: "failed", error: "도구 인자가 올바른 JSON이 아닙니다." };
  }
  try {
    return await broker.execute({
      providerId: context.providerId,
      conversationId: context.conversationId,
      runId: context.runId,
      toolCallId: call.id,
      name: call.name,
      input,
    }, { cwd: context.cwd, signal: context.signal });
  } catch {
    return { toolCallId: call.id, status: "failed", error: "허용되지 않거나 잘못된 프로젝트 도구 요청입니다." };
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
    const requested = record(value)?.path;
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

function providerUsage(usage: OpenRouterUsage | null | undefined): ProviderUsage | undefined {
  if (!usage) return undefined;
  const value: ProviderUsage = {
    inputTokens: nonNegativeNumber(usage.prompt_tokens),
    cachedInputTokens: nonNegativeNumber(usage.prompt_tokens_details?.cached_tokens),
    outputTokens: nonNegativeNumber(usage.completion_tokens),
    reasoningTokens: nonNegativeNumber(usage.completion_tokens_details?.reasoning_tokens),
    totalTokens: nonNegativeNumber(usage.total_tokens),
    costCredits: nonNegativeNumber(usage.cost),
  };
  return Object.values(value).some((item) => item !== undefined) ? value : undefined;
}

function addUsage(current: ProviderUsage | undefined, next: ProviderUsage | undefined): ProviderUsage | undefined {
  if (!next) return current;
  if (!current) return next;
  return {
    inputTokens: sum(current.inputTokens, next.inputTokens),
    cachedInputTokens: sum(current.cachedInputTokens, next.cachedInputTokens),
    outputTokens: sum(current.outputTokens, next.outputTokens),
    reasoningTokens: sum(current.reasoningTokens, next.reasoningTokens),
    totalTokens: sum(current.totalTokens, next.totalTokens),
    costCredits: sum(current.costCredits, next.costCredits),
  };
}

function sum(left: number | undefined, right: number | undefined): number | undefined {
  return left === undefined && right === undefined ? undefined : (left ?? 0) + (right ?? 0);
}

function supportsTools(model: OpenRouterModelRecord): boolean {
  return model.supportedParameters.includes("tools");
}

function validateOpenRouterRouting(
  selection: ProviderRoutingSelection | undefined,
  available: readonly OpenRouterUpstreamRecord[],
): ProviderRoutingSelection | undefined {
  if (!selection) return undefined;
  const allowed = new Set(available.map((upstream) => upstream.id));
  if (selection.upstreams.length === 0 || selection.upstreams.length > 4
      || new Set(selection.upstreams).size !== selection.upstreams.length
      || selection.upstreams.some((upstream) => !allowed.has(upstream))) {
    throw new ProviderError(409, "선택한 OpenRouter upstream은 현재 모델의 strict ZDR 목록에 없습니다.");
  }
  if (selection.allowFallbacks && selection.upstreams.length < 2) {
    throw new ProviderError(400, "OpenRouter fallback을 사용하려면 승인할 upstream을 두 개 이상 선택해 주세요.");
  }
  if (!selection.allowFallbacks && selection.upstreams.length !== 1) {
    throw new ProviderError(400, "OpenRouter upstream 고정은 정확히 한 provider만 선택해야 합니다.");
  }
  return structuredClone(selection);
}

function openRouterRoutingPolicy(selection: ProviderRoutingSelection | undefined): Pick<
  OpenRouterChatRequest["provider"],
  "allow_fallbacks" | "order" | "only"
> {
  if (!selection) return { allow_fallbacks: false };
  return {
    allow_fallbacks: selection.allowFallbacks,
    order: [...selection.upstreams],
    only: [...selection.upstreams],
  };
}

function routingResult(
  selection: ProviderRoutingSelection | undefined,
  actualProvider: string | undefined,
  available: readonly OpenRouterUpstreamRecord[] | undefined,
): Record<string, unknown> {
  const actualUpstream = resolveActualUpstream(selection, actualProvider, available ?? []);
  return {
    profile: "strict-zdr",
    requestedUpstreams: selection ? [...selection.upstreams] : [],
    allowFallbacks: selection?.allowFallbacks === true,
    ...(actualProvider ? { actualProvider } : {}),
    ...(actualUpstream ? { actualUpstream } : {}),
  };
}

function selectedRouterProvider(
  metadata: OpenRouterChatChunk["openrouter_metadata"],
  expectedModel: string,
): string | undefined {
  if (!metadata || metadata.requested !== expectedModel || !Number.isSafeInteger(metadata.attempt)
      || (metadata.attempt ?? 0) < 1) return undefined;
  const selected = array(metadata.endpoints?.available)
    .slice(0, 100)
    .map(record)
    .filter((endpoint) => endpoint?.selected === true && endpoint.model === expectedModel);
  if (selected.length !== 1 || typeof selected[0]?.provider !== "string") return undefined;
  return safeLabel(selected[0].provider, 120);
}

function resolveActualUpstream(
  selection: ProviderRoutingSelection | undefined,
  actualProvider: string | undefined,
  available: readonly OpenRouterUpstreamRecord[],
): string | undefined {
  if (!selection || !actualProvider) return undefined;
  if (!selection.allowFallbacks && selection.upstreams.length === 1) return selection.upstreams[0];
  const selected = available.filter((upstream) => selection.upstreams.includes(upstream.id)
    && upstream.name === actualProvider);
  return selected.length === 1 ? selected[0]?.id : undefined;
}

function validOpenRouterUpstreamId(value: string): boolean {
  return value.length <= 120 && /^[a-z0-9][a-z0-9._/-]*$/.test(value);
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

function safeOpenRouterFailure(code: string | number | null | undefined): string {
  const safeCode = code === undefined || code === null ? "" : String(code);
  return /^[A-Za-z0-9_.-]{1,40}$/.test(safeCode)
    ? `OpenRouter 응답이 실패했습니다 (${safeCode}).`
    : "OpenRouter 응답이 실패했습니다.";
}

function classifyOpenRouterError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  const status = typeof error === "object" && error !== null && "status" in error
    && typeof error.status === "number" ? error.status : undefined;
  if (status === 400 || status === 404 || status === 422) {
    return new ProviderError(400, "OpenRouter가 모델, 입력 또는 strict routing 조건을 거부했습니다.");
  }
  if (status === 401) return new ProviderError(401, "OpenRouter API key가 거부되었습니다.");
  if (status === 402) return new ProviderError(402, "OpenRouter credit 또는 사용 한도가 부족합니다.");
  if (status === 403) return new ProviderError(403, "OpenRouter 계정 또는 privacy policy가 요청을 허용하지 않습니다.");
  if (status === 429) return new ProviderError(429, "OpenRouter 요청 속도 또는 사용량 한도에 도달했습니다.");
  if (status && status >= 500) return new ProviderError(502, "OpenRouter 또는 선택한 upstream이 일시적으로 응답하지 않습니다.");
  return new ProviderError(502, "OpenRouter streaming 연결이 중단되었습니다.");
}

function parseAllowlist(value: string | undefined): string[] {
  return value?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
}

function credentialFingerprint(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}

function runKey(conversationId: string, runId: string): string {
  return JSON.stringify([conversationId, runId]);
}

function record(value: unknown): Record<string, any> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, any>
    : null;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function boundedCatalogNumber(value: unknown, maximum: number): number | undefined {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && /^(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value)
      ? Number(value)
      : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= maximum ? parsed : undefined;
}

function nullableCatalogNumber(value: unknown, maximum: number): number | null {
  return boundedCatalogNumber(value, maximum) ?? null;
}

function catalogPricing(value: unknown): ProviderCatalogPricing | undefined {
  const pricing = record(value);
  if (!pricing) return undefined;
  const input = catalogPerMillion(pricing.prompt);
  const output = catalogPerMillion(pricing.completion);
  const request = boundedCatalogNumber(pricing.request, 1_000_000);
  const image = boundedCatalogNumber(pricing.image, 1_000_000);
  if (input === undefined && output === undefined && request === undefined && image === undefined) return undefined;
  return {
    ...(input !== undefined ? { inputPerMillionUsd: input } : {}),
    ...(output !== undefined ? { outputPerMillionUsd: output } : {}),
    ...(request !== undefined ? { requestUsd: request } : {}),
    ...(image !== undefined ? { imageUsd: image } : {}),
  };
}

function catalogPerMillion(value: unknown): number | undefined {
  const perToken = boundedCatalogNumber(value, 1_000);
  if (perToken === undefined) return undefined;
  const perMillion = perToken * 1_000_000;
  return Number.isFinite(perMillion) && perMillion <= 1_000_000_000 ? perMillion : undefined;
}

function catalogMilliseconds(value: unknown): number | undefined {
  const seconds = boundedCatalogNumber(value, 3_600);
  return seconds === undefined ? undefined : Math.round(seconds * 1_000);
}

function boundedPercentage(value: unknown): number | undefined {
  return boundedCatalogNumber(value, 100);
}

function catalogTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 40) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function formatCreditAmount(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

function safeIdentifier(value: string, maximum: number): string | undefined {
  return /^[A-Za-z0-9._:/-]+$/.test(value) && value.length <= maximum ? value : undefined;
}

function safeLabel(value: string, maximum: number): string | undefined {
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return normalized ? normalized.slice(0, maximum) : undefined;
}
