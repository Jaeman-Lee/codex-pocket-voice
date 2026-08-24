import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import type { Thread } from "../generated/app-server/v2/Thread";
import type { ModelListResponse } from "../generated/app-server/v2/ModelListResponse";
import type { Turn } from "../generated/app-server/v2/Turn";
import type { AppServerNotification, RunTurnOptions } from "../src/app-server-client.js";
import { PathPolicy } from "../src/path-policy.js";
import { MediaManager } from "../src/media-manager.js";
import { ProjectManager } from "../src/project-manager.js";
import { startWebServer, type WebCodexClient } from "../src/web-server.js";
import { GatewayAuth } from "../src/gateway-auth.js";

const cwd = process.cwd();

test("loopback web gateway serves the PWA, validates origins, and controls a turn", async (t) => {
  const fake = new FakeWebClient();
  const paths = await PathPolicy.fromEnvironment(cwd);
  const mediaDir = await mkdtemp(join(tmpdir(), "codex-pocket-media-test-"));
  const projectHome = await mkdtemp(join(tmpdir(), "codex-pocket-projects-test-"));
  const authHome = await mkdtemp(join(tmpdir(), "codex-pocket-auth-test-"));
  t.after(() => rm(mediaDir, { recursive: true, force: true }));
  t.after(() => rm(projectHome, { recursive: true, force: true }));
  t.after(() => rm(authHome, { recursive: true, force: true }));
  const projects = await ProjectManager.fromEnvironment(paths, projectHome);
  const auth = await GatewayAuth.create({
    stateFile: join(authHome, "auth.json"),
    pairingCode: "12345678",
    deviceKind: "linux",
    deviceName: "Test PC",
  });
  const running = await startWebServer({
    client: fake,
    paths,
    staticDir: resolve(cwd, "client/dist"),
    media: new MediaManager({ rootDir: mediaDir }),
    projects,
    auth,
    port: 0,
  });
  t.after(() => running.close());
  const base = `http://127.0.0.1:${running.port}`;

  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Codex Pocket/);
  assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'self'/);
  assert.match(page.headers.get("permissions-policy") ?? "", /microphone=\(self\)/);

  const unauthenticated = await fetch(`${base}/api/health`);
  assert.equal(unauthenticated.status, 401);
  const missingOrigin = await fetch(`${base}/api/pairing/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: "12345678" }),
  });
  assert.equal(missingOrigin.status, 403);
  const paired = await jsonFetch(`${base}/api/pairing/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost" },
    body: JSON.stringify({ code: "12345678", label: "Test app" }),
  });
  const authorization = `Bearer ${paired.token}`;
  const authorized = (headers: Record<string, string> = {}) => ({ Authorization: authorization, ...headers });

  const health = await jsonFetch(`${base}/api/health`, { headers: authorized() });
  assert.equal(health.ok, true);
  assert.deepEqual(health.allowedWorkspaceRoots, [cwd]);

  const models = await jsonFetch(`${base}/api/models`, { headers: authorized() });
  assert.equal(models.models[0].id, "test-codex");
  assert.equal(models.models[0].defaultEffort, "medium");
  const providerData = await jsonFetch(`${base}/api/providers`, { headers: authorized() });
  assert.equal(providerData.providers[0].id, "codex");
  assert.equal(providerData.providers[0].status, "connected");
  assert.equal(providerData.providers[0].installed, true);
  assert.equal(providerData.providers[0].canLogin, true);
  const providerTest = await jsonFetch(`${base}/api/providers/codex/test`, {
    method: "POST",
    headers: authorized({ "Content-Type": "application/json", Origin: "http://localhost" }),
    body: "{}",
  });
  assert.equal(providerTest.test.ok, true);
  assert.equal(providerTest.test.modelCount, 1);
  assert.match(providerTest.test.detail, /AI 요청은 보내지 않았습니다/);
  const unsupportedProvider = await fetch(`${base}/api/models?provider=claude`, { headers: authorized() });
  assert.equal(unsupportedProvider.status, 409);

  const workspaceData = await jsonFetch(`${base}/api/workspaces`, { headers: authorized() });
  assert.equal(workspaceData.creationLocations[0].path, projectHome);
  const created = await jsonFetch(`${base}/api/projects`, {
    method: "POST",
    headers: authorized({ "Content-Type": "application/json", Origin: "http://localhost" }),
    body: JSON.stringify({ name: "new-mobile-project", parent: projectHome }),
  });
  assert.equal(created.project.name, "new-mobile-project");
  assert.equal(paths.isAllowed(created.project.path), true);

  const listed = await jsonFetch(`${base}/api/threads`, { headers: authorized() });
  assert.equal(listed.threads[0].id, "thread-web");
  const read = await jsonFetch(`${base}/api/threads/thread-web`, { headers: authorized() });
  assert.equal(read.thread.turns[0].items[0].text, "hello");

  const blocked = await fetch(`${base}/api/runs`, {
    method: "POST",
    headers: authorized({ "Content-Type": "application/json", Origin: "https://evil.example" }),
    body: JSON.stringify({ prompt: "test", cwd }),
  });
  assert.equal(blocked.status, 403);

  const nativePreflight = await fetch(`${base}/api/runs`, {
    method: "OPTIONS",
    headers: { Origin: "http://localhost", "Access-Control-Request-Method": "POST" },
  });
  assert.equal(nativePreflight.status, 204);
  assert.equal(nativePreflight.headers.get("access-control-allow-origin"), "http://localhost");

  const streamAbort = new AbortController();
  const stream = await fetch(`${base}/api/events`, { signal: streamAbort.signal, headers: authorized() });
  assert.equal(stream.status, 200);
  const reader = stream.body!.getReader();
  const initial = await reader.read();
  assert.match(new TextDecoder().decode(initial.value), /connected/);
  streamAbort.abort();

  const uploadedResponse = await fetch(`${base}/api/media?name=screen.png`, {
    method: "POST",
    headers: authorized({ "Content-Type": "image/png", Origin: "http://localhost" }),
    body: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
  });
  assert.equal(uploadedResponse.status, 201);
  const uploaded = await uploadedResponse.json() as any;
  assert.equal(uploaded.media.kind, "image");
  const reloadedMedia = new MediaManager({ rootDir: mediaDir });
  await reloadedMedia.initialize();
  assert.equal(reloadedMedia.get(uploaded.media.id).name, "screen.png");

  const started = await jsonFetch(`${base}/api/runs`, {
    method: "POST",
    headers: authorized({ "Content-Type": "application/json", Origin: "http://localhost" }),
    body: JSON.stringify({
      prompt: "change a file",
      cwd,
      provider: "codex",
      accountId: "cli-default",
      model: "test-codex",
      effort: "high",
      attachments: [uploaded.media.id],
    }),
  });
  assert.equal(started.operation.status, "running");
  assert.equal(fake.lastRun?.cwd, cwd);
  assert.equal(fake.lastRun?.networkAccess, false);
  assert.equal(fake.lastRun?.model, "test-codex");
  assert.equal(fake.lastRun?.effort, "high");
  assert.equal(fake.lastRun?.imagePaths?.length, 1);

  const nativeHealth = await fetch(`${base}/api/health`, { headers: authorized({ Origin: "http://localhost" }) });
  assert.equal(nativeHealth.status, 200);
  assert.equal(nativeHealth.headers.get("access-control-allow-origin"), "http://localhost");

  const operationId = started.operation.id;
  const activeRuns = await jsonFetch(`${base}/api/runs?status=running`, { headers: authorized() });
  assert.equal(activeRuns.operations.length, 1);
  assert.equal(activeRuns.operations[0].id, operationId);
  const released = await jsonFetch(`${base}/api/session/handoff`, {
    method: "POST",
    headers: authorized({ "Content-Type": "application/json", Origin: "http://localhost" }),
    body: JSON.stringify({ workspace: cwd, threadId: "thread-web", operationId }),
  });
  assert.equal(released.handoff.threadId, "thread-web");
  assert.equal(released.handoff.operationId, operationId);
  assert.equal(released.operation.status, "running");
  assert.equal(released.threadUnsubscribeStatus, null);
  assert.equal(fake.interrupted, undefined);
  const availableHandoff = await jsonFetch(`${base}/api/session/handoff`, { headers: authorized() });
  assert.equal(availableHandoff.handoff.id, released.handoff.id);
  assert.equal(availableHandoff.operation.id, operationId);
  const unrelatedHandoff = await jsonFetch(
    `${base}/api/session/handoff?workspace=${encodeURIComponent(created.project.path)}`,
    { headers: authorized() },
  );
  assert.equal(unrelatedHandoff.handoff, null);
  const interrupted = await jsonFetch(`${base}/api/runs/${operationId}/interrupt`, {
    method: "POST",
    headers: authorized({ "Content-Type": "application/json", Origin: base }),
    body: "{}",
  });
  assert.equal(interrupted.interruptRequested, true);
  assert.deepEqual(fake.interrupted, ["thread-web", "turn-web"]);

  fake.finish("interrupted");
  await waitFor(async () => {
    const operation = await jsonFetch(`${base}/api/runs/${operationId}`, { headers: authorized() });
    return operation.operation.status === "interrupted";
  });
  await waitFor(async () => fake.unsubscribed.length === 1);
  assert.deepEqual(fake.unsubscribed, ["thread-web"]);
  const claimed = await jsonFetch(`${base}/api/session/handoffs/${released.handoff.id}/claim`, {
    method: "POST",
    headers: authorized({ "Content-Type": "application/json", Origin: base }),
    body: "{}",
  });
  assert.equal(claimed.claimed.id, released.handoff.id);
  const clearedHandoff = await jsonFetch(
    `${base}/api/session/handoff?workspace=${encodeURIComponent(cwd)}`,
    { headers: authorized() },
  );
  assert.equal(clearedHandoff.handoff, null);

  const idleRelease = await jsonFetch(`${base}/api/session/handoff`, {
    method: "POST",
    headers: authorized({ "Content-Type": "application/json", Origin: "http://localhost" }),
    body: JSON.stringify({ workspace: cwd, threadId: "thread-web" }),
  });
  assert.equal(idleRelease.threadUnsubscribeStatus, "unsubscribed");
  assert.deepEqual(fake.unsubscribed, ["thread-web", "thread-web"]);
});

class FakeWebClient implements WebCodexClient {
  lastRun?: RunTurnOptions;
  interrupted?: [string, string];
  unsubscribed: string[] = [];
  private listeners = new Set<(notification: AppServerNotification) => void>();
  private resolveTurn?: (turn: Turn) => void;

  async start() {
    return { userAgent: "fake-codex", codexHome: cwd, platformFamily: "unix", platformOs: "linux" };
  }

  async listThreads() {
    return { data: [thread()], nextCursor: null, backwardsCursor: null };
  }

  async listModels(): Promise<ModelListResponse> {
    return {
      data: [{
        id: "test-codex",
        model: "test-codex",
        upgrade: null,
        upgradeInfo: null,
        availabilityNux: null,
        displayName: "Test Codex",
        description: "Model used by the gateway test",
        modelSpecialty: null,
        hidden: false,
        supportedReasoningEfforts: [
          { reasoningEffort: "low", description: "Fast" },
          { reasoningEffort: "medium", description: "Balanced" },
          { reasoningEffort: "high", description: "Deep" },
        ],
        defaultReasoningEffort: "medium",
        inputModalities: ["text"],
        supportsPersonality: false,
        multiAgentVersion: null,
        additionalSpeedTiers: [],
        serviceTiers: [],
        defaultServiceTier: null,
        isDefault: true,
      }],
      nextCursor: null,
    };
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

  async unsubscribeThread(threadId: string) {
    this.unsubscribed.push(threadId);
    return { status: "unsubscribed" as const };
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
    projectId: null,
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
      ? [{ ...turn("completed"), items: [{ type: "agentMessage", id: "message-web", text: "hello", phase: "final_answer", memoryCitation: null, delivery: null }] }]
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
