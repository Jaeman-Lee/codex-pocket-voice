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
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
    totalTokens?: number;
    costCredits?: number;
  };
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
  accountId?: string;
  model?: string;
  effort?: string;
  networkAccess?: boolean;
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
