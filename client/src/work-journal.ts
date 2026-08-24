import type { DeviceId, ProviderId } from "./types";
import { isNativeApp } from "./native";
import { NativeJournal } from "./native-journal";
import {
  conversationKey,
  speechGlossaryKey,
  type JournalConversation,
  type JournalQueue,
  type JournalSpeechGlossary,
} from "./work-journal-model";
import { MigratingRawJournal, NativeSqliteRawJournal, type RawJournal } from "./work-journal-raw";
import { parseSpeechGlossaryEntries } from "./speech-glossary";
import { secureGet, secureSet } from "./secure-storage";

const DATABASE_NAME = "codex-pocket-work-journal";
const DATABASE_VERSION = 2;
const CONVERSATION_STORE = "conversations";
const QUEUE_STORE = "queues";
const ENVELOPE_VERSION = 2;

interface EncryptedEnvelope {
  version: typeof ENVELOPE_VERSION;
  key?: string;
  device?: DeviceId;
  iv: string;
  ciphertext: string;
}

export interface WorkJournal {
  loadConversation(
    device: DeviceId,
    workspace: string,
    threadId: string,
    provider?: ProviderId,
  ): Promise<JournalConversation | undefined>;
  saveConversation(record: JournalConversation): Promise<void>;
  loadQueue(device: DeviceId): Promise<JournalQueue | undefined>;
  saveQueue(record: JournalQueue): Promise<void>;
  loadSpeechGlossary(device: DeviceId, workspace: string): Promise<JournalSpeechGlossary | undefined>;
  saveSpeechGlossary(record: JournalSpeechGlossary): Promise<void>;
}

export function createWorkJournal(): WorkJournal {
  const fallback = new LocalStorageRawJournal(window.localStorage);
  const browser: RawJournal = "indexedDB" in window
    ? new ResilientRawJournal(new IndexedDbRawJournal(window.indexedDB), fallback)
    : fallback;
  const raw = isNativeApp()
    ? new MigratingRawJournal(new NativeSqliteRawJournal(NativeJournal), browser)
    : browser;
  return new EncryptedWorkJournal(raw);
}

class EncryptedWorkJournal implements WorkJournal {
  private readonly key = loadJournalKey();

  constructor(private readonly raw: RawJournal) {}

  async loadConversation(
    device: DeviceId,
    workspace: string,
    threadId: string,
    provider: ProviderId = "codex",
  ): Promise<JournalConversation | undefined> {
    const key = conversationKey(device, workspace, threadId, provider);
    const value = await this.raw.loadConversation(key);
    if (isEnvelope(value)) {
      const decrypted = await decryptValue(value, `conversation:${key}`, this.key);
      return isJournalConversation(decrypted) ? decrypted : undefined;
    }
    if (!isJournalConversation(value)) return undefined;
    void this.saveConversation(value).catch(() => undefined);
    return value;
  }

  async saveConversation(record: JournalConversation): Promise<void> {
    const envelope = await encryptValue(record, `conversation:${record.key}`, this.key);
    await this.raw.saveConversation({ ...envelope, key: record.key });
  }

  async loadQueue(device: DeviceId): Promise<JournalQueue | undefined> {
    const value = await this.raw.loadQueue(device);
    if (isEnvelope(value)) {
      const decrypted = await decryptValue(value, `queue:${device}`, this.key);
      return isJournalQueue(decrypted) ? decrypted : undefined;
    }
    if (!isJournalQueue(value)) return undefined;
    void this.saveQueue(value).catch(() => undefined);
    return value;
  }

  async saveQueue(record: JournalQueue): Promise<void> {
    const envelope = await encryptValue(record, `queue:${record.device}`, this.key);
    await this.raw.saveQueue({ ...envelope, device: record.device });
  }

  async loadSpeechGlossary(device: DeviceId, workspace: string): Promise<JournalSpeechGlossary | undefined> {
    const key = speechGlossaryKey(device, workspace);
    const storageIndex = await journalStorageIndex("speech-glossary", key);
    const value = await this.raw.loadSpeechGlossary(storageIndex);
    if (isEnvelope(value)) {
      const decrypted = await decryptValue(value, `speech-glossary:${key}`, this.key);
      return isJournalSpeechGlossary(decrypted) ? decrypted : undefined;
    }
    if (!isJournalSpeechGlossary(value)) return undefined;
    void this.saveSpeechGlossary(value).catch(() => undefined);
    return value;
  }

  async saveSpeechGlossary(record: JournalSpeechGlossary): Promise<void> {
    const expectedKey = speechGlossaryKey(record.device, record.workspace);
    if (record.key !== expectedKey || !isJournalSpeechGlossary(record)) {
      throw new Error("프로젝트 음성 용어 사전이 올바르지 않습니다.");
    }
    const envelope = await encryptValue(record, `speech-glossary:${record.key}`, this.key);
    const storageIndex = await journalStorageIndex("speech-glossary", record.key);
    await this.raw.saveSpeechGlossary({ ...envelope, key: storageIndex });
  }
}

class ResilientRawJournal implements RawJournal {
  constructor(private readonly primary: RawJournal, private readonly fallback: RawJournal) {}

  async loadConversation(key: string): Promise<unknown> {
    try {
      return await this.primary.loadConversation(key) ?? await this.fallback.loadConversation(key);
    } catch {
      return this.fallback.loadConversation(key);
    }
  }

  async saveConversation(value: unknown): Promise<void> {
    try {
      await this.primary.saveConversation(value);
    } catch {
      await this.fallback.saveConversation(value);
    }
  }

  async loadQueue(device: DeviceId): Promise<unknown> {
    try {
      return await this.primary.loadQueue(device) ?? await this.fallback.loadQueue(device);
    } catch {
      return this.fallback.loadQueue(device);
    }
  }

  async saveQueue(value: unknown): Promise<void> {
    try {
      await this.primary.saveQueue(value);
    } catch {
      await this.fallback.saveQueue(value);
    }
  }

  async loadSpeechGlossary(key: string): Promise<unknown> {
    try {
      return await this.primary.loadSpeechGlossary(key) ?? await this.fallback.loadSpeechGlossary(key);
    } catch {
      return this.fallback.loadSpeechGlossary(key);
    }
  }

  async saveSpeechGlossary(value: unknown): Promise<void> {
    try {
      await this.primary.saveSpeechGlossary(value);
    } catch {
      await this.fallback.saveSpeechGlossary(value);
    }
  }
}

class IndexedDbRawJournal implements RawJournal {
  private database?: Promise<IDBDatabase>;

  constructor(private readonly indexedDb: IDBFactory) {}

  loadConversation(key: string): Promise<unknown> {
    return this.get(CONVERSATION_STORE, key);
  }

  saveConversation(value: unknown): Promise<void> {
    return this.put(CONVERSATION_STORE, value);
  }

  loadQueue(device: DeviceId): Promise<unknown> {
    return this.get(QUEUE_STORE, device);
  }

  saveQueue(value: unknown): Promise<void> {
    return this.put(QUEUE_STORE, value);
  }

  loadSpeechGlossary(key: string): Promise<unknown> {
    return this.get(CONVERSATION_STORE, key);
  }

  saveSpeechGlossary(value: unknown): Promise<void> {
    return this.put(CONVERSATION_STORE, value);
  }

  private open(): Promise<IDBDatabase> {
    this.database ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = this.indexedDb.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(CONVERSATION_STORE)) {
          database.createObjectStore(CONVERSATION_STORE, { keyPath: "key" });
        }
        if (!database.objectStoreNames.contains(QUEUE_STORE)) {
          database.createObjectStore(QUEUE_STORE, { keyPath: "device" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("작업 저널을 열 수 없습니다."));
      request.onblocked = () => reject(new Error("작업 저널 업그레이드가 차단됐습니다."));
    });
    return this.database;
  }

  private async get(storeName: string, key: IDBValidKey): Promise<unknown> {
    const database = await this.open();
    const transaction = database.transaction(storeName, "readonly");
    const request = transaction.objectStore(storeName).get(key);
    const result = await requestResult(request);
    await transactionDone(transaction);
    return result;
  }

  private async put(storeName: string, value: unknown): Promise<void> {
    const database = await this.open();
    const transaction = database.transaction(storeName, "readwrite");
    transaction.objectStore(storeName).put(value);
    await transactionDone(transaction);
  }
}

class LocalStorageRawJournal implements RawJournal {
  constructor(private readonly storage: Storage) {}

  async loadConversation(key: string): Promise<unknown> {
    return this.read(`conversation:${key}`);
  }

  async saveConversation(value: unknown): Promise<void> {
    const key = objectString(value, "key");
    if (!key) throw new Error("작업 저널 conversation key가 없습니다.");
    this.write(`conversation:${key}`, value);
  }

  async loadQueue(device: DeviceId): Promise<unknown> {
    return this.read(`queue:${device}`);
  }

  async saveQueue(value: unknown): Promise<void> {
    const device = objectString(value, "device");
    if (!device) throw new Error("작업 저널 device key가 없습니다.");
    this.write(`queue:${device}`, value);
  }

  async loadSpeechGlossary(key: string): Promise<unknown> {
    return this.read(`speech-glossary:${key}`);
  }

  async saveSpeechGlossary(value: unknown): Promise<void> {
    const key = objectString(value, "key");
    if (!key) throw new Error("작업 저널 speech glossary key가 없습니다.");
    this.write(`speech-glossary:${key}`, value);
  }

  private read(key: string): unknown {
    const value = this.storage.getItem(`codex-pocket-journal:${key}`);
    if (!value) return undefined;
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return undefined;
    }
  }

  private write(key: string, value: unknown): void {
    this.storage.setItem(`codex-pocket-journal:${key}`, JSON.stringify(value));
  }
}

async function loadJournalKey(): Promise<CryptoKey> {
  let encoded = await secureGet("journal-master-key");
  if (!encoded) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    encoded = encodeBase64(bytes);
    await secureSet("journal-master-key", encoded);
  }
  return crypto.subtle.importKey("raw", asArrayBuffer(decodeBase64(encoded)), "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function encryptValue(value: unknown, context: string, key: Promise<CryptoKey>): Promise<EncryptedEnvelope> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  const additionalData = new TextEncoder().encode(context);
  const ciphertext = await crypto.subtle.encrypt({
    name: "AES-GCM",
    iv: asArrayBuffer(iv),
    additionalData: asArrayBuffer(additionalData),
  }, await key, asArrayBuffer(encoded));
  return { version: ENVELOPE_VERSION, iv: encodeBase64(iv), ciphertext: encodeBase64(new Uint8Array(ciphertext)) };
}

async function decryptValue(value: EncryptedEnvelope, context: string, key: Promise<CryptoKey>): Promise<unknown> {
  try {
    const plaintext = await crypto.subtle.decrypt({
      name: "AES-GCM",
      iv: asArrayBuffer(decodeBase64(value.iv)),
      additionalData: asArrayBuffer(new TextEncoder().encode(context)),
    }, await key, asArrayBuffer(decodeBase64(value.ciphertext)));
    return JSON.parse(new TextDecoder().decode(plaintext)) as unknown;
  } catch {
    return undefined;
  }
}

function isEnvelope(value: unknown): value is EncryptedEnvelope {
  if (!value || typeof value !== "object") return false;
  const envelope = value as Record<string, unknown>;
  return envelope.version === ENVELOPE_VERSION && typeof envelope.iv === "string" && typeof envelope.ciphertext === "string";
}

function isJournalConversation(value: unknown): value is JournalConversation {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.key === "string" && typeof record.device === "string"
    && typeof record.workspace === "string" && typeof record.threadId === "string"
    && Array.isArray(record.messages) && typeof record.updatedAt === "string";
}

function isJournalQueue(value: unknown): value is JournalQueue {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.device === "string" && Array.isArray(record.prompts) && typeof record.updatedAt === "string";
}

function isJournalSpeechGlossary(value: unknown): value is JournalSpeechGlossary {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.key === "string" && typeof record.device === "string"
    && typeof record.workspace === "string" && typeof record.updatedAt === "string"
    && record.key === speechGlossaryKey(record.device, record.workspace)
    && parseSpeechGlossaryEntries(record.entries) !== null;
}

function objectString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : undefined;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function journalStorageIndex(kind: "speech-glossary", value: string): Promise<string> {
  const encoded = new TextEncoder().encode(`${kind}\0${value}`);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", encoded);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("작업 저널 요청이 실패했습니다."));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("작업 저널 저장이 실패했습니다."));
    transaction.onabort = () => reject(transaction.error ?? new Error("작업 저널 저장이 취소됐습니다."));
  });
}
