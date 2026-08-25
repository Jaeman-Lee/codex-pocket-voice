import { ClaudeProviderAdapter } from "./claude-provider.js";
import { CodexProviderAdapter, type CodexProviderClient } from "./codex-provider.js";
import { OpenAIProviderAdapter } from "./openai-provider.js";
import { OpenRouterProviderAdapter } from "./openrouter-provider.js";
import type { ProviderModelGradeSource } from "./model-grades.js";
import type { ToolBroker } from "../tool-broker.js";
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
  type ProviderRuntime,
  type ProviderSteerInput,
} from "./types.js";
export { ProviderError } from "./types.js";

export class ProviderRegistry {
  private readonly adapters: readonly ModelProviderAdapter[];

  constructor(
    codex: CodexProviderClient,
    adapters?: readonly ModelProviderAdapter[],
    options: { toolBroker?: ToolBroker; modelGrades?: ProviderModelGradeSource } = {},
  ) {
    this.adapters = adapters ?? [
      new CodexProviderAdapter(codex),
      new OpenAIProviderAdapter({ toolBroker: options.toolBroker, modelGrades: options.modelGrades }),
      new OpenRouterProviderAdapter({ toolBroker: options.toolBroker, modelGrades: options.modelGrades }),
      new ClaudeProviderAdapter(),
    ];
  }

  async list(): Promise<ProviderDescriptor[]> {
    return Promise.all(this.adapters.map((adapter) => adapter.describe()));
  }

  async models(providerId: string | null): Promise<ProviderModel[]> {
    return this.adapter(providerId).listModels();
  }

  test(providerId: string | null): Promise<ProviderConnectionTest> {
    return this.adapter(providerId).testConnection();
  }

  loginSpec(providerId: string | null): Promise<ProviderLoginSpec> {
    return this.adapter(providerId).loginSpec();
  }

  assertRunnable(providerId: unknown, accountId: unknown): void {
    const adapter = this.adapter(typeof providerId === "string" ? providerId : null);
    if (!adapter.canRun || !adapter.runtime) {
      throw new ProviderError(409, "선택한 AI 제공자는 이 단말에서 아직 실행할 수 없습니다.");
    }
    adapter.assertAccount(accountId);
  }

  async startRun(providerId: unknown, accountId: unknown, input: ProviderRunInput): Promise<ProviderRun> {
    const runtime = this.runtime(providerId, accountId);
    return runtime.startRun(input);
  }

  async cancelRun(providerId: unknown, conversationId: string, runId: string): Promise<void> {
    return this.runtimeOnly(providerId).cancelRun(conversationId, runId);
  }

  async steerRun(
    providerId: unknown,
    conversationId: string,
    runId: string,
    input: ProviderSteerInput,
  ): Promise<void> {
    const runtime = this.runtimeOnly(providerId);
    if (!runtime.steerRun) throw new ProviderError(409, "선택한 AI 제공자는 실행 중 방향 수정을 지원하지 않습니다.");
    await runtime.steerRun(conversationId, runId, input);
  }

  subscribe(listener: (event: ProviderEvent) => void): () => void {
    const subscriptions = this.adapters
      .map((adapter) => adapter.runtime?.subscribe(listener))
      .filter((unsubscribe): unsubscribe is () => void => unsubscribe !== undefined);
    return () => {
      for (const unsubscribe of subscriptions) unsubscribe();
    };
  }

  private adapter(providerId: string | null): ModelProviderAdapter {
    const id = providerId ?? "codex";
    const adapter = this.adapters.find((item) => item.id === id);
    if (!adapter) throw new ProviderError(400, "알 수 없는 AI 제공자입니다.");
    return adapter;
  }

  private runtime(providerId: unknown, accountId: unknown): ProviderRuntime {
    const adapter = this.adapter(typeof providerId === "string" ? providerId : null);
    if (!adapter.canRun || !adapter.runtime) {
      throw new ProviderError(409, "선택한 AI 제공자는 이 단말에서 아직 실행할 수 없습니다.");
    }
    adapter.assertAccount(accountId);
    return adapter.runtime;
  }

  private runtimeOnly(providerId: unknown): ProviderRuntime {
    const adapter = this.adapter(typeof providerId === "string" ? providerId : null);
    if (!adapter.canRun || !adapter.runtime) {
      throw new ProviderError(409, "선택한 AI 제공자는 이 단말에서 아직 실행할 수 없습니다.");
    }
    return adapter.runtime;
  }
}
