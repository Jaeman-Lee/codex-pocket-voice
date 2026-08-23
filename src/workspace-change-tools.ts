import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, realpath, rename, unlink } from "node:fs/promises";
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
const MAX_BATCH_FILES = 8;
const MAX_BATCH_REPLACEMENT_CHARS = 48_000;
const MAX_BATCH_REPLACEMENT_BYTES = 48 * 1024;
const MAX_BATCH_DIFF_CHARS = 18_000;
const MAX_BATCH_DIFF_LINES = 240;
const MAX_BATCH_APPROVAL_DETAILS_BYTES = 30 * 1024;

interface ReplaceTextInput {
  path: string;
  expectedSha256: string;
  content: string;
}

interface BatchReplaceTextInput {
  files: ReplaceTextInput[];
}

interface LoadedTextFile {
  target: string;
  content: string;
  sha256: string;
  mode: number;
  device: number;
  inode: number;
}

interface ReplacementCandidate {
  input: ReplaceTextInput;
  current: LoadedTextFile;
  nextSha256: string;
}

interface PreparedReplacement extends ReplacementCandidate {
  temporary: string;
  backup: string;
  backupCreated: boolean;
  installed: boolean;
}

export interface WorkspaceChangeToolOptions {
  beforeBatchCommit?: (index: number, path: string) => Promise<void>;
}

export function createWorkspaceChangeTools(
  paths: PathPolicy,
  options: WorkspaceChangeToolOptions = {},
): RegisteredTool[] {
  return [workspaceReplaceTextTool(paths), workspaceReplaceTextBatchTool(paths, options)];
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
      inputSchema: strictObject(replacementProperties(), ["path", "expected_sha256", "content"]),
      risk: "change",
    },
    validate(input) {
      return validateReplacement(exactObject(input, ["path", "expected_sha256", "content"]));
    },
    async approval(input, context) {
      const { current, nextSha256 } = (await loadReplacementCandidates(paths, [input], context))[0]!;
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
      const candidates = await loadReplacementCandidates(paths, [input], context);
      const { current, nextSha256 } = candidates[0]!;
      const transaction = await replaceLoadedFiles(candidates, context.signal);
      return {
        path: input.path,
        previousSha256: current.sha256,
        sha256: nextSha256,
        bytes: Buffer.byteLength(input.content, "utf8"),
        ...(transaction.cleanupPending ? { cleanupPending: true } : {}),
      };
    },
  };
}

function workspaceReplaceTextBatchTool(
  paths: PathPolicy,
  options: WorkspaceChangeToolOptions,
): RegisteredTool<BatchReplaceTextInput> {
  return {
    definition: {
      name: "workspace_replace_text_batch",
      description: [
        `Replace ${2}-${MAX_BATCH_FILES} existing text files inside the selected project after one explicit approval.`,
        "Pass the sha256 returned by workspace_read for every file.",
        "All files are checked and staged before commit; a detected race or runtime failure rolls back files already installed.",
        "This tool cannot create, delete, rename, chmod, or modify sensitive files.",
      ].join(" "),
      inputSchema: strictObject({
        files: {
          type: "array",
          minItems: 2,
          maxItems: MAX_BATCH_FILES,
          items: strictObject(replacementProperties(), ["path", "expected_sha256", "content"]),
        },
      }, ["files"]),
      risk: "change",
    },
    validate(input) {
      const value = exactObject(input, ["files"]);
      if (!Array.isArray(value.files) || value.files.length < 2 || value.files.length > MAX_BATCH_FILES) {
        throw new ToolBrokerError(400, `files must contain ${2}-${MAX_BATCH_FILES} replacements`);
      }
      const files = value.files.map((file) => validateReplacement(
        exactObject(file, ["path", "expected_sha256", "content"]),
      ));
      const paths = new Set(files.map((file) => file.path));
      if (paths.size !== files.length) throw new ToolBrokerError(400, "Batch replacement paths must be unique");
      const totalChars = files.reduce((total, file) => total + file.content.length, 0);
      const totalBytes = files.reduce((total, file) => total + Buffer.byteLength(file.content, "utf8"), 0);
      if (totalChars > MAX_BATCH_REPLACEMENT_CHARS || totalBytes > MAX_BATCH_REPLACEMENT_BYTES) {
        throw new ToolBrokerError(400, "Batch replacement content exceeds the aggregate safe size limit");
      }
      return { files };
    },
    async approval(input, context) {
      const candidates = await loadReplacementCandidates(paths, input.files, context);
      const preview = batchReplacementDiff(candidates);
      const files = candidates.map((candidate) => ({
        path: candidate.input.path,
        expectedSha256: candidate.current.sha256,
        nextSha256: candidate.nextSha256,
        changedLines: replacementDiff(
          candidate.input.path,
          candidate.current.content,
          candidate.input.content,
        ).changedLines,
      }));
      return {
        redactedSummary: `Replace text in ${candidates.length} files`,
        redactedDetails: boundedBatchApprovalDetails(files, preview),
        requiresTouch: true,
      };
    },
    async execute(input, context) {
      const candidates = await loadReplacementCandidates(paths, input.files, context);
      const transaction = await replaceLoadedFiles(
        candidates,
        context.signal,
        options.beforeBatchCommit,
      );
      const files = candidates.map((candidate) => ({
        path: candidate.input.path,
        previousSha256: candidate.current.sha256,
        sha256: candidate.nextSha256,
        bytes: Buffer.byteLength(candidate.input.content, "utf8"),
      }));
      return {
        fileCount: files.length,
        totalBytes: files.reduce((total, file) => total + file.bytes, 0),
        files,
        ...(transaction.cleanupPending ? { cleanupPending: true } : {}),
      };
    },
  };
}

function replacementProperties(): Record<string, unknown> {
  return {
    path: { type: "string", minLength: 1, maxLength: 500, description: "Project-relative existing text file." },
    expected_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
    content: { type: "string", maxLength: MAX_REPLACEMENT_CHARS, description: "Complete replacement UTF-8 text." },
  };
}

function validateReplacement(value: Record<string, unknown>): ReplaceTextInput {
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
}

async function loadReplacementCandidates(
  paths: PathPolicy,
  inputs: readonly ReplaceTextInput[],
  context: ToolExecutionContext,
): Promise<ReplacementCandidate[]> {
  return Promise.all(inputs.map(async (input) => {
    const current = await loadTextFile(paths, input, context);
    assertExpectedVersion(input, current);
    const nextSha256 = digest(input.content);
    if (nextSha256 === current.sha256) {
      throw new ToolBrokerError(409, `Replacement content is unchanged for ${input.path}`);
    }
    return { input, current, nextSha256 };
  }));
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
    device: direct.dev,
    inode: direct.ino,
  };
}

function assertExpectedVersion(input: ReplaceTextInput, current: LoadedTextFile): void {
  if (current.sha256 !== input.expectedSha256) {
    throw new ToolBrokerError(409, "File changed after it was read; read it again before proposing a replacement");
  }
}

async function replaceLoadedFiles(
  candidates: readonly ReplacementCandidate[],
  signal?: AbortSignal,
  beforeCommit?: (index: number, path: string) => Promise<void>,
): Promise<{ cleanupPending: boolean }> {
  const transactionId = randomUUID();
  const prepared: PreparedReplacement[] = candidates.map((candidate, index) => ({
    ...candidate,
    temporary: path.join(path.dirname(candidate.current.target), `.codex-pocket-${transactionId}-${index}.tmp`),
    backup: path.join(path.dirname(candidate.current.target), `.codex-pocket-${transactionId}-${index}.bak`),
    backupCreated: false,
    installed: false,
  }));
  try {
    for (const item of prepared) await stageReplacement(item, signal);
    for (let index = 0; index < prepared.length; index += 1) {
      const item = prepared[index]!;
      await beforeCommit?.(index, item.input.path);
      if (signal?.aborted) throw new ToolBrokerError(499, "Tool execution was cancelled");
      await link(item.current.target, item.backup);
      item.backupCreated = true;
      await assertLinkedOriginal(item.backup, item.current);
      await rename(item.temporary, item.current.target);
      item.installed = true;
    }
    await syncDirectories(prepared.map((item) => path.dirname(item.current.target)));
  } catch (error) {
    let rollbackFailed = false;
    for (const item of [...prepared].reverse()) {
      if (item.backupCreated) {
        try {
          if (item.installed) await rename(item.backup, item.current.target);
          else await unlink(item.backup);
          item.backupCreated = false;
          item.installed = false;
        } catch {
          rollbackFailed = true;
        }
      }
      if (!item.installed) await unlink(item.temporary).catch(() => undefined);
    }
    await syncDirectories(prepared.map((item) => path.dirname(item.current.target))).catch(() => {
      rollbackFailed = true;
    });
    if (rollbackFailed) {
      throw new ToolBrokerError(500, "Replacement rollback could not be completed safely; preserved backups require recovery");
    }
    throw error;
  }

  let cleanupPending = false;
  for (const item of prepared) {
    if (!item.backupCreated) continue;
    try {
      await unlink(item.backup);
      item.backupCreated = false;
    } catch {
      cleanupPending = true;
    }
  }
  await syncDirectories(prepared.map((item) => path.dirname(item.current.target))).catch(() => {
    cleanupPending = true;
  });
  return { cleanupPending };
}

async function stageReplacement(item: PreparedReplacement, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new ToolBrokerError(499, "Tool execution was cancelled");
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(item.temporary, "wx", 0o600);
    await handle.writeFile(item.input.content, "utf8");
    await handle.sync();
    await handle.chmod(item.current.mode);
    await handle.close();
    handle = undefined;
    if (signal?.aborted) throw new ToolBrokerError(499, "Tool execution was cancelled");
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(item.temporary).catch(() => undefined);
    throw error;
  }
}

async function assertLinkedOriginal(backup: string, expected: LoadedTextFile): Promise<void> {
  const direct = await lstat(backup).catch(() => null);
  if (!direct?.isFile() || direct.isSymbolicLink() || direct.nlink !== 2
      || direct.dev !== expected.device || direct.ino !== expected.inode) {
    throw new ToolBrokerError(409, "File changed while the approved replacement was being committed");
  }
  const file = await open(backup, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => {
    throw new ToolBrokerError(409, "File changed while the approved replacement was being committed");
  });
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.nlink !== 2 || opened.dev !== expected.device || opened.ino !== expected.inode
        || opened.size > MAX_EXISTING_BYTES) {
      throw new ToolBrokerError(409, "File changed while the approved replacement was being committed");
    }
    const bytes = await file.readFile();
    if (createHash("sha256").update(bytes).digest("hex") !== expected.sha256) {
      throw new ToolBrokerError(409, "File changed while the approved replacement was being committed");
    }
  } finally {
    await file.close();
  }
}

async function syncDirectories(directories: readonly string[]): Promise<void> {
  for (const directoryPath of [...new Set(directories)].sort()) {
    const directory = await open(directoryPath, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
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

function batchReplacementDiff(candidates: readonly ReplacementCandidate[]): {
  diff: string;
  changedLines: number;
  truncated: boolean;
} {
  const previews = candidates.map((candidate) => replacementDiff(
    candidate.input.path,
    candidate.current.content,
    candidate.input.content,
  ));
  const lines = previews.flatMap((preview, index) => [
    ...(index > 0 ? [""] : []),
    ...preview.diff.split("\n"),
  ]);
  const lineTruncated = lines.length > MAX_BATCH_DIFF_LINES;
  let diff = redactWorkspaceSecrets(lines.slice(0, MAX_BATCH_DIFF_LINES).join("\n"));
  const charTruncated = diff.length > MAX_BATCH_DIFF_CHARS;
  if (charTruncated) diff = diff.slice(0, MAX_BATCH_DIFF_CHARS);
  const truncated = previews.some((preview) => preview.truncated) || lineTruncated || charTruncated;
  if (truncated && !diff.endsWith("[diff truncated]")) diff += "\n[diff truncated]";
  return {
    diff,
    changedLines: previews.reduce((total, preview) => total + preview.changedLines, 0),
    truncated,
  };
}

function boundedBatchApprovalDetails(
  files: Array<{
    path: string;
    expectedSha256: string;
    nextSha256: string;
    changedLines: number;
  }>,
  preview: { diff: string; changedLines: number; truncated: boolean },
): Record<string, unknown> {
  let diff = preview.diff;
  let truncated = preview.truncated;
  while (true) {
    const details = {
      fileCount: files.length,
      changedLines: preview.changedLines,
      files,
      diff,
      diffTruncated: truncated,
    };
    if (Buffer.byteLength(JSON.stringify(details)) <= MAX_BATCH_APPROVAL_DETAILS_BYTES) return details;
    if (diff.length === 0) throw new ToolBrokerError(400, "Batch approval metadata exceeds the safe size limit");
    diff = diff.slice(0, Math.max(0, diff.length - 1_024));
    truncated = true;
    if (diff && !diff.endsWith("[diff truncated]")) diff = `${diff}\n[diff truncated]`;
  }
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
