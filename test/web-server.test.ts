import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import type { TLSSocket } from "node:tls";
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
import { EventJournal } from "../src/event-journal.js";
import { InMemoryApprovalBroker } from "../src/approval-broker.js";
import { loadPocketLinkTlsConfig, publicKeyPin } from "../src/pocket-link.js";
import { createTestCertificate } from "./helpers/tls-certificate.js";

const cwd = process.cwd();

test("loopback web gateway serves the PWA, validates origins, and controls a turn", async (t) => {
  const fake = new FakeWebClient();
  const paths = await PathPolicy.fromEnvironment(cwd);
  const mediaDir = await mkdtemp(join(tmpdir(), "codex-pocket-media-test-"));
  const projectHome = await mkdtemp(join(tmpdir(), "codex-pocket-projects-test-"));
  const authHome = await mkdtemp(join(tmpdir(), "codex-pocket-auth-test-"));
  const tlsHome = await mkdtemp(join(tmpdir(), "codex-pocket-tls-test-"));
  const workspaceTransactionDirectory = join(authHome, "workspace-transactions");
  const unsafeManifest = join(workspaceTransactionDirectory, "00000000-0000-4000-8000-000000000001.json");
  t.after(() => rm(mediaDir, { recursive: true, force: true }));
  t.after(() => rm(projectHome, { recursive: true, force: true }));
  t.after(() => rm(authHome, { recursive: true, force: true }));
  t.after(() => rm(tlsHome, { recursive: true, force: true }));
  await mkdir(workspaceTransactionDirectory, { mode: 0o700 });
  await writeFile(unsafeManifest, "not-json", { mode: 0o600, flag: "wx" });
  const tlsFiles = await createTestCertificate(tlsHome, "127.0.0.1");
  const clientFiles = await createTestCertificate(tlsHome, "pocket-client.test", "client");
  const otherClientFiles = await createTestCertificate(tlsHome, "other-client.test", "other-client");
  const clientIdentity = {
    certificate: await readFile(clientFiles.certificateFile),
    privateKey: await readFile(clientFiles.privateKeyFile),
  };
  const otherClientIdentity = {
    certificate: await readFile(otherClientFiles.certificateFile),
    privateKey: await readFile(otherClientFiles.privateKeyFile),
  };
  const pocketLink = await loadPocketLinkTlsConfig({
    CODEX_POCKET_LINK_HOST: "127.0.0.1",
    CODEX_POCKET_LINK_PORT: "8789",
    CODEX_POCKET_LINK_ADVERTISE_HOST: "127.0.0.1",
    CODEX_POCKET_LINK_CERT_FILE: tlsFiles.certificateFile,
    CODEX_POCKET_LINK_KEY_FILE: tlsFiles.privateKeyFile,
  });
  assert.ok(pocketLink);
  const projects = await ProjectManager.fromEnvironment(paths, projectHome);
  const auth = await GatewayAuth.create({
    stateFile: join(authHome, "auth.json"),
    pairingCode: "12345678",
    deviceKind: "linux",
    deviceName: "Test PC",
  });
  let nextApprovalId = 0;
  const approvals = new InMemoryApprovalBroker({
    createId: () => nextApprovalId++ === 0 ? "approval-web" : `approval-web-${nextApprovalId}`,
  });
  const running = await startWebServer({
    client: fake,
    paths,
    staticDir: resolve(cwd, "client/dist"),
    media: new MediaManager({ rootDir: mediaDir }),
    projects,
    auth,
    approvals,
    pocketLink: { ...pocketLink, port: 0 },
    workspaceTransactionDirectory,
    port: 0,
  });
  t.after(() => running.close());
  const base = `http://127.0.0.1:${running.port}`;
  assert.equal(running.pocketLink?.publicKeyPin, pocketLink.publicKeyPin);
  const missingDeviceProof = await secureJson(running.pocketLink!.port, `127.0.0.1:${running.port}`);
  assert.equal(missingDeviceProof.status, 401);
  assert.equal(missingDeviceProof.body.code, "TLS_DEVICE_PROOF_REQUIRED");
  const secureStatus = await secureJson(
    running.pocketLink!.port,
    `127.0.0.1:${running.port}`,
    clientIdentity,
  );
  assert.equal(secureStatus.status, 200);
  assert.equal(secureStatus.body.appVersion, "2.0.0");
  assert.equal(secureStatus.peerPin, running.pocketLink?.publicKeyPin);
  const blockedDirectHost = await secureJson(running.pocketLink!.port, "example.test", clientIdentity);
  assert.equal(blockedDirectHost.status, 400);
  const tlsPaired = await secureJson(
    running.pocketLink!.port,
    `127.0.0.1:${running.port}`,
    clientIdentity,
    {
      path: "/api/pairing/claim",
      method: "POST",
      headers: { Origin: "http://localhost", "Content-Type": "application/json" },
      body: JSON.stringify({ code: "12345678", label: "Pocket test app" }),
    },
  );
  assert.equal(tlsPaired.status, 201);
  assert.equal(tlsPaired.body.client.tlsBound, true);
  const tlsHealth = await secureJson(
    running.pocketLink!.port,
    `127.0.0.1:${running.port}`,
    clientIdentity,
    { path: "/api/health", headers: { Authorization: `Bearer ${tlsPaired.body.token}` } },
  );
  assert.equal(tlsHealth.status, 200);
  assert.equal(tlsHealth.body.client.tlsBound, true);
  const wrongTlsIdentity = await secureJson(
    running.pocketLink!.port,
    `127.0.0.1:${running.port}`,
    otherClientIdentity,
    { path: "/api/health", headers: { Authorization: `Bearer ${tlsPaired.body.token}` } },
  );
  assert.equal(wrongTlsIdentity.status, 401);
  assert.equal(wrongTlsIdentity.body.code, "TLS_DEVICE_MISMATCH");
  const nonTlsRotationStart = await fetch(`${base}/api/pairing/tls-key-rotation/start`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tlsPaired.body.token}`,
      Origin: "http://localhost",
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  assert.equal(nonTlsRotationStart.status, 401);
  assert.equal(((await nonTlsRotationStart.json()) as { code?: string }).code, "TLS_DEVICE_PROOF_REQUIRED");
  const rotationStart = await secureJson(
    running.pocketLink!.port,
    `127.0.0.1:${running.port}`,
    clientIdentity,
    {
      path: "/api/pairing/tls-key-rotation/start",
      method: "POST",
      headers: {
        Authorization: `Bearer ${tlsPaired.body.token}`,
        Origin: "http://localhost",
        "Content-Type": "application/json",
      },
      body: "{}",
    },
  );
  assert.equal(rotationStart.status, 201);
  assert.match(rotationStart.body.rotationToken, /^[A-Za-z0-9_-]{43}$/);
  const rotationPending = await secureJson(
    running.pocketLink!.port,
    `127.0.0.1:${running.port}`,
    otherClientIdentity,
    {
      path: "/api/pairing/tls-key-rotation/status",
      method: "POST",
      headers: {
        Authorization: `Bearer ${tlsPaired.body.token}`,
        Origin: "http://localhost",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ rotationToken: rotationStart.body.rotationToken }),
    },
  );
  assert.equal(rotationPending.status, 200);
  assert.equal(rotationPending.body.status, "pending");
  const rotationCompleted = await secureJson(
    running.pocketLink!.port,
    `127.0.0.1:${running.port}`,
    otherClientIdentity,
    {
      path: "/api/pairing/tls-key-rotation/complete",
      method: "POST",
      headers: {
        Authorization: `Bearer ${tlsPaired.body.token}`,
        Origin: "http://localhost",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ rotationToken: rotationStart.body.rotationToken }),
    },
  );
  assert.equal(rotationCompleted.status, 200);
  assert.equal(rotationCompleted.body.previousKeyRetired, true);
  const retiredTlsIdentity = await secureJson(
    running.pocketLink!.port,
    `127.0.0.1:${running.port}`,
    clientIdentity,
    { path: "/api/health", headers: { Authorization: `Bearer ${tlsPaired.body.token}` } },
  );
  assert.equal(retiredTlsIdentity.status, 401);
  assert.equal(retiredTlsIdentity.body.code, "TLS_DEVICE_MISMATCH");
  const rotatedTlsHealth = await secureJson(
    running.pocketLink!.port,
    `127.0.0.1:${running.port}`,
    otherClientIdentity,
    { path: "/api/health", headers: { Authorization: `Bearer ${tlsPaired.body.token}` } },
  );
  assert.equal(rotatedTlsHealth.status, 200);
  const rotationFinalized = await secureJson(
    running.pocketLink!.port,
    `127.0.0.1:${running.port}`,
    otherClientIdentity,
    {
      path: "/api/pairing/tls-key-rotation/finalize",
      method: "POST",
      headers: {
        Authorization: `Bearer ${tlsPaired.body.token}`,
        Origin: "http://localhost",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ rotationToken: rotationStart.body.rotationToken }),
    },
  );
  assert.equal(rotationFinalized.status, 200);
  assert.equal(rotationFinalized.body.finalized, true);

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

  const startupRecovery = await jsonFetch(`${base}/api/workspace-changes/recovery`, { headers: authorized() });
  assert.equal(startupRecovery.supported, true);
  assert.equal(startupRecovery.status.blocked, true);
  assert.equal(startupRecovery.status.pendingCountKnown, false);
  const crossOriginRecovery = await fetch(`${base}/api/workspace-changes/recovery/retry`, {
    method: "POST",
    headers: authorized({ "Content-Type": "application/json", Origin: "https://evil.example" }),
    body: JSON.stringify({ confirm: "retry-safe-workspace-recovery" }),
  });
  assert.equal(crossOriginRecovery.status, 403);
  const missingRecoveryConfirmation = await fetch(`${base}/api/workspace-changes/recovery/retry`, {
    method: "POST",
    headers: authorized({ "Content-Type": "application/json", Origin: base }),
    body: "{}",
  });
  assert.equal(missingRecoveryConfirmation.status, 400);
  const expandedRecoveryRequest = await fetch(`${base}/api/workspace-changes/recovery/retry`, {
    method: "POST",
    headers: authorized({ "Content-Type": "application/json", Origin: base }),
    body: JSON.stringify({ confirm: "retry-safe-workspace-recovery", discardJournal: true }),
  });
  assert.equal(expandedRecoveryRequest.status, 400);
  const blockedRecovery = await jsonFetch(`${base}/api/workspace-changes/recovery/retry`, {
    method: "POST",
    headers: authorized({ "Content-Type": "application/json", Origin: base }),
    body: JSON.stringify({ confirm: "retry-safe-workspace-recovery" }),
  });
  assert.equal(blockedRecovery.status.blocked, true);
  assert.equal(blockedRecovery.status.pendingCountKnown, false);
  assert.doesNotMatch(blockedRecovery.status.error, new RegExp(authHome.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  await unlink(unsafeManifest);
  const recovered = await jsonFetch(`${base}/api/workspace-changes/recovery/retry`, {
    method: "POST",
    headers: authorized({ "Content-Type": "application/json", Origin: base }),
    body: JSON.stringify({ confirm: "retry-safe-workspace-recovery" }),
  });
  assert.equal(recovered.status.blocked, false);
  assert.deepEqual(recovered.status.pendingTransactions, []);

  const models = await jsonFetch(`${base}/api/models`, { headers: authorized() });
  assert.equal(models.models[0].id, "test-codex");
  assert.equal(models.models[0].defaultEffort, "medium");
  const providerData = await jsonFetch(`${base}/api/providers`, { headers: authorized() });
  assert.equal(providerData.providers[0].id, "codex");
  assert.equal(providerData.providers[0].status, "connected");
  assert.equal(providerData.providers[0].installed, true);
  assert.equal(providerData.providers[0].canLogin, true);
  assert.equal(providerData.providers[0].capabilities.streaming, true);
  assert.equal(providerData.providers[0].capabilities.approvals, false);
  const openAIProvider = providerData.providers.find((item: any) => item.id === "openai");
  const openRouterProvider = providerData.providers.find((item: any) => item.id === "openrouter");
  assert.equal(openAIProvider.capabilities.approvals, true);
  assert.equal(openAIProvider.capabilities.workspaceWrite, true);
  assert.equal(typeof openAIProvider.capabilities.commandExecution, "boolean");
  assert.equal(openRouterProvider.capabilities.approvals, true);
  assert.equal(openRouterProvider.capabilities.workspaceWrite, true);
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
  assert.equal(workspaceData.workspaces[0].identity.kind, "git");
  assert.equal(
    typeof workspaceData.workspaces[0].identity.branch === "string"
      || (workspaceData.workspaces[0].identity.detached === true
        && typeof workspaceData.workspaces[0].identity.head === "string"),
    true,
  );
  const created = await jsonFetch(`${base}/api/projects`, {
    method: "POST",
    headers: authorized({ "Content-Type": "application/json", Origin: "http://localhost" }),
    body: JSON.stringify({ name: "new-mobile-project", parent: projectHome }),
  });
  assert.equal(created.project.name, "new-mobile-project");
  assert.equal(paths.isAllowed(created.project.path), true);
  assert.equal(created.project.identity.kind, "git");
  assert.equal(created.project.identity.branch, "main");

  const listed = await jsonFetch(`${base}/api/threads`, { headers: authorized() });
  assert.equal(listed.threads[0].id, "thread-web");
  const read = await jsonFetch(`${base}/api/threads/thread-web`, { headers: authorized() });
  assert.equal(read.thread.turns[0].items[0].text, "hello");

  const crossProjectRun = await fetch(`${base}/api/runs`, {
    method: "POST",
    headers: authorized({ "Content-Type": "application/json", Origin: "http://localhost" }),
    body: JSON.stringify({ prompt: "wrong project", cwd: created.project.path, threadId: "thread-web" }),
  });
  assert.equal(crossProjectRun.status, 409);
  assert.match((await crossProjectRun.json() as any).error, /selected workspace/);

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
  assert.match(nativePreflight.headers.get("access-control-allow-headers") ?? "", /Last-Event-ID/);
  assert.match(nativePreflight.headers.get("access-control-allow-methods") ?? "", /PATCH/);
  assert.match(nativePreflight.headers.get("access-control-allow-methods") ?? "", /PUT/);

  const streamAbort = new AbortController();
  const stream = await fetch(`${base}/api/events`, { signal: streamAbort.signal, headers: authorized() });
  assert.equal(stream.status, 200);
  const reader = stream.body!.getReader();
  const initial = await reader.read();
  assert.match(new TextDecoder().decode(initial.value), /connected/);
  streamAbort.abort();
  const unauthenticatedNotificationStream = await fetch(`${base}/api/events/notifications`);
  assert.equal(unauthenticatedNotificationStream.status, 401);

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

  const runRequest = {
    requestId: "queued-web-1",
    prompt: "change a file",
    cwd,
    provider: "codex",
    accountId: "cli-default",
    model: "test-codex",
    effort: "high",
    attachments: [uploaded.media.id],
  };
  const started = await jsonFetch(`${base}/api/runs`, {
    method: "POST",
    headers: authorized({ "Content-Type": "application/json", Origin: "http://localhost" }),
    body: JSON.stringify(runRequest),
  });
  assert.equal(started.operation.status, "running");
  assert.equal(started.operation.providerId, "codex");
  assert.equal(started.operation.workspaceIdentity.kind, "git");
  assert.equal(
    typeof started.operation.workspaceIdentity.branch === "string"
      || (started.operation.workspaceIdentity.detached === true
        && typeof started.operation.workspaceIdentity.head === "string"),
    true,
  );
  assert.equal(fake.lastRun?.cwd, cwd);
  assert.equal(fake.lastRun?.networkAccess, false);
  assert.equal(fake.lastRun?.model, "test-codex");
  assert.equal(fake.lastRun?.effort, "high");
  assert.equal(fake.lastRun?.imagePaths?.length, 1);
  const retried = await jsonFetch(`${base}/api/runs`, {
    method: "POST",
    headers: authorized({ "Content-Type": "application/json", Origin: "http://localhost" }),
    body: JSON.stringify(runRequest),
  });
  assert.equal(retried.operation.id, started.operation.id);
  assert.equal(fake.runsStarted, 1);

  const approvalHandle = approvals.requestApproval({
    providerId: "codex",
    conversationId: "thread-web",
    runId: "turn-web",
    toolCallId: "tool-call-web",
    risk: "high_risk",
    redactedSummary: "검증된 명령 한 건 실행",
    redactedDetails: { command: "npm test", paths: ["package.json"] },
  });
  const approvalList = await jsonFetch(`${base}/api/approvals`, { headers: authorized() });
  assert.equal(approvalList.approvals.length, 1);
  assert.equal(approvalList.approvals[0].operationId, started.operation.id);
  assert.equal(approvalList.approvals[0].requiresTouch, true);
  const crossOriginApproval = await fetch(`${base}/api/approvals/approval-web/decision`, {
    method: "POST",
    headers: authorized({ "Content-Type": "application/json", Origin: "https://evil.example" }),
    body: JSON.stringify({ decision: "approved" }),
  });
  assert.equal(crossOriginApproval.status, 403);
  const approvalDecision = await jsonFetch(`${base}/api/approvals/approval-web/decision`, {
    method: "POST",
    headers: authorized({ "Content-Type": "application/json", Origin: base }),
    body: JSON.stringify({ decision: "approved" }),
  });
  assert.equal(approvalDecision.resolution.source, "touch");
  assert.equal((await approvalHandle.decision).decision, "approved");
  assert.deepEqual((await jsonFetch(`${base}/api/approvals`, { headers: authorized() })).approvals, []);
  const declinedHandle = approvals.requestApproval({
    providerId: "codex",
    conversationId: "thread-web",
    runId: "turn-web",
    toolCallId: "tool-call-declined",
    risk: "change",
    redactedSummary: "한 파일 변경",
    redactedDetails: { paths: ["package.json"] },
  });
  const declinedDecision = await jsonFetch(`${base}/api/approvals/approval-web-2/decision`, {
    method: "POST",
    headers: authorized({ "Content-Type": "application/json", Origin: base }),
    body: JSON.stringify({ decision: "declined", source: "voice" }),
  });
  assert.equal(declinedDecision.resolution.decision, "declined");
  assert.equal(declinedDecision.resolution.source, "touch");
  assert.equal((await declinedHandle.decision).decision, "declined");
  const conflictingRetry = await fetch(`${base}/api/runs`, {
    method: "POST",
    headers: authorized({ "Content-Type": "application/json", Origin: "http://localhost" }),
    body: JSON.stringify({ ...runRequest, prompt: "different request" }),
  });
  assert.equal(conflictingRetry.status, 409);
  assert.equal(fake.runsStarted, 1);

  const nativeHealth = await fetch(`${base}/api/health`, { headers: authorized({ Origin: "http://localhost" }) });
  assert.equal(nativeHealth.status, 200);
  assert.equal(nativeHealth.headers.get("access-control-allow-origin"), "http://localhost");

  const operationId = started.operation.id;
  const crossOriginMetadata = await fetch(`${base}/api/runs/${operationId}/metadata`, {
    method: "PATCH",
    headers: authorized({ "Content-Type": "application/json", Origin: "https://evil.example" }),
    body: JSON.stringify({ pinned: true }),
  });
  assert.equal(crossOriginMetadata.status, 403);
  const organized = await jsonFetch(`${base}/api/runs/${operationId}/metadata`, {
    method: "PATCH",
    headers: authorized({ "Content-Type": "application/json", Origin: base }),
    body: JSON.stringify({ goalName: "Mobile release audit", pinned: true }),
  });
  assert.equal(organized.operation.goalName, "Mobile release audit");
  assert.equal(typeof organized.operation.pinnedAt, "string");
  const activeArchive = await fetch(`${base}/api/runs/${operationId}/metadata`, {
    method: "PATCH",
    headers: authorized({ "Content-Type": "application/json", Origin: base }),
    body: JSON.stringify({ archived: true }),
  });
  assert.equal(activeArchive.status, 409);
  const activeRuns = await jsonFetch(`${base}/api/runs?status=running`, { headers: authorized() });
  assert.equal(activeRuns.operations.length, 1);
  assert.equal(activeRuns.operations[0].id, operationId);
  assert.equal(activeRuns.operations[0].accountId, "cli-default");
  assert.equal(activeRuns.operations[0].model, "test-codex");
  assert.equal(activeRuns.operations[0].effort, "high");
  assert.equal(activeRuns.operations[0].networkAccess, false);
  const journalPolicy = await jsonFetch(
    `${base}/api/journal/policy?workspace=${encodeURIComponent(cwd)}`,
    { headers: authorized() },
  );
  assert.equal(journalPolicy.policy.retentionMs, 7 * 24 * 60 * 60_000);
  assert.equal(journalPolicy.limits.retentionMs.minimum, 24 * 60 * 60_000);
  assert.equal(journalPolicy.summary.operationCount, 1);
  const policyStreamAbort = new AbortController();
  const policyStream = await fetch(`${base}/api/events`, {
    headers: authorized(),
    signal: policyStreamAbort.signal,
  });
  const policyReader = policyStream.body!.getReader();
  await readUntil(policyReader, (text) => text.includes('"action":"replay_complete"'));
  const crossOriginPolicy = await fetch(`${base}/api/journal/policy`, {
    method: "PUT",
    headers: authorized({ "Content-Type": "application/json", Origin: "https://evil.example" }),
    body: JSON.stringify({
      retentionMs: 24 * 60 * 60_000,
      maxOperations: 50,
      maxEvents: 200,
      confirm: "apply-retention-policy",
    }),
  });
  assert.equal(crossOriginPolicy.status, 403);
  const missingPolicyConfirmation = await fetch(`${base}/api/journal/policy`, {
    method: "PUT",
    headers: authorized({ "Content-Type": "application/json", Origin: base }),
    body: JSON.stringify({ retentionMs: 24 * 60 * 60_000, maxOperations: 50, maxEvents: 200 }),
  });
  assert.equal(missingPolicyConfirmation.status, 400);
  const updatedPolicy = await jsonFetch(`${base}/api/journal/policy`, {
    method: "PUT",
    headers: authorized({ "Content-Type": "application/json", Origin: base }),
    body: JSON.stringify({
      retentionMs: 24 * 60 * 60_000,
      maxOperations: 50,
      maxEvents: 200,
      confirm: "apply-retention-policy",
    }),
  });
  assert.equal(updatedPolicy.policy.retentionMs, 24 * 60 * 60_000);
  assert.equal(updatedPolicy.policy.maxOperations, 50);
  const policyEvent = await readUntil(policyReader, (text) => text.includes('"action":"policy_updated"'));
  assert.match(policyEvent, /"maxEvents":200/);
  policyStreamAbort.abort();
  const journalExportResponse = await fetch(
    `${base}/api/journal/export?workspace=${encodeURIComponent(cwd)}`,
    { headers: authorized() },
  );
  assert.equal(journalExportResponse.status, 200);
  assert.match(journalExportResponse.headers.get("content-disposition") ?? "", /attachment/);
  assert.equal(journalExportResponse.headers.get("cache-control"), "no-store");
  assert.equal(journalExportResponse.headers.get("x-content-type-options"), "nosniff");
  const journalExport = await journalExportResponse.json() as any;
  assert.equal(journalExport.workspace, cwd);
  assert.equal(journalExport.operations[0].id, operationId);
  assert.equal(journalExport.operations[0].goalName, "Mobile release audit");
  assert.equal(journalExport.operations[0].pinnedAt, organized.operation.pinnedAt);
  const activeDelete = await fetch(`${base}/api/journal/workspace`, {
    method: "DELETE",
    headers: authorized({ "Content-Type": "application/json", Origin: base }),
    body: JSON.stringify({ workspace: cwd, confirm: "delete-companion-history" }),
  });
  assert.equal(activeDelete.status, 409);
  const mismatchedHandoff = await fetch(`${base}/api/session/handoff`, {
    method: "POST",
    headers: authorized({ "Content-Type": "application/json", Origin: "http://localhost" }),
    body: JSON.stringify({ workspace: created.project.path, threadId: "thread-web" }),
  });
  assert.equal(mismatchedHandoff.status, 409);
  assert.match((await mismatchedHandoff.json() as any).error, /selected workspace/);
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

  const liveNotificationAbort = new AbortController();
  const liveNotificationResponse = await fetch(`${base}/api/events/notifications`, {
    headers: authorized(),
    signal: liveNotificationAbort.signal,
  });
  assert.equal(liveNotificationResponse.status, 200);
  const liveNotificationReader = liveNotificationResponse.body!.getReader();
  const liveNotificationInitial = await readUntil(
    liveNotificationReader,
    (text) => text.includes('"action":"replay_complete"'),
  );
  assert.doesNotMatch(liveNotificationInitial, /"type":"work_notification"/);

  fake.finish("interrupted");
  await waitFor(async () => {
    const operation = await jsonFetch(`${base}/api/runs/${operationId}`, { headers: authorized() });
    return operation.operation.status === "interrupted";
  });
  await waitFor(async () => fake.unsubscribed.length === 1);
  assert.deepEqual(fake.unsubscribed, ["thread-web"]);
  const liveNotification = await readUntil(
    liveNotificationReader,
    (text) => text.includes('"type":"work_notification"'),
  );
  liveNotificationAbort.abort();
  assert.match(liveNotification, /"schema":1/);
  assert.match(liveNotification, /"kind":"completed"/);
  assert.match(liveNotification, new RegExp(`"operationId":"${operationId}"`));
  assert.doesNotMatch(liveNotification, /change a file|Mobile release audit|package\.json|workspace|cwd|result/);
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
  await jsonFetch(`${base}/api/session/handoffs/${idleRelease.handoff.id}/claim`, {
    method: "POST",
    headers: authorized({ "Content-Type": "application/json", Origin: base }),
    body: "{}",
  });
  const archived = await jsonFetch(`${base}/api/runs/${operationId}/metadata`, {
    method: "PATCH",
    headers: authorized({ "Content-Type": "application/json", Origin: base }),
    body: JSON.stringify({ archived: true }),
  });
  assert.equal(typeof archived.operation.archivedAt, "string");
  assert.equal(archived.operation.pinnedAt, undefined);

  const failedRun = await jsonFetch(`${base}/api/runs`, {
    method: "POST",
    headers: authorized({ "Content-Type": "application/json", Origin: base }),
    body: JSON.stringify({
      requestId: "failed-notification-run",
      prompt: "private failed notification prompt",
      cwd,
      provider: "codex",
      accountId: "cli-default",
      model: "test-codex",
    }),
  });
  fake.finish("failed");
  await waitFor(async () => {
    const current = await jsonFetch(`${base}/api/runs/${failedRun.operation.id}`, { headers: authorized() });
    return current.operation.status === "failed";
  });

  const invalidCursor = await fetch(`${base}/api/events`, {
    headers: authorized({ "Last-Event-ID": "not-a-cursor" }),
  });
  assert.equal(invalidCursor.status, 400);
  const invalidNotificationCursor = await fetch(`${base}/api/events/notifications`, {
    headers: authorized({ "Last-Event-ID": "not-a-cursor" }),
  });
  assert.equal(invalidNotificationCursor.status, 400);

  const replayAbort = new AbortController();
  const replayResponse = await fetch(`${base}/api/events`, {
    headers: authorized({ "Last-Event-ID": "0" }),
    signal: replayAbort.signal,
  });
  assert.equal(replayResponse.status, 200);
  const replayText = await readUntil(
    replayResponse.body!.getReader(),
    (text) => text.includes(operationId)
      && text.includes('"status":"interrupted"')
      && text.includes('"action":"replay_complete"'),
  );
  replayAbort.abort();
  assert.match(replayText, /id: \d+/);
  assert.match(replayText, /"action":"started"/);
  assert.match(replayText, /"action":"completed"/);
  assert.match(replayText, /"action":"metadata_updated"/);
  assert.match(replayText, /"goalName":"Mobile release audit"/);
  assert.match(replayText, /"type":"approval"/);
  assert.match(replayText, /"action":"resolved"/);
  assert.match(replayText, /"latestCursor":\d+/);

  const notificationReplayAbort = new AbortController();
  const notificationReplayResponse = await fetch(`${base}/api/events/notifications`, {
    headers: authorized({ "Last-Event-ID": "0" }),
    signal: notificationReplayAbort.signal,
  });
  assert.equal(notificationReplayResponse.status, 200);
  const notificationReplayText = await readUntil(
    notificationReplayResponse.body!.getReader(),
    (text) => text.includes('"action":"replay_complete"'),
  );
  notificationReplayAbort.abort();
  assert.match(notificationReplayText, /id: \d+/);
  assert.match(notificationReplayText, /"type":"notification_stream","action":"connected"/);
  assert.match(notificationReplayText, /"schema":1,"type":"work_notification","kind":"approval"/);
  assert.match(notificationReplayText, /"kind":"completed"/);
  assert.match(notificationReplayText, /"kind":"failed"/);
  assert.match(notificationReplayText, /"occurredAt":"[^"]+"/);
  assert.match(notificationReplayText, /"expiresAt":"[^"]+"/);
  assert.match(notificationReplayText, /"action":"replay_complete","latestCursor":\d+/);
  assert.doesNotMatch(
    notificationReplayText,
    /change a file|different request|private failed notification prompt|Mobile release audit|검증된 명령|package\.json|workspace|cwd|prompt|result|redacted/,
  );

  const missingDeleteConfirmation = await fetch(`${base}/api/journal/workspace`, {
    method: "DELETE",
    headers: authorized({ "Content-Type": "application/json", Origin: base }),
    body: JSON.stringify({ workspace: cwd }),
  });
  assert.equal(missingDeleteConfirmation.status, 400);
  const deletedHistory = await jsonFetch(`${base}/api/journal/workspace`, {
    method: "DELETE",
    headers: authorized({ "Content-Type": "application/json", Origin: base }),
    body: JSON.stringify({ workspace: cwd, confirm: "delete-companion-history" }),
  });
  assert.equal(deletedHistory.deletedOperations, 2);
  assert.ok(deletedHistory.deletedEvents >= 1);
  assert.deepEqual((await jsonFetch(`${base}/api/runs`, { headers: authorized() })).operations, []);
  const emptyJournal = await jsonFetch(
    `${base}/api/journal/policy?workspace=${encodeURIComponent(cwd)}`,
    { headers: authorized() },
  );
  assert.deepEqual(emptyJournal.summary, { operationCount: 0, eventCount: 0 });
});

test("gateway restart persists unknown-operation acknowledgement and replays it", async (t) => {
  const paths = await PathPolicy.fromEnvironment(cwd);
  const mediaDir = await mkdtemp(join(tmpdir(), "codex-pocket-ack-media-"));
  const projectHome = await mkdtemp(join(tmpdir(), "codex-pocket-ack-projects-"));
  const authHome = await mkdtemp(join(tmpdir(), "codex-pocket-ack-auth-"));
  t.after(() => rm(mediaDir, { recursive: true, force: true }));
  t.after(() => rm(projectHome, { recursive: true, force: true }));
  t.after(() => rm(authHome, { recursive: true, force: true }));
  const projects = await ProjectManager.fromEnvironment(paths, projectHome);
  const auth = await GatewayAuth.create({
    stateFile: join(authHome, "auth.json"),
    pairingCode: "87654321",
    deviceKind: "linux",
    deviceName: "Restart PC",
  });
  let running: Awaited<ReturnType<typeof startWebServer>> | undefined = await startWebServer({
    client: new FakeWebClient(),
    paths,
    staticDir: resolve(cwd, "client/dist"),
    media: new MediaManager({ rootDir: mediaDir }),
    projects,
    auth,
    port: 0,
  });
  let base = `http://127.0.0.1:${running.port}`;
  const paired = await jsonFetch(`${base}/api/pairing/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost" },
    body: JSON.stringify({ code: "87654321", label: "Restart test" }),
  });
  const headers = (extra: Record<string, string> = {}) => ({
    Authorization: `Bearer ${paired.token}`,
    ...extra,
  });
  const started = await jsonFetch(`${base}/api/runs`, {
    method: "POST",
    headers: headers({ "Content-Type": "application/json", Origin: "http://localhost" }),
    body: JSON.stringify({ requestId: "restart-run", prompt: "stay durable", cwd }),
  });
  await running.close();

  running = await startWebServer({
    client: new FakeWebClient(),
    paths,
    staticDir: resolve(cwd, "client/dist"),
    media: new MediaManager({ rootDir: mediaDir }),
    projects,
    auth,
    port: 0,
  });
  t.after(() => running?.close().catch(() => undefined));
  base = `http://127.0.0.1:${running.port}`;
  const restored = await jsonFetch(`${base}/api/runs/${started.operation.id}`, { headers: headers() });
  assert.equal(restored.operation.status, "unknown");
  assert.equal(restored.operation.acknowledgedAt, undefined);

  const acknowledged = await jsonFetch(`${base}/api/runs/${started.operation.id}/acknowledge`, {
    method: "POST",
    headers: headers({ "Content-Type": "application/json", Origin: "http://localhost" }),
    body: "{}",
  });
  assert.equal(acknowledged.operation.status, "unknown");
  assert.equal(typeof acknowledged.operation.acknowledgedAt, "string");

  const replayAbort = new AbortController();
  const replay = await fetch(`${base}/api/events`, {
    headers: headers({ "Last-Event-ID": "0" }),
    signal: replayAbort.signal,
  });
  const replayText = await readUntil(
    replay.body!.getReader(),
    (text) => text.includes('"action":"acknowledged"')
      && text.includes('"action":"replay_complete"'),
  );
  replayAbort.abort();
  assert.match(replayText, /id: \d+/);

  await running.close();
  const journal = await EventJournal.create(join(authHome, "event-journal.sqlite3"));
  const persisted = journal.load().operations.find((operation) => operation.id === started.operation.id);
  assert.equal(persisted?.acknowledgedAt, acknowledged.operation.acknowledgedAt);
  journal.close();
  running = undefined;
});

test("notification replay keeps only the latest sixteen minimal events", async (t) => {
  const paths = await PathPolicy.fromEnvironment(cwd);
  const root = await mkdtemp(join(tmpdir(), "codex-pocket-notification-replay-"));
  const auth = await GatewayAuth.create({
    stateFile: join(root, "auth.json"),
    pairingCode: "24681357",
    deviceKind: "linux",
    deviceName: "Notification replay PC",
  });
  const journal = await EventJournal.create(join(root, "events.sqlite3"));
  for (let index = 0; index < 20; index += 1) {
    const completedAt = `2026-08-24T00:00:${String(index).padStart(2, "0")}.000Z`;
    journal.saveOperation({
      id: `operation-${index}`,
      providerId: "codex",
      conversationId: `conversation-${index}`,
      runId: `run-${index}`,
      cwd,
      prompt: `private prompt ${index}`,
      status: "completed",
      startedAt: completedAt,
      completedAt,
    });
    journal.appendEvent(`operation-${index}`, cwd, {
      type: "operation",
      action: "completed",
      operation: {
        id: `operation-${index}`,
        completedAt,
        prompt: `private prompt ${index}`,
        cwd,
      },
    });
  }
  const running = await startWebServer({
    client: new FakeWebClient(),
    paths,
    staticDir: resolve(cwd, "client/dist"),
    media: new MediaManager({ rootDir: join(root, "media") }),
    projects: await ProjectManager.fromEnvironment(paths, root),
    auth,
    journal,
    port: 0,
  });
  t.after(() => running.close().catch(() => undefined));
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = `http://127.0.0.1:${running.port}`;
  const paired = await jsonFetch(`${base}/api/pairing/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost" },
    body: JSON.stringify({ code: "24681357", label: "Replay test" }),
  });
  const abort = new AbortController();
  const response = await fetch(`${base}/api/events/notifications`, {
    headers: { Authorization: `Bearer ${paired.token}`, "Last-Event-ID": "0" },
    signal: abort.signal,
  });
  const replay = await readUntil(
    response.body!.getReader(),
    (text) => text.includes('"action":"replay_complete"'),
  );
  abort.abort();
  assert.match(replay, /"replayed":16/);
  assert.equal(replay.match(/"type":"work_notification"/g)?.length, 16);
  assert.match(replay, /"operationId":"operation-4"/);
  assert.match(replay, /"operationId":"operation-19"/);
  assert.doesNotMatch(replay, /operation-3|private prompt|workspace|cwd/);
});

class FakeWebClient implements WebCodexClient {
  lastRun?: RunTurnOptions;
  interrupted?: [string, string];
  unsubscribed: string[] = [];
  runsStarted = 0;
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
    this.runsStarted += 1;
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

async function secureJson(
  port: number,
  hostHeader: string,
  identity?: { certificate: Buffer; privateKey: Buffer },
  options: {
    path?: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): Promise<{
  status: number;
  body: any;
  peerPin: string;
}> {
  return new Promise((resolvePromise, rejectPromise) => {
    const agent = new HttpsAgent({ maxCachedSessions: 0 });
    const request = httpsRequest({
      host: "127.0.0.1",
      port,
      path: options.path ?? "/api/status",
      method: options.method ?? "GET",
      rejectUnauthorized: false,
      agent,
      ...(identity ? { cert: identity.certificate, key: identity.privateKey } : {}),
      headers: { Host: hostHeader, ...options.headers },
    }, (response) => {
      const chunks: Buffer[] = [];
      const peer = (response.socket as TLSSocket).getPeerX509Certificate();
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        agent.destroy();
        try {
          if (!peer) throw new Error("PocketLink TLS peer certificate is missing");
          resolvePromise({
            status: response.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
            peerPin: publicKeyPin(peer),
          });
        } catch (error) {
          rejectPromise(error);
        }
      });
    });
    request.once("error", (error) => {
      agent.destroy();
      rejectPromise(error);
    });
    request.end(options.body);
  });
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Condition was not met in time");
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  complete: (text: string) => boolean,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + 2_000;
  while (!complete(text) && Date.now() < deadline) {
    const next = await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("SSE replay timed out")), 500)),
    ]);
    if (next.done) break;
    text += decoder.decode(next.value, { stream: true });
  }
  if (!complete(text)) throw new Error("SSE replay did not include the terminal operation");
  return text;
}
