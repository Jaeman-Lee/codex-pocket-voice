import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { constants as cryptoConstants } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { basename, dirname, extname, isAbsolute, join, relative, sep } from "node:path";
import { TLSSocket } from "node:tls";
import type { ThreadListResponse } from "../generated/app-server/v2/ThreadListResponse";
import type { ThreadReadResponse } from "../generated/app-server/v2/ThreadReadResponse";
import type { ThreadUnsubscribeResponse } from "../generated/app-server/v2/ThreadUnsubscribeResponse";
import type { CodexProviderClient } from "./providers/codex-provider.js";
import type { ProviderModelGradeSource } from "./providers/model-grades.js";
import type { ProviderEvent, ProviderRoutingSelection } from "./providers/types.js";
import { PathPolicy } from "./path-policy.js";
import { compactThread, presentThread } from "./result.js";
import { MediaError, MediaManager } from "./media-manager.js";
import { ProjectCreationError, ProjectManager } from "./project-manager.js";
import { ProviderError, ProviderRegistry } from "./providers/registry.js";
import {
  CostAndPolicyGuard,
  RUN_POLICY_CONFIG_LIMITS,
  RunPolicyError,
} from "./run-policy.js";
import { ProviderLoginManager } from "./provider-login-manager.js";
import { GatewayAuth, GatewayAuthError } from "./gateway-auth.js";
import { APP_VERSION, GATEWAY_CAPABILITIES, GATEWAY_PROTOCOL_MINIMUM, GATEWAY_PROTOCOL_VERSION } from "./version.js";
import { collectSystemDiagnostics } from "./system-diagnostics.js";
import { SessionHandoffStore, type SessionHandoff } from "./session-handoff-store.js";
import { inspectWorkspaceIdentity } from "./workspace-identity.js";
import {
  ApprovalBrokerError,
  InMemoryApprovalBroker,
  type ApprovalBroker,
  type ApprovalRequest,
} from "./approval-broker.js";
import { createReadOnlyWorkspaceTools } from "./read-only-tools.js";
import { createWorkspaceChangeTools } from "./workspace-change-tools.js";
import type { WorkspaceChangeEngine } from "./workspace-change-engine.js";
import { createWorkspaceExecutionTools } from "./workspace-execution-tools.js";
import { LocalToolBroker } from "./tool-broker.js";
import {
  EVENT_JOURNAL_POLICY_LIMITS,
  EventJournal,
  EventJournalExportError,
  type JournalReplayEvent,
} from "./event-journal.js";
import { publicKeyPin, type PocketLinkTlsConfig } from "./pocket-link.js";
import {
  RunCoordinator,
  RunCoordinatorError,
  type RunForkProvenance,
  type RunOperation,
  type RunOperationMetadataPatch,
} from "./run-coordinator.js";
import {
  RunForkManager,
  RunForkManagerError,
  type RunForkSelection,
} from "./run-fork-manager.js";

const MAX_BODY_BYTES = 128 * 1024;
const MAX_EVENT_TEXT = 80_000;
const MAX_NOTIFICATION_REPLAY_EVENTS = 16;
const THREAD_WRITER_RELEASE_RETRY_DELAYS_MS = [0, 50, 250] as const;
const NATIVE_APP_ORIGINS = new Set(["http://localhost", "https://localhost", "capacitor://localhost"]);
const STATIC_FILES = new Map([
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/app.js", "app.js"],
  ["/styles.css", "styles.css"],
  ["/manifest.webmanifest", "manifest.webmanifest"],
  ["/sw.js", "sw.js"],
  ["/icon.svg", "icon.svg"],
]);

export interface WebCodexClient extends CodexProviderClient {
  listThreads(limit?: number, searchTerm?: string): Promise<ThreadListResponse>;
  readThread(threadId: string, includeTurns?: boolean): Promise<ThreadReadResponse>;
  unsubscribeThread(threadId: string): Promise<ThreadUnsubscribeResponse>;
}

export interface WebServerOptions {
  client: WebCodexClient;
  paths: PathPolicy;
  staticDir: string;
  host?: string;
  port?: number;
  media?: MediaManager;
  projects?: ProjectManager;
  auth?: GatewayAuth;
  handoffs?: SessionHandoffStore;
  providers?: ProviderRegistry;
  modelGrades?: ProviderModelGradeSource;
  runPolicyGuard?: CostAndPolicyGuard;
  journal?: EventJournal;
  approvals?: ApprovalBroker;
  pocketLink?: PocketLinkTlsConfig;
  workspaceTransactionDirectory?: string;
}

export interface RunningWebServer {
  server: Server;
  host: string;
  port: number;
  deviceId: string;
  deviceName: string;
  pairingCode: string;
  pairingExpiresAt: string;
  pocketLink?: {
    host: string;
    port: number;
    advertiseHost: string;
    publicKeyPin: string;
  };
  close(): Promise<void>;
}

interface RunBody {
  requestId?: unknown;
  prompt?: unknown;
  cwd?: unknown;
  threadId?: unknown;
  conversationId?: unknown;
  networkAccess?: unknown;
  model?: unknown;
  effort?: unknown;
  timeoutSeconds?: unknown;
  attachments?: unknown;
  provider?: unknown;
  accountId?: unknown;
  routing?: unknown;
  policyConfirmation?: unknown;
  forkPreviewId?: unknown;
}

interface SteerBody {
  requestId?: unknown;
  prompt?: unknown;
  attachments?: unknown;
}

interface ForkPreviewBody {
  sourceOperationId?: unknown;
  targetProvider?: unknown;
  accountId?: unknown;
  model?: unknown;
  effort?: unknown;
  networkAccess?: unknown;
  routing?: unknown;
  prompt?: unknown;
  attachments?: unknown;
}

interface CreateProjectBody {
  name?: unknown;
  parent?: unknown;
}

export async function startWebServer(options: WebServerOptions): Promise<RunningWebServer> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8787;
  if (!isLoopbackName(host)) {
    throw new Error(`Web UI must bind to loopback, received: ${host}`);
  }
  const rootInfo = await stat(options.staticDir);
  if (!rootInfo.isDirectory()) throw new Error(`Web static directory is invalid: ${options.staticDir}`);

  const sseClients = new Set<ServerResponse>();
  const notificationSseClients = new Set<ServerResponse>();
  const media = options.media ?? new MediaManager({
    onUpdate: (item) => broadcast(sseClients, { type: "media", media: item }),
  });
  await media.initialize();
  const projects = options.projects ?? await ProjectManager.fromEnvironment(options.paths);
  const auth = options.auth ?? await GatewayAuth.create();
  const handoffs = options.handoffs ?? await SessionHandoffStore.create(
    process.env.CODEX_POCKET_HANDOFF_STATE ?? join(dirname(auth.stateFile), "session-handoff.json"),
  );
  const journal = options.journal ?? await EventJournal.create(
    process.env.CODEX_POCKET_EVENT_JOURNAL ?? join(dirname(auth.stateFile), "event-journal.sqlite3"),
    { keyFile: process.env.CODEX_POCKET_EVENT_JOURNAL_KEY_FILE },
  );
  const approvals = options.approvals ?? new InMemoryApprovalBroker();
  const executionTools = options.providers ? [] : await createWorkspaceExecutionTools(options.paths);
  let workspaceChangeEngine: WorkspaceChangeEngine | undefined;
  const changeTools = options.providers ? [] : await createWorkspaceChangeTools(options.paths, {
    transactionDirectory: options.workspaceTransactionDirectory
      ?? process.env.CODEX_POCKET_WORKSPACE_TRANSACTIONS
      ?? join(dirname(auth.stateFile), "workspace-transactions"),
    deferRecoveryFailure: true,
    onEngineReady: (engine) => { workspaceChangeEngine = engine; },
  });
  const toolBroker = options.providers
    ? undefined
    : new LocalToolBroker([
        ...createReadOnlyWorkspaceTools(options.paths),
        ...changeTools,
        ...executionTools,
      ], approvals, options.paths);
  const providers = options.providers ?? new ProviderRegistry(options.client, undefined, {
    toolBroker,
    modelGrades: options.modelGrades,
  });
  const providerLogins = new ProviderLoginManager(providers);
  const journalPolicy = journal.policy();
  const runPolicy = options.runPolicyGuard ?? new CostAndPolicyGuard(providers, journal);
  const runs = new RunCoordinator(providers, {
    assertWorkspace: (cwd) => options.paths.assertAllowed(cwd),
    stateStore: journal,
    retentionMs: journalPolicy.retentionMs,
    maxOperations: journalPolicy.maxOperations,
    policyGuard: runPolicy,
  });
  const runForks = new RunForkManager();
  const threadWriterReleases = new Map<string, Promise<ThreadUnsubscribeResponse>>();
  const releaseThreadWriter = (threadId: string): Promise<ThreadUnsubscribeResponse> => {
    const pending = threadWriterReleases.get(threadId);
    if (pending) return pending;
    const release = releaseThreadWriterWithRetry(options.client, threadId);
    threadWriterReleases.set(threadId, release);
    void release.then(
      () => threadWriterReleases.delete(threadId),
      () => threadWriterReleases.delete(threadId),
    );
    return release;
  };
  const unsubscribeRuns = runs.subscribe((event) => {
    if (event.type === "operation") {
      const publicEvent = {
        type: "operation",
        action: event.action,
        operation: publicOperation(event.operation),
      };
      appendAndBroadcast(
        journal,
        sseClients,
        notificationSseClients,
        event.operation.id,
        event.operation.cwd,
        publicEvent,
      );
      if ((event.action === "completed" || event.action === "failed")
          && event.operation.providerId === "codex"
          && handoffs.current({
            workspace: event.operation.cwd,
            threadId: event.operation.conversationId,
          })) {
        void releaseThreadWriter(event.operation.conversationId).catch((error) => {
          process.stderr.write(`[codex-session-handoff] Could not release completed thread writer: ${safeInternalError(error)}\n`);
        });
      }
      return;
    }
    const forwarded = sanitizeNotification(event.event);
    if (forwarded) {
      appendAndBroadcast(journal, sseClients, notificationSseClients, event.operationId, event.cwd, forwarded);
    }
  });
  const unsubscribeApprovals = approvals.subscribe((event) => {
    const operation = runs.findByProviderRun(
      event.request.providerId,
      event.request.conversationId,
      event.request.runId,
    );
    if (!operation) {
      process.stderr.write("[codex-approval-broker] Ignored an approval event without a matching run\n");
      return;
    }
    const publicEvent = {
      type: "approval",
      action: event.type === "requested" ? "requested" : "resolved",
      approval: publicApproval(event.request, operation),
      ...(event.type === "resolved" ? { resolution: event.resolution } : {}),
    };
    appendAndBroadcast(journal, sseClients, notificationSseClients, operation.id, operation.cwd, publicEvent);
  });

  const requestListener = (request: IncomingMessage, response: ServerResponse) => {
    void handleRequest(request, response, options, auth, handoffs, media, projects, providers, providerLogins, runs, runForks, runPolicy, approvals, journal, workspaceChangeEngine, sseClients, notificationSseClients, undefined).catch(
      (error) => sendError(response, error),
    );
  };
  const pocketLinkRequestListener = (request: IncomingMessage, response: ServerResponse) => {
    void Promise.resolve().then(() => pocketLinkClientPublicKeyPin(request)).then((tlsPublicKeyPin) => (
      handleRequest(request, response, options, auth, handoffs, media, projects, providers, providerLogins, runs, runForks, runPolicy, approvals, journal, workspaceChangeEngine, sseClients, notificationSseClients, tlsPublicKeyPin)
    )).catch((error) => sendError(response, error));
  };
  const server = createServer(requestListener);
  configureServer(server);
  const pocketLinkServer = options.pocketLink
    ? createHttpsServer({
        cert: options.pocketLink.certificate,
        key: options.pocketLink.privateKey,
        minVersion: "TLSv1.2",
        maxVersion: "TLSv1.3",
        requestCert: true,
        rejectUnauthorized: false,
        secureOptions: cryptoConstants.SSL_OP_NO_TICKET,
      }, pocketLinkRequestListener)
    : undefined;
  if (pocketLinkServer) {
    configureServer(pocketLinkServer);
    pocketLinkServer.maxConnections = 64;
    pocketLinkServer.on("resumeSession", (_sessionId, callback) => callback(null, null));
  }

  const heartbeat = setInterval(() => {
    for (const response of sseClients) response.write(": heartbeat\n\n");
    for (const response of notificationSseClients) response.write(": heartbeat\n\n");
  }, 20_000);
  heartbeat.unref();

  let localPort: number;
  let pocketLinkPort: number | undefined;
  try {
    localPort = await listenServer(server, port, host);
    if (pocketLinkServer && options.pocketLink) {
      pocketLinkPort = await listenServer(pocketLinkServer, options.pocketLink.port, options.pocketLink.host);
    }
  } catch (error) {
    clearInterval(heartbeat);
    providerLogins.close();
    approvals.close();
    unsubscribeApprovals();
    unsubscribeRuns();
    runs.close();
    await Promise.all([closeServer(server), closeServer(pocketLinkServer)]);
    journal.close();
    throw error;
  }

  return {
    server,
    host,
    port: localPort,
    deviceId: auth.device.id,
    deviceName: auth.device.name,
    pairingCode: auth.pairingCode,
    pairingExpiresAt: auth.pairingExpiresAt,
    ...(options.pocketLink && pocketLinkPort !== undefined ? {
      pocketLink: {
        host: options.pocketLink.host,
        port: pocketLinkPort,
        advertiseHost: options.pocketLink.advertiseHost,
        publicKeyPin: options.pocketLink.publicKeyPin,
      },
    } : {}),
    async close() {
      clearInterval(heartbeat);
      providerLogins.close();
      approvals.close();
      unsubscribeApprovals();
      unsubscribeRuns();
      runs.close();
      for (const response of sseClients) response.end();
      sseClients.clear();
      for (const response of notificationSseClients) response.end();
      notificationSseClients.clear();
      server.closeIdleConnections();
      pocketLinkServer?.closeIdleConnections();
      try {
        await Promise.all([closeServer(server), closeServer(pocketLinkServer)]);
      } finally {
        journal.close();
      }
    },
  };
}

type ListeningServer = Server | HttpsServer;

async function releaseThreadWriterWithRetry(
  client: WebCodexClient,
  threadId: string,
): Promise<ThreadUnsubscribeResponse> {
  let lastError: unknown;
  for (const delayMs of THREAD_WRITER_RELEASE_RETRY_DELAYS_MS) {
    if (delayMs > 0) await wait(delayMs);
    try {
      return await client.unsubscribeThread(threadId);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Could not release Codex thread writer");
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function configureServer(server: ListeningServer): void {
  server.requestTimeout = 0;
  server.headersTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
}

async function listenServer(server: ListeningServer, port: number, host: string): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Web server did not get a TCP address");
  return address.port;
}

async function closeServer(server: ListeningServer | undefined): Promise<void> {
  if (!server?.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function pocketLinkClientPublicKeyPin(request: IncomingMessage): string {
  if (!(request.socket instanceof TLSSocket) || !request.socket.encrypted) {
    throw new GatewayAuthError(401, "TLS_DEVICE_PROOF_REQUIRED", "PocketLink 단말 인증서가 필요합니다.");
  }
  const certificate = request.socket.getPeerX509Certificate();
  if (!certificate) {
    throw new GatewayAuthError(401, "TLS_DEVICE_PROOF_REQUIRED", "PocketLink 단말 인증서가 필요합니다.");
  }
  const now = Date.now();
  if (now < Date.parse(certificate.validFrom) || now > Date.parse(certificate.validTo)) {
    throw new GatewayAuthError(401, "TLS_DEVICE_PROOF_EXPIRED", "PocketLink 단말 인증서가 유효하지 않습니다.");
  }
  return publicKeyPin(certificate);
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: WebServerOptions,
  auth: GatewayAuth,
  handoffs: SessionHandoffStore,
  media: MediaManager,
  projects: ProjectManager,
  providers: ProviderRegistry,
  providerLogins: ProviderLoginManager,
  runs: RunCoordinator,
  runForks: RunForkManager,
  runPolicy: CostAndPolicyGuard,
  approvals: ApprovalBroker,
  journal: EventJournal,
  workspaceChangeEngine: WorkspaceChangeEngine | undefined,
  sseClients: Set<ServerResponse>,
  notificationSseClients: Set<ServerResponse>,
  tlsPublicKeyPin: string | undefined,
): Promise<void> {
  setSecurityHeaders(response);
  const host = request.headers.host;
  if (!host || !isLoopbackHostHeader(host)) throw new HttpError(400, "Loopback Host header required");
  const url = new URL(request.url ?? "/", `http://${host}`);

  if (url.pathname.startsWith("/api/")) {
    response.setHeader("Cache-Control", "no-store");
    applyApiCors(request, response);
    if (request.method === "OPTIONS") {
      response.statusCode = 204;
      response.end();
      return;
    }
    await handleApi(request, response, url, options, auth, handoffs, media, projects, providers, providerLogins, runs, runForks, runPolicy, approvals, journal, workspaceChangeEngine, sseClients, notificationSseClients, tlsPublicKeyPin);
    return;
  }
  await serveStatic(request, response, url.pathname, options.staticDir);
}

async function handleApi(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  options: WebServerOptions,
  auth: GatewayAuth,
  handoffs: SessionHandoffStore,
  media: MediaManager,
  projects: ProjectManager,
  providers: ProviderRegistry,
  providerLogins: ProviderLoginManager,
  runs: RunCoordinator,
  runForks: RunForkManager,
  runPolicy: CostAndPolicyGuard,
  approvals: ApprovalBroker,
  journal: EventJournal,
  workspaceChangeEngine: WorkspaceChangeEngine | undefined,
  sseClients: Set<ServerResponse>,
  notificationSseClients: Set<ServerResponse>,
  tlsPublicKeyPin: string | undefined,
): Promise<void> {
  if (request.method === "GET" && url.pathname === "/api/status") {
    sendJson(response, 200, {
      ok: true,
      appVersion: APP_VERSION,
      protocolVersion: GATEWAY_PROTOCOL_VERSION,
      minimumClientProtocol: GATEWAY_PROTOCOL_MINIMUM,
      device: auth.device,
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/pairing/status") {
    sendJson(response, 200, {
      ...auth.pairingStatus(),
      appVersion: APP_VERSION,
      protocolVersion: GATEWAY_PROTOCOL_VERSION,
      minimumClientProtocol: GATEWAY_PROTOCOL_MINIMUM,
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/pairing/claim") {
    assertSameOrigin(request);
    const body = await readJson(request) as { code?: unknown; label?: unknown };
    sendJson(response, 201, await auth.claim(body.code, body.label, tlsPublicKeyPin));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/pairing/tls-key-rotation/status") {
    assertSameOrigin(request);
    const body = await readJson(request) as { rotationToken?: unknown };
    sendJson(response, 200, await auth.inspectTlsKeyRotation(
      request.headers.authorization,
      body.rotationToken,
      tlsPublicKeyPin,
    ));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/pairing/tls-key-rotation/complete") {
    assertSameOrigin(request);
    const body = await readJson(request) as { rotationToken?: unknown };
    sendJson(response, 200, await auth.completeTlsKeyRotation(
      request.headers.authorization,
      body.rotationToken,
      tlsPublicKeyPin,
    ));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/pairing/tls-key-rotation/abort") {
    assertSameOrigin(request);
    const body = await readJson(request) as { rotationToken?: unknown };
    sendJson(response, 200, await auth.abortTlsKeyRotation(
      request.headers.authorization,
      body.rotationToken,
      tlsPublicKeyPin,
    ));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/pairing/tls-key-rotation/finalize") {
    assertSameOrigin(request);
    const body = await readJson(request) as { rotationToken?: unknown };
    sendJson(response, 200, await auth.finalizeTlsKeyRotation(
      request.headers.authorization,
      body.rotationToken,
      tlsPublicKeyPin,
    ));
    return;
  }

  const authenticatedClient = auth.requireAuthorization(request.headers.authorization, tlsPublicKeyPin);

  if (request.method === "GET" && url.pathname === "/api/workspace-changes/recovery") {
    sendJson(response, 200, {
      supported: workspaceChangeEngine !== undefined,
      status: workspaceChangeEngine?.recoveryStatus() ?? null,
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/workspace-changes/recovery/retry") {
    assertSameOrigin(request);
    if (!workspaceChangeEngine) throw new HttpError(404, "Workspace change recovery is unavailable");
    const body = await readJson(request);
    if (!isRecord(body) || !hasExactKeys(body, ["confirm"]) || body.confirm !== "retry-safe-workspace-recovery") {
      throw new HttpError(400, "Workspace recovery confirmation is invalid");
    }
    sendJson(response, 200, { status: await workspaceChangeEngine.retryRecovery() });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/pairing/tls-key-rotation/start") {
    assertSameOrigin(request);
    await readJson(request, true);
    sendJson(response, 201, await auth.startTlsKeyRotation(authenticatedClient.id, tlsPublicKeyPin));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/health") {
    const initialized = await options.client.start();
    sendJson(response, 200, {
      ok: true,
      ...initialized,
      allowedWorkspaceRoots: options.paths.roots,
      media: {
        maxBytes: media.maxBytes,
        videoModel: media.model,
        responseLanguage: media.analysisLanguage,
        retentionHours: Math.round(media.retentionMs / 60 / 60_000),
      },
      device: auth.device,
      client: authenticatedClient,
      gateway: {
        appVersion: APP_VERSION,
        protocolVersion: GATEWAY_PROTOCOL_VERSION,
        minimumClientProtocol: GATEWAY_PROTOCOL_MINIMUM,
        capabilities: GATEWAY_CAPABILITIES,
      },
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/workspaces") {
    const workspaces = await Promise.all(projects.list().map(async (workspace) => ({
      ...workspace,
      identity: await inspectWorkspaceIdentity(workspace.path),
    })));
    sendJson(response, 200, {
      device: auth.device,
      workspaces,
      creationLocations: projects.creationLocations(),
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/models") {
    const catalog = await providers.models(url.searchParams.get("provider"));
    sendJson(response, 200, {
      models: catalog,
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/providers") {
    sendJson(response, 200, { providers: await providers.list() });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/diagnostics") {
    sendJson(response, 200, {
      diagnostics: await collectSystemDiagnostics(projects.list().length, projects.creationLocations().length),
    });
    return;
  }

  const providerTestMatch = url.pathname.match(/^\/api\/providers\/([^/]+)\/test$/);
  if (request.method === "POST" && providerTestMatch) {
    assertSameOrigin(request);
    await readJson(request, true);
    const provider = decodeURIComponent(providerTestMatch[1]!);
    sendJson(response, 200, { test: await providers.test(provider) });
    return;
  }

  const providerLoginMatch = url.pathname.match(/^\/api\/providers\/([^/]+)\/login$/);
  if (request.method === "POST" && providerLoginMatch) {
    assertSameOrigin(request);
    await readJson(request, true);
    const provider = decodeURIComponent(providerLoginMatch[1]!);
    sendJson(response, 202, { login: await providerLogins.start(provider) });
    return;
  }

  const loginSessionMatch = url.pathname.match(/^\/api\/provider-logins\/([^/]+)$/);
  if (request.method === "GET" && loginSessionMatch) {
    sendJson(response, 200, { login: providerLogins.get(decodeURIComponent(loginSessionMatch[1]!)) });
    return;
  }

  const cancelLoginMatch = url.pathname.match(/^\/api\/provider-logins\/([^/]+)\/cancel$/);
  if (request.method === "POST" && cancelLoginMatch) {
    assertSameOrigin(request);
    await readJson(request, true);
    sendJson(response, 200, { login: providerLogins.cancel(decodeURIComponent(cancelLoginMatch[1]!)) });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/projects") {
    assertSameOrigin(request);
    const body = (await readJson(request)) as CreateProjectBody;
    const name = requiredString(body.name, "name", 80);
    const parent = optionalString(body.parent, "parent", 4_096);
    const project = await projects.create(name, parent);
    sendJson(response, 201, {
      device: auth.device,
      project: { ...project, identity: await inspectWorkspaceIdentity(project.path) },
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/threads") {
    const requestedLimit = Number(url.searchParams.get("limit") ?? "20");
    const limit = Number.isInteger(requestedLimit) ? Math.max(1, Math.min(50, requestedLimit)) : 20;
    const search = url.searchParams.get("search")?.slice(0, 200) || undefined;
    const listed = await options.client.listThreads(50, search);
    const threads = listed.data
      .filter((thread) => options.paths.isAllowed(thread.cwd))
      .slice(0, limit)
      .map(compactThread);
    sendJson(response, 200, { threads, nextCursor: listed.nextCursor });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/session/handoff") {
    const workspace = url.searchParams.get("workspace") || undefined;
    const threadId = url.searchParams.get("threadId") || undefined;
    if (workspace) options.paths.assertAllowed(workspace);
    const candidate = handoffs.current({ workspace, threadId });
    const handoff = candidate && await handoffMatchesWorkspace(candidate, options, runs) ? candidate : null;
    const operation = handoff?.operationId ? runs.get(handoff.operationId) : undefined;
    sendJson(response, 200, {
      handoff,
      operation: operation ? publicOperation(operation) : null,
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/session/handoff") {
    assertSameOrigin(request);
    const body = await readJson(request) as { workspace?: unknown; threadId?: unknown; operationId?: unknown };
    const requestedOperationId = optionalString(body.operationId, "operationId", 200);
    const operation = requestedOperationId ? runs.get(requestedOperationId) : undefined;
    if (requestedOperationId && !operation) throw new HttpError(404, "Operation not found");
    if (operation && operation.providerId !== "codex") {
      throw new HttpError(409, "이 세션 인계 방식은 Codex 대화에서만 사용할 수 있습니다.");
    }
    const threadId = optionalString(body.threadId, "threadId", 200) ?? operation?.conversationId;
    if (!threadId) throw new HttpError(400, "threadId is required");
    const read = await options.client.readThread(threadId, false);
    options.paths.assertAllowed(read.thread.cwd);
    const workspace = await options.paths.resolveWorkspace(
      optionalString(body.workspace, "workspace", 4_096) ?? operation?.cwd ?? read.thread.cwd,
    );
    const threadWorkspace = await options.paths.resolveWorkspace(read.thread.cwd);
    if (!containsWorkspace(workspace, threadWorkspace)) {
      throw new HttpError(409, "Thread does not belong to the selected workspace");
    }
    if (operation && (operation.conversationId !== threadId || operation.cwd !== workspace)) {
      throw new HttpError(409, "Operation does not belong to this session");
    }
    const unsubscribe = operation?.status === "running"
      ? null
      : await releaseThreadWriterWithRetry(options.client, threadId);
    const handoff = await handoffs.release({
      workspace,
      threadId,
      ...(operation ? { operationId: operation.id } : {}),
      releasedBy: authenticatedClient,
    });
    broadcast(sseClients, { type: "session", action: "released", handoff });
    sendJson(response, 201, {
      handoff,
      operation: operation ? publicOperation(operation) : null,
      threadUnsubscribeStatus: unsubscribe?.status ?? null,
    });
    return;
  }

  const claimHandoffMatch = url.pathname.match(/^\/api\/session\/handoffs\/([^/]+)\/claim$/);
  if (request.method === "POST" && claimHandoffMatch) {
    assertSameOrigin(request);
    await readJson(request, true);
    const handoffId = decodeURIComponent(claimHandoffMatch[1]!);
    const existing = handoffs.list().find((item) => item.id === handoffId);
    if (!existing) throw new HttpError(404, "Session handoff not found");
    options.paths.assertAllowed(existing.workspace);
    if (!await handoffMatchesWorkspace(existing, options, runs)) {
      throw new HttpError(409, "Session handoff no longer belongs to its recorded workspace");
    }
    const claimed = await handoffs.claim(handoffId);
    broadcast(sseClients, { type: "session", action: "claimed", handoffId });
    sendJson(response, 200, { claimed });
    return;
  }

  const threadMatch = url.pathname.match(/^\/api\/threads\/([^/]+)$/);
  if (request.method === "GET" && threadMatch) {
    const threadId = decodeURIComponent(threadMatch[1]!);
    const read = await options.client.readThread(threadId, true);
    options.paths.assertAllowed(read.thread.cwd);
    sendJson(response, 200, { thread: presentThread(read.thread) });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/events") {
    const requestedCursor = eventCursor(request.headers["last-event-id"]);
    const cursor = requestedCursor ?? journal.latestCursor();
    const replay = journal.replayAfter(cursor);
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    response.write(`data: ${JSON.stringify({
      type: "connected",
      at: new Date().toISOString(),
      journalCursor: replay.latestCursor,
      replayed: replay.events.length,
    })}\n\n`);
    if (replay.gapBefore || replay.journalReset) {
      response.write(`data: ${JSON.stringify({
        type: "journal",
        action: "reset",
        reason: replay.journalReset ? "database_reset" : "retention_gap",
        latestCursor: replay.latestCursor,
      })}\n\n`);
    }
    for (const event of replay.events) response.write(journalFrame(event));
    response.write(`data: ${JSON.stringify({
      type: "journal",
      action: "replay_complete",
      latestCursor: replay.latestCursor,
    })}\n\n`);
    sseClients.add(response);
    request.once("close", () => sseClients.delete(response));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/events/notifications") {
    const requestedCursor = eventCursor(request.headers["last-event-id"]);
    const cursor = requestedCursor ?? journal.latestCursor();
    const replay = journal.replayAfter(cursor);
    const notificationEvents = replay.events.flatMap((event) => {
      const notification = workNotification(event.event);
      return notification ? [{ ...event, event: notification }] : [];
    }).slice(-MAX_NOTIFICATION_REPLAY_EVENTS);
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    response.write(`data: ${JSON.stringify({
      type: "notification_stream",
      action: "connected",
      latestCursor: replay.latestCursor,
      replayed: notificationEvents.length,
    })}\n\n`);
    if (replay.gapBefore || replay.journalReset) {
      response.write(`data: ${JSON.stringify({
        type: "notification_stream",
        action: "reset",
        latestCursor: replay.latestCursor,
      })}\n\n`);
    }
    for (const event of notificationEvents) response.write(journalFrame(event));
    response.write(`data: ${JSON.stringify({
      type: "notification_stream",
      action: "replay_complete",
      latestCursor: replay.latestCursor,
    })}\n\n`);
    notificationSseClients.add(response);
    request.once("close", () => notificationSseClients.delete(response));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/media") {
    assertWriteOrigin(request);
    const contentType = request.headers["content-type"] ?? "";
    const name = url.searchParams.get("name") ?? "attachment";
    const item = await media.saveUpload(request, name, contentType);
    sendJson(response, 201, { media: item });
    return;
  }

  const mediaMatch = url.pathname.match(/^\/api\/media\/([^/]+)$/);
  if (request.method === "GET" && mediaMatch) {
    sendJson(response, 200, { media: media.get(decodeURIComponent(mediaMatch[1]!)) });
    return;
  }
  if (request.method === "DELETE" && mediaMatch) {
    assertWriteOrigin(request);
    await media.delete(decodeURIComponent(mediaMatch[1]!));
    sendJson(response, 200, { deleted: true });
    return;
  }

  const analyzeMatch = url.pathname.match(/^\/api\/media\/([^/]+)\/analyze$/);
  if (request.method === "POST" && analyzeMatch) {
    assertSameOrigin(request);
    await readJson(request, true);
    const item = media.queueAnalysis(decodeURIComponent(analyzeMatch[1]!));
    sendJson(response, item.status === "ready" ? 200 : 202, { media: item });
    return;
  }

  const frameMatch = url.pathname.match(/^\/api\/media\/([^/]+)\/frames\/(\d+)$/);
  if (request.method === "GET" && frameMatch) {
    const path = media.getFrame(decodeURIComponent(frameMatch[1]!), Number(frameMatch[2]));
    await serveFile(request, response, path, "image/jpeg", "private, max-age=3600");
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/runs") {
    const status = url.searchParams.get("status");
    const workspace = url.searchParams.get("workspace");
    if (workspace) options.paths.assertAllowed(workspace);
    const listed = runs.list({ status: status ?? undefined, workspace: workspace ?? undefined }).map(publicOperation);
    sendJson(response, 200, { operations: listed });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/fleet-summary") {
    const operations = runs.list();
    const waitingOperationIds = new Set(approvals.listPending().flatMap((approval) => {
      const operation = runs.findByProviderRun(approval.providerId, approval.conversationId, approval.runId);
      return operation ? [operation.id] : [];
    }));
    sendJson(response, 200, {
      summary: {
        schema: 1,
        running: operations.filter((operation) => operation.status === "running"
          && !waitingOperationIds.has(operation.id)).length,
        waitingForApproval: waitingOperationIds.size,
        unknown: operations.filter((operation) => operation.status === "unknown"
          && !operation.acknowledgedAt).length,
        failed: operations.filter((operation) => operation.status === "failed").length,
        retainedOperations: operations.length,
        recoveryBlocked: workspaceChangeEngine?.recoveryStatus().blocked === true,
      },
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/run-policy") {
    sendJson(response, 200, {
      policy: journal.runPolicy(),
      limits: RUN_POLICY_CONFIG_LIMITS,
    });
    return;
  }

  if (request.method === "PUT" && url.pathname === "/api/run-policy") {
    assertSameOrigin(request);
    const value = await readJson(request);
    if (!isRecord(value)) throw new HttpError(400, "Run policy body is invalid");
    const allowedFields = new Set([
      "emergencyStop",
      "maxOutputTokens",
      "maxTotalTokens",
      "maxRunCostMicrosUsd",
      "dailyTokenWarning",
      "monthlyCostSoftLimitMicrosUsd",
      "confirm",
    ]);
    if (Object.keys(value).some((key) => !allowedFields.has(key))) {
      throw new HttpError(400, "Run policy body contains an unsupported field");
    }
    if (value.confirm !== "apply-run-policy") {
      throw new HttpError(400, "Explicit run policy confirmation is required");
    }
    if (typeof value.emergencyStop !== "boolean") throw new HttpError(400, "emergencyStop must be boolean");
    const policy = journal.updateRunPolicy({
      emergencyStop: value.emergencyStop,
      maxOutputTokens: requiredBoundedInteger(
        value.maxOutputTokens,
        RUN_POLICY_CONFIG_LIMITS.maxOutputTokens.minimum,
        RUN_POLICY_CONFIG_LIMITS.maxOutputTokens.maximum,
        "maxOutputTokens",
      ),
      maxTotalTokens: requiredBoundedInteger(
        value.maxTotalTokens,
        RUN_POLICY_CONFIG_LIMITS.maxTotalTokens.minimum,
        RUN_POLICY_CONFIG_LIMITS.maxTotalTokens.maximum,
        "maxTotalTokens",
      ),
      maxRunCostMicrosUsd: requiredBoundedInteger(
        value.maxRunCostMicrosUsd,
        RUN_POLICY_CONFIG_LIMITS.maxRunCostMicrosUsd.minimum,
        RUN_POLICY_CONFIG_LIMITS.maxRunCostMicrosUsd.maximum,
        "maxRunCostMicrosUsd",
      ),
      dailyTokenWarning: requiredBoundedInteger(
        value.dailyTokenWarning,
        RUN_POLICY_CONFIG_LIMITS.dailyTokenWarning.minimum,
        RUN_POLICY_CONFIG_LIMITS.dailyTokenWarning.maximum,
        "dailyTokenWarning",
      ),
      monthlyCostSoftLimitMicrosUsd: requiredBoundedInteger(
        value.monthlyCostSoftLimitMicrosUsd,
        RUN_POLICY_CONFIG_LIMITS.monthlyCostSoftLimitMicrosUsd.minimum,
        RUN_POLICY_CONFIG_LIMITS.monthlyCostSoftLimitMicrosUsd.maximum,
        "monthlyCostSoftLimitMicrosUsd",
      ),
    });
    broadcast(sseClients, { type: "run_policy", action: "updated", runPolicy: policy });
    sendJson(response, 200, { policy, limits: RUN_POLICY_CONFIG_LIMITS });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/run-policy/preflight") {
    assertSameOrigin(request);
    const value = await readJson(request);
    if (!isRecord(value)) throw new HttpError(400, "Run policy preflight body is invalid");
    const allowedFields = new Set(["provider", "accountId", "model", "routing", "attachments"]);
    if (Object.keys(value).some((key) => !allowedFields.has(key))) {
      throw new HttpError(400, "Run policy preflight body contains an unsupported field");
    }
    const providerId = optionalString(value.provider, "provider", 40) ?? "codex";
    const accountId = optionalString(value.accountId, "accountId", 100);
    const model = optionalString(value.model, "model", 200);
    const routing = optionalRoutingSelection(value.routing);
    if (routing && providerId !== "openrouter") {
      throw new HttpError(400, "upstream routing is only available for OpenRouter");
    }
    const attachmentIds = optionalStringArray(value.attachments, "attachments", 4, 200);
    const attachmentCount = media.resolveForTurn(attachmentIds).imagePaths.length;
    const preflight = await runPolicy.preflight({
      providerId,
      ...(accountId ? { accountId } : {}),
      ...(model ? { model } : {}),
      ...(routing ? { routing } : {}),
      attachmentCount,
    }, runs.list());
    sendJson(response, 200, { preflight });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/approvals") {
    const pending = approvals.listPending().flatMap((approval) => {
      const operation = runs.findByProviderRun(approval.providerId, approval.conversationId, approval.runId);
      return operation ? [publicApproval(approval, operation)] : [];
    });
    sendJson(response, 200, { approvals: pending });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/journal/policy") {
    const requestedWorkspace = url.searchParams.get("workspace");
    const workspace = requestedWorkspace ? await options.paths.resolveWorkspace(requestedWorkspace) : undefined;
    sendJson(response, 200, {
      policy: journal.policy(),
      limits: journal.policyLimits(),
      ...(workspace ? { workspace, summary: journal.workspaceSummary(workspace) } : {}),
    });
    return;
  }

  if (request.method === "PUT" && url.pathname === "/api/journal/policy") {
    assertSameOrigin(request);
    const value = await readJson(request);
    if (!isRecord(value)) throw new HttpError(400, "Journal policy body is invalid");
    const allowedFields = new Set(["retentionMs", "maxOperations", "maxEvents", "confirm"]);
    if (Object.keys(value).some((key) => !allowedFields.has(key))) {
      throw new HttpError(400, "Journal policy body contains an unsupported field");
    }
    if (value.confirm !== "apply-retention-policy") {
      throw new HttpError(400, "Explicit journal policy confirmation is required");
    }
    const policy = journal.updatePolicy({
      retentionMs: requiredBoundedInteger(
        value.retentionMs,
        EVENT_JOURNAL_POLICY_LIMITS.retentionMs.minimum,
        EVENT_JOURNAL_POLICY_LIMITS.retentionMs.maximum,
        "retentionMs",
      ),
      maxOperations: requiredBoundedInteger(
        value.maxOperations,
        EVENT_JOURNAL_POLICY_LIMITS.maxOperations.minimum,
        EVENT_JOURNAL_POLICY_LIMITS.maxOperations.maximum,
        "maxOperations",
      ),
      maxEvents: requiredBoundedInteger(
        value.maxEvents,
        EVENT_JOURNAL_POLICY_LIMITS.maxEvents.minimum,
        EVENT_JOURNAL_POLICY_LIMITS.maxEvents.maximum,
        "maxEvents",
      ),
    });
    runs.updateRetentionPolicy(policy);
    broadcast(sseClients, { type: "journal", action: "policy_updated", policy });
    sendJson(response, 200, { policy, limits: journal.policyLimits() });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/journal/export") {
    const workspace = await options.paths.resolveWorkspace(
      requiredString(url.searchParams.get("workspace"), "workspace", 4_096),
    );
    sendJsonDownload(response, journal.exportWorkspace(workspace), `codex-pocket-journal-${Date.now()}.json`);
    return;
  }

  if (request.method === "DELETE" && url.pathname === "/api/journal/workspace") {
    assertSameOrigin(request);
    const body = await readJson(request) as { workspace?: unknown; confirm?: unknown };
    const workspace = await options.paths.resolveWorkspace(requiredString(body.workspace, "workspace", 4_096));
    if (body.confirm !== "delete-companion-history") {
      throw new HttpError(400, "Explicit journal deletion confirmation is required");
    }
    const before = journal.workspaceSummary(workspace);
    const deleted = runs.deleteWorkspaceHistory(workspace);
    const after = journal.workspaceSummary(workspace);
    const result = {
      workspace,
      deletedOperations: deleted.deletedOperationIds.length,
      deletedEvents: Math.max(0, before.eventCount - after.eventCount),
    };
    broadcast(sseClients, { type: "journal", action: "history_deleted", ...result });
    sendJson(response, 200, result);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/run-forks/preview") {
    assertSameOrigin(request);
    const value = await readJson(request);
    if (!isRecord(value)) throw new HttpError(400, "Provider fork preview body is invalid");
    const allowedFields = new Set([
      "sourceOperationId",
      "targetProvider",
      "accountId",
      "model",
      "effort",
      "networkAccess",
      "routing",
      "prompt",
      "attachments",
    ]);
    if (Object.keys(value).some((key) => !allowedFields.has(key))) {
      throw new HttpError(400, "Provider fork preview body contains an unsupported field");
    }
    const body = value as ForkPreviewBody;
    const sourceOperationId = requiredString(body.sourceOperationId, "sourceOperationId", 200);
    const source = runs.get(sourceOperationId);
    if (!source) throw new HttpError(404, "Fork source operation not found");
    options.paths.assertAllowed(source.cwd);
    const targetProvider = requiredString(body.targetProvider, "targetProvider", 40);
    const accountId = optionalString(body.accountId, "accountId", 100);
    const model = optionalString(body.model, "model", 200);
    const effort = optionalEnum(
      body.effort,
      ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const,
      "effort",
    );
    const routing = optionalRoutingSelection(body.routing);
    if (routing && targetProvider !== "openrouter") {
      throw new HttpError(400, "upstream routing is only available for OpenRouter");
    }
    const networkAccess = optionalBoolean(body.networkAccess, false, "networkAccess");
    const prompt = requiredString(body.prompt, "prompt", 100_000);
    const attachmentIds = optionalStringArray(body.attachments, "attachments", 4, 200);
    const attachmentInput = media.resolveForTurn(attachmentIds);
    providers.assertRunnable(targetProvider, accountId);
    const preflight = await runPolicy.preflight({
      providerId: targetProvider,
      ...(accountId ? { accountId } : {}),
      ...(model ? { model } : {}),
      ...(routing ? { routing } : {}),
      attachmentCount: attachmentInput.imagePaths.length,
    }, runs.list());
    const selection: RunForkSelection = {
      targetProviderId: targetProvider,
      ...(accountId ? { accountId } : {}),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(routing ? { routing } : {}),
      networkAccess,
      prompt,
      attachmentIds,
    };
    const preview = runForks.create({
      clientId: authenticatedClient.id,
      source,
      selection,
      attachments: attachmentInput,
      policy: preflight.snapshot,
      ...(preflight.confirmationToken ? { policyConfirmation: preflight.confirmationToken } : {}),
    });
    sendJson(response, 201, { preview });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/runs") {
    assertSameOrigin(request);
    const body = (await readJson(request)) as RunBody;
    const requestId = optionalString(body.requestId, "requestId", 200);
    const forkPreviewId = optionalString(body.forkPreviewId, "forkPreviewId", 200);
    const prompt = requiredString(body.prompt, "prompt", 100_000);
    const provider = optionalString(body.provider, "provider", 40) ?? "codex";
    const accountId = optionalString(body.accountId, "accountId", 100);
    const threadId = optionalString(body.threadId, "threadId", 200);
    const requestedConversationId = optionalString(body.conversationId, "conversationId", 200);
    if (threadId && provider !== "codex") {
      throw new HttpError(409, "threadId is reserved for Codex conversations; use conversationId for this provider");
    }
    if (threadId && requestedConversationId && threadId !== requestedConversationId) {
      throw new HttpError(400, "threadId and conversationId must identify the same Codex conversation");
    }
    const effort = optionalEnum(
      body.effort,
      ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const,
      "effort",
    );
    const model = optionalString(body.model, "model", 200);
    const routing = optionalRoutingSelection(body.routing);
    if (routing && provider !== "openrouter") {
      throw new HttpError(400, "upstream routing is only available for OpenRouter");
    }
    const networkAccess = optionalBoolean(body.networkAccess, false, "networkAccess");
    const policyConfirmation = optionalString(body.policyConfirmation, "policyConfirmation", 200);
    const timeoutSeconds = optionalInteger(body.timeoutSeconds, 30, 3600, 900, "timeoutSeconds");
    const attachmentIds = optionalStringArray(body.attachments, "attachments", 4, 200);
    const selection: RunForkSelection = {
      targetProviderId: provider,
      ...(accountId ? { accountId } : {}),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(routing ? { routing } : {}),
      networkAccess,
      prompt,
      attachmentIds,
    };
    const requestedCwd = optionalString(body.cwd, "cwd", 4_096);
    let conversationId = requestedConversationId ?? threadId;
    let cwd: string;
    let providerPrompt: string;
    let imagePaths: string[];
    let effectivePolicyConfirmation = policyConfirmation;
    let fork: RunForkProvenance | undefined;
    if (forkPreviewId) {
      if (!requestId) throw new HttpError(400, "Provider fork confirmation requires requestId");
      if (threadId || requestedConversationId) {
        throw new HttpError(409, "Provider fork always starts a new conversation");
      }
      if (policyConfirmation) {
        throw new HttpError(400, "Provider fork policy confirmation is owned by its preview");
      }
      const sourceOperationId = runForks.sourceOperationId(forkPreviewId, authenticatedClient.id);
      const source = runs.get(sourceOperationId);
      if (!source) throw new HttpError(409, "Fork source operation is no longer retained");
      options.paths.assertAllowed(source.cwd);
      const sourceWorkspace = await options.paths.resolveWorkspace(source.cwd);
      cwd = await options.paths.resolveWorkspace(requestedCwd ?? sourceWorkspace);
      if (cwd !== sourceWorkspace) {
        throw new HttpError(409, "Provider fork cannot move context to another workspace");
      }
      const prepared = runForks.claim({
        previewId: forkPreviewId,
        clientId: authenticatedClient.id,
        requestId,
        source,
        selection,
      });
      conversationId = undefined;
      providerPrompt = prepared.providerPrompt;
      imagePaths = prepared.imagePaths;
      effectivePolicyConfirmation = prepared.policyConfirmation;
      fork = prepared.provenance;
    } else {
      if (conversationId && provider === "codex") {
        const existing = await options.client.readThread(conversationId, false);
        options.paths.assertAllowed(existing.thread.cwd);
        cwd = await options.paths.resolveWorkspace(requestedCwd ?? existing.thread.cwd);
        const threadWorkspace = await options.paths.resolveWorkspace(existing.thread.cwd);
        if (!containsWorkspace(cwd, threadWorkspace)) {
          throw new HttpError(409, "Thread does not belong to the selected workspace");
        }
      } else {
        cwd = await options.paths.resolveWorkspace(requestedCwd);
      }
      const attachmentInput = media.resolveForTurn(attachmentIds);
      providerPrompt = `${prompt}${attachmentInput.promptContext}`;
      imagePaths = attachmentInput.imagePaths;
    }
    const operation = await runs.start({
      providerId: provider,
      accountId,
      prompt,
      input: {
        conversationId,
        cwd,
        prompt: providerPrompt,
        imagePaths,
        networkAccess,
        model,
        effort,
        routing,
        timeoutMs: timeoutSeconds * 1_000,
      },
      workspaceIdentity: await inspectWorkspaceIdentity(cwd),
      idempotencyKey: requestId ? `${authenticatedClient.id}:${requestId}` : undefined,
      policyConfirmation: effectivePolicyConfirmation,
      fork,
    });
    sendJson(response, 202, { operation: publicOperation(operation) });
    return;
  }

  const operationMatch = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
  if (request.method === "GET" && operationMatch) {
    const operation = runs.get(decodeURIComponent(operationMatch[1]!));
    if (!operation) throw new HttpError(404, "Operation not found");
    sendJson(response, 200, { operation: publicOperation(operation) });
    return;
  }

  const operationMetadataMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/metadata$/);
  if (request.method === "PATCH" && operationMetadataMatch) {
    assertSameOrigin(request);
    const value = await readJson(request);
    if (!isRecord(value)) throw new HttpError(400, "Operation metadata body is invalid");
    const allowedFields = new Set(["goalName", "pinned", "archived"]);
    if (Object.keys(value).some((key) => !allowedFields.has(key))) {
      throw new HttpError(400, "Operation metadata body contains an unsupported field");
    }
    const patch: RunOperationMetadataPatch = {};
    if (Object.hasOwn(value, "goalName")) {
      if (value.goalName !== null && typeof value.goalName !== "string") {
        throw new HttpError(400, "goalName must be a string or null");
      }
      patch.goalName = value.goalName;
    }
    for (const field of ["pinned", "archived"] as const) {
      if (!Object.hasOwn(value, field)) continue;
      if (typeof value[field] !== "boolean") throw new HttpError(400, `${field} must be a boolean`);
      patch[field] = value[field];
    }
    const operationId = decodeURIComponent(operationMetadataMatch[1]!);
    const operation = runs.get(operationId);
    if (!operation) throw new HttpError(404, "Operation not found");
    options.paths.assertAllowed(operation.cwd);
    sendJson(response, 200, { operation: publicOperation(runs.updateMetadata(operationId, patch)) });
    return;
  }

  const steerMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/steer$/);
  if (request.method === "POST" && steerMatch) {
    assertSameOrigin(request);
    const body = await readJson(request) as SteerBody;
    if (!isRecord(body) || Object.keys(body).some((key) => !["requestId", "prompt", "attachments"].includes(key))) {
      throw new HttpError(400, "Run steer body contains an unsupported field");
    }
    const operationId = decodeURIComponent(steerMatch[1]!);
    const operation = runs.get(operationId);
    if (!operation) throw new HttpError(404, "Operation not found");
    options.paths.assertAllowed(operation.cwd);
    const requestId = requiredString(body.requestId, "requestId", 200);
    const prompt = requiredString(body.prompt, "prompt", 100_000);
    const attachmentIds = optionalStringArray(body.attachments, "attachments", 4, 200);
    const attachmentInput = media.resolveForTurn(attachmentIds);
    const updated = await runs.steer(operationId, {
      requestId: `${authenticatedClient.id}:${requestId}`,
      prompt,
      input: {
        prompt: `${prompt}${attachmentInput.promptContext}`,
        imagePaths: attachmentInput.imagePaths,
      },
    });
    sendJson(response, 200, { operation: publicOperation(updated) });
    return;
  }

  const interruptMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/interrupt$/);
  if (request.method === "POST" && interruptMatch) {
    assertSameOrigin(request);
    await readJson(request, true);
    const operationId = decodeURIComponent(interruptMatch[1]!);
    const operation = runs.get(operationId);
    if (!operation) throw new HttpError(404, "Operation not found");
    options.paths.assertAllowed(operation.cwd);
    const cancelled = await runs.cancel(operationId);
    sendJson(response, 200, {
      operation: publicOperation(cancelled.operation),
      interruptRequested: cancelled.interruptRequested,
    });
    return;
  }

  const acknowledgeMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/acknowledge$/);
  if (request.method === "POST" && acknowledgeMatch) {
    assertSameOrigin(request);
    await readJson(request, true);
    const operationId = decodeURIComponent(acknowledgeMatch[1]!);
    const operation = runs.get(operationId);
    if (!operation) throw new HttpError(404, "Operation not found");
    options.paths.assertAllowed(operation.cwd);
    sendJson(response, 200, { operation: publicOperation(runs.acknowledge(operationId)) });
    return;
  }

  const approvalDecisionMatch = url.pathname.match(/^\/api\/approvals\/([^/]+)\/decision$/);
  if (request.method === "POST" && approvalDecisionMatch) {
    assertSameOrigin(request);
    const body = await readJson(request) as { decision?: unknown };
    const decision = requiredString(body.decision, "decision", 20);
    if (decision !== "approved" && decision !== "declined") {
      throw new HttpError(400, "decision must be approved or declined");
    }
    const approvalId = decodeURIComponent(approvalDecisionMatch[1]!);
    const approval = approvals.get(approvalId);
    if (!approval) throw new HttpError(404, "Approval request not found");
    const operation = runs.findByProviderRun(approval.providerId, approval.conversationId, approval.runId);
    if (!operation) throw new HttpError(409, "Approval request no longer belongs to a retained run");
    options.paths.assertAllowed(operation.cwd);
    const resolution = approvals.resolve(approvalId, decision, "touch");
    sendJson(response, 200, {
      approval: publicApproval(approvals.get(approvalId)!, operation),
      resolution,
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/pairing/revoke") {
    assertSameOrigin(request);
    await readJson(request, true);
    await auth.revoke(authenticatedClient.id);
    sendJson(response, 200, { revoked: true });
    return;
  }

  throw new HttpError(404, "API route not found");
}

function sanitizeNotification(notification: ProviderEvent): Record<string, unknown> | null {
  const threadId = notification.conversationId;
  if (notification.providerId !== "codex") return sanitizeCommonProviderEvent(notification);

  switch (notification.kind) {
    case "output.delta":
      return {
        type: "codex",
        providerId: notification.providerId,
        method: "item/agentMessage/delta",
        params: {
          threadId,
          turnId: notification.runId,
          itemId: notification.itemId,
          delta: notification.delta,
        },
      };
    case "workspace.diff":
      return {
        type: "codex",
        providerId: notification.providerId,
        method: "turn/diff/updated",
        params: { threadId, turnId: notification.runId, diff: truncateText(notification.diff) },
      };
    case "run.started":
    case "run.completed":
      return {
        type: "codex",
        providerId: notification.providerId,
        method: notification.kind === "run.started" ? "turn/started" : "turn/completed",
        params: {
          threadId,
          turnId: notification.runId,
          status: notification.status,
        },
      };
    case "tool.started":
    case "tool.completed": {
      const item = notification.tool;
      return {
        type: "codex",
        providerId: notification.providerId,
        method: notification.kind === "tool.started" ? "item/started" : "item/completed",
        params: {
          threadId,
          turnId: notification.runId,
          item: {
            type: item.type,
            id: item.id,
            command: truncateText(item.command, 4_000),
            status: item.status,
            paths: item.paths,
          },
        },
      };
    }
    case "run.failed":
      return {
        type: "codex",
        providerId: notification.providerId,
        method: "error",
        params: { threadId, turnId: notification.runId, message: truncateText(notification.message, 4_000) },
      };
    case "warning":
      return {
        type: "codex",
        providerId: notification.providerId,
        method: "warning",
        params: { threadId, turnId: notification.runId, message: truncateText(notification.message, 4_000) },
      };
    default:
      return null;
  }
}

function sanitizeCommonProviderEvent(notification: ProviderEvent): Record<string, unknown> {
  const base = {
    type: "provider",
    providerId: notification.providerId,
    conversationId: notification.conversationId,
    runId: notification.runId,
    eventId: notification.eventId,
    sequence: notification.sequence,
    kind: notification.kind,
  };
  switch (notification.kind) {
    case "output.delta":
      return { ...base, delta: truncateText(notification.delta) };
    case "workspace.diff":
      return { ...base, diff: truncateText(notification.diff) };
    case "tool.started":
    case "tool.completed":
      return {
        ...base,
        tool: {
          ...notification.tool,
          command: truncateText(notification.tool.command, 4_000),
          paths: notification.tool.paths?.slice(0, 200),
        },
      };
    case "usage.updated":
      return { ...base, usage: notification.usage };
    case "run.started":
    case "run.completed":
      return { ...base, status: notification.status };
    case "run.failed":
    case "warning":
      return { ...base, message: truncateText(notification.message, 4_000) };
  }
}

async function serveStatic(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  staticDir: string,
): Promise<void> {
  if (request.method !== "GET" && request.method !== "HEAD") throw new HttpError(405, "Method not allowed");
  const filename = STATIC_FILES.get(pathname);
  if (!filename) throw new HttpError(404, "Not found");
  const filePath = join(staticDir, filename);
  const info = await stat(filePath).catch(() => null);
  if (!info?.isFile()) throw new HttpError(404, "Static asset not found");
  response.statusCode = 200;
  response.setHeader("Content-Type", contentType(filename));
  response.setHeader("Content-Length", info.size);
  response.setHeader("Cache-Control", pathname === "/sw.js" ? "no-cache" : "public, max-age=300");
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.once("error", reject);
    response.once("finish", resolve);
    stream.pipe(response);
  });
}

async function serveFile(
  request: IncomingMessage,
  response: ServerResponse,
  filePath: string,
  type: string,
  cacheControl: string,
): Promise<void> {
  if (request.method !== "GET" && request.method !== "HEAD") throw new HttpError(405, "Method not allowed");
  const info = await stat(filePath).catch(() => null);
  if (!info?.isFile()) throw new HttpError(404, "File not found");
  response.statusCode = 200;
  response.setHeader("Content-Type", type);
  response.setHeader("Content-Length", info.size);
  response.setHeader("Cache-Control", cacheControl);
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.once("error", reject);
    response.once("finish", resolve);
    stream.pipe(response);
  });
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; connect-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  );
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(self), geolocation=()");
}

function assertSameOrigin(request: IncomingMessage): void {
  if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "application/json required");
  }
  assertWriteOrigin(request);
}

function assertWriteOrigin(request: IncomingMessage): void {
  const origin = request.headers.origin;
  if (!origin) throw new HttpError(403, "Origin header required for write requests");
  const host = request.headers.host;
  try {
    const parsed = new URL(origin);
    const sameLoopbackOrigin = Boolean(host && parsed.host === host && isLoopbackName(parsed.hostname));
    if (!sameLoopbackOrigin && !NATIVE_APP_ORIGINS.has(origin) && !NATIVE_APP_ORIGINS.has(parsed.origin)) {
      throw new Error("mismatch");
    }
  } catch {
    throw new HttpError(403, "Cross-origin write request blocked");
  }
}

function applyApiCors(request: IncomingMessage, response: ServerResponse): void {
  const origin = request.headers.origin;
  if (!origin) return;
  let allowedOrigin = NATIVE_APP_ORIGINS.has(origin) ? origin : "";
  try {
    const parsedOrigin = new URL(origin).origin;
    if (!allowedOrigin && NATIVE_APP_ORIGINS.has(parsedOrigin)) allowedOrigin = parsedOrigin;
  } catch {
    return;
  }
  if (!allowedOrigin) return;
  response.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  response.setHeader("Access-Control-Allow-Methods", "DELETE, GET, PATCH, POST, PUT, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Last-Event-ID");
  response.setHeader("Vary", "Origin");
}

async function readJson(request: IncomingMessage, allowEmpty = false): Promise<unknown> {
  let total = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new HttpError(413, "Request body too large");
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text && allowEmpty) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent) return;
  const body = JSON.stringify(value);
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", Buffer.byteLength(body));
  response.end(body);
}

function sendJsonDownload(response: ServerResponse, value: unknown, filename: string): void {
  if (response.headersSent) return;
  const body = `${JSON.stringify(value, null, 2)}\n`;
  response.statusCode = 200;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Content-Length", Buffer.byteLength(body));
  response.end(body);
}

function sendError(response: ServerResponse, error: unknown): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  const status = error instanceof HttpError
    ? error.status
    : error instanceof MediaError
      || error instanceof ProjectCreationError
      || error instanceof ProviderError
      || error instanceof GatewayAuthError
      || error instanceof RunCoordinatorError
      || error instanceof ApprovalBrokerError
      || error instanceof EventJournalExportError
      || error instanceof RunPolicyError
      || error instanceof RunForkManagerError
      ? error.statusCode
      : 500;
  const message = error instanceof Error ? error.message : String(error);
  if (status >= 500) process.stderr.write(`[codex-web] ${message}\n`);
  sendJson(response, status, {
    error: message,
    ...(error instanceof GatewayAuthError ? { code: error.code } : {}),
  });
}

function broadcast(clients: Set<ServerResponse>, event: Record<string, unknown>): void {
  const frame = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of clients) client.write(frame);
}

function appendAndBroadcast(
  journal: EventJournal,
  clients: Set<ServerResponse>,
  notificationClients: Set<ServerResponse>,
  operationId: string,
  cwd: string,
  event: Record<string, unknown>,
): void {
  try {
    const persisted = journal.appendEvent(operationId, cwd, event);
    const frame = journalFrame(persisted);
    for (const client of clients) client.write(frame);
    const notification = workNotification(event);
    if (notification) {
      const notificationFrame = journalFrame({ ...persisted, event: notification });
      for (const client of notificationClients) client.write(notificationFrame);
    }
  } catch (error) {
    process.stderr.write(`[codex-event-journal] Event persistence failed: ${safeInternalError(error)}\n`);
    broadcast(clients, event);
  }
}

function workNotification(event: Record<string, unknown>): Record<string, unknown> | null {
  if (event.type === "operation" && (event.action === "completed" || event.action === "failed")) {
    const operation = isRecord(event.operation) ? event.operation : {};
    const operationId = boundedIdentifier(operation.id, 200);
    const occurredAt = isoTimestamp(operation.completedAt);
    if (!operationId || !occurredAt) return null;
    return {
      schema: 1,
      type: "work_notification",
      kind: event.action === "failed" ? "failed" : "completed",
      operationId,
      occurredAt,
    };
  }
  if (event.type === "approval" && event.action === "requested") {
    const approval = isRecord(event.approval) ? event.approval : {};
    const operationId = boundedIdentifier(approval.operationId, 200);
    const occurredAt = isoTimestamp(approval.requestedAt);
    const expiresAt = isoTimestamp(approval.expiresAt);
    if (!operationId || !occurredAt || !expiresAt) return null;
    return {
      schema: 1,
      type: "work_notification",
      kind: "approval",
      operationId,
      occurredAt,
      expiresAt,
    };
  }
  return null;
}

function boundedIdentifier(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maximum
    && !/[\x00-\x1f\x7f]/.test(value)
    ? value
    : undefined;
}

function isoTimestamp(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value))
    ? value
    : undefined;
}

function journalFrame(event: JournalReplayEvent): string {
  return `id: ${event.cursor}\ndata: ${JSON.stringify(event.event)}\n\n`;
}

function eventCursor(value: string | string[] | undefined): number | undefined {
  if (value === undefined) return undefined;
  const normalized = Array.isArray(value) ? value[0] : value;
  if (!normalized || !/^[0-9]{1,16}$/.test(normalized)) throw new HttpError(400, "Invalid Last-Event-ID");
  const cursor = Number(normalized);
  if (!Number.isSafeInteger(cursor)) throw new HttpError(400, "Invalid Last-Event-ID");
  return cursor;
}

function safeInternalError(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message.replace(/[\r\n]/g, " ").slice(0, 500)
    : "unknown journal error";
}

function publicOperation(operation: RunOperation): Record<string, unknown> {
  const { resumeState, steers, fork, ...visible } = operation;
  const publicFork = fork ? publicRunFork(fork) : undefined;
  return {
    ...visible,
    ...(steers ? {
      steers: steers.map(({
        requestFingerprint: _requestFingerprint,
        requestId: _requestId,
        ...steer
      }) => steer),
    } : {}),
    ...(publicFork ? { fork: publicFork } : {}),
    resumable: resumeState !== undefined,
    ...(operation.providerId === "codex"
      ? { threadId: operation.conversationId, turnId: operation.runId }
      : {}),
  };
}

function publicRunFork(fork: RunForkProvenance): Omit<RunForkProvenance, "contextDigest"> {
  const { contextDigest: _contextDigest, ...visible } = fork;
  return visible;
}

async function handoffMatchesWorkspace(
  handoff: SessionHandoff,
  options: WebServerOptions,
  runs: RunCoordinator,
): Promise<boolean> {
  try {
    const workspace = await options.paths.resolveWorkspace(handoff.workspace);
    const read = await options.client.readThread(handoff.threadId, false);
    const threadWorkspace = await options.paths.resolveWorkspace(read.thread.cwd);
    if (!containsWorkspace(workspace, threadWorkspace)) return false;
    const operation = handoff.operationId ? runs.get(handoff.operationId) : undefined;
    return !operation || (
      operation.providerId === "codex"
      && operation.conversationId === handoff.threadId
      && operation.cwd === workspace
    );
  } catch {
    return false;
  }
}

function containsWorkspace(workspace: string, candidate: string): boolean {
  const nested = relative(workspace, candidate);
  return nested === "" || (!isAbsolute(nested) && nested !== ".." && !nested.startsWith(`..${sep}`));
}

function publicApproval(approval: ApprovalRequest, operation: RunOperation): Record<string, unknown> {
  return {
    id: approval.id,
    operationId: operation.id,
    cwd: operation.cwd,
    providerId: approval.providerId,
    conversationId: approval.conversationId,
    runId: approval.runId,
    toolCallId: approval.toolCallId,
    risk: approval.risk,
    redactedSummary: approval.redactedSummary,
    redactedDetails: approval.redactedDetails,
    status: approval.status,
    requiresTouch: approval.requiresTouch,
    requestedAt: approval.requestedAt,
    expiresAt: approval.expiresAt,
  };
}

function requiredString(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) throw new HttpError(400, `${name} is required`);
  if (value.length > max) throw new HttpError(400, `${name} is too long`);
  return value.trim();
}

function optionalString(value: unknown, name: string, max: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > max) throw new HttpError(400, `${name} is invalid`);
  return value;
}

function optionalInteger(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
  name: string,
): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new HttpError(400, `${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function optionalBoolean(value: unknown, fallback: boolean, name: string): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") throw new HttpError(400, `${name} must be a boolean`);
  return value;
}

function requiredBoundedInteger(value: unknown, min: number, max: number, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new HttpError(400, `${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function optionalEnum<const T extends readonly string[]>(
  value: unknown,
  choices: T,
  name: string,
): T[number] | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !choices.includes(value)) throw new HttpError(400, `${name} is invalid`);
  return value as T[number];
}

function optionalStringArray(
  value: unknown,
  name: string,
  maxItems: number,
  maxLength: number,
): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maxItems) throw new HttpError(400, `${name} is invalid`);
  return value.map((item) => {
    if (typeof item !== "string" || !item || item.length > maxLength) throw new HttpError(400, `${name} is invalid`);
    return item;
  });
}

function optionalRoutingSelection(value: unknown): ProviderRoutingSelection | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value) || !hasExactKeys(value, ["upstreams", "allowFallbacks"])) {
    throw new HttpError(400, "routing is invalid");
  }
  const upstreams = optionalStringArray(value.upstreams, "routing.upstreams", 4, 120);
  if (upstreams.length === 0 || new Set(upstreams).size !== upstreams.length
      || upstreams.some((upstream) => !/^[a-z0-9][a-z0-9._/-]*$/.test(upstream))) {
    throw new HttpError(400, "routing.upstreams is invalid");
  }
  if (typeof value.allowFallbacks !== "boolean") throw new HttpError(400, "routing.allowFallbacks is invalid");
  if (value.allowFallbacks ? upstreams.length < 2 : upstreams.length !== 1) {
    throw new HttpError(400, "routing fallback policy does not match the selected upstreams");
  }
  return { upstreams, allowFallbacks: value.allowFallbacks };
}

function isLoopbackHostHeader(host: string): boolean {
  try {
    return isLoopbackName(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
}

function isLoopbackName(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && actual.every((key) => expected.includes(key));
}

function truncateText(value: unknown, limit = MAX_EVENT_TEXT): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.length <= limit ? value : `${value.slice(0, limit)}\n… [truncated]`;
}

function contentType(filename: string): string {
  switch (extname(filename)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".webmanifest":
      return "application/manifest+json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}
