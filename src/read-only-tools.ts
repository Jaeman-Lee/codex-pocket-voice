import { spawn } from "node:child_process";
import { realpath, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { PathPolicy } from "./path-policy.js";
import {
  ToolBrokerError,
  type RegisteredTool,
  type ToolExecutionContext,
} from "./tool-broker.js";

const MAX_LIST_ENTRIES = 200;
const MAX_READ_BYTES = 64 * 1024;
const MAX_READ_FILE_BYTES = 1024 * 1024;
const MAX_READ_LINES = 500;
const MAX_SEARCH_RESULTS = 100;
const MAX_PROCESS_OUTPUT_BYTES = 256 * 1024;
const MAX_TOOL_OUTPUT_CHARS = 80_000;
const PROCESS_TIMEOUT_MS = 10_000;

const BLOCKED_COMPONENTS = new Set([
  ".git",
  ".gnupg",
  ".ssh",
  ".gradle",
  "node_modules",
]);
const BLOCKED_BASENAMES = new Set([
  ".netrc",
  ".npmrc",
  ".pypirc",
  "credentials",
  "credentials.json",
  "id_ed25519",
  "id_rsa",
]);
const BLOCKED_EXTENSIONS = new Set([
  ".jks",
  ".key",
  ".keystore",
  ".p12",
  ".pem",
  ".pfx",
]);

interface ListInput {
  path: string;
  maxEntries: number;
}

interface ReadInput {
  path: string;
  startLine: number;
  endLine: number | null;
}

interface SearchInput {
  query: string;
  path: string;
  fileGlob: string | null;
  maxResults: number;
}

interface GitDiffInput {
  staged: boolean;
  path: string | null;
}

interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function createReadOnlyWorkspaceTools(paths: PathPolicy): RegisteredTool[] {
  return [
    workspaceListTool(paths),
    workspaceReadTool(paths),
    workspaceSearchTool(paths),
    gitStatusTool(paths),
    gitDiffTool(paths),
  ];
}

function workspaceListTool(paths: PathPolicy): RegisteredTool<ListInput> {
  return {
    definition: {
      name: "workspace_list",
      description: "List files and directories inside the selected project. This tool is read-only and hides sensitive paths.",
      inputSchema: strictObject({
        path: { type: ["string", "null"], description: "Project-relative directory path, or null for the project root." },
        max_entries: { type: ["integer", "null"], minimum: 1, maximum: MAX_LIST_ENTRIES },
      }, ["path", "max_entries"]),
      risk: "observation",
    },
    validate(input) {
      const value = exactObject(input, ["path", "max_entries"]);
      return {
        path: nullableRelativePath(value.path, "."),
        maxEntries: nullableInteger(value.max_entries, 100, 1, MAX_LIST_ENTRIES),
      };
    },
    approval: (input) => ({ redactedSummary: `List ${input.path}` }),
    async execute(input, context) {
      assertNotSensitive(input.path);
      const cwd = await paths.resolveWorkspace(context.cwd);
      const directory = await paths.resolveExistingPath(cwd, input.path);
      const info = await stat(directory);
      if (!info.isDirectory()) throw new ToolBrokerError(400, "workspace_list path must be a directory");
      const entries = (await readdir(directory, { withFileTypes: true }))
        .filter((entry) => !isSensitivePath(entry.name))
        .sort((left, right) => left.name.localeCompare(right.name));
      const visible = entries.slice(0, input.maxEntries).map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : entry.isSymbolicLink() ? "symlink" : "other",
      }));
      return {
        path: projectPath(cwd, directory),
        entries: visible,
        truncated: entries.length > visible.length,
      };
    },
  };
}

function workspaceReadTool(paths: PathPolicy): RegisteredTool<ReadInput> {
  return {
    definition: {
      name: "workspace_read",
      description: "Read a bounded line range from a text file inside the selected project. Sensitive files and paths outside the project are denied.",
      inputSchema: strictObject({
        path: { type: "string", description: "Project-relative text file path." },
        start_line: { type: ["integer", "null"], minimum: 1 },
        end_line: { type: ["integer", "null"], minimum: 1 },
      }, ["path", "start_line", "end_line"]),
      risk: "observation",
    },
    validate(input) {
      const value = exactObject(input, ["path", "start_line", "end_line"]);
      const startLine = nullableInteger(value.start_line, 1, 1, Number.MAX_SAFE_INTEGER);
      const endLine = value.end_line === null
        ? null
        : requiredInteger(value.end_line, "end_line", startLine, Number.MAX_SAFE_INTEGER);
      return { path: requiredRelativePath(value.path), startLine, endLine };
    },
    approval: (input) => ({ redactedSummary: `Read ${input.path}` }),
    async execute(input, context) {
      assertNotSensitive(input.path);
      const cwd = await paths.resolveWorkspace(context.cwd);
      const file = await paths.resolveExistingPath(cwd, input.path);
      assertNotSensitive(projectPath(cwd, file));
      const info = await stat(file);
      if (!info.isFile()) throw new ToolBrokerError(400, "workspace_read path must be a regular file");
      if (info.size > MAX_READ_FILE_BYTES) throw new ToolBrokerError(400, "File is too large for the read-only tool");
      const bytes = await readFile(file);
      if (bytes.includes(0)) throw new ToolBrokerError(400, "Binary files are not available to the read-only tool");
      const lines = bytes.toString("utf8").split(/\r?\n/);
      const requestedEnd = input.endLine ?? Math.min(lines.length, input.startLine + MAX_READ_LINES - 1);
      const endLine = Math.min(requestedEnd, input.startLine + MAX_READ_LINES - 1, lines.length);
      const content = redactWorkspaceSecrets(lines.slice(input.startLine - 1, endLine).join("\n"));
      const bounded = truncate(content, MAX_READ_BYTES);
      return {
        path: projectPath(cwd, file),
        startLine: input.startLine,
        endLine,
        totalLines: lines.length,
        content: bounded.value,
        truncated: bounded.truncated || requestedEnd < lines.length || endLine < requestedEnd,
      };
    },
  };
}

function workspaceSearchTool(paths: PathPolicy): RegisteredTool<SearchInput> {
  return {
    definition: {
      name: "workspace_search",
      description: "Search for a fixed text string inside the selected project. It does not follow symlinks or return sensitive paths.",
      inputSchema: strictObject({
        query: { type: "string", minLength: 1, maxLength: 200 },
        path: { type: ["string", "null"], description: "Project-relative file or directory, or null for the project root." },
        file_glob: { type: ["string", "null"], description: "Optional ripgrep file glob such as **/*.ts." },
        max_results: { type: ["integer", "null"], minimum: 1, maximum: MAX_SEARCH_RESULTS },
      }, ["query", "path", "file_glob", "max_results"]),
      risk: "observation",
    },
    validate(input) {
      const value = exactObject(input, ["query", "path", "file_glob", "max_results"]);
      const query = requiredString(value.query, "query", 200);
      if (query.includes("\0")) throw new ToolBrokerError(400, "query contains an invalid character");
      const fileGlob = nullableString(value.file_glob, "file_glob", 200);
      if (fileGlob?.startsWith("!")) throw new ToolBrokerError(400, "Exclusion globs are not accepted");
      return {
        query,
        path: nullableRelativePath(value.path, "."),
        fileGlob,
        maxResults: nullableInteger(value.max_results, 40, 1, MAX_SEARCH_RESULTS),
      };
    },
    approval: (input) => ({ redactedSummary: `Search ${input.path}` }),
    async execute(input, context) {
      assertNotSensitive(input.path);
      const cwd = await paths.resolveWorkspace(context.cwd);
      const target = await paths.resolveExistingPath(cwd, input.path);
      assertNotSensitive(projectPath(cwd, target));
      const args = ["--json", "--fixed-strings", "--no-messages", "--", input.query, target];
      if (input.fileGlob) args.splice(3, 0, "--glob", input.fileGlob);
      const result = await runProcess("rg", args, cwd, context.signal);
      if (result.code !== 0 && result.code !== 1) {
        throw new ToolBrokerError(502, "Workspace search is unavailable");
      }
      const matches: Array<Record<string, unknown>> = [];
      for (const line of result.stdout.split("\n")) {
        if (!line || matches.length >= input.maxResults) break;
        const parsed = parseJson(line);
        if (parsed?.type !== "match" || !isRecord(parsed.data)) continue;
        const pathValue = textField(parsed.data.path);
        const lineValue = textField(parsed.data.lines);
        const lineNumber = typeof parsed.data.line_number === "number" ? parsed.data.line_number : undefined;
        if (!pathValue || !lineValue) continue;
        const relative = projectPath(cwd, pathValue);
        if (isSensitivePath(relative)) continue;
        matches.push({
          path: relative,
          line: lineNumber,
          text: truncate(redactWorkspaceSecrets(lineValue.trimEnd()), 600).value,
        });
      }
      return { query: input.query, matches, truncated: matches.length >= input.maxResults };
    },
  };
}

function gitStatusTool(paths: PathPolicy): RegisteredTool<Record<string, never>> {
  return {
    definition: {
      name: "git_status",
      description: "Show bounded Git branch and working-tree status for the selected project. No Git hooks or writes are run.",
      inputSchema: strictObject({}, []),
      risk: "observation",
    },
    validate(input) {
      exactObject(input, []);
      return {};
    },
    approval: () => ({ redactedSummary: "Read Git status" }),
    async execute(_input, context) {
      const cwd = await resolveGitWorkspace(paths, context.cwd, context.signal);
      const result = await runGit(cwd, ["status", "--short", "--branch", "--untracked-files=normal"], context.signal);
      if (result.code !== 0) throw new ToolBrokerError(400, "Selected project is not a readable Git worktree");
      let hidden = 0;
      const lines = result.stdout.split("\n").filter((line) => {
        if (!line || line.startsWith("## ")) return true;
        const candidate = line.length > 3 ? line.slice(3) : line;
        const pathsInLine = candidate.split(" -> ");
        if (pathsInLine.some(isSensitivePath)) {
          hidden += 1;
          return false;
        }
        return true;
      });
      const bounded = truncate(redactWorkspaceSecrets(lines.join("\n").trimEnd()), MAX_TOOL_OUTPUT_CHARS);
      return { status: bounded.value, hiddenSensitivePaths: hidden, truncated: bounded.truncated };
    },
  };
}

function gitDiffTool(paths: PathPolicy): RegisteredTool<GitDiffInput> {
  return {
    definition: {
      name: "git_diff",
      description: "Show a bounded, read-only Git diff for the selected project. External diff drivers and text conversions are disabled.",
      inputSchema: strictObject({
        staged: { type: "boolean" },
        path: { type: ["string", "null"], description: "Optional project-relative path." },
      }, ["staged", "path"]),
      risk: "observation",
    },
    validate(input) {
      const value = exactObject(input, ["staged", "path"]);
      if (typeof value.staged !== "boolean") throw new ToolBrokerError(400, "staged must be boolean");
      const requestedPath = value.path === null ? null : requiredRelativePath(value.path);
      if (requestedPath) assertNotSensitive(requestedPath);
      return { staged: value.staged, path: requestedPath };
    },
    approval: () => ({ redactedSummary: "Read Git diff" }),
    async execute(input, context) {
      const cwd = await resolveGitWorkspace(paths, context.cwd, context.signal);
      if (input.path) await paths.resolveRelativePath(cwd, input.path);
      const args = ["diff", "--no-ext-diff", "--no-textconv", "--no-color"];
      if (input.staged) args.push("--cached");
      if (input.path) args.push("--", input.path);
      const result = await runGit(cwd, args, context.signal);
      if (result.code !== 0) throw new ToolBrokerError(400, "Git diff could not be read");
      const filtered = filterSensitiveDiff(result.stdout);
      const bounded = truncate(redactWorkspaceSecrets(filtered.output.trimEnd()), MAX_TOOL_OUTPUT_CHARS);
      return {
        diff: bounded.value,
        hiddenSensitiveFiles: filtered.hidden,
        truncated: bounded.truncated,
      };
    },
  };
}

async function resolveGitWorkspace(paths: PathPolicy, requestedCwd: string, signal?: AbortSignal): Promise<string> {
  const cwd = await paths.resolveWorkspace(requestedCwd);
  const rootResult = await runGit(cwd, ["rev-parse", "--show-toplevel"], signal);
  if (rootResult.code !== 0) throw new ToolBrokerError(400, "Selected project is not a Git worktree");
  const root = await realpath(rootResult.stdout.trim());
  if (!isWithin(cwd, root)) {
    throw new ToolBrokerError(403, "Git repository root is outside the selected project");
  }
  const gitDirectoryResult = await runGit(root, ["rev-parse", "--absolute-git-dir"], signal);
  if (gitDirectoryResult.code !== 0) throw new ToolBrokerError(400, "Git metadata could not be resolved");
  const gitDirectory = await realpath(gitDirectoryResult.stdout.trim());
  if (!paths.isAllowed(gitDirectory)) {
    throw new ToolBrokerError(403, "Git metadata is outside the allowed workspace roots");
  }
  return root;
}

function runGit(cwd: string, args: string[], signal?: AbortSignal): Promise<ProcessResult> {
  return runProcess("git", [
    "--no-optional-locks",
    "-c", "core.fsmonitor=false",
    "-c", "diff.external=",
    ...args,
  ], cwd, signal, gitEnvironment());
}

function runProcess(
  command: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
  environment?: NodeJS.ProcessEnv,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ToolBrokerError(499, "Tool execution was cancelled"));
      return;
    }
    const child = spawn(command, args, {
      cwd,
      env: environment ?? process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;
    const finishError = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(error);
    };
    const append = (target: Buffer[], chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_PROCESS_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        finishError(new ToolBrokerError(413, "Tool output exceeded the safe limit"));
        return;
      }
      target.push(chunk);
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
      });
    });
    const abort = () => {
      child.kill("SIGKILL");
      finishError(new ToolBrokerError(499, "Tool execution was cancelled"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finishError(new ToolBrokerError(408, "Tool execution timed out"));
    }, PROCESS_TIMEOUT_MS);
    timer.unref();
  });
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (
      key === "GIT_DIR"
      || key === "GIT_WORK_TREE"
      || key === "GIT_INDEX_FILE"
      || key === "GIT_OBJECT_DIRECTORY"
      || key === "GIT_ALTERNATE_OBJECT_DIRECTORIES"
      || key === "GIT_EXTERNAL_DIFF"
      || key === "GIT_SSH_COMMAND"
      || key === "GIT_CONFIG_PARAMETERS"
      || key === "GIT_CONFIG_COUNT"
      || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)
    ) delete environment[key];
  }
  environment.GIT_CONFIG_GLOBAL = "/dev/null";
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_PAGER = "cat";
  environment.PAGER = "cat";
  return environment;
}

function filterSensitiveDiff(value: string): { output: string; hidden: number } {
  const kept: string[] = [];
  let hidden = 0;
  let skip = false;
  for (const line of value.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      skip = Boolean(match && (isSensitivePath(match[1]!) || isSensitivePath(match[2]!)));
      if (skip) hidden += 1;
    }
    if (!skip) kept.push(line);
  }
  return { output: kept.join("\n"), hidden };
}

export function redactWorkspaceSecrets(value: string): string {
  return value
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]")
    .replace(/(Authorization\s*:\s*Bearer\s+)[^\s"']+/gi, "$1[REDACTED]")
    .replace(/\b((?:OPENAI|OPENROUTER|ANTHROPIC|AWS|GITHUB|GH|NPM)_[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD))\s*([:=])\s*([^\s"']+)/gi, "$1$2[REDACTED API KEY]")
    .replace(/\b(sk-(?:proj-)?[A-Za-z0-9_-]{12,})\b/g, "[REDACTED API KEY]");
}

export function isSensitivePath(value: string): boolean {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  const components = normalized.split("/").filter(Boolean);
  if (components.some((component) => BLOCKED_COMPONENTS.has(component.toLowerCase()))) return true;
  const basename = components.at(-1)?.toLowerCase() ?? "";
  if (basename === ".env" || basename.startsWith(".env.")) return true;
  if (BLOCKED_BASENAMES.has(basename)) return true;
  return BLOCKED_EXTENSIONS.has(path.extname(basename));
}

function assertNotSensitive(value: string): void {
  if (isSensitivePath(value)) throw new ToolBrokerError(403, "Sensitive workspace path is not available to API tools");
}

function strictObject(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}

function exactObject(input: unknown, allowed: string[]): Record<string, unknown> {
  if (!isRecord(input)) throw new ToolBrokerError(400, "Tool input must be an object");
  const extras = Object.keys(input).filter((key) => !allowed.includes(key));
  if (extras.length > 0) throw new ToolBrokerError(400, "Tool input contains unsupported fields");
  return input;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredRelativePath(value: unknown): string {
  const result = requiredString(value, "path", 500);
  if (path.isAbsolute(result) || result.includes("\0")) throw new ToolBrokerError(400, "path must be project-relative");
  return result;
}

function nullableRelativePath(value: unknown, fallback: string): string {
  return value === null ? fallback : requiredRelativePath(value);
}

function requiredString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maxLength) {
    throw new ToolBrokerError(400, `${label} must be a non-empty string up to ${maxLength} characters`);
  }
  return value;
}

function nullableString(value: unknown, label: string, maxLength: number): string | null {
  return value === null ? null : requiredString(value, label, maxLength);
}

function nullableInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return value === null ? fallback : requiredInteger(value, "integer", minimum, maximum);
}

function requiredInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new ToolBrokerError(400, `${label} is outside the allowed range`);
  }
  return value as number;
}

function parseJson(value: string): Record<string, any> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function textField(value: unknown): string | null {
  return isRecord(value) && typeof value.text === "string" ? value.text : null;
}

function projectPath(cwd: string, candidate: string): string {
  const relative = path.relative(cwd, candidate);
  return relative === "" ? "." : relative.split(path.sep).join("/");
}

function isWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function truncate(value: string, maximum: number): { value: string; truncated: boolean } {
  if (value.length <= maximum) return { value, truncated: false };
  return { value: `${value.slice(0, maximum)}\n[output truncated]`, truncated: true };
}
