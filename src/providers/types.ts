export type ProviderId = string;

export interface ProviderModel {
  id: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  defaultEffort: string;
  efforts: Array<{ id: string; description: string }>;
}

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
  installed: boolean;
  version?: string;
  canLogin: boolean;
  canTest: boolean;
  capabilities: {
    run: boolean;
    resume: boolean;
    models: boolean;
    attachments: boolean;
  };
  installGuide: {
    summary: string;
    command: string;
    docsUrl: string;
  };
}

export interface ProviderConnectionTest {
  ok: boolean;
  detail: string;
  checkedAt: string;
  modelCount?: number;
}

export interface ProviderLoginSpec {
  command: string;
  args: string[];
}

export interface ModelProviderAdapter {
  readonly id: ProviderId;
  readonly canRun: boolean;
  describe(): Promise<ProviderDescriptor>;
  listModels(): Promise<ProviderModel[]>;
  assertAccount(accountId: unknown): void;
  testConnection(): Promise<ProviderConnectionTest>;
  loginSpec(): Promise<ProviderLoginSpec>;
}

export class ProviderError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}
