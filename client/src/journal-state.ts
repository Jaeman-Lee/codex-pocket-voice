import type { DeviceId, QueuedPrompt } from "./types";

export type ConversationJournalPhase = "idle" | "loading" | "restored" | "live";
export type QueueJournalPhase = "idle" | "loading" | "ready";

export interface JournalState {
  conversation: {
    generation: number;
    key: string;
    phase: ConversationJournalPhase;
  };
  queue: {
    generation: number;
    device: DeviceId | null;
    phase: QueueJournalPhase;
    changedDuringLoad: boolean;
  };
}

export type JournalAction =
  | { type: "conversation_begin"; generation: number; key: string }
  | { type: "conversation_loaded"; generation: number; key: string; restored: boolean }
  | { type: "conversation_live"; generation: number; key: string }
  | { type: "queue_begin"; generation: number; device: DeviceId }
  | { type: "queue_changed"; device: DeviceId }
  | { type: "queue_loaded"; generation: number; device: DeviceId };

export const initialJournalState: JournalState = {
  conversation: { generation: 0, key: "", phase: "idle" },
  queue: { generation: 0, device: null, phase: "idle", changedDuringLoad: false },
};

export function reduceJournalState(state: JournalState, action: JournalAction): JournalState {
  switch (action.type) {
    case "conversation_begin":
      if (!Number.isSafeInteger(action.generation)
          || action.generation <= state.conversation.generation) return state;
      return {
        ...state,
        conversation: { generation: action.generation, key: action.key, phase: "loading" },
      };
    case "conversation_loaded":
      if (!conversationMatches(state, action)) return state;
      return {
        ...state,
        conversation: {
          ...state.conversation,
          phase: action.restored ? "restored" : "live",
        },
      };
    case "conversation_live":
      if (!conversationMatches(state, action)) return state;
      return { ...state, conversation: { ...state.conversation, phase: "live" } };
    case "queue_begin":
      if (!Number.isSafeInteger(action.generation) || action.generation <= state.queue.generation) return state;
      return {
        ...state,
        queue: {
          generation: action.generation,
          device: action.device,
          phase: "loading",
          changedDuringLoad: false,
        },
      };
    case "queue_changed":
      if (state.queue.device !== action.device || state.queue.phase !== "loading") return state;
      return { ...state, queue: { ...state.queue, changedDuringLoad: true } };
    case "queue_loaded":
      if (!queueLoadMatches(state, action.generation, action.device)) return state;
      return { ...state, queue: { ...state.queue, phase: "ready", changedDuringLoad: false } };
  }
}

export function conversationJournalRestored(state: JournalState, key: string): boolean {
  return state.conversation.key === key && state.conversation.phase === "restored";
}

export function queueLoadMatches(state: JournalState, generation: number, device: DeviceId): boolean {
  return state.queue.generation === generation
    && state.queue.device === device
    && state.queue.phase === "loading";
}

export function queueJournalReady(state: JournalState, device: DeviceId): boolean {
  return state.queue.device === device && state.queue.phase === "ready";
}

export function mergeRestoredPrompts(
  restored: readonly QueuedPrompt[],
  changedDuringLoad: readonly QueuedPrompt[],
): QueuedPrompt[] {
  const liveIds = new Set(changedDuringLoad.map((prompt) => prompt.id));
  return [
    ...restored.filter((prompt) => !liveIds.has(prompt.id)).map((prompt) => ({
      ...prompt,
      requiresConfirmation: true,
    })),
    ...changedDuringLoad,
  ];
}

function conversationMatches(
  state: JournalState,
  action: { generation: number; key: string },
): boolean {
  return state.conversation.generation === action.generation && state.conversation.key === action.key;
}
