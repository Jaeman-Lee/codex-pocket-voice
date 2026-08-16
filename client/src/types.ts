export type ConnectionStatus = "pending" | "online" | "error";
export type DeviceId = "pc" | "phone";
export type ProviderId = "codex" | "claude";

export interface DeviceInfo {
  id: DeviceId;
  name: string;
}
export type OperationStatus = "running" | "completed" | "interrupted" | "failed";

export interface Workspace {
  path: string;
  name: string;
}

export interface WorkspaceResponse {
  device: DeviceInfo;
  workspaces: Workspace[];
  creationLocations: Workspace[];
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
}

export interface ProviderResponse {
  providers: ProviderOption[];
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
  commands?: Array<{ command: string; status: string; exitCode?: number | null }>;
  fileChanges?: Array<{ changes?: Array<{ kind: string; path: string }> }>;
}

export interface Operation {
  id: string;
  threadId: string;
  turnId: string;
  cwd: string;
  prompt: string;
  status: OperationStatus;
  error?: string;
  result?: RunResult;
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

export interface CodexEvent {
  type: string;
  action?: string;
  operation?: Operation;
  method?: string;
  params?: Record<string, unknown>;
  media?: MediaItem;
}
