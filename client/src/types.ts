export type ConnectionStatus = "pending" | "online" | "error";
export type DeviceId = string;
export type ProviderId = string;

export interface DeviceTarget {
  id: DeviceId;
  name: string;
  kind: "linux" | "android";
  baseUrl: string;
  builtIn?: boolean;
  remoteDeviceId?: string;
  transport?: "termux" | "pocketlink";
}

export interface DeviceInfo {
  id: string;
  kind: "linux" | "android";
  name: string;
}
export type OperationStatus = "running" | "unknown" | "completed" | "interrupted" | "failed";

export interface Workspace {
  path: string;
  name: string;
  identity?: WorkspaceIdentity;
}

export interface WorkspaceIdentity {
  kind: "git" | "directory";
  branch?: string;
  head?: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
  changedFiles?: number;
  dirty?: boolean;
  detached?: boolean;
  linkedWorktree?: boolean;
}

export interface WorkspaceResponse {
  device: DeviceInfo;
  workspaces: Workspace[];
  creationLocations: Workspace[];
}

export interface JournalPolicy {
  retentionMs: number;
  maxOperations: number;
  maxEvents: number;
  maxExportBytes: number;
}

export interface JournalPolicyLimits {
  retentionMs: { minimum: number; maximum: number };
  maxOperations: { minimum: number; maximum: number };
  maxEvents: { minimum: number; maximum: number };
}

export interface RunPolicyConfig {
  emergencyStop: boolean;
  maxOutputTokens: number;
  maxTotalTokens: number;
  maxRunCostMicrosUsd: number;
  dailyTokenWarning: number;
  monthlyCostSoftLimitMicrosUsd: number;
}

export interface RunPolicyConfigLimits {
  maxOutputTokens: { minimum: number; maximum: number };
  maxTotalTokens: { minimum: number; maximum: number };
  maxRunCostMicrosUsd: { minimum: number; maximum: number };
  dailyTokenWarning: { minimum: number; maximum: number };
  monthlyCostSoftLimitMicrosUsd: { minimum: number; maximum: number };
}

export interface RunPolicyPricingSnapshot {
  status: "known" | "unknown";
  source: "catalog" | "unavailable";
  inputPerMillionUsd?: number;
  outputPerMillionUsd?: number;
  requestUsd?: number;
  imageUsd?: number;
  maximumRunCostMicrosUsd?: number;
}

export interface RunPolicySnapshot {
  schema: 1;
  providerId: ProviderId;
  model?: string;
  routing?: ProviderRoutingSelection;
  privacyProfile: "codex-managed" | "openai-store-false" | "openrouter-strict-zdr" | "provider-defined";
  evaluatedAt: string;
  configRevision: string;
  attachmentCount: number;
  limits?: {
    maxOutputTokens: number;
    maxTotalTokens: number;
    maxRunCostMicrosUsd: number;
  };
  pricing: RunPolicyPricingSnapshot;
  usageWindow: {
    rollingDayTokens: number;
    monthCostMicrosUsd: number;
    dailyWarningReached: boolean;
    monthlySoftLimitReached: boolean;
  };
  warnings: string[];
  confirmationRequired: boolean;
}

export interface RunPolicyPreflight {
  snapshot: RunPolicySnapshot;
  confirmationToken?: string;
  confirmationExpiresAt?: string;
}

export interface WorkspaceChangeRecoveryTransaction {
  id: string;
  workspace: string;
  phase: "staging" | "prepared" | "committed";
  operation: "replace" | "create" | "rename";
  paths: string[];
}

export interface WorkspaceChangeRecoveryStatus {
  blocked: boolean;
  pendingCountKnown: boolean;
  pendingTransactions: WorkspaceChangeRecoveryTransaction[];
  error?: string;
  attemptedAt: string;
}

export interface WorkspaceChangeRecoveryResponse {
  supported: boolean;
  status: WorkspaceChangeRecoveryStatus | null;
}

export interface ModelOption {
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

export interface ProviderRoutingSelection {
  upstreams: string[];
  allowFallbacks: boolean;
}

export interface ModelResponse {
  models: ModelOption[];
}

export interface ProviderOption {
  id: ProviderId;
  name: string;
  available: boolean;
  status: "connected" | "login_required" | "not_installed";
  detail: string;
  accounts: Array<{ id: string; label: string; connected: boolean }>;
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
    streaming?: boolean;
    toolCalling?: boolean;
    approvals?: boolean;
    workspaceRead?: boolean;
    workspaceWrite?: boolean;
    commandExecution?: boolean;
    usageAccounting?: boolean;
    steering?: boolean;
  };
  installGuide: {
    summary: string;
    command: string;
    docsUrl: string;
  };
}

export interface ProviderResponse {
  providers: ProviderOption[];
}

export interface ProviderConnectionTest {
  ok: boolean;
  detail: string;
  checkedAt: string;
  modelCount?: number;
}

export interface ProviderLoginSession {
  id: string;
  provider: ProviderId;
  status: "starting" | "waiting" | "connected" | "failed" | "cancelled";
  output: string;
  verificationUrl?: string;
  userCode?: string;
  startedAt: string;
  completedAt?: string;
}

export interface SystemDiagnostics {
  ok: boolean;
  platform: "linux";
  architecture: string;
  nodeVersion: string;
  tools: Array<{
    id: string;
    label: string;
    required: boolean;
    available: boolean;
    version?: string;
  }>;
  workspaceCount: number;
  creationLocationCount: number;
  checkedAt: string;
}

export interface ThreadSummary {
  id: string;
  cwd: string;
  name?: string | null;
  preview?: string | null;
}

export interface HistoryItem {
  type: string;
  text?: string;
  command?: string;
  output?: string;
  status?: string;
  changes?: Array<{ kind: string; path: string }>;
}

export interface ThreadDetail {
  id: string;
  cwd: string;
  turns: Array<{ items: HistoryItem[] }>;
}

export interface RunResult {
  threadId?: string;
  finalResponse?: string;
  resumeAvailable?: boolean;
  resumeTruncated?: boolean;
  commands?: Array<{ command: string; status: string; exitCode?: number | null }>;
  fileChanges?: Array<{ changes?: Array<{ kind: string; path: string }> }>;
  usage?: {
    requestCount?: number;
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
    totalTokens?: number;
    costCredits?: number;
  };
  policyUsage?: {
    status: "provider-reported" | "catalog-estimate" | "unknown";
    currency: "USD";
    requestCount: number;
    costMicrosUsd?: number;
  };
  routedProvider?: string;
  modelVerification?: ProviderModelVerification;
  routing?: {
    profile: "strict-zdr";
    requestedUpstreams: string[];
    allowFallbacks: boolean;
    actualProvider?: string;
    actualUpstream?: string;
  };
  artifacts?: RunArtifact[];
}

export interface RunArtifact {
  id: string;
  name: string;
  kind: "test" | "log" | "image" | "apk";
  mimeType: string;
  size: number;
  sha256: string;
  createdAt: string;
  preview?: string;
}

export interface Operation {
  id: string;
  providerId?: ProviderId;
  conversationId?: string;
  runId?: string;
  threadId?: string;
  turnId?: string;
  cwd: string;
  prompt: string;
  steers?: Array<{
    prompt: string;
    attachmentCount: number;
    requestedAt: string;
    acceptedAt: string;
  }>;
  accountId?: string;
  model?: string;
  effort?: string;
  networkAccess?: boolean;
  routing?: ProviderRoutingSelection;
  runPolicy?: RunPolicySnapshot;
  fork?: RunForkProvenance;
  workspaceIdentity?: WorkspaceIdentity;
  status: OperationStatus;
  startedAt?: string;
  completedAt?: string;
  acknowledgedAt?: string;
  goalName?: string;
  pinnedAt?: string;
  archivedAt?: string;
  error?: string;
  result?: RunResult;
  resumable?: boolean;
}

export interface RunForkProvenance {
  schema: 1;
  sourceOperationId: string;
  sourceProviderId: ProviderId;
  sourceModel?: string;
  targetProviderId: ProviderId;
  importedCharacters: number;
  transferredCharacters: number;
  estimatedInputTokens: number;
  truncated: boolean;
  attachmentCount: number;
  previewedAt: string;
  confirmedAt: string;
}

export interface RunForkContextItem {
  role: "user" | "assistant";
  label: string;
  text: string;
}

export interface RunForkPreview {
  id: string;
  expiresAt: string;
  source: {
    operationId: string;
    providerId: ProviderId;
    model?: string;
    workspace: string;
  };
  target: {
    providerId: ProviderId;
    accountId?: string;
    model?: string;
    routing?: ProviderRoutingSelection;
    networkAccess: boolean;
  };
  context: {
    items: RunForkContextItem[];
    importedCharacters: number;
    transferredCharacters: number;
    estimatedInputTokens: number;
    truncated: boolean;
    attachmentCount: number;
    included: string[];
    excluded: string[];
  };
  policy: RunPolicySnapshot;
}

export interface OperationMetadataPatch {
  goalName?: string | null;
  pinned?: boolean;
  archived?: boolean;
}

export type ApprovalRisk = "observation" | "change" | "execution" | "high_risk" | "external_effect";
export type ApprovalStatus = "pending" | "approved" | "declined" | "expired";

export interface ApprovalItem {
  id: string;
  operationId: string;
  cwd: string;
  providerId: ProviderId;
  conversationId: string;
  runId: string;
  toolCallId: string;
  risk: ApprovalRisk;
  redactedSummary: string;
  redactedDetails?: Record<string, unknown>;
  status: ApprovalStatus;
  requiresTouch: boolean;
  requestedAt: string;
  expiresAt: string;
}

export interface ApprovalResolution {
  requestId: string;
  decision: Exclude<ApprovalStatus, "pending">;
  source: "touch" | "voice" | "system";
  decidedAt: string;
  feedback?: ApprovalFeedback;
}

export interface ApprovalFeedbackLine {
  path: string;
  oldLine?: number;
  newLine?: number;
  code: string;
  comment: string;
}

export interface ApprovalFeedback {
  lines: ApprovalFeedbackLine[];
}

export interface SessionHandoff {
  id: string;
  workspace: string;
  threadId: string;
  operationId?: string;
  releasedBy: { id: string; label: string };
  releasedAt: string;
  expiresAt: string;
}

export type MediaStatus = "uploaded" | "queued" | "analyzing" | "ready" | "failed";

export interface MediaItem {
  id: string;
  name: string;
  kind: "image" | "video";
  mimeType: string;
  size: number;
  status: MediaStatus;
  frameCount: number;
  error?: string;
  analysis?: {
    summary: string;
    issues: string[];
    durationSeconds: number;
    model: string;
  };
}

export interface PendingAttachment extends Omit<MediaItem, "status"> {
  status: MediaStatus | "uploading";
  previewUrl?: string;
  progress?: number;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  pending?: boolean;
  error?: boolean;
  details?: string;
}

export interface QueuedPrompt {
  id: string;
  text: string;
  cwd: string;
  threadId: string;
  networkAccess: boolean;
  model: string;
  effort: string;
  provider: ProviderId;
  accountId: string;
  routing?: ProviderRoutingSelection;
  policyConfirmation?: string;
  forkPreviewId?: string;
  forkSourceOperationId?: string;
  attachments: PendingAttachment[];
  displayed?: boolean;
  createdAt?: string;
  expiresAt?: string;
  requiresConfirmation?: boolean;
}

export interface CodexEvent {
  type: string;
  providerId?: ProviderId;
  action?: string;
  reason?: "database_reset" | "retention_gap" | "persistence_failure";
  latestCursor?: number;
  journalCursor?: number;
  workspace?: string;
  deletedOperations?: number;
  deletedEvents?: number;
  policy?: JournalPolicy;
  runPolicy?: RunPolicyConfig;
  replayed?: number;
  handoffId?: string;
  operation?: Operation;
  handoff?: SessionHandoff;
  method?: string;
  params?: Record<string, unknown>;
  conversationId?: string;
  runId?: string;
  kind?: "run.started" | "output.delta" | "workspace.diff" | "tool.started" | "tool.completed"
    | "usage.updated" | "run.completed" | "run.failed" | "warning";
  delta?: string;
  diff?: string;
  message?: string;
  status?: string;
  tool?: { type?: string; id?: string; command?: string; status?: string; paths?: string[] };
  usage?: {
    requestCount?: number;
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
    totalTokens?: number;
    costCredits?: number;
  };
  media?: MediaItem;
  approval?: ApprovalItem;
  resolution?: ApprovalResolution;
}
