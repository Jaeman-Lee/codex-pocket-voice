import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";

const GIT_TIMEOUT_MS = 5_000;
const MAX_GIT_OUTPUT_BYTES = 256 * 1024;
const MAX_CHANGED_FILES = 10_000;

export interface WorkspaceIdentity {
  kind: "git" | "directory";
  branch?: string;
  head?: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
  changedFiles?: number;
  dirty?: boolean;
  detached?: boolean;
  linkedWorktree?: boolean;
}

interface GitResult {
  code: number;
  stdout: string;
}

export async function inspectWorkspaceIdentity(cwd: string): Promise<WorkspaceIdentity> {
  const canonical = await realpath(cwd);
  const [status, layout] = await Promise.all([
    runGit(canonical, ["status", "--porcelain=v2", "--branch", "--untracked-files=normal"]),
    runGit(canonical, ["rev-parse", "--show-toplevel", "--git-dir", "--git-common-dir"]),
  ]);
  if (status.code !== 0 || layout.code !== 0) return { kind: "directory" };

  const layoutLines = layout.stdout.split(/\r?\n/).filter(Boolean);
  if (layoutLines.length < 3) return { kind: "directory" };
  const gitDirectory = path.normalize(resolveGitPath(canonical, layoutLines[1]!));
  const commonDirectory = path.normalize(resolveGitPath(canonical, layoutLines[2]!));
  const parsed = parseStatus(status.stdout);
  return {
    kind: "git",
    ...(parsed.branch ? { branch: parsed.branch } : {}),
    ...(parsed.head ? { head: parsed.head } : {}),
    ...(parsed.upstream ? { upstream: parsed.upstream } : {}),
    ...(parsed.ahead !== undefined ? { ahead: parsed.ahead } : {}),
    ...(parsed.behind !== undefined ? { behind: parsed.behind } : {}),
    changedFiles: parsed.changedFiles,
    dirty: parsed.changedFiles > 0,
    detached: parsed.detached,
    linkedWorktree: gitDirectory !== commonDirectory,
  };
}

function parseStatus(value: string): {
  branch?: string;
  head?: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
  changedFiles: number;
  detached: boolean;
} {
  let branch: string | undefined;
  let head: string | undefined;
  let upstream: string | undefined;
  let ahead: number | undefined;
  let behind: number | undefined;
  let detached = false;
  let changedFiles = 0;
  for (const line of value.split(/\r?\n/)) {
    if (!line) continue;
    if (!line.startsWith("# ")) {
      changedFiles = Math.min(MAX_CHANGED_FILES, changedFiles + 1);
      continue;
    }
    if (line.startsWith("# branch.head ")) {
      const value = safeField(line.slice("# branch.head ".length));
      detached = value === "(detached)";
      if (!detached && value) branch = value;
    } else if (line.startsWith("# branch.oid ")) {
      const value = safeField(line.slice("# branch.oid ".length));
      if (/^[a-f0-9]{12,64}$/i.test(value)) head = value.slice(0, 12).toLowerCase();
    } else if (line.startsWith("# branch.upstream ")) {
      upstream = safeField(line.slice("# branch.upstream ".length)) || undefined;
    } else if (line.startsWith("# branch.ab ")) {
      const match = /^\+(\d+) -(\d+)$/.exec(line.slice("# branch.ab ".length));
      if (match) {
        ahead = Number(match[1]);
        behind = Number(match[2]);
      }
    }
  }
  return { branch, head, upstream, ahead, behind, changedFiles, detached };
}

function resolveGitPath(cwd: string, value: string): string {
  const clean = safeField(value);
  return path.isAbsolute(clean) ? clean : path.resolve(cwd, clean);
}

function safeField(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 500);
}

function runGit(cwd: string, args: readonly string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = spawn("git", ["--no-optional-locks", ...args], {
      cwd,
      detached: true,
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_PAGER: "cat",
        PAGER: "cat",
      },
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(chunks).toString("utf8") });
    };
    child.stdout.on("data", (chunk: Buffer) => {
      if (bytes >= MAX_GIT_OUTPUT_BYTES) return;
      const accepted = chunk.subarray(0, MAX_GIT_OUTPUT_BYTES - bytes);
      chunks.push(accepted);
      bytes += accepted.length;
      if (accepted.length < chunk.length) {
        try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      }
    });
    child.once("error", () => finish(1));
    child.once("close", (code) => finish(code ?? 1));
    const timer = setTimeout(() => {
      try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      finish(1);
    }, GIT_TIMEOUT_MS);
    timer.unref();
  });
}
