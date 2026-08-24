import type { ChatMessage, DeviceId, ProviderId, QueuedPrompt } from "./types";

export type JournalSyncState = "local" | "queued" | "running" | "synced";

export interface JournalConversation {
  key: string;
  device: DeviceId;
  workspace: string;
  threadId: string;
  messages: ChatMessage[];
  syncState: JournalSyncState;
  updatedAt: string;
}

export interface JournalQueue {
  device: DeviceId;
  prompts: QueuedPrompt[];
  updatedAt: string;
}

export function conversationKey(
  device: DeviceId,
  workspace: string,
  threadId: string,
  provider: ProviderId = "codex",
): string {
  if (provider !== "codex") return JSON.stringify([device, provider, workspace, threadId || "new"]);
  return JSON.stringify([device, workspace, threadId || "new"]);
}

export function restoredMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => message.pending
    ? {
        ...message,
        pending: false,
        error: true,
        text: message.text || "진행 중이던 작업입니다. 단말에 다시 연결해 상태를 확인해 주세요.",
      }
    : { ...message });
}

export function serializableQueue(prompts: QueuedPrompt[]): QueuedPrompt[] {
  return prompts.map(({
    policyConfirmation: _policyConfirmation,
    forkPreviewId: _forkPreviewId,
    ...prompt
  }) => ({
    ...prompt,
    attachments: prompt.attachments.map(({ previewUrl: _previewUrl, ...attachment }) => ({ ...attachment })),
  }));
}
