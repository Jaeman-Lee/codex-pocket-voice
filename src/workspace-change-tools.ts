import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import type { PathPolicy } from "./path-policy.js";
import { isSensitivePath, redactWorkspaceSecrets } from "./read-only-tools.js";
import {
  ToolBrokerError,
  type RegisteredTool,
  type ToolExecutionContext,
} from "./tool-broker.js";

const MAX_REPLACEMENT_CHARS = 12_000;
const MAX_REPLACEMENT_BYTES = 12 * 1024;
const MAX_EXISTING_BYTES = 1024 * 1024;
const MAX_DIFF_CHARS = 12_000;
const MAX_DIFF_LINES = 160;

interface ReplaceTextInput {
  path: string;
  expectedSha256: string;
  content: string;
}

interface LoadedTextFile {
  target: string;
  content: string;
  sha256: string;
  mode: number;
}

export function createWorkspaceChangeTools(paths: PathPolicy): RegisteredTool[] {
  return [workspaceReplaceTextTool(paths)];
}

function workspaceReplaceTextTool(paths: PathPolicy): RegisteredTool<ReplaceTextInput> {
  return {
    definition: {
      name: "workspace_replace_text",
      description: [
        "Replace one existing text file inside the selected project after explicit user approval.",
        "Pass the sha256 returned by workspace_read so concurrent or unseen changes are never overwritten.",
        "This first write milestone cannot create, delete, rename, chmod, or modify sensitive files.",
      ].join(" "),
      inputSchema: strictObject({
        path: { type: "string", minLength: 1, maxLength: 500, description: "Project-relative existing text file." },
        expected_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
        content: { type: "string", maxLength: MAX_REPLACEMENT_CHARS, description: "Complete replacement UTF-8 text." },
      }, ["path", "expected_sha256", "content"]),
      risk: "change",
    },
    validate(input) {
      const value = exactObject(input, ["path", "expected_sha256", "content"]);
      const requestedPath = requiredSafeRelativePath(value.path);
      if (isSensitivePath(requestedPath)) {
        throw new ToolBrokerError(403, "Sensitive workspace files cannot be modified by API tools");
      }
      if (typeof value.expected_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.expected_sha256)) {
        throw new ToolBrokerError(400, "expected_sha256 must be a lowercase SHA-256 digest");
      }
      if (typeof value.content !== "string" || value.content.length > MAX_REPLACEMENT_CHARS) {
        throw new ToolBrokerError(400, `content must be UTF-8 text up to ${MAX_REPLACEMENT_CHARS} characters`);
      }
      if (value.content.includes("\0") || Buffer.byteLength(value.content, "utf8") > MAX_REPLACEMENT_BYTES) {
        throw new ToolBrokerError(400, "content exceeds the safe UTF-8 size limit or contains a null byte");
      }
      if (redactWorkspaceSecrets(value.content) !== value.content) {
        throw new ToolBrokerError(403, "Replacement content appears to contain a credential or private key");
      }
      return { path: requestedPath, expectedSha256: value.expected_sha256, content: value.content };
    },
    async approval(input, context) {
      const current = await loadTextFile(paths, input, context);
      assertExpectedVersion(input, current);
      const nextSha256 = digest(input.content);
      if (nextSha256 === current.sha256) throw new ToolBrokerError(409, "Replacement content is unchanged");
      const preview = replacementDiff(input.path, current.content, input.content);
      return {
        redactedSummary: `Replace text in ${input.path}`,
        redactedDetails: {
          path: input.path,
          expectedSha256: current.sha256,
          nextSha256,
          changedLines: preview.changedLines,
          diff: preview.diff,
          diffTruncated: preview.truncated,
        },
        requiresTouch: true,
      };
    },
    async execute(input, context) {
      const current = await loadTextFile(paths, input, context);
      assertExpectedVersion(input, current);
      if (context.signal?.aborted) throw new ToolBrokerError(499, "Tool execution was cancelled");
      const nextSha256 = digest(input.content);
      if (nextSha256 === current.sha256) throw new ToolBrokerError(409, "Replacement content is unchanged");
      await atomicReplace(current.target, input.content, current.mode, context.signal);
      return {
        path: input.path,
        previousSha256: current.sha256,
        sha256: nextSha256,
        bytes: Buffer.byteLength(input.content, "utf8"),
      };
    },
  };
}

async function loadTextFile(
  paths: PathPolicy,
  input: ReplaceTextInput,
  context: ToolExecutionContext,
): Promise<LoadedTextFile> {
  if (context.signal?.aborted) throw new ToolBrokerError(499, "Tool execution was cancelled");
  const cwd = await paths.resolveWorkspace(context.cwd);
  const requested = path.join(cwd, input.path);
  const direct = await lstat(requested).catch(() => null);
  if (!direct?.isFile() || direct.isSymbolicLink() || direct.nlink !== 1) {
    throw new ToolBrokerError(400, "workspace_replace_text requires one existing regular non-linked file");
  }
  const target = await realpath(requested);
  if (target !== requested) throw new ToolBrokerError(403, "Symlinked path components cannot be modified");
  const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => {
    throw new ToolBrokerError(400, "Existing file could not be read");
  });
  let bytes: Buffer;
  let mode: number;
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== direct.dev || opened.ino !== direct.ino) {
      throw new ToolBrokerError(409, "Existing file changed while it was being checked");
    }
    if (opened.size > MAX_EXISTING_BYTES) throw new ToolBrokerError(400, "Existing file is too large to replace safely");
    mode = opened.mode & 0o777;
    bytes = await file.readFile();
  } finally {
    await file.close();
  }
  if (bytes.includes(0)) throw new ToolBrokerError(400, "Binary files cannot be replaced by this tool");
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ToolBrokerError(400, "Existing file is not valid UTF-8 text");
  }
  return {
    target,
    content,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    mode,
  };
}

function assertExpectedVersion(input: ReplaceTextInput, current: LoadedTextFile): void {
  if (current.sha256 !== input.expectedSha256) {
    throw new ToolBrokerError(409, "File changed after it was read; read it again before proposing a replacement");
  }
}

async function atomicReplace(target: string, content: string, mode: number, signal?: AbortSignal): Promise<void> {
  const temporary = path.join(path.dirname(target), `.codex-pocket-${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.chmod(mode);
    await handle.close();
    handle = undefined;
    if (signal?.aborted) throw new ToolBrokerError(499, "Tool execution was cancelled");
    await rename(temporary, target);
    const directory = await open(path.dirname(target), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function replacementDiff(file: string, before: string, after: string): {
  diff: string;
  changedLines: number;
  truncated: boolean;
} {
  const oldLines = before.split("\n");
  const newLines = after.split("\n");
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix
    && suffix < newLines.length - prefix
    && oldLines[oldLines.length - suffix - 1] === newLines[newLines.length - suffix - 1]
  ) suffix += 1;
  const removed = oldLines.slice(prefix, oldLines.length - suffix);
  const added = newLines.slice(prefix, newLines.length - suffix);
  const body = [
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -${prefix + 1},${removed.length} +${prefix + 1},${added.length} @@`,
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
  ];
  const lineTruncated = body.length > MAX_DIFF_LINES;
  let diff = redactWorkspaceSecrets(body.slice(0, MAX_DIFF_LINES).join("\n"));
  const charTruncated = diff.length > MAX_DIFF_CHARS;
  if (charTruncated) diff = diff.slice(0, MAX_DIFF_CHARS);
  if (lineTruncated || charTruncated) diff += "\n[diff truncated]";
  return { diff, changedLines: Math.max(removed.length, added.length), truncated: lineTruncated || charTruncated };
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function strictObject(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}

function exactObject(input: unknown, allowed: string[]): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ToolBrokerError(400, "Tool input must be an object");
  }
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new ToolBrokerError(400, "Tool input contains unsupported fields");
  }
  return value;
}

function requiredSafeRelativePath(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 500 || value.includes("\0")) {
    throw new ToolBrokerError(400, "path must be a project-relative file path");
  }
  if (path.isAbsolute(value) || value.includes("\\")) throw new ToolBrokerError(400, "path must use a project-relative POSIX form");
  const components = value.split("/");
  if (components.some((component) => !component || component === "." || component === "..")) {
    throw new ToolBrokerError(400, "path cannot contain empty, dot, or parent components");
  }
  return value;
}
