import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { basename, dirname, extname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ThreadListResponse } from "../generated/app-server/v2/ThreadListResponse";
import type { ThreadReadResponse } from "../generated/app-server/v2/ThreadReadResponse";
import type { CodexProviderClient } from "./providers/codex-provider.js";
import type { ProviderEvent, ProviderRun } from "./providers/types.js";
import { PathPolicy } from "./path-policy.js";
import { compactThread, presentThread } from "./result.js";
import { MediaError, MediaManager } from "./media-manager.js";
import { ProjectCreationError, ProjectManager } from "./project-manager.js";
import { ProviderError, ProviderRegistry } from "./providers/registry.js";
import { ProviderLoginManager } from "./provider-login-manager.js";
import { GatewayAuth, GatewayAuthError } from "./gateway-auth.js";
import { APP_VERSION, GATEWAY_CAPABILITIES, GATEWAY_PROTOCOL_MINIMUM, GATEWAY_PROTOCOL_VERSION } from "./version.js";
import { collectSystemDiagnostics } from "./system-diagnostics.js";
import { SessionHandoffStore } from "./session-handoff-store.js";

const MAX_BODY_BYTES = 128 * 1024;
const MAX_EVENT_TEXT = 80_000;
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
}

export interface RunningWebServer {
  server: Server;
  host: string;
  port: number;
  deviceId: string;
  pairingCode: string;
  pairingExpiresAt: string;
  close(): Promise<void>;
}

type OperationStatus = "running" | "completed" | "interrupted" | "failed";

interface Operation {
  id: string;
  providerId: string;
  threadId: string;
  turnId: string;
  cwd: string;
  prompt: string;
  status: OperationStatus;
  startedAt: string;
  completedAt?: string;
  result?: Record<string, unknown>;
  error?: string;
}

interface RunBody {
  prompt?: unknown;
  cwd?: unknown;
  threadId?: unknown;
  networkAccess?: unknown;
  model?: unknown;
  effort?: unknown;
  timeoutSeconds?: unknown;
  attachments?: unknown;
  provider?: unknown;
  accountId?: unknown;
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
  const operations = new Map<string, Operation>();
  const activeThreads = new Set<string>();
  const media = options.media ?? new MediaManager({
    onUpdate: (item) => broadcast(sseClients, { type: "media", media: item }),
  });
  await media.initialize();
  const projects = options.projects ?? await ProjectManager.fromEnvironment(options.paths);
  const auth = options.auth ?? await GatewayAuth.create();
  const handoffs = options.handoffs ?? await SessionHandoffStore.create(
    process.env.CODEX_POCKET_HANDOFF_STATE ?? join(dirname(auth.stateFile), "session-handoff.json"),
  );
  const providers = new ProviderRegistry(options.client);
  const providerLogins = new ProviderLoginManager(providers);
  const unsubscribe = providers.subscribe((event) => {
    const forwarded = sanitizeNotification(event, activeThreads);
    if (forwarded) broadcast(sseClients, forwarded);
  });

  const server = createServer((request, response) => {
    void handleRequest(request, response, options, auth, handoffs, media, projects, providers, providerLogins, operations, activeThreads, sseClients).catch(
      (error) => sendError(response, error),
    );
  });
  server.requestTimeout = 0;
  server.headersTimeout = 30_000;

  const heartbeat = setInterval(() => {
    for (const response of sseClients) response.write(": heartbeat\n\n");
  }, 20_000);
  heartbeat.unref();

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Web server did not get a TCP address");

  return {
    server,
    host,
    port: address.port,
    deviceId: auth.device.id,
    pairingCode: auth.pairingCode,
    pairingExpiresAt: auth.pairingExpiresAt,
    async close() {
      clearInterval(heartbeat);
      providerLogins.close();
      unsubscribe();
      for (const response of sseClients) response.end();
      sseClients.clear();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
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
  operations: Map<string, Operation>,
  activeThreads: Set<string>,
  sseClients: Set<ServerResponse>,
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
    await handleApi(request, response, url, options, auth, handoffs, media, projects, providers, providerLogins, operations, activeThreads, sseClients);
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
  operations: Map<string, Operation>,
  activeThreads: Set<string>,
  sseClients: Set<ServerResponse>,
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
    sendJson(response, 201, await auth.claim(body.code, body.label));
    return;
  }

  const authenticatedClient = auth.requireAuthorization(request.headers.authorization);

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
    sendJson(response, 200, {
      device: auth.device,
      workspaces: projects.list(),
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
    sendJson(response, 201, { device: auth.device, project });
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
    const handoff = handoffs.current();
    const operation = handoff?.operationId ? operations.get(handoff.operationId) : undefined;
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
    const operation = requestedOperationId ? operations.get(requestedOperationId) : undefined;
    if (requestedOperationId && !operation) throw new HttpError(404, "Operation not found");
    const threadId = optionalString(body.threadId, "threadId", 200) ?? operation?.threadId;
    if (!threadId) throw new HttpError(400, "threadId is required");
    const read = await options.client.readThread(threadId, false);
    options.paths.assertAllowed(read.thread.cwd);
    const workspace = await options.paths.resolveWorkspace(
      optionalString(body.workspace, "workspace", 4_096) ?? operation?.cwd ?? read.thread.cwd,
    );
    if (operation && (operation.threadId !== threadId || operation.cwd !== workspace)) {
      throw new HttpError(409, "Operation does not belong to this session");
    }
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
    });
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
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    response.write(`data: ${JSON.stringify({ type: "connected", at: new Date().toISOString() })}\n\n`);
    sseClients.add(response);
    request.once("close", () => sseClients.delete(response));
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
    cleanupOperations(operations);
    const status = url.searchParams.get("status");
    const workspace = url.searchParams.get("workspace");
    if (workspace) options.paths.assertAllowed(workspace);
    const listed = [...operations.values()]
      .filter((operation) => (!status || operation.status === status) && (!workspace || operation.cwd === workspace))
      .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))
      .map(publicOperation);
    sendJson(response, 200, { operations: listed });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/runs") {
    assertSameOrigin(request);
    const body = (await readJson(request)) as RunBody;
    const prompt = requiredString(body.prompt, "prompt", 100_000);
    const provider = optionalString(body.provider, "provider", 40) ?? "codex";
    const accountId = optionalString(body.accountId, "accountId", 100);
    const threadId = optionalString(body.threadId, "threadId", 200);
    const requestedCwd = optionalString(body.cwd, "cwd", 4_096);
    let cwd: string;
    if (threadId) {
      const existing = await options.client.readThread(threadId, false);
      options.paths.assertAllowed(existing.thread.cwd);
      cwd = await options.paths.resolveWorkspace(requestedCwd ?? existing.thread.cwd);
    } else {
      cwd = await options.paths.resolveWorkspace(requestedCwd);
    }

    const effort = optionalEnum(
      body.effort,
      ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const,
      "effort",
    );
    const model = optionalString(body.model, "model", 200);
    const networkAccess = body.networkAccess === true;
    const timeoutSeconds = optionalInteger(body.timeoutSeconds, 30, 3600, 900, "timeoutSeconds");
    const attachmentIds = optionalStringArray(body.attachments, "attachments", 4, 200);
    const attachmentInput = media.resolveForTurn(attachmentIds);
    const begun = await providers.startRun(provider, accountId, {
      conversationId: threadId,
      cwd,
      prompt: `${prompt}${attachmentInput.promptContext}`,
      imagePaths: attachmentInput.imagePaths,
      networkAccess,
      model,
      effort,
      timeoutMs: timeoutSeconds * 1_000,
    });
    options.paths.assertAllowed(begun.cwd);

    const operation: Operation = {
      id: randomUUID(),
      providerId: begun.providerId,
      threadId: begun.conversationId,
      turnId: begun.runId,
      cwd: begun.cwd,
      prompt,
      status: "running",
      startedAt: new Date().toISOString(),
    };
    cleanupOperations(operations);
    operations.set(operation.id, operation);
    activeThreads.add(operation.threadId);
    broadcast(sseClients, { type: "operation", action: "started", operation: publicOperation(operation) });
    void settleOperation(operation, begun, operations, activeThreads, sseClients);
    sendJson(response, 202, { operation: publicOperation(operation) });
    return;
  }

  const operationMatch = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
  if (request.method === "GET" && operationMatch) {
    const operation = operations.get(decodeURIComponent(operationMatch[1]!));
    if (!operation) throw new HttpError(404, "Operation not found");
    sendJson(response, 200, { operation: publicOperation(operation) });
    return;
  }

  const interruptMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/interrupt$/);
  if (request.method === "POST" && interruptMatch) {
    assertSameOrigin(request);
    await readJson(request, true);
    const operation = operations.get(decodeURIComponent(interruptMatch[1]!));
    if (!operation) throw new HttpError(404, "Operation not found");
    options.paths.assertAllowed(operation.cwd);
    if (operation.status === "running") {
      await providers.cancelRun(operation.providerId, operation.threadId, operation.turnId);
    }
    sendJson(response, 200, { operation: publicOperation(operation), interruptRequested: true });
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

async function settleOperation(
  operation: Operation,
  begun: ProviderRun,
  operations: Map<string, Operation>,
  activeThreads: Set<string>,
  clients: Set<ServerResponse>,
): Promise<void> {
  try {
    const completed = await begun.completion;
    operation.status = completed.status;
    operation.completedAt = new Date().toISOString();
    operation.result = completed.result;
    broadcast(clients, { type: "operation", action: "completed", operation: publicOperation(operation) });
  } catch (error) {
    operation.status = "failed";
    operation.completedAt = new Date().toISOString();
    operation.error = error instanceof Error ? error.message : String(error);
    broadcast(clients, { type: "operation", action: "failed", operation: publicOperation(operation) });
  } finally {
    if (![...operations.values()].some((item) => item.threadId === operation.threadId && item.status === "running")) {
      activeThreads.delete(operation.threadId);
    }
  }
}

function sanitizeNotification(
  notification: ProviderEvent,
  activeThreads: Set<string>,
): Record<string, unknown> | null {
  const params = isRecord(notification.params) ? notification.params : {};
  const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
  if (!threadId || !activeThreads.has(threadId)) return null;

  switch (notification.method) {
    case "item/agentMessage/delta":
      return {
        type: "codex",
        providerId: notification.providerId,
        method: notification.method,
        params: pick(params, ["threadId", "turnId", "itemId", "delta"]),
      };
    case "turn/diff/updated":
      return {
        type: "codex",
        providerId: notification.providerId,
        method: notification.method,
        params: { ...pick(params, ["threadId", "turnId"]), diff: truncateText(params.diff) },
      };
    case "turn/started":
    case "turn/completed":
      return {
        type: "codex",
        providerId: notification.providerId,
        method: notification.method,
        params: {
          threadId,
          turnId: isRecord(params.turn) && typeof params.turn.id === "string" ? params.turn.id : undefined,
          status: isRecord(params.turn) ? params.turn.status : undefined,
        },
      };
    case "item/started":
    case "item/completed": {
      const item = isRecord(params.item) ? params.item : {};
      return {
        type: "codex",
        providerId: notification.providerId,
        method: notification.method,
        params: {
          ...pick(params, ["threadId", "turnId"]),
          item: {
            type: item.type,
            id: item.id,
            command: truncateText(item.command, 4_000),
            status: item.status,
            paths: Array.isArray(item.changes)
              ? item.changes
                  .filter(isRecord)
                  .map((change) => change.path)
                  .filter((path): path is string => typeof path === "string")
              : undefined,
          },
        },
      };
    }
    case "error":
    case "warning":
      return { type: "codex", providerId: notification.providerId, method: notification.method, params };
    default:
      return null;
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
  response.setHeader("Access-Control-Allow-Methods", "DELETE, GET, POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
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

function sendError(response: ServerResponse, error: unknown): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  const status = error instanceof HttpError
    ? error.status
    : error instanceof MediaError || error instanceof ProjectCreationError || error instanceof ProviderError || error instanceof GatewayAuthError
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

function publicOperation(operation: Operation): Record<string, unknown> {
  return { ...operation };
}

function cleanupOperations(operations: Map<string, Operation>): void {
  const cutoff = Date.now() - 6 * 60 * 60_000;
  for (const [id, operation] of operations) {
    if (operation.status !== "running" && Date.parse(operation.completedAt ?? operation.startedAt) < cutoff) {
      operations.delete(id);
    }
  }
  while (operations.size > 100) {
    const removable = [...operations.entries()].find(([, item]) => item.status !== "running");
    if (!removable) break;
    operations.delete(removable[0]);
  }
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

function pick(source: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));
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
