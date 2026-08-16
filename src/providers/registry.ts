import type { ModelListResponse } from "../../generated/app-server/v2/ModelListResponse";
import { ClaudeProviderAdapter } from "./claude-provider.js";
import { CodexProviderAdapter, type CodexProviderClient } from "./codex-provider.js";
import { ProviderError, type ModelProviderAdapter, type ProviderConnectionTest, type ProviderDescriptor, type ProviderLoginSpec } from "./types.js";
export { ProviderError } from "./types.js";

export class ProviderRegistry {
  private readonly adapters: readonly ModelProviderAdapter[];

  constructor(codex: CodexProviderClient) {
    this.adapters = [new CodexProviderAdapter(codex), new ClaudeProviderAdapter()];
  }

  async list(): Promise<ProviderDescriptor[]> {
    return Promise.all(this.adapters.map((adapter) => adapter.describe()));
  }

  async models(providerId: string | null): Promise<ModelListResponse> {
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
    if (adapter.id !== "codex") {
      throw new ProviderError(409, "선택한 AI 제공자는 이 단말에서 아직 실행할 수 없습니다.");
    }
    adapter.assertAccount(accountId);
  }

  private adapter(providerId: string | null): ModelProviderAdapter {
    const id = providerId ?? "codex";
    const adapter = this.adapters.find((item) => item.id === id);
    if (!adapter) throw new ProviderError(400, "알 수 없는 AI 제공자입니다.");
    return adapter;
  }
}
