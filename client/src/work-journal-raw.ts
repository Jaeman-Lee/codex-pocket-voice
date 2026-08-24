import type { NativeJournalPlugin } from "./native-journal";
import type { DeviceId } from "./types";

export interface RawJournal {
  loadConversation(key: string): Promise<unknown>;
  saveConversation(value: unknown): Promise<void>;
  loadQueue(device: DeviceId): Promise<unknown>;
  saveQueue(value: unknown): Promise<void>;
  loadSpeechGlossary(key: string): Promise<unknown>;
  saveSpeechGlossary(value: unknown): Promise<void>;
}

export class MigratingRawJournal implements RawJournal {
  constructor(private readonly primary: RawJournal, private readonly legacy: RawJournal) {}

  async loadConversation(key: string): Promise<unknown> {
    const current = await this.primary.loadConversation(key).catch(() => undefined);
    if (current !== undefined && current !== null) return current;
    const legacy = await this.legacy.loadConversation(key);
    if (legacy !== undefined && legacy !== null) {
      await this.primary.saveConversation(legacy).catch(() => undefined);
    }
    return legacy;
  }

  async saveConversation(value: unknown): Promise<void> {
    await saveWithRollbackMirror(
      () => this.primary.saveConversation(value),
      () => this.legacy.saveConversation(value),
    );
  }

  async loadQueue(device: DeviceId): Promise<unknown> {
    const current = await this.primary.loadQueue(device).catch(() => undefined);
    if (current !== undefined && current !== null) return current;
    const legacy = await this.legacy.loadQueue(device);
    if (legacy !== undefined && legacy !== null) {
      await this.primary.saveQueue(legacy).catch(() => undefined);
    }
    return legacy;
  }

  async saveQueue(value: unknown): Promise<void> {
    await saveWithRollbackMirror(
      () => this.primary.saveQueue(value),
      () => this.legacy.saveQueue(value),
    );
  }

  async loadSpeechGlossary(key: string): Promise<unknown> {
    const current = await this.primary.loadSpeechGlossary(key).catch(() => undefined);
    if (current !== undefined && current !== null) return current;
    const legacy = await this.legacy.loadSpeechGlossary(key);
    if (legacy !== undefined && legacy !== null) {
      await this.primary.saveSpeechGlossary(legacy).catch(() => undefined);
    }
    return legacy;
  }

  async saveSpeechGlossary(value: unknown): Promise<void> {
    await saveWithRollbackMirror(
      () => this.primary.saveSpeechGlossary(value),
      () => this.legacy.saveSpeechGlossary(value),
    );
  }
}

export class NativeSqliteRawJournal implements RawJournal {
  constructor(private readonly native: NativeJournalPlugin) {}

  async loadConversation(key: string): Promise<unknown> {
    const index = await nativeJournalIndex("conversation", key);
    return parseNativePayload((await this.native.getConversation({ key: index })).payload);
  }

  async saveConversation(value: unknown): Promise<void> {
    const key = objectString(value, "key");
    if (!key) throw new Error("작업 저널 conversation key가 없습니다.");
    await this.native.putConversation({
      key: await nativeJournalIndex("conversation", key),
      payload: encryptedPayload(value),
    });
  }

  async loadQueue(device: DeviceId): Promise<unknown> {
    const index = await nativeJournalIndex("queue", device);
    return parseNativePayload((await this.native.getQueue({ device: index })).payload);
  }

  async saveQueue(value: unknown): Promise<void> {
    const device = objectString(value, "device");
    if (!device) throw new Error("작업 저널 device key가 없습니다.");
    await this.native.putQueue({
      device: await nativeJournalIndex("queue", device),
      payload: encryptedPayload(value),
    });
  }

  async loadSpeechGlossary(key: string): Promise<unknown> {
    const index = await nativeJournalIndex("speech-glossary", key);
    return parseNativePayload((await this.native.getSpeechGlossary({ scope: index })).payload);
  }

  async saveSpeechGlossary(value: unknown): Promise<void> {
    const key = objectString(value, "key");
    if (!key) throw new Error("작업 저널 speech glossary key가 없습니다.");
    await this.native.putSpeechGlossary({
      scope: await nativeJournalIndex("speech-glossary", key),
      payload: encryptedPayload(value),
    });
  }
}

async function saveWithRollbackMirror(
  savePrimary: () => Promise<void>,
  saveLegacy: () => Promise<void>,
): Promise<void> {
  const [primary, legacy] = await Promise.allSettled([savePrimary(), saveLegacy()]);
  if (primary.status === "fulfilled" || legacy.status === "fulfilled") return;
  throw primary.reason;
}

function parseNativePayload(payload: string | null): unknown {
  if (payload === null) return undefined;
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    return undefined;
  }
}

function objectString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : undefined;
}

function encryptedPayload(value: unknown): string {
  if (!value || typeof value !== "object") throw new Error("암호화된 작업 저널 envelope가 필요합니다.");
  const record = value as Record<string, unknown>;
  if (record.version !== 2 || typeof record.iv !== "string" || typeof record.ciphertext !== "string") {
    throw new Error("암호화된 작업 저널 envelope가 필요합니다.");
  }
  return JSON.stringify({ version: 2, iv: record.iv, ciphertext: record.ciphertext });
}

async function nativeJournalIndex(kind: "conversation" | "queue" | "speech-glossary", value: string): Promise<string> {
  const encoded = new TextEncoder().encode(`${kind}\0${value}`);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", encoded);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
