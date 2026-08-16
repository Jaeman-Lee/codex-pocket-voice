import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { ProviderId } from "./providers/types.js";
import { ProviderError } from "./providers/types.js";
import type { ProviderRegistry } from "./providers/registry.js";

export type ProviderLoginStatus = "starting" | "waiting" | "connected" | "failed" | "cancelled";

export interface ProviderLoginSession {
  id: string;
  provider: ProviderId;
  status: ProviderLoginStatus;
  output: string;
  verificationUrl?: string;
  userCode?: string;
  startedAt: string;
  completedAt?: string;
}

interface ManagedLogin { session: ProviderLoginSession; child: ChildProcessWithoutNullStreams }

export class ProviderLoginManager {
  private readonly sessions = new Map<string, ManagedLogin>();

  constructor(private readonly providers: ProviderRegistry) {}

  async start(provider: string): Promise<ProviderLoginSession> {
    if (provider !== "codex" && provider !== "claude") throw new ProviderError(400, "알 수 없는 AI 제공자입니다.");
    const existing = [...this.sessions.values()].find((item) => item.session.provider === provider && isActive(item.session));
    if (existing) return publicSession(existing.session);
    const spec = await this.providers.loginSpec(provider);
    const session: ProviderLoginSession = {
      id: randomUUID(),
      provider,
      status: "starting",
      output: "로그인 안내를 준비하는 중…",
      startedAt: new Date().toISOString(),
    };
    const child = spawn(spec.command, spec.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    });
    const managed = { session, child };
    this.sessions.set(session.id, managed);
    const append = (chunk: Buffer) => this.append(managed, chunk.toString("utf8"));
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.once("error", (error) => this.fail(managed, error.message));
    child.once("close", (code, signal) => {
      if (!isActive(session)) return;
      session.completedAt = new Date().toISOString();
      if (code === 0) {
        session.status = "connected";
        session.output = `${session.output}\n계정 연결이 완료되었습니다.`.trim();
      } else {
        session.status = "failed";
        session.output = `${session.output}\n로그인 프로세스가 종료되었습니다${signal ? ` (${signal})` : ` (exit ${code ?? "?"})`}.`.trim();
      }
    });
    this.cleanup();
    return publicSession(session);
  }

  get(id: string): ProviderLoginSession {
    const managed = this.sessions.get(id);
    if (!managed) throw new ProviderError(404, "로그인 세션을 찾을 수 없습니다.");
    return publicSession(managed.session);
  }

  cancel(id: string): ProviderLoginSession {
    const managed = this.sessions.get(id);
    if (!managed) throw new ProviderError(404, "로그인 세션을 찾을 수 없습니다.");
    if (isActive(managed.session)) {
      managed.session.status = "cancelled";
      managed.session.completedAt = new Date().toISOString();
      managed.session.output = `${managed.session.output}\n사용자가 로그인을 취소했습니다.`.trim();
      managed.child.kill("SIGTERM");
    }
    return publicSession(managed.session);
  }

  close(): void {
    for (const managed of this.sessions.values()) if (isActive(managed.session)) managed.child.kill("SIGTERM");
  }

  private append(managed: ManagedLogin, text: string): void {
    const clean = stripAnsi(text).replace(/\r/g, "");
    const prior = managed.session.output === "로그인 안내를 준비하는 중…" ? "" : managed.session.output;
    managed.session.output = `${prior}${clean}`.slice(-16_000).trim();
    managed.session.status = "waiting";
    const url = managed.session.output.match(/https:\/\/[^\s<>'"]+/)?.[0];
    if (url) managed.session.verificationUrl = url.replace(/[),.;]+$/, "");
    const code = managed.session.output.match(/(?:one[- ]time code|user code|코드)[^A-Z0-9]*([A-Z0-9]{4,}(?:-[A-Z0-9]{4,})?)/i)?.[1];
    if (code) managed.session.userCode = code.toUpperCase();
  }

  private fail(managed: ManagedLogin, message: string): void {
    managed.session.status = "failed";
    managed.session.completedAt = new Date().toISOString();
    managed.session.output = `${managed.session.output}\n${message}`.trim();
  }

  private cleanup(): void {
    const cutoff = Date.now() - 60 * 60_000;
    for (const [id, managed] of this.sessions) {
      if (!isActive(managed.session) && Date.parse(managed.session.completedAt ?? managed.session.startedAt) < cutoff) this.sessions.delete(id);
    }
  }
}

function isActive(session: ProviderLoginSession): boolean {
  return session.status === "starting" || session.status === "waiting";
}

function publicSession(session: ProviderLoginSession): ProviderLoginSession {
  return { ...session };
}

function stripAnsi(value: string): string {
  return value.replace(/\x1B(?:[@-_][0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g, "");
}
