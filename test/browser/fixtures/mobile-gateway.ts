import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Thread } from "../../../generated/app-server/v2/Thread.js";
import type { ModelListResponse } from "../../../generated/app-server/v2/ModelListResponse.js";
import type { Turn } from "../../../generated/app-server/v2/Turn.js";
import type {
  AppServerNotification,
  BeginTurnResult,
  RunTurnOptions,
  SteerTurnOptions,
} from "../../../src/app-server-client.js";
import { InMemoryApprovalBroker } from "../../../src/approval-broker.js";
import { GatewayAuth } from "../../../src/gateway-auth.js";
import { MediaManager } from "../../../src/media-manager.js";
import { PathPolicy } from "../../../src/path-policy.js";
import { startWebServer, type WebCodexClient } from "../../../src/web-server.js";

const PAIRING_CODE = "12345678";
const LONG_PATH = `src/browser-fixture/${"deeply-nested-mobile-segment-".repeat(18)}acceptance.ts`;
const LONG_DIFF = [
  `diff --git a/${LONG_PATH} b/${LONG_PATH}`,
  `--- a/${LONG_PATH}`,
  `+++ b/${LONG_PATH}`,
  "@@ -1,2 +1,3 @@",
  `+export const syntheticMobileAcceptanceValue = "${"unbroken-layout-token-".repeat(42)}";`,
].join("\n");
const REVIEW_PATH = "src/browser-fixture/review.ts";
const REVIEW_DIFF = [
  `diff --git a/${REVIEW_PATH} b/${REVIEW_PATH}`,
  `--- a/${REVIEW_PATH}`,
  `+++ b/${REVIEW_PATH}`,
  "@@ -1 +1 @@",
  "-export const reviewed = false;",
  "+export const reviewed = true;",
].join("\n");

const workspace = resolve(process.cwd());
const port = Number(process.env.CODEX_POCKET_BROWSER_PORT ?? "41731");
if (!Number.isInteger(port) || port < 1_024 || port > 65_535) {
  throw new Error("CODEX_POCKET_BROWSER_PORT must be an unprivileged TCP port");
}

const stateDirectory = await mkdtemp(join(tmpdir(), "codex-pocket-browser-"));
const paths = await PathPolicy.fromEnvironment(workspace);
const auth = await GatewayAuth.create({
  stateFile: join(stateDirectory, "gateway-auth.json"),
  pairingCode: PAIRING_CODE,
  deviceKind: "linux",
  deviceName: "Browser fixture PC",
});
let approvalNumber = 0;
const approvals = new InMemoryApprovalBroker({
  createId: () => `approval-browser-${++approvalNumber}`,
});
interface PendingTurn {
  threadId: string;
  resolve(turn: Turn): void;
  timers: NodeJS.Timeout[];
}

class MobileAcceptanceClient implements WebCodexClient {
  private readonly listeners = new Set<(notification: AppServerNotification) => void>();
  private readonly pending = new Map<string, PendingTurn>();
  private runNumber = 0;

  constructor(private readonly approvals: InMemoryApprovalBroker) {}

  async start() {
    return {
      userAgent: "fake-codex-browser",
      codexHome: stateDirectory,
      platformFamily: "unix" as const,
      platformOs: "linux",
    };
  }

  async listThreads() {
    return {
      data: [
        mobileThread("thread-mobile"),
        mobileThread("thread-nested", resolve(workspace, "client")),
      ],
      nextCursor: null,
      backwardsCursor: null,
    };
  }

  async listModels(): Promise<ModelListResponse> {
    return {
      data: [{
        id: "browser-model",
        model: "browser-model",
        upgrade: null,
        upgradeInfo: null,
        availabilityNux: null,
        displayName: "Browser acceptance model",
        description: "Synthetic model that never reaches an external provider",
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

  async readThread(threadId: string) {
    return {
      thread: mobileThread(
        threadId,
        threadId === "thread-nested" ? resolve(workspace, "client") : workspace,
      ),
    };
  }

  async beginTurn(options: RunTurnOptions): Promise<BeginTurnResult> {
    for (const pendingApproval of this.approvals.listPending()) {
      this.approvals.resolve(pendingApproval.id, "declined", "system");
    }
    this.runNumber += 1;
    const threadId = options.threadId ?? "thread-mobile";
    const turnId = `turn-mobile-${this.runNumber}`;
    const thread = mobileThread(threadId);
    let resolveTurn!: (turn: Turn) => void;
    const completion = new Promise<Turn>((resolvePromise) => {
      resolveTurn = resolvePromise;
    });
    const timers: NodeJS.Timeout[] = [];
    const later = (delay: number, callback: () => void) => {
      const timer = setTimeout(callback, delay);
      timer.unref();
      timers.push(timer);
    };
    const pending: PendingTurn = { threadId, resolve: resolveTurn, timers };
    this.pending.set(turnId, pending);

    later(700, () => {
      this.emit({
        method: "item/agentMessage/delta",
        params: {
          threadId,
          turnId,
          itemId: `message-${turnId}`,
          delta: "합성 모바일 레이아웃을 검증하고 있습니다.",
        },
      });
      this.emit({
        method: "turn/diff/updated",
        params: { threadId, turnId, diff: LONG_DIFF },
      });
    });
    later(1_500, () => {
      this.approvals.requestApproval({
        providerId: "codex",
        conversationId: threadId,
        runId: turnId,
        toolCallId: `tool-${turnId}`,
        risk: "high_risk",
        redactedSummary: "긴 경로를 포함한 합성 변경 검토",
        redactedDetails: {
          paths: [LONG_PATH, REVIEW_PATH],
          diff: REVIEW_DIFF,
          purpose: "browser-layout-only",
        },
        requiresTouch: true,
        expiresInMs: 60_000,
      });
    });
    later(7_000, () => this.finish(turnId, "completed"));

    return {
      thread,
      turn: mobileTurn(turnId, "inProgress"),
      completion,
    };
  }

  async interrupt(_threadId: string, turnId: string): Promise<void> {
    this.finish(turnId, "interrupted");
  }

  async steerTurn(options: SteerTurnOptions): Promise<void> {
    const pending = this.pending.get(options.turnId);
    if (!pending || pending.threadId !== options.threadId) {
      throw new Error("synthetic active turn does not match the steer request");
    }
    this.emit({
      method: "item/agentMessage/delta",
      params: {
        threadId: options.threadId,
        turnId: options.turnId,
        itemId: `message-${options.turnId}`,
        delta: ` 방향 수정 반영: ${options.prompt.slice(0, 80)}`,
      },
    });
  }

  async unsubscribeThread() {
    return { status: "unsubscribed" as const };
  }

  subscribe(listener: (notification: AppServerNotification) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(notification: AppServerNotification): void {
    for (const listener of this.listeners) listener(notification);
  }

  private finish(turnId: string, status: "completed" | "interrupted"): void {
    const pending = this.pending.get(turnId);
    if (!pending) return;
    this.pending.delete(turnId);
    for (const timer of pending.timers) clearTimeout(timer);
    pending.resolve(mobileTurn(turnId, status, "합성 모바일 수용 검사가 완료되었습니다."));
  }
}

function mobileThread(id: string, threadCwd = workspace): Thread {
  return {
    id,
    extra: null,
    sessionId: `session-${id}`,
    forkedFromId: null,
    parentThreadId: null,
    preview: "Synthetic browser acceptance thread",
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
    cwd: threadCwd,
    cliVersion: "browser-fixture",
    source: "appServer",
    canAcceptDirectInput: true,
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: "Browser acceptance",
    turns: [],
  };
}

function mobileTurn(id: string, status: Turn["status"], response = ""): Turn {
  return {
    id,
    items: response ? [{
      type: "agentMessage",
      id: `message-${id}`,
      text: response,
      phase: "final_answer",
      memoryCitation: null,
      delivery: null,
    }] : [],
    itemsView: "full",
    status,
    error: null,
    startedAt: 1,
    completedAt: status === "inProgress" ? null : 2,
    durationMs: status === "inProgress" ? null : 1_000,
  };
}

const client = new MobileAcceptanceClient(approvals);
let running: Awaited<ReturnType<typeof startWebServer>>;
try {
  running = await startWebServer({
    client,
    paths,
    staticDir: resolve(workspace, "client/dist"),
    media: new MediaManager({ rootDir: join(stateDirectory, "media") }),
    auth,
    approvals,
    workspaceTransactionDirectory: join(stateDirectory, "workspace-transactions"),
    port,
  });
} catch (error) {
  await rm(stateDirectory, { recursive: true, force: true });
  throw error;
}

process.stderr.write("[mobile-browser-fixture] production gateway ready\n");

let closing = false;
async function close(exitCode: number): Promise<void> {
  if (closing) return;
  closing = true;
  try {
    await running.close();
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
    process.exit(exitCode);
  }
}

process.once("SIGINT", () => void close(0));
process.once("SIGTERM", () => void close(0));
process.once("uncaughtException", (error) => {
  process.stderr.write(`[mobile-browser-fixture] ${error instanceof Error ? error.message : String(error)}\n`);
  void close(1);
});
process.once("unhandledRejection", (error) => {
  process.stderr.write(`[mobile-browser-fixture] ${error instanceof Error ? error.message : String(error)}\n`);
  void close(1);
});
