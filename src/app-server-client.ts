import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { InitializeResponse } from "../generated/app-server/InitializeResponse";
import type { Thread } from "../generated/app-server/v2/Thread";
import type { ThreadListResponse } from "../generated/app-server/v2/ThreadListResponse";
import type { ThreadReadResponse } from "../generated/app-server/v2/ThreadReadResponse";
import type { ThreadResumeResponse } from "../generated/app-server/v2/ThreadResumeResponse";
import type { ThreadStartResponse } from "../generated/app-server/v2/ThreadStartResponse";
import type { Turn } from "../generated/app-server/v2/Turn";
import type { TurnStartResponse } from "../generated/app-server/v2/TurnStartResponse";

type RpcId = number | string;
type JsonObject = Record<string, unknown>;

export interface AppServerNotification {
  method: string;
  params?: unknown;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

interface TurnWaiter {
  resolve(turn: Turn): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export interface RunTurnOptions {
  threadId?: string;
  cwd: string;
  prompt: string;
  networkAccess?: boolean;
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh";
  timeoutMs?: number;
}

export interface RunTurnResult {
  thread: Thread;
  turn: Turn;
}

export interface BeginTurnResult {
  thread: Thread;
  turn: Turn;
  completion: Promise<Turn>;
}

export interface AppServerClientOptions {
  command?: string;
  args?: string[];
  requestTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export class CodexAppServerClient {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private readonly pending = new Map<RpcId, PendingRequest>();
  private readonly turnWaiters = new Map<string, TurnWaiter>();
  private readonly completedTurns = new Map<string, Turn>();
  private readonly notificationListeners = new Set<(notification: AppServerNotification) => void>();
  private starting?: Promise<InitializeResponse>;
  private init?: InitializeResponse;

  constructor(private readonly options: AppServerClientOptions = {}) {}

  async start(): Promise<InitializeResponse> {
    if (this.init) return this.init;
    if (this.starting) return this.starting;
    this.starting = this.startInternal();
    try {
      this.init = await this.starting;
      return this.init;
    } finally {
      this.starting = undefined;
    }
  }

  get initializeResult(): InitializeResponse | undefined {
    return this.init;
  }

  async listThreads(limit = 10, searchTerm?: string): Promise<ThreadListResponse> {
    await this.start();
    return this.request<ThreadListResponse>("thread/list", {
      limit,
      sortKey: "updated_at",
      sortDirection: "desc",
      searchTerm: searchTerm ?? null,
    });
  }

  async readThread(threadId: string, includeTurns = true): Promise<ThreadReadResponse> {
    await this.start();
    return this.request<ThreadReadResponse>("thread/read", { threadId, includeTurns });
  }

  async runTurn(options: RunTurnOptions): Promise<RunTurnResult> {
    const started = await this.beginTurn(options);
    const turn = await started.completion;
    return { thread: started.thread, turn };
  }

  async beginTurn(options: RunTurnOptions): Promise<BeginTurnResult> {
    await this.start();
    let threadResponse: ThreadStartResponse | ThreadResumeResponse;

    if (options.threadId) {
      threadResponse = await this.request<ThreadResumeResponse>("thread/resume", {
        threadId: options.threadId,
        cwd: options.cwd,
        approvalPolicy: "never",
        sandbox: "workspace-write",
        model: options.model ?? null,
      });
    } else {
      threadResponse = await this.request<ThreadStartResponse>("thread/start", {
        cwd: options.cwd,
        approvalPolicy: "never",
        sandbox: "workspace-write",
        model: options.model ?? null,
        ephemeral: false,
      });
    }

    const thread = threadResponse.thread;
    const started = await this.request<TurnStartResponse>("turn/start", {
      threadId: thread.id,
      input: [{ type: "text", text: options.prompt, text_elements: [] }],
      cwd: options.cwd,
      approvalPolicy: "never",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: [options.cwd],
        networkAccess: options.networkAccess ?? false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
      model: options.model ?? null,
      effort: options.effort ?? null,
    });

    const completion = this.waitForTurn(
      started.turn.id,
      options.timeoutMs ?? 15 * 60_000,
    );
    return { thread, turn: started.turn, completion };
  }

  subscribe(listener: (notification: AppServerNotification) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  async interrupt(threadId: string, turnId: string): Promise<void> {
    await this.start();
    await this.request("turn/interrupt", { threadId, turnId });
  }

  async close(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.init = undefined;
    if (!child || child.exitCode !== null) return;
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const force = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
        resolve();
      }, 2_000);
      child.once("exit", () => {
        clearTimeout(force);
        resolve();
      });
    });
  }

  private async startInternal(): Promise<InitializeResponse> {
    const command = this.options.command ?? process.env.CODEX_BIN ?? "codex";
    const args = this.options.args ?? ["app-server", "--listen", "stdio://"];
    const child = spawn(command, args, {
      env: this.options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => this.handleLine(line));
    child.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    child.once("error", (error) => this.failAll(error));
    child.once("exit", (code, signal) => {
      this.child = undefined;
      this.init = undefined;
      this.failAll(new Error(`codex app-server exited (code=${code}, signal=${signal})`));
    });

    const initialized = await this.request<InitializeResponse>("initialize", {
      clientInfo: { name: "codex_voice_bridge", title: "Codex Voice Bridge", version: "0.1.0" },
      capabilities: null,
    });
    this.notify("initialized", {});
    return initialized;
  }

  private request<T = unknown>(method: string, params: unknown): Promise<T> {
    if (!this.child?.stdin.writable) {
      return Promise.reject(new Error("codex app-server is not running"));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`app-server request timed out: ${method}`));
      }, this.options.requestTimeoutMs ?? 30_000);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      this.write({ id, method, params });
    });
  }

  private notify(method: string, params: unknown): void {
    this.write({ method, params });
  }

  private write(message: JsonObject): void {
    if (!this.child?.stdin.writable) throw new Error("codex app-server stdin is closed");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    let message: JsonObject;
    try {
      message = JSON.parse(line) as JsonObject;
    } catch {
      process.stderr.write(`[codex-voice-bridge] Ignored non-JSON app-server line\n`);
      return;
    }

    if ("id" in message && "method" in message) {
      this.handleServerRequest(message);
      return;
    }
    if ("id" in message) {
      const id = message.id as RpcId;
      const pending = this.pending.get(id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      if (message.error) {
        const error = message.error as { message?: string; code?: number };
        pending.reject(new Error(error.message ?? `app-server error ${error.code ?? "unknown"}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.method === "turn/completed") {
      const params = message.params as { turn: Turn };
      const waiter = this.turnWaiters.get(params.turn.id);
      if (waiter) {
        clearTimeout(waiter.timer);
        this.turnWaiters.delete(params.turn.id);
        waiter.resolve(params.turn);
      } else {
        this.completedTurns.set(params.turn.id, params.turn);
      }
    }
    if (typeof message.method === "string") {
      const notification = { method: message.method, params: message.params };
      for (const listener of this.notificationListeners) {
        try {
          listener(notification);
        } catch (error) {
          process.stderr.write(`[codex-voice-bridge] Notification listener failed: ${String(error)}\n`);
        }
      }
    }
  }

  private handleServerRequest(message: JsonObject): void {
    const id = message.id as RpcId;
    const method = String(message.method);
    let result: unknown;
    switch (method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
        result = { decision: "decline" };
        break;
      case "applyPatchApproval":
      case "execCommandApproval":
        result = { decision: { denied: { rejection: "Remote bridge never grants elevated approval" } } };
        break;
      case "item/tool/requestUserInput":
        result = { answers: {} };
        break;
      case "mcpServer/elicitation/request":
        result = { action: "decline", content: null, _meta: null };
        break;
      case "currentTime/read":
        result = { currentTimeAt: Math.floor(Date.now() / 1000) };
        break;
      default:
        this.write({
          id,
          error: { code: -32601, message: `Remote bridge does not handle server request: ${method}` },
        });
        return;
    }
    this.write({ id, result });
  }

  private waitForTurn(turnId: string, timeoutMs: number): Promise<Turn> {
    const completed = this.completedTurns.get(turnId);
    if (completed) {
      this.completedTurns.delete(turnId);
      return Promise.resolve(completed);
    }
    return new Promise<Turn>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.turnWaiters.delete(turnId);
        reject(new Error(`Codex turn timed out after ${Math.round(timeoutMs / 1000)} seconds`));
      }, timeoutMs);
      this.turnWaiters.set(turnId, { resolve, reject, timer });
    });
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const waiter of this.turnWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.turnWaiters.clear();
  }
}
