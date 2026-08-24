export type ProviderId = string;

export type ProviderRunStatus = "completed" | "interrupted" | "failed";

export interface ProviderRoutingSelection {
  upstreams: string[];
  allowFallbacks: boolean;
}

export interface ProviderRunInput {
  conversationId?: string;
  cwd: string;
  prompt: string;
  imagePaths?: string[];
  networkAccess?: boolean;
  model?: string;
  effort?: string;
  timeoutMs?: number;
  routing?: ProviderRoutingSelection;
  resumeState?: ProviderResumeState;
}

export interface ProviderResumeState {
  version: 1;
  providerId: string;
  model: string;
  data: Record<string, unknown>;
  truncated?: boolean;
}

export interface ProviderRunCompletion {
  status: ProviderRunStatus;
  result: Record<string, unknown>;
  resumeState?: ProviderResumeState;
}

export interface ProviderRun {
  providerId: ProviderId;
  conversationId: string;
  runId: string;
  cwd: string;
  completion: Promise<ProviderRunCompletion>;
}

interface ProviderEventBase {
  providerId: ProviderId;
  conversationId: string;
  runId?: string;
  eventId?: string;
  sequence?: number;
}

export interface ProviderUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  costCredits?: number;
}

export interface ProviderToolSummary {
  type: string;
  id?: string;
  command?: string;
  status?: string;
  paths?: string[];
}

export type ProviderEvent = ProviderEventBase & (
  | { kind: "run.started"; status?: string }
  | { kind: "output.delta"; delta: string; itemId?: string }
  | { kind: "workspace.diff"; diff: string }
  | { kind: "tool.started" | "tool.completed"; tool: ProviderToolSummary }
  | { kind: "usage.updated"; usage: ProviderUsage }
  | { kind: "run.completed"; status: ProviderRunStatus }
  | { kind: "run.failed"; message: string }
  | { kind: "warning"; message: string }
);

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
  capabilities?: {
    tools: boolean;
    imageInput: boolean;
    workspaceRead?: boolean;
    workspaceWrite?: boolean;
    commandExecution?: boolean;
  };
  verification?: ProviderModelVerification;
  pricing?: ProviderCatalogPricing;
  expiresAt?: string;
  routingOptions?: ProviderRoutingOption[];
}

export interface ProviderCatalogPricing {
  inputPerMillionUsd?: number;
  outputPerMillionUsd?: number;
  requestUsd?: number;
  imageUsd?: number;
}

export interface ProviderRoutingOption {
  id: string;
  displayName: string;
  pricing?: ProviderCatalogPricing;
  latencyP50Ms?: number;
  throughputP50?: number;
  uptime30m?: number;
  quantization?: string;
  supportsTools?: boolean;
  verification?: ProviderModelVerification;
}

export type ProviderModelGrade = "pass" | "not_tested" | "fail" | "expired" | "invalid";

export interface ProviderModelVerification {
  scope: "model" | "upstream";
  conversation: ProviderModelGrade;
  projectRead: ProviderModelGrade;
  coding: ProviderModelGrade;
  checkedAt?: string;
  expiresAt?: string;
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
    toolCalling: boolean;
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
