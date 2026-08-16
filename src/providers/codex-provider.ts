import type { InitializeResponse } from "../../generated/app-server/InitializeResponse";
import type { ModelListResponse } from "../../generated/app-server/v2/ModelListResponse";
import { ProviderError, type ModelProviderAdapter, type ProviderConnectionTest, type ProviderDescriptor, type ProviderLoginSpec } from "./types.js";

export interface CodexProviderClient {
  start(): Promise<InitializeResponse>;
  listModels(): Promise<ModelListResponse>;
}

export class CodexProviderAdapter implements ModelProviderAdapter {
  readonly id = "codex" as const;

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
      installGuide: {
        summary: "macOS·Linux 공식 설치 스크립트",
        command: "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
        docsUrl: "https://developers.openai.com/codex/cli/",
      },
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

  async testConnection(): Promise<ProviderConnectionTest> {
    const models = await this.client.listModels();
    const visible = models.data.filter((model) => !model.hidden);
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
}
