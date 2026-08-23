import { registerPlugin } from "@capacitor/core";

export interface NativeJournalPlugin {
  getConversation(options: { key: string }): Promise<{ payload: string | null }>;
  putConversation(options: { key: string; payload: string }): Promise<void>;
  getQueue(options: { device: string }): Promise<{ payload: string | null }>;
  putQueue(options: { device: string; payload: string }): Promise<void>;
}

export const NativeJournal = registerPlugin<NativeJournalPlugin>("PocketJournal");
