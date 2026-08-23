export type ProviderId = string;

export type ProviderRunStatus = "completed" | "interrupted" | "failed";

export interface ProviderRunInput {
  conversationId?: string;
  cwd: string;
  prompt: string;
  imagePaths?: string[];
  networkAccess?: boolean;
  model?: string;
  effort?: string;
  timeoutMs?: number;
}

export interface ProviderRunCompletion {
  status: ProviderRunStatus;
  result: Record<string, unknown>;
}

export interface ProviderRun {
  providerId: ProviderId;
  conversationId: string;
  runId: string;
  cwd: string;
  completion: Promise<ProviderRunCompletion>;
}

export interface ProviderEvent {
  providerId: ProviderId;
  conversationId?: string;
  runId?: string;
  eventId?: string;
  sequence?: number;
  method: string;
  params?: unknown;
}

export interface ProviderRuntime {
  startRun(input: ProviderRunInput): Promise<ProviderRun>;
  cancelRun(conversationId: string, runId: string): Promise<void>;
  subscribe(listener: (event: ProviderEvent) => void): () => void;
}

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
    streaming: boolean;
    approvals: boolean;
    workspaceRead: boolean;
    workspaceWrite: boolean;
    commandExecution: boolean;
    usageAccounting: boolean;
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
  readonly runtime?: ProviderRuntime;
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
