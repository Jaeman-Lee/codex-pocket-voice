import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import type { Thread } from "../generated/app-server/v2/Thread";
import type { Turn } from "../generated/app-server/v2/Turn";
import type { AppServerNotification, RunTurnOptions } from "../src/app-server-client.js";
import { PathPolicy } from "../src/path-policy.js";
import { startWebServer, type WebCodexClient } from "../src/web-server.js";

const cwd = process.cwd();

test("loopback web gateway serves the PWA, validates origins, and controls a turn", async (t) => {
  const fake = new FakeWebClient();
  const paths = await PathPolicy.fromEnvironment(cwd);
  const running = await startWebServer({
    client: fake,
    paths,
    staticDir: resolve(cwd, "web"),
    port: 0,
  });
  t.after(() => running.close());
  const base = `http://127.0.0.1:${running.port}`;

  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Codex Pocket/);
  assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'self'/);
  assert.match(page.headers.get("permissions-policy") ?? "", /microphone=\(self\)/);

  const health = await jsonFetch(`${base}/api/health`);
  assert.equal(health.ok, true);
  assert.deepEqual(health.allowedWorkspaceRoots, [cwd]);

  const listed = await jsonFetch(`${base}/api/threads`);
  assert.equal(listed.threads[0].id, "thread-web");
  const read = await jsonFetch(`${base}/api/threads/thread-web`);
  assert.equal(read.thread.turns[0].items[0].text, "hello");

  const blocked = await fetch(`${base}/api/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
    body: JSON.stringify({ prompt: "test", cwd }),
  });
  assert.equal(blocked.status, 403);

  const streamAbort = new AbortController();
  const stream = await fetch(`${base}/api/events`, { signal: streamAbort.signal });
  assert.equal(stream.status, 200);
  const reader = stream.body!.getReader();
  const initial = await reader.read();
  assert.match(new TextDecoder().decode(initial.value), /connected/);
  streamAbort.abort();

  const started = await jsonFetch(`${base}/api/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: base },
    body: JSON.stringify({ prompt: "change a file", cwd }),
  });
  assert.equal(started.operation.status, "running");
  assert.equal(fake.lastRun?.cwd, cwd);
  assert.equal(fake.lastRun?.networkAccess, false);

  const operationId = started.operation.id;
  const interrupted = await jsonFetch(`${base}/api/runs/${operationId}/interrupt`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: base },
    body: "{}",
  });
  assert.equal(interrupted.interruptRequested, true);
  assert.deepEqual(fake.interrupted, ["thread-web", "turn-web"]);

  fake.finish("interrupted");
  await waitFor(async () => {
    const operation = await jsonFetch(`${base}/api/runs/${operationId}`);
    return operation.operation.status === "interrupted";
  });
});

class FakeWebClient implements WebCodexClient {
  lastRun?: RunTurnOptions;
  interrupted?: [string, string];
  private listeners = new Set<(notification: AppServerNotification) => void>();
  private resolveTurn?: (turn: Turn) => void;

  async start() {
    return { userAgent: "fake-codex", codexHome: cwd, platformFamily: "unix", platformOs: "linux" };
  }

  async listThreads() {
    return { data: [thread()], nextCursor: null, backwardsCursor: null };
  }

  async readThread() {
    return { thread: thread(true) };
  }

  async beginTurn(options: RunTurnOptions) {
    this.lastRun = options;
    const completion = new Promise<Turn>((resolve) => {
      this.resolveTurn = resolve;
    });
    return { thread: thread(), turn: turn("inProgress"), completion };
  }

  async interrupt(threadId: string, turnId: string) {
    this.interrupted = [threadId, turnId];
  }

  subscribe(listener: (notification: AppServerNotification) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  finish(status: Turn["status"]) {
    this.resolveTurn?.(turn(status));
  }
}

function thread(includeTurns = false): Thread {
  return {
    id: "thread-web",
    extra: null,
    sessionId: "session-web",
    forkedFromId: null,
    parentThreadId: null,
    preview: "web test",
    ephemeral: false,
    section: null,
    sectionEnteredAt: null,
    historyMode: "legacy",
    modelProvider: "openai",
    createdAt: 1,
    updatedAt: 2,
    recencyAt: 2,
    status: { type: "idle" },
    path: null,
    cwd,
    cliVersion: "test",
    source: "appServer",
    canAcceptDirectInput: true,
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: "Web test",
    turns: includeTurns
      ? [{ ...turn("completed"), items: [{ type: "agentMessage", id: "message-web", text: "hello", phase: "final_answer", memoryCitation: null }] }]
      : [],
  };
}

function turn(status: Turn["status"]): Turn {
  return {
    id: "turn-web",
    items: [],
    itemsView: "full",
    status,
    error: null,
    startedAt: 1,
    completedAt: status === "inProgress" ? null : 2,
    durationMs: status === "inProgress" ? null : 1_000,
  };
}

async function jsonFetch(url: string, init?: RequestInit): Promise<any> {
  const response = await fetch(url, init);
  const value = (await response.json()) as any;
  if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
  return value;
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Condition was not met in time");
}
