import type { ModelListResponse } from "../../generated/app-server/v2/ModelListResponse";

export type ProviderId = "codex" | "claude";

export interface ProviderAccount {
  id: string;
  label: string;
  connected: boolean;
}

export interface ProviderDescriptor {
  id: ProviderId;
  name: string;
  available: boolean;
  status: "connected" | "login_required" | "not_installed";
  detail: string;
  accounts: ProviderAccount[];
  loginCommand: string;
}

export interface ModelProviderAdapter {
  readonly id: ProviderId;
  describe(): Promise<ProviderDescriptor>;
  listModels(): Promise<ModelListResponse>;
  assertAccount(accountId: unknown): void;
}

export class ProviderError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}
