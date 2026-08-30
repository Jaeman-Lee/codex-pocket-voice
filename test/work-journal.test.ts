import assert from "node:assert/strict";
import test from "node:test";
import type { ChatMessage, QueuedPrompt } from "../client/src/types.js";
import { conversationKey, restoredMessages, serializableQueue } from "../client/src/work-journal-model.js";

test("work journal keys isolate device, workspace, and thread", () => {
  const phone = conversationKey("phone", "/workspace/a", "thread-1");
  const pc = conversationKey("pc", "/workspace/a", "thread-1");
  const otherThread = conversationKey("phone", "/workspace/a", "thread-2");
  assert.notEqual(phone, pc);
  assert.notEqual(phone, otherThread);
  assert.equal(conversationKey("phone", "/workspace/a", ""), '["phone","/workspace/a","new"]');
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

test("persisted prompt queues remove temporary blob preview URLs", () => {
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
  assert.equal(prompts[0]?.attachments[0]?.previewUrl, "blob:temporary");
});
