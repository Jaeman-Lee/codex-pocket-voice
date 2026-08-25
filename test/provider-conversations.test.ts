import assert from "node:assert/strict";
import test from "node:test";
import {
  latestProviderForkSource,
  providerConversationMessages,
  providerConversationThreads,
} from "../client/src/provider-conversations.js";
import type { Operation } from "../client/src/types.js";

test("API provider conversation views stay isolated by provider, workspace, and resumable owner", () => {
  const operations: Operation[] = [
    operation("one", "openai", "/workspace/a", "conversation-a", "첫 질문", "첫 답변", false, 1),
    operation("two", "openai", "/workspace/a", "conversation-a", "둘째 질문", "둘째 답변", true, 2),
    operation("other-provider", "openrouter", "/workspace/a", "conversation-a", "섞이면 안 됨", "no", true, 3),
    operation("other-workspace", "openai", "/workspace/b", "conversation-b", "다른 프로젝트", "no", true, 4),
    {
      ...operation("failed", "openai", "/workspace/a", "conversation-a", "실패한 질문", "", false, 5),
      status: "failed",
      error: "network stopped",
    },
  ];

  assert.deepEqual(providerConversationThreads(operations, "openai", "/workspace/a"), [{
    id: "conversation-a",
    cwd: "/workspace/a",
    name: "둘째 질문",
    preview: "둘째 답변",
  }]);
  assert.deepEqual(
    providerConversationMessages(operations, "openai", "/workspace/a", "conversation-a")
      .map((message) => [message.role, message.text, message.error ?? false]),
    [
      ["user", "첫 질문", false],
      ["assistant", "첫 답변", false],
      ["user", "둘째 질문", false],
      ["assistant", "둘째 답변", false],
      ["user", "실패한 질문", false],
      ["assistant", "작업 실패: network stopped", true],
    ],
  );
});

test("Provider fork source is the latest terminal operation in the selected conversation", () => {
  const operations: Operation[] = [
    operation("older", "openai", "/workspace/a", "conversation-a", "old", "old", true, 1),
    operation("latest", "openai", "/workspace/a", "conversation-a", "new", "new", true, 3),
    operation("other-conversation", "openai", "/workspace/a", "conversation-b", "other", "other", true, 4),
    { ...operation("running", "openai", "/workspace/a", "conversation-a", "running", "", false, 5), completedAt: undefined, status: "running" },
    { ...operation("unknown", "openai", "/workspace/a", "conversation-a", "unknown", "", false, 6), status: "unknown" },
  ];

  assert.equal(latestProviderForkSource(operations, "openai", "/workspace/a", "conversation-a")?.id, "latest");
  assert.equal(latestProviderForkSource(operations, "openai", "/workspace/a")?.id, "other-conversation");
  assert.equal(latestProviderForkSource(operations, "openrouter", "/workspace/a"), null);
});

function operation(
  id: string,
  providerId: string,
  cwd: string,
  conversationId: string,
  prompt: string,
  finalResponse: string,
  resumable: boolean,
  second: number,
): Operation {
  return {
    id,
    providerId,
    cwd,
    conversationId,
    runId: `run-${id}`,
    prompt,
    status: "completed",
    startedAt: `2026-08-24T00:00:0${second}.000Z`,
    completedAt: `2026-08-24T00:00:0${second}.500Z`,
    result: { finalResponse },
    resumable,
  };
}
