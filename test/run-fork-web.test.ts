import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import type { ModelListResponse } from "../generated/app-server/v2/ModelListResponse.js";
import type { AppServerNotification, RunTurnOptions } from "../src/app-server-client.js";
import { GatewayAuth } from "../src/gateway-auth.js";
import { PathPolicy } from "../src/path-policy.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import type {
  ModelProviderAdapter,
  ProviderConnectionTest,
  ProviderDescriptor,
  ProviderLoginSpec,
  ProviderModel,
  ProviderRun,
  ProviderRunInput,
  ProviderRuntime,
} from "../src/providers/types.js";
import { startWebServer, type WebCodexClient } from "../src/web-server.js";

const cwd = process.cwd();

test("Provider fork preview and confirmation bind reviewed context to one new run", async (t) => {
  const authHome = await mkdtemp(join(tmpdir(), "codex-pocket-fork-web-"));
  t.after(() => rm(authHome, { recursive: true, force: true }));
  const auth = await GatewayAuth.create({
    stateFile: join(authHome, "auth.json"),
    pairingCode: "87654321",
    deviceKind: "linux",
    deviceName: "Fork test PC",
  });
  const sourceRuntime = new RecordingRuntime("source", "source answer");
  const targetRuntime = new RecordingRuntime("target", "target answer");
  const codex = new NoopWebClient();
  const providers = new ProviderRegistry(codex, [
    new RecordingAdapter("source", sourceRuntime),
    new RecordingAdapter("target", targetRuntime),
  ]);
  const running = await startWebServer({
    client: codex,
    paths: await PathPolicy.fromEnvironment(cwd),
    staticDir: resolve(cwd, "client/dist"),
    auth,
    providers,
    port: 0,
  });
  t.after(() => running.close());
  const base = `http://127.0.0.1:${running.port}`;
  const paired = await requestJson(`${base}/api/pairing/claim`, {
    method: "POST",
    headers: { Origin: "http://localhost", "Content-Type": "application/json" },
    body: JSON.stringify({ code: "87654321", label: "Fork client" }),
  });
  assert.equal(paired.status, 201);
  const authorized = {
    Authorization: `Bearer ${paired.body.token}`,
    Origin: "http://localhost",
    "Content-Type": "application/json",
  };

  const sourceStart = await requestJson(`${base}/api/runs`, {
    method: "POST",
    headers: authorized,
    body: JSON.stringify({
      requestId: "source-request",
      provider: "source",
      prompt: "source user request",
      cwd,
      networkAccess: false,
    }),
  });
  assert.equal(sourceStart.status, 202);
  const sourceId = sourceStart.body.operation.id as string;
  await waitFor(async () => {
    const response = await requestJson(`${base}/api/runs/${encodeURIComponent(sourceId)}`, {
      headers: { Authorization: authorized.Authorization },
    });
    return response.body.operation.status === "completed";
  });

  const previewResponse = await requestJson(`${base}/api/run-forks/preview`, {
    method: "POST",
    headers: authorized,
    body: JSON.stringify({
      sourceOperationId: sourceId,
      targetProvider: "target",
      prompt: "new target request",
      networkAccess: false,
      attachments: [],
    }),
  });
  assert.equal(previewResponse.status, 201);
  const preview = previewResponse.body.preview;
  assert.equal(preview.source.operationId, sourceId);
  assert.equal(preview.source.providerId, "source");
  assert.equal(preview.target.providerId, "target");
  assert.equal(preview.policy.providerId, "target");
  assert.equal(preview.context.items[0].text, "source user request");
  assert.equal(preview.context.items[1].text, "source answer");
  assert.equal("confirmationToken" in preview, false);

  const forkBody = {
    requestId: "fork-request",
    forkPreviewId: preview.id,
    provider: "target",
    prompt: "new target request",
    cwd,
    networkAccess: false,
    attachments: [],
  };
  const forkResponse = await requestJson(`${base}/api/runs`, {
    method: "POST",
    headers: authorized,
    body: JSON.stringify(forkBody),
  });
  assert.equal(forkResponse.status, 202);
  assert.equal(forkResponse.body.operation.providerId, "target");
  assert.equal(forkResponse.body.operation.fork.sourceOperationId, sourceId);
  assert.equal(forkResponse.body.operation.fork.targetProviderId, "target");
  assert.equal("contextDigest" in forkResponse.body.operation.fork, false);
  assert.equal(targetRuntime.starts.length, 1);
  assert.equal(targetRuntime.starts[0]?.conversationId, undefined);
  assert.match(targetRuntime.starts[0]?.prompt ?? "", /source user request/);
  assert.match(targetRuntime.starts[0]?.prompt ?? "", /source answer/);
  assert.match(targetRuntime.starts[0]?.prompt ?? "", /new target request/);
  assert.match(targetRuntime.starts[0]?.prompt ?? "", /이전 Provider의 도구 상태나 권한을 이어받지 마세요/);

  const retried = await requestJson(`${base}/api/runs`, {
    method: "POST",
    headers: authorized,
    body: JSON.stringify(forkBody),
  });
  assert.equal(retried.status, 202);
  assert.equal(retried.body.operation.id, forkResponse.body.operation.id);
  assert.equal(targetRuntime.starts.length, 1);

  const reusedByAnotherRequest = await requestJson(`${base}/api/runs`, {
    method: "POST",
    headers: authorized,
    body: JSON.stringify({ ...forkBody, requestId: "different-request" }),
  });
  assert.equal(reusedByAnotherRequest.status, 409);
  assert.match(reusedByAnotherRequest.body.error, /처음 확인한 요청/);

  const secondPairing = await requestJson(`${base}/api/pairing/claim`, {
    method: "POST",
    headers: { Origin: "http://localhost", "Content-Type": "application/json" },
    body: JSON.stringify({ code: "87654321", label: "Other fork client" }),
  });
  assert.equal(secondPairing.status, 201);
  const crossClient = await requestJson(`${base}/api/runs`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secondPairing.body.token}`,
      Origin: "http://localhost",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ...forkBody, requestId: "cross-client" }),
  });
  assert.equal(crossClient.status, 403);
});

class RecordingRuntime implements ProviderRuntime {
  readonly starts: ProviderRunInput[] = [];

  constructor(
    private readonly providerId: string,
    private readonly finalResponse: string,
  ) {}

  async startRun(input: ProviderRunInput): Promise<ProviderRun> {
    this.starts.push(structuredClone(input));
    const sequence = this.starts.length;
    return {
      providerId: this.providerId,
      conversationId: `conversation-${this.providerId}-${sequence}`,
      runId: `run-${this.providerId}-${sequence}`,
      cwd: input.cwd,
      completion: Promise.resolve({
        status: "completed",
        result: { finalResponse: this.finalResponse },
      }),
    };
  }

  async cancelRun(): Promise<void> {}

  subscribe(): () => void {
    return () => undefined;
  }
}

class RecordingAdapter implements ModelProviderAdapter {
  readonly canRun = true;

  constructor(
    readonly id: string,
    readonly runtime: RecordingRuntime,
  ) {}

  async describe(): Promise<ProviderDescriptor> {
    return {
      id: this.id,
      name: this.id,
      available: true,
      status: "connected",
      detail: "test provider",
      accounts: [],
      loginCommand: "",
      installed: true,
      canLogin: false,
      canTest: true,
      capabilities: {
        run: true,
        resume: false,
        models: false,
        attachments: false,
        streaming: false,
        toolCalling: false,
        approvals: false,
        workspaceRead: false,
        workspaceWrite: false,
        commandExecution: false,
        usageAccounting: false,
        steering: false,
      },
      installGuide: { summary: "test", command: "", docsUrl: "https://example.test" },
    };
  }

  async listModels(): Promise<ProviderModel[]> {
    return [];
  }

  assertAccount(accountId: unknown): void {
    if (accountId !== undefined) throw new Error("test provider does not use accounts");
  }

  async testConnection(): Promise<ProviderConnectionTest> {
    return { ok: true, detail: "connected", checkedAt: new Date().toISOString() };
  }

  async loginSpec(): Promise<ProviderLoginSpec> {
    return { command: "", args: [] };
  }
}

class NoopWebClient implements WebCodexClient {
  async start() {
    return { userAgent: "fork-test", codexHome: cwd, platformFamily: "unix", platformOs: "linux" };
  }

  async listThreads() {
    return { data: [], nextCursor: null, backwardsCursor: null };
  }

  async listModels(): Promise<ModelListResponse> {
    return { data: [], nextCursor: null };
  }

  async readThread(): Promise<never> {
    throw new Error("Codex thread access is outside this test");
  }

  async beginTurn(_options: RunTurnOptions): Promise<never> {
    throw new Error("Codex turn access is outside this test");
  }

  async interrupt(): Promise<void> {}

  async steerTurn(): Promise<void> {}

  async unsubscribeThread() {
    return { status: "notLoaded" as const };
  }

  subscribe(_listener: (notification: AppServerNotification) => void) {
    return () => undefined;
  }
}

async function requestJson(url: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const response = await fetch(url, init);
  return { status: response.status, body: await response.json() };
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error("Condition was not met in time");
}
