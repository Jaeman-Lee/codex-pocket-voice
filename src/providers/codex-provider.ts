import type { InitializeResponse } from "../../generated/app-server/InitializeResponse";
import type { ModelListResponse } from "../../generated/app-server/v2/ModelListResponse";
import { ProviderError, type ModelProviderAdapter, type ProviderDescriptor } from "./types.js";

export interface CodexProviderClient {
  start(): Promise<InitializeResponse>;
  listModels(): Promise<ModelListResponse>;
}

export class CodexProviderAdapter implements ModelProviderAdapter {
  readonly id = "codex" as const;

  constructor(private readonly client: CodexProviderClient) {}

  async describe(): Promise<ProviderDescriptor> {
    await this.client.start();
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
      loginCommand: "codex login",
    };
  }

  listModels(): Promise<ModelListResponse> {
    return this.client.listModels();
  }

  assertAccount(accountId: unknown): void {
    if (accountId !== undefined && accountId !== null && accountId !== "cli-default") {
      throw new ProviderError(400, "선택한 Codex CLI 계정 프로필을 찾을 수 없습니다.");
    }
  }
}
