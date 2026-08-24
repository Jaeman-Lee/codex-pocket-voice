import assert from "node:assert/strict";
import test from "node:test";
import type { ChatMessage, QueuedPrompt } from "../client/src/types.js";
import type { NativeJournalPlugin } from "../client/src/native-journal.js";
import {
  MigratingRawJournal,
  NativeSqliteRawJournal,
  type RawJournal,
} from "../client/src/work-journal-raw.js";
import {
  conversationKey,
  restoredMessages,
  serializableQueue,
  speechGlossaryKey,
} from "../client/src/work-journal-model.js";

test("work journal keys isolate device, provider, workspace, and thread without changing Codex rollback keys", () => {
  const phone = conversationKey("phone", "/workspace/a", "thread-1");
  const pc = conversationKey("pc", "/workspace/a", "thread-1");
  const otherThread = conversationKey("phone", "/workspace/a", "thread-2");
  assert.notEqual(phone, pc);
  assert.notEqual(phone, otherThread);
  assert.equal(conversationKey("phone", "/workspace/a", ""), '["phone","/workspace/a","new"]');
  assert.equal(
    conversationKey("phone", "/workspace/a", "", "openai"),
    '["phone","openai","/workspace/a","new"]',
  );
  assert.notEqual(
    conversationKey("phone", "/workspace/a", "conversation-1", "openai"),
    conversationKey("phone", "/workspace/a", "conversation-1", "openrouter"),
  );
});

test("restoring a journal never presents an interrupted response as still running", () => {
  const messages: ChatMessage[] = [
    { id: "user", role: "user", text: "continue" },
    { id: "assistant", role: "assistant", text: "", pending: true },
  ];
  const restored = restoredMessages(messages);
  assert.equal(restored[1]?.pending, false);
  assert.equal(restored[1]?.error, true);
  assert.match(restored[1]?.text ?? "", /다시 연결/);
  assert.equal(messages[1]?.pending, true);
});

test("persisted prompt queues remove temporary blob URLs and one-time capabilities", () => {
  const prompts: QueuedPrompt[] = [{
    id: "queued-1",
    text: "inspect image",
    cwd: "/workspace/a",
    threadId: "",
    networkAccess: false,
    model: "",
    effort: "",
    provider: "codex",
    accountId: "cli-default",
    routing: { upstreams: ["strict-primary", "strict-backup"], allowFallbacks: true },
    policyConfirmation: "ephemeral-run-policy-token",
    forkPreviewId: "ephemeral-provider-fork-preview",
    forkSourceOperationId: "operation-source",
    attachments: [{
      id: "media-1",
      name: "screen.png",
      kind: "image",
      mimeType: "image/png",
      size: 10,
      status: "uploaded",
      frameCount: 0,
      previewUrl: "blob:temporary",
    }],
  }];
  const saved = serializableQueue(prompts);
  assert.equal(saved[0]?.attachments[0]?.previewUrl, undefined);
  assert.deepEqual(saved[0]?.routing, { upstreams: ["strict-primary", "strict-backup"], allowFallbacks: true });
  assert.equal(saved[0]?.policyConfirmation, undefined);
  assert.equal(saved[0]?.forkPreviewId, undefined);
  assert.equal(saved[0]?.forkSourceOperationId, "operation-source");
  assert.equal(prompts[0]?.policyConfirmation, "ephemeral-run-policy-token");
  assert.equal(prompts[0]?.forkPreviewId, "ephemeral-provider-fork-preview");
  assert.equal(prompts[0]?.attachments[0]?.previewUrl, "blob:temporary");
});

test("native journal migration copies legacy records without deleting the rollback copy", async () => {
  const primary = new MemoryRawJournal();
  const legacy = new MemoryRawJournal();
  const record = { key: "conversation-a", version: 2, iv: "iv", ciphertext: "encrypted" };
  legacy.conversations.set(record.key, record);
  const journal = new MigratingRawJournal(primary, legacy);

  assert.deepEqual(await journal.loadConversation(record.key), record);
  assert.deepEqual(primary.conversations.get(record.key), record);
  assert.deepEqual(legacy.conversations.get(record.key), record);

  const next = { ...record, ciphertext: "updated" };
  await journal.saveConversation(next);
  assert.deepEqual(primary.conversations.get(record.key), next);
  assert.deepEqual(legacy.conversations.get(record.key), next);

  const glossary = { key: speechGlossaryKey("phone", "/workspace/a"), version: 2, iv: "iv", ciphertext: "terms" };
  legacy.speechGlossaries.set(glossary.key, glossary);
  assert.deepEqual(await journal.loadSpeechGlossary(glossary.key), glossary);
  assert.deepEqual(primary.speechGlossaries.get(glossary.key), glossary);
  assert.deepEqual(legacy.speechGlossaries.get(glossary.key), glossary);
});

test("native journal keeps saving when either SQLite or the rollback mirror is unavailable", async () => {
  const primary = new MemoryRawJournal();
  const legacy = new MemoryRawJournal();
  const record = { device: "linux-a", version: 2, iv: "iv", ciphertext: "encrypted" };

  primary.failWrites = true;
  await new MigratingRawJournal(primary, legacy).saveQueue(record);
  assert.deepEqual(legacy.queues.get(record.device), record);

  primary.failWrites = false;
  legacy.failWrites = true;
  await new MigratingRawJournal(primary, legacy).saveQueue(record);
  assert.deepEqual(primary.queues.get(record.device), record);
});

test("native SQLite bridge sends only encrypted envelopes and ignores corrupt rows", async () => {
  const writes: Array<{ key: string; payload: string }> = [];
  const native: NativeJournalPlugin = {
    async getConversation() { return { payload: "not-json" }; },
    async putConversation(options) { writes.push(options); },
    async getQueue() { return { payload: null }; },
    async putQueue() {},
    async getSpeechGlossary() { return { payload: null }; },
    async putSpeechGlossary() {},
  };
  const journal = new NativeSqliteRawJournal(native);
  const envelope = { key: "conversation-a", version: 2, iv: "safe-iv", ciphertext: "encrypted-only" };

  await journal.saveConversation(envelope);
  assert.equal(writes.length, 1);
  assert.match(writes[0]!.key, /^[a-f0-9]{64}$/);
  assert.notEqual(writes[0]!.key, envelope.key);
  assert.deepEqual(JSON.parse(writes[0]!.payload), {
    version: 2,
    iv: envelope.iv,
    ciphertext: envelope.ciphertext,
  });
  assert.equal(await journal.loadConversation(envelope.key), undefined);
  assert.doesNotMatch(writes[0]!.payload, /prompt|Authorization|OPENAI_API_KEY/);
});

test("native SQLite bridge hashes the project glossary scope and sends ciphertext only", async () => {
  const writes: Array<{ scope: string; payload: string }> = [];
  const native: NativeJournalPlugin = {
    async getConversation() { return { payload: null }; },
    async putConversation() {},
    async getQueue() { return { payload: null }; },
    async putQueue() {},
    async getSpeechGlossary() { return { payload: null }; },
    async putSpeechGlossary(options) { writes.push(options); },
  };
  const journal = new NativeSqliteRawJournal(native);
  const key = speechGlossaryKey("linux-a", "/private/project/path");
  await journal.saveSpeechGlossary({ key, version: 2, iv: "safe-iv", ciphertext: "encrypted-terms" });

  assert.equal(writes.length, 1);
  assert.match(writes[0]!.scope, /^[a-f0-9]{64}$/);
  assert.notEqual(writes[0]!.scope, key);
  assert.doesNotMatch(writes[0]!.payload, /private|project|OpenRouter/);
  assert.deepEqual(JSON.parse(writes[0]!.payload), {
    version: 2,
    iv: "safe-iv",
    ciphertext: "encrypted-terms",
  });
});

class MemoryRawJournal implements RawJournal {
  readonly conversations = new Map<string, unknown>();
  readonly queues = new Map<string, unknown>();
  readonly speechGlossaries = new Map<string, unknown>();
  failWrites = false;

  async loadConversation(key: string): Promise<unknown> {
    return this.conversations.get(key);
  }

  async saveConversation(value: unknown): Promise<void> {
    if (this.failWrites) throw new Error("write failed");
    const key = (value as { key?: string }).key;
    if (!key) throw new Error("key missing");
    this.conversations.set(key, structuredClone(value));
  }

  async loadQueue(device: string): Promise<unknown> {
    return this.queues.get(device);
  }

  async saveQueue(value: unknown): Promise<void> {
    if (this.failWrites) throw new Error("write failed");
    const device = (value as { device?: string }).device;
    if (!device) throw new Error("device missing");
    this.queues.set(device, structuredClone(value));
  }

  async loadSpeechGlossary(key: string): Promise<unknown> {
    return this.speechGlossaries.get(key);
  }

  async saveSpeechGlossary(value: unknown): Promise<void> {
    if (this.failWrites) throw new Error("write failed");
    const key = (value as { key?: string }).key;
    if (!key) throw new Error("key missing");
    this.speechGlossaries.set(key, structuredClone(value));
  }
}
