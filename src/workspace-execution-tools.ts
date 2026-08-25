import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdtemp, open, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PathPolicy } from "./path-policy.js";
import { isSensitivePath, redactWorkspaceSecrets } from "./read-only-tools.js";
import { ToolBrokerError, type RegisteredTool, type ToolExecutionContext } from "./tool-broker.js";

const MAX_PACKAGE_BYTES = 128 * 1024;
const MAX_PROCESS_BYTES = 512 * 1024;
const MAX_RESULT_CHARS = 80_000;
const MAX_MASK_ENTRIES = 20_000;
const EXECUTION_TIMEOUT_MS = 3 * 60_000;

const SANDBOX_SCRIPT = `
root=$1
workspace=$2
node_runtime=$3
mask_count=$4
shift 4
mount -t tmpfs -o mode=0755,size=768m tmpfs "$root"
mkdir -p "$root/usr" "$root/bin" "$root/lib" "$root/lib64" "$root/runtime" "$root/workspace" "$root/upper" "$root/work" "$root/tmp" "$root/proc" "$root/dev"
for source in /usr /bin /lib /lib64; do
  if [ -e "$source" ]; then
    mount --rbind "$source" "$root$source"
    mount -o remount,ro,bind "$root$source"
  fi
done
mount --rbind "$node_runtime" "$root/runtime"
mount -o remount,ro,bind "$root/runtime"
mount -t overlay overlay -o "lowerdir=$workspace,upperdir=$root/upper,workdir=$root/work" "$root/workspace"
mount -t proc -o nosuid,nodev,noexec proc "$root/proc"
mount -t tmpfs -o mode=1777,size=256m tmpfs "$root/tmp"
touch "$root/dev/null" "$root/dev/urandom"
mount --bind /dev/null "$root/dev/null"
mount --bind /dev/urandom "$root/dev/urandom"
while [ "$mask_count" -gt 0 ]; do
  spec=$1
  shift
  mask_count=$((mask_count - 1))
  kind=$(printf '%s' "$spec" | cut -c1)
  relative=$(printf '%s' "$spec" | cut -c3-)
  target="$root/workspace/$relative"
  if [ "$kind" = d ]; then
    mount -t tmpfs -o mode=000,size=4k tmpfs "$target"
  else
    mount --bind /dev/null "$target"
  fi
done
if command -v ip >/dev/null 2>&1; then ip link set lo up || true; fi
exec chroot "$root" /usr/bin/env -i PATH=/runtime/bin:/usr/local/bin:/usr/bin:/bin HOME=/tmp TMPDIR=/tmp CI=1 \
  /bin/sh -ceu 'cd /workspace; exec /usr/bin/prlimit --as=8589934592 --fsize=536870912 --cpu=180 --nproc=256 --nofile=1024 -- "$@"' sh "$@"
`;

export type VerificationTask = "check" | "test" | "build";

interface VerifyInput {
  task: VerificationTask;
  expectedPackageSha256: string;
}

interface PackageScript {
  cwd: string;
  sha256: string;
  task: VerificationTask;
  script: string;
  command: string[];
}

export interface SandboxedCommandResult {
  code: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  truncated: boolean;
}

export interface WorkspaceSandboxRunner {
  run(cwd: string, command: readonly string[], signal?: AbortSignal): Promise<SandboxedCommandResult>;
}

export interface WorkspaceExecutionToolOptions {
  runner?: WorkspaceSandboxRunner | null;
}

export async function createWorkspaceExecutionTools(
  paths: PathPolicy,
  options: WorkspaceExecutionToolOptions = {},
): Promise<RegisteredTool[]> {
  const runner = options.runner === undefined ? await UnshareOverlayRunner.create() : options.runner;
  return runner ? [projectVerifyTool(paths, runner)] : [];
}

function projectVerifyTool(paths: PathPolicy, runner: WorkspaceSandboxRunner): RegisteredTool<VerifyInput> {
  return {
    definition: {
      name: "project_verify",
      description: [
        "Run one existing npm check, test, or build script after explicit touch approval.",
        "The command runs with no external network, an empty environment, masked sensitive files, and a disposable overlay.",
        "Its filesystem changes are discarded and arbitrary command text or arguments are not accepted.",
      ].join(" "),
      inputSchema: strictObject({
        task: { type: "string", enum: ["check", "test", "build"] },
        expected_package_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
      }, ["task", "expected_package_sha256"]),
      risk: "execution",
    },
    validate(input) {
      const value = exactObject(input, ["task", "expected_package_sha256"]);
      if (value.task !== "check" && value.task !== "test" && value.task !== "build") {
        throw new ToolBrokerError(400, "task must be check, test, or build");
      }
      if (typeof value.expected_package_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.expected_package_sha256)) {
        throw new ToolBrokerError(400, "expected_package_sha256 must be a lowercase SHA-256 digest");
      }
      return { task: value.task, expectedPackageSha256: value.expected_package_sha256 };
    },
    async approval(input, context) {
      const selected = await loadPackageScript(paths, input, context);
      return {
        redactedSummary: `Run npm ${input.task} verification`,
        redactedDetails: {
          task: input.task,
          command: selected.command.join(" "),
          script: redactWorkspaceSecrets(selected.script),
          packageSha256: selected.sha256,
          network: "disabled",
          filesystem: "disposable overlay; project changes are discarded",
          sensitiveFiles: "masked",
          timeoutSeconds: Math.floor(EXECUTION_TIMEOUT_MS / 1_000),
        },
        requiresTouch: true,
      };
    },
    async execute(input, context) {
      const selected = await loadPackageScript(paths, input, context);
      const result = await runner.run(selected.cwd, selected.command, context.signal);
      return {
        task: selected.task,
        command: selected.command.join(" "),
        exitCode: result.code,
        stdout: boundedRedacted(result.stdout),
        stderr: boundedRedacted(result.stderr),
        durationMs: result.durationMs,
        outputTruncated: result.truncated || result.stdout.length > MAX_RESULT_CHARS || result.stderr.length > MAX_RESULT_CHARS,
        filesystemChangesDiscarded: true,
        networkAccess: false,
      };
    },
  };
}

async function loadPackageScript(
  paths: PathPolicy,
  input: VerifyInput,
  context: ToolExecutionContext,
): Promise<PackageScript> {
  if (context.signal?.aborted) throw new ToolBrokerError(499, "Tool execution was cancelled");
  const cwd = await paths.resolveWorkspace(context.cwd);
  const requested = path.join(cwd, "package.json");
  const direct = await lstat(requested).catch(() => null);
  if (!direct?.isFile() || direct.isSymbolicLink() || direct.nlink !== 1 || direct.size > MAX_PACKAGE_BYTES) {
    throw new ToolBrokerError(400, "project_verify requires one regular package.json in the selected project");
  }
  if (await realpath(requested) !== requested) throw new ToolBrokerError(403, "Symlinked package.json paths are not accepted");
  const file = await open(requested, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => {
    throw new ToolBrokerError(400, "package.json could not be read safely");
  });
  let bytes: Buffer;
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== direct.dev || opened.ino !== direct.ino) {
      throw new ToolBrokerError(409, "package.json changed while it was being checked");
    }
    bytes = await file.readFile();
  } finally {
    await file.close();
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== input.expectedPackageSha256) {
    throw new ToolBrokerError(409, "package.json changed after it was read; read it again before requesting verification");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ToolBrokerError(400, "package.json is not valid UTF-8 JSON");
  }
  const scripts = record(parsed)?.scripts;
  const script = record(scripts)?.[input.task];
  if (typeof script !== "string" || !script.trim() || script.length > 4_000) {
    throw new ToolBrokerError(400, `package.json does not define a bounded ${input.task} script`);
  }
  return {
    cwd,
    sha256,
    task: input.task,
    script,
    command: input.task === "test" ? ["npm", "test"] : ["npm", "run", input.task],
  };
}

class UnshareOverlayRunner implements WorkspaceSandboxRunner {
  static async create(): Promise<UnshareOverlayRunner | null> {
    if (process.platform !== "linux") return null;
    const runner = new UnshareOverlayRunner();
    const probeWorkspace = await mkdtemp(path.join(tmpdir(), "codex-pocket-sandbox-probe-workspace-"));
    try {
      await writeFile(path.join(probeWorkspace, "probe.txt"), "host\n", { mode: 0o600 });
      const result = await runner.runRaw(
        probeWorkspace,
        ["node", "-e", "require('node:fs').writeFileSync('probe.txt','sandbox\\n');process.stdout.write('sandbox-ok')"],
        undefined,
        10_000,
      );
      const host = await readFile(path.join(probeWorkspace, "probe.txt"), "utf8");
      const available = result.code === 0 && result.stdout === "sandbox-ok" && host === "host\n";
      if (!available && process.env.CODEX_POCKET_SANDBOX_DEBUG === "1") {
        process.stderr.write(`[codex-command-sandbox] Probe failed (${result.code}): ${boundedRedacted(result.stderr)}\n`);
      }
      return available ? runner : null;
    } catch (error) {
      if (process.env.CODEX_POCKET_SANDBOX_DEBUG === "1") {
        process.stderr.write(`[codex-command-sandbox] Probe error: ${error instanceof Error ? error.message : "unknown error"}\n`);
      }
      return null;
    } finally {
      await rm(probeWorkspace, { recursive: true, force: true });
    }
  }

  run(cwd: string, command: readonly string[], signal?: AbortSignal): Promise<SandboxedCommandResult> {
    return this.runRaw(cwd, command, signal, EXECUTION_TIMEOUT_MS);
  }

  private async runRaw(
    cwd: string,
    command: readonly string[],
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<SandboxedCommandResult> {
    if (signal?.aborted) throw new ToolBrokerError(499, "Tool execution was cancelled");
    const canonical = await realpath(cwd);
    const nodeRuntime = await realpath(path.dirname(path.dirname(process.execPath)));
    const root = await mkdtemp(path.join(tmpdir(), "codex-pocket-command-sandbox-"));
    try {
      const masks = await sensitiveMasks(canonical);
      return await spawnSandbox(root, canonical, nodeRuntime, masks, command, signal, timeoutMs);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}

function spawnSandbox(
  root: string,
  cwd: string,
  nodeRuntime: string,
  masks: readonly string[],
  command: readonly string[],
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<SandboxedCommandResult> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn("unshare", [
      "--user", "--map-root-user", "--mount", "--net", "--pid", "--fork",
      "/bin/sh", "-ceu", SANDBOX_SCRIPT, "sh", root, cwd, nodeRuntime, String(masks.length), ...masks, ...command,
    ], {
      env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8" },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let truncated = false;
    let settled = false;
    const kill = () => {
      try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    };
    const finishError = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      kill();
      reject(error);
    };
    const append = (target: Buffer[], chunk: Buffer) => {
      if (bytes >= MAX_PROCESS_BYTES) {
        truncated = true;
        return;
      }
      const remaining = MAX_PROCESS_BYTES - bytes;
      const accepted = chunk.subarray(0, remaining);
      target.push(accepted);
      bytes += accepted.length;
      if (accepted.length < chunk.length) truncated = true;
    };
    child.stdout.on("data", (chunk: Buffer) => append(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => append(stderr, chunk));
    child.once("error", finishError);
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        durationMs: Date.now() - startedAt,
        truncated,
      });
    });
    const abort = () => finishError(new ToolBrokerError(499, "Tool execution was cancelled"));
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(
      () => finishError(new ToolBrokerError(408, "Sandboxed verification timed out")),
      timeoutMs,
    );
    timer.unref();
  });
}

async function sensitiveMasks(root: string): Promise<string[]> {
  const masks: string[] = [];
  const pending = [{ absolute: root, relative: "" }];
  let visited = 0;
  while (pending.length > 0 && visited < MAX_MASK_ENTRIES) {
    const directory = pending.pop()!;
    const entries = await readdir(directory.absolute, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      visited += 1;
      if (visited > MAX_MASK_ENTRIES) break;
      const relative = directory.relative ? `${directory.relative}/${entry.name}` : entry.name;
      if (relative === "node_modules" || relative.startsWith("node_modules/")) continue;
      const absolute = path.join(directory.absolute, entry.name);
      const info = await lstat(absolute).catch(() => null);
      if (!info) continue;
      const sensitive = isSensitivePath(relative) || (info.isFile() && info.nlink > 1);
      if (sensitive) {
        masks.push(`${info.isDirectory() ? "d" : "f"}:${relative}`);
        continue;
      }
      if (info.isDirectory() && !info.isSymbolicLink()) pending.push({ absolute, relative });
    }
  }
  return masks;
}

function boundedRedacted(value: string): string {
  const redacted = redactWorkspaceSecrets(value);
  return redacted.length <= MAX_RESULT_CHARS
    ? redacted
    : `${redacted.slice(0, MAX_RESULT_CHARS)}\n[output truncated]`;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function strictObject(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}

function exactObject(input: unknown, allowed: string[]): Record<string, unknown> {
  const value = record(input);
  if (!value) throw new ToolBrokerError(400, "Tool input must be an object");
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new ToolBrokerError(400, "Tool input contains unsupported fields");
  }
  return value;
}
