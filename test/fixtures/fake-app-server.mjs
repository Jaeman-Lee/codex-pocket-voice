import readline from "node:readline";

const cwd = process.env.FAKE_CODEX_CWD ?? process.cwd();
const thread = {
  id: "thread-1",
  extra: null,
  sessionId: "session-1",
  forkedFromId: null,
  parentThreadId: null,
  preview: "test conversation",
  ephemeral: false,
  section: null,
  sectionEnteredAt: null,
  historyMode: "full",
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
  name: "test",
  turns: [],
};

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
let pendingTurn = false;
let imageChecked = false;

rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (!Object.hasOwn(message, "id")) return;

  if (!message.method && message.id === "approval-1") {
    if (message.result?.decision !== "decline") {
      process.stderr.write("unsafe approval response\n");
      process.exit(2);
    }
    if (pendingTurn) completeTurn();
    return;
  }

  switch (message.method) {
    case "initialize":
      write({ id: message.id, result: { userAgent: "fake/1", codexHome: cwd, platformFamily: "unix", platformOs: "android" } });
      break;
    case "thread/list":
      write({ id: message.id, result: { data: [thread], nextCursor: null, backwardsCursor: null } });
      break;
    case "thread/read":
      write({ id: message.id, result: { thread } });
      break;
    case "thread/start":
      if (message.params.runtimeWorkspaceRoots !== undefined) {
        write({ id: message.id, error: { code: -1, message: "thread/start.runtimeWorkspaceRoots requires experimentalApi capability" } });
        break;
      }
      write({ id: message.id, result: { thread, model: "test", modelProvider: "openai", serviceTier: null, cwd, runtimeWorkspaceRoots: [cwd], instructionSources: [], approvalPolicy: "never", approvalsReviewer: "user", sandbox: { type: "workspaceWrite", writableRoots: [cwd], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }, activePermissionProfile: null, reasoningEffort: null, multiAgentMode: "explicitRequestOnly" } });
      break;
    case "thread/resume":
      if (message.params.runtimeWorkspaceRoots !== undefined || message.params.excludeTurns !== undefined) {
        write({ id: message.id, error: { code: -1, message: "thread/resume experimental fields require experimentalApi capability" } });
        break;
      }
      write({ id: message.id, result: { thread, model: "test", modelProvider: "openai", serviceTier: null, cwd, runtimeWorkspaceRoots: [cwd], instructionSources: [], approvalPolicy: "never", approvalsReviewer: "user", sandbox: { type: "workspaceWrite", writableRoots: [cwd], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }, activePermissionProfile: null, reasoningEffort: null, multiAgentMode: "explicitRequestOnly", initialTurnsPage: null, turnsBackwardsCursor: null, itemsBackwardsCursor: null } });
      break;
    case "turn/start":
      if (message.params.runtimeWorkspaceRoots !== undefined || message.params.approvalPolicy !== "never" || message.params.sandboxPolicy?.type !== "workspaceWrite") {
        write({ id: message.id, error: { code: -1, message: "unsafe turn policy" } });
        break;
      }
      if (process.env.FAKE_EXPECT_IMAGE === "1" && !imageChecked) {
        imageChecked = true;
        if (!message.params.input.some((item) => item.type === "localImage" && item.detail === "auto")) {
          write({ id: message.id, error: { code: -1, message: "missing local image input" } });
          break;
        }
      }
      write({ id: message.id, result: { turn: turn("inProgress", []) } });
      pendingTurn = true;
      write({ method: "item/agentMessage/delta", params: { threadId: thread.id, turnId: "turn-1", itemId: "message-1", delta: "working" } });
      write({ id: "approval-1", method: "item/commandExecution/requestApproval", params: {} });
      break;
    case "turn/interrupt":
      write({ id: message.id, result: {} });
      break;
    default:
      write({ id: message.id, error: { code: -32601, message: `unknown ${message.method}` } });
  }
});

function completeTurn() {
  pendingTurn = false;
  write({
    method: "turn/completed",
    params: {
      threadId: thread.id,
      turn: turn("completed", [{ type: "agentMessage", id: "message-1", text: "done", phase: "final_answer", memoryCitation: null }]),
    },
  });
}

function turn(status, items) {
  return { id: "turn-1", items, itemsView: { type: "full" }, status, error: null, startedAt: 1, completedAt: status === "completed" ? 2 : null, durationMs: status === "completed" ? 1000 : null };
}
