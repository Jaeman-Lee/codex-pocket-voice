import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { APP_VERSION } from "./version.js";

const execFileAsync = promisify(execFile);
const MAX_GIT_STATUS_BYTES = 64 * 1024;

export interface CleanSourceIdentity {
  version: string;
  versionCode: number;
  commit: string;
}

export class SourceIdentityError extends Error {}

export async function readCleanSourceIdentity(
  readStatus: () => Promise<string> = readGitStatus,
): Promise<CleanSourceIdentity> {
  let output: string;
  try {
    output = await readStatus();
  } catch {
    throw new SourceIdentityError("Checked-out Git identity could not be verified");
  }
  return parseCleanSourceIdentity(output, APP_VERSION);
}

export function parseCleanSourceIdentity(output: string, version: string): CleanSourceIdentity {
  if (typeof output !== "string" || Buffer.byteLength(output, "utf8") > MAX_GIT_STATUS_BYTES
      || /[\u0000\r\u007f]/.test(output)) {
    throw new SourceIdentityError("Checked-out Git identity is invalid");
  }
  const lines = output.endsWith("\n") ? output.slice(0, -1).split("\n") : output.split("\n");
  const commitLines = lines.filter((line) => line.startsWith("# branch.oid "));
  if (commitLines.length !== 1 || lines.some((line) => !line.startsWith("# "))) {
    throw new SourceIdentityError("Checked-out Git worktree is not clean");
  }
  const commit = commitLines[0]!.slice("# branch.oid ".length);
  if (!/^[a-f0-9]{40}$/.test(commit)) {
    throw new SourceIdentityError("Checked-out Git commit is invalid");
  }
  return { version, versionCode: versionCode(version), commit };
}

async function readGitStatus(): Promise<string> {
  const result = await execFileAsync("git", [
    "status", "--porcelain=v2", "--branch", "--untracked-files=normal",
  ], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: MAX_GIT_STATUS_BYTES,
  });
  return result.stdout;
}

function versionCode(version: string): number {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new SourceIdentityError("Source version is invalid");
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part) || part < 0 || part > 99)) {
    throw new SourceIdentityError("Source version is invalid");
  }
  return parts[0]! * 10_000 + parts[1]! * 100 + parts[2]!;
}
