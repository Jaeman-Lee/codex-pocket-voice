import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { spawn } from "node:child_process";
import { ProviderError, type ModelProviderAdapter, type ProviderConnectionTest, type ProviderDescriptor, type ProviderLoginSpec } from "./types.js";

export class ClaudeProviderAdapter implements ModelProviderAdapter {
  readonly id = "claude" as const;
  readonly canRun = false;

  async describe(): Promise<ProviderDescriptor> {
    const command = process.env.CLAUDE_BIN ?? "claude";
    const installed = await commandExists(command);
    const auth = installed ? await claudeAuthStatus(command) : null;
    const connected = auth?.connected === true;
    return {
      id: this.id,
      name: "Claude Code",
      available: false,
      status: connected ? "connected" : installed ? "login_required" : "not_installed",
      detail: connected
        ? "계정 연결을 확인했습니다. 대화 실행 어댑터는 다음 단계에서 활성화됩니다."
        : installed
        ? "CLI가 감지됐습니다. 브라우저에서 계정을 연결해 주세요."
        : "이 단말에 Claude Code CLI가 설치되지 않았습니다.",
      accounts: connected ? [{ id: "cli-default", label: auth?.label ?? "현재 CLI 로그인", connected: true }] : [],
      loginCommand: "claude auth login --console",
      installed,
      version: auth?.version,
      canLogin: installed,
      canTest: installed,
      capabilities: { run: false, resume: false, models: false, attachments: false },
      installGuide: {
        summary: "PC에 Claude Code를 설치한 뒤 이 화면에서 연결하세요.",
        command: "curl -fsSL https://claude.ai/install.sh | bash",
        docsUrl: "https://code.claude.com/docs/en/setup",
      },
    };
  }

  async listModels(): Promise<never> {
    throw new ProviderError(409, "Claude Code 실행 어댑터는 아직 연결되지 않았습니다.");
  }

  assertAccount(): void {
    throw new ProviderError(409, "Claude Code 실행 어댑터는 아직 연결되지 않았습니다.");
  }

  async testConnection(): Promise<ProviderConnectionTest> {
    const command = process.env.CLAUDE_BIN ?? "claude";
    if (!await commandExists(command)) throw new ProviderError(409, "Claude Code CLI를 먼저 설치해 주세요.");
    const auth = await claudeAuthStatus(command);
    if (!auth?.connected) throw new ProviderError(409, "Claude Code 로그인이 필요합니다.");
    return {
      ok: true,
      detail: "Claude Code CLI 계정 연결을 확인했습니다. AI 요청은 보내지 않았습니다.",
      checkedAt: new Date().toISOString(),
    };
  }

  async loginSpec(): Promise<ProviderLoginSpec> {
    const command = process.env.CLAUDE_BIN ?? "claude";
    if (!await commandExists(command)) throw new ProviderError(409, "Claude Code CLI를 먼저 설치해 주세요.");
    return { command, args: ["auth", "login", "--console"] };
  }
}

interface ClaudeAuthInfo { connected: boolean; label?: string; version?: string }

async function claudeAuthStatus(command: string): Promise<ClaudeAuthInfo | null> {
  const result = await run(command, ["auth", "status", "--json"], 5_000).catch(() => null);
  if (!result || result.code !== 0) return null;
  try {
    const parsed = JSON.parse(result.output) as Record<string, unknown>;
    const connected = parsed.loggedIn === true || parsed.authenticated === true;
    const email = typeof parsed.email === "string" ? parsed.email : undefined;
    const subscription = typeof parsed.subscriptionType === "string" ? parsed.subscriptionType : undefined;
    return { connected, label: email ?? subscription, version: typeof parsed.version === "string" ? parsed.version : undefined };
  } catch {
    return { connected: /logged in|authenticated/i.test(result.output) };
  }
}

function run(command: string, args: string[], timeoutMs: number): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const append = (chunk: Buffer) => { output = `${output}${chunk.toString("utf8")}`.slice(-16_000); };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.once("error", reject);
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.once("close", (code) => { clearTimeout(timer); resolve({ code, output }); });
  });
}

async function commandExists(command: string): Promise<boolean> {
  if (isAbsolute(command)) return isExecutable(command);
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    if (await isExecutable(join(directory, command))) return true;
  }
  return false;
}

async function isExecutable(path: string): Promise<boolean> {
  return access(path, constants.X_OK).then(() => true, () => false);
}
