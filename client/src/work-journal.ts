import type { DeviceId } from "./types";
import { conversationKey, type JournalConversation, type JournalQueue } from "./work-journal-model";

const DATABASE_NAME = "codex-pocket-work-journal";
const DATABASE_VERSION = 1;
const CONVERSATION_STORE = "conversations";
const QUEUE_STORE = "queues";

export interface WorkJournal {
  loadConversation(device: DeviceId, workspace: string, threadId: string): Promise<JournalConversation | undefined>;
  saveConversation(record: JournalConversation): Promise<void>;
  loadQueue(device: DeviceId): Promise<JournalQueue | undefined>;
  saveQueue(record: JournalQueue): Promise<void>;
}

export function createWorkJournal(): WorkJournal {
  const fallback = new LocalStorageWorkJournal(window.localStorage);
  if (!("indexedDB" in window)) return fallback;
  return new ResilientWorkJournal(new IndexedDbWorkJournal(window.indexedDB), fallback);
}

class ResilientWorkJournal implements WorkJournal {
  constructor(private readonly primary: WorkJournal, private readonly fallback: WorkJournal) {}

  async loadConversation(device: DeviceId, workspace: string, threadId: string): Promise<JournalConversation | undefined> {
    try {
      return await this.primary.loadConversation(device, workspace, threadId)
        ?? await this.fallback.loadConversation(device, workspace, threadId);
    } catch {
      return this.fallback.loadConversation(device, workspace, threadId);
    }
  }

  async saveConversation(record: JournalConversation): Promise<void> {
    try {
      await this.primary.saveConversation(record);
    } catch {
      await this.fallback.saveConversation(record);
    }
  }

  async loadQueue(device: DeviceId): Promise<JournalQueue | undefined> {
    try {
      return await this.primary.loadQueue(device) ?? await this.fallback.loadQueue(device);
    } catch {
      return this.fallback.loadQueue(device);
    }
  }

  async saveQueue(record: JournalQueue): Promise<void> {
    try {
      await this.primary.saveQueue(record);
    } catch {
      await this.fallback.saveQueue(record);
    }
  }
}

class IndexedDbWorkJournal implements WorkJournal {
  private database?: Promise<IDBDatabase>;

  constructor(private readonly indexedDb: IDBFactory) {}

  async loadConversation(device: DeviceId, workspace: string, threadId: string): Promise<JournalConversation | undefined> {
    return this.get<JournalConversation>(CONVERSATION_STORE, conversationKey(device, workspace, threadId));
  }

  saveConversation(record: JournalConversation): Promise<void> {
    return this.put(CONVERSATION_STORE, record);
  }

  async loadQueue(device: DeviceId): Promise<JournalQueue | undefined> {
    return this.get<JournalQueue>(QUEUE_STORE, device);
  }

  saveQueue(record: JournalQueue): Promise<void> {
    return this.put(QUEUE_STORE, record);
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

  private async get<T>(storeName: string, key: IDBValidKey): Promise<T | undefined> {
    const database = await this.open();
    const transaction = database.transaction(storeName, "readonly");
    const request = transaction.objectStore(storeName).get(key);
    const result = await requestResult<T | undefined>(request);
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

class LocalStorageWorkJournal implements WorkJournal {
  constructor(private readonly storage: Storage) {}

  async loadConversation(device: DeviceId, workspace: string, threadId: string): Promise<JournalConversation | undefined> {
    return this.read<JournalConversation>(`conversation:${conversationKey(device, workspace, threadId)}`);
  }

  async saveConversation(record: JournalConversation): Promise<void> {
    this.write(`conversation:${record.key}`, record);
  }

  async loadQueue(device: DeviceId): Promise<JournalQueue | undefined> {
    return this.read<JournalQueue>(`queue:${device}`);
  }

  async saveQueue(record: JournalQueue): Promise<void> {
    this.write(`queue:${record.device}`, record);
  }

  private read<T>(key: string): T | undefined {
    const value = this.storage.getItem(`codex-pocket-journal:${key}`);
    if (!value) return undefined;
    try {
      return JSON.parse(value) as T;
    } catch {
      return undefined;
    }
  }

  private write(key: string, value: unknown): void {
    this.storage.setItem(`codex-pocket-journal:${key}`, JSON.stringify(value));
  }
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
