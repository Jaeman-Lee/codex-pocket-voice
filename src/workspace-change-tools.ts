import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import type { PathPolicy } from "./path-policy.js";
import { isSensitivePath, redactWorkspaceSecrets } from "./read-only-tools.js";
import {
  ToolBrokerError,
  type RegisteredTool,
  type ToolExecutionContext,
} from "./tool-broker.js";
import {
  WorkspaceChangeEngine,
  type WorkspaceChangeMutation,
  type WorkspaceCreationPlan,
  type WorkspaceFileSnapshot,
  type WorkspaceRenamePlan,
  type WorkspaceReplacementPlan,
} from "./workspace-change-engine.js";

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

interface CreateTextInput {
  path: string;
  content: string;
}

interface RenameTextInput {
  sourcePath: string;
  expectedSha256: string;
  targetPath: string;
}

interface ReplacementCandidate {
  input: ReplaceTextInput;
  current: WorkspaceFileSnapshot;
  nextSha256: string;
}

export interface WorkspaceChangeToolOptions {
  transactionDirectory: string;
  beforeBatchCommit?: (index: number, path: string) => Promise<void>;
  afterMutation?: (mutation: WorkspaceChangeMutation, index: number, path: string) => Promise<void>;
  deferRecoveryFailure?: boolean;
  onEngineReady?: (engine: WorkspaceChangeEngine) => void;
}

export async function createWorkspaceChangeTools(
  paths: PathPolicy,
  options: WorkspaceChangeToolOptions,
): Promise<RegisteredTool[]> {
  const engine = await WorkspaceChangeEngine.create(paths, {
    transactionDirectory: options.transactionDirectory,
    beforeCommit: options.beforeBatchCommit,
    afterMutation: options.afterMutation,
    deferRecoveryFailure: options.deferRecoveryFailure,
  });
  options.onEngineReady?.(engine);
  return [
    workspaceReplaceTextTool(paths, engine),
    workspaceReplaceTextBatchTool(paths, engine),
    workspaceCreateTextTool(paths, engine),
    workspaceRenameTextTool(paths, engine),
  ];
}

function workspaceReplaceTextTool(
  paths: PathPolicy,
  engine: WorkspaceChangeEngine,
): RegisteredTool<ReplaceTextInput> {
  return {
    definition: {
      name: "workspace_replace_text",
      description: [
        "Replace one existing text file inside the selected project after explicit user approval.",
        "Pass the sha256 returned by workspace_read so concurrent or unseen changes are never overwritten.",
        "The transaction is crash-recoverable and cannot delete, chmod, or modify sensitive files.",
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
      const transaction = await engine.replace(candidates.map(replacementPlan), context.signal);
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
  engine: WorkspaceChangeEngine,
): RegisteredTool<BatchReplaceTextInput> {
  return {
    definition: {
      name: "workspace_replace_text_batch",
      description: [
        `Replace ${2}-${MAX_BATCH_FILES} existing text files inside the selected project after one explicit approval.`,
        "Pass the sha256 returned by workspace_read for every file.",
        "All files are checked and staged before commit; runtime failure or process restart rolls back an incomplete transaction.",
        "This tool cannot delete, chmod, or modify sensitive files.",
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
      const transaction = await engine.replace(candidates.map(replacementPlan), context.signal);
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

function workspaceCreateTextTool(
  paths: PathPolicy,
  engine: WorkspaceChangeEngine,
): RegisteredTool<CreateTextInput> {
  return {
    definition: {
      name: "workspace_create_text",
      description: [
        "Create one new UTF-8 text file in an existing project directory after explicit user approval.",
        "The destination must still be absent when committed and is never overwritten.",
        "The transaction is crash-recoverable and cannot create directories, chmod, or write sensitive paths or secrets.",
      ].join(" "),
      inputSchema: strictObject({
        path: { type: "string", minLength: 1, maxLength: 500, description: "Project-relative new text file." },
        content: { type: "string", maxLength: MAX_REPLACEMENT_CHARS, description: "Complete new UTF-8 text." },
      }, ["path", "content"]),
      risk: "change",
    },
    validate(input) {
      const value = exactObject(input, ["path", "content"]);
      return {
        path: validateChangePath(value.path),
        content: validateTextContent(value.content, "content"),
      };
    },
    async approval(input, context) {
      const plan = await loadCreationPlan(paths, input, context);
      const preview = creationDiff(input.path, input.content);
      return {
        redactedSummary: `Create text file ${input.path}`,
        redactedDetails: {
          path: input.path,
          nextSha256: plan.nextSha256,
          bytes: Buffer.byteLength(input.content, "utf8"),
          mode: "0644",
          changedLines: preview.changedLines,
          diff: preview.diff,
          diffTruncated: preview.truncated,
        },
        requiresTouch: true,
      };
    },
    async execute(input, context) {
      const plan = await loadCreationPlan(paths, input, context);
      const transaction = await engine.createFile(plan, context.signal);
      return {
        path: input.path,
        sha256: plan.nextSha256,
        bytes: Buffer.byteLength(input.content, "utf8"),
        mode: "0644",
        ...(transaction.cleanupPending ? { cleanupPending: true } : {}),
      };
    },
  };
}

function workspaceRenameTextTool(
  paths: PathPolicy,
  engine: WorkspaceChangeEngine,
): RegisteredTool<RenameTextInput> {
  return {
    definition: {
      name: "workspace_rename_text",
      description: [
        "Rename one existing UTF-8 text file to an absent path after explicit user approval.",
        "Pass the sha256 returned by workspace_read; the source and destination are rechecked at commit.",
        "The transaction is crash-recoverable and cannot overwrite, create directories, chmod, or touch sensitive paths.",
      ].join(" "),
      inputSchema: strictObject({
        source_path: { type: "string", minLength: 1, maxLength: 500 },
        expected_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
        target_path: { type: "string", minLength: 1, maxLength: 500 },
      }, ["source_path", "expected_sha256", "target_path"]),
      risk: "change",
    },
    validate(input) {
      const value = exactObject(input, ["source_path", "expected_sha256", "target_path"]);
      const sourcePath = validateChangePath(value.source_path);
      const targetPath = validateChangePath(value.target_path);
      if (sourcePath === targetPath) throw new ToolBrokerError(400, "Rename source and destination must differ");
      if (typeof value.expected_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.expected_sha256)) {
        throw new ToolBrokerError(400, "expected_sha256 must be a lowercase SHA-256 digest");
      }
      return { sourcePath, expectedSha256: value.expected_sha256, targetPath };
    },
    async approval(input, context) {
      const plan = await loadRenamePlan(paths, input, context);
      return {
        redactedSummary: `Rename ${input.sourcePath} to ${input.targetPath}`,
        redactedDetails: {
          sourcePath: input.sourcePath,
          targetPath: input.targetPath,
          expectedSha256: plan.current.sha256,
          bytes: Buffer.byteLength(plan.current.content, "utf8"),
          diff: renameDiff(input.sourcePath, input.targetPath),
          diffTruncated: false,
        },
        requiresTouch: true,
      };
    },
    async execute(input, context) {
      const plan = await loadRenamePlan(paths, input, context);
      const transaction = await engine.renameFile(plan, context.signal);
      return {
        sourcePath: input.sourcePath,
        targetPath: input.targetPath,
        sha256: plan.current.sha256,
        bytes: Buffer.byteLength(plan.current.content, "utf8"),
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
  const requestedPath = validateChangePath(value.path);
  if (typeof value.expected_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.expected_sha256)) {
    throw new ToolBrokerError(400, "expected_sha256 must be a lowercase SHA-256 digest");
  }
  return {
    path: requestedPath,
    expectedSha256: value.expected_sha256,
    content: validateTextContent(value.content, "content"),
  };
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
): Promise<WorkspaceFileSnapshot> {
  if (context.signal?.aborted) throw new ToolBrokerError(499, "Tool execution was cancelled");
  const workspace = await paths.resolveWorkspace(context.cwd);
  const requested = path.join(workspace, input.path);
  const direct = await lstatOrNull(requested);
  if (!direct?.isFile() || direct.isSymbolicLink() || direct.nlink !== 1) {
    throw new ToolBrokerError(400, "Workspace text changes require one existing regular non-linked file");
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
    workspace,
    path: input.path,
    target,
    content,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    mode,
    device: direct.dev,
    inode: direct.ino,
  };
}

function assertExpectedVersion(input: ReplaceTextInput, current: WorkspaceFileSnapshot): void {
  if (current.sha256 !== input.expectedSha256) {
    throw new ToolBrokerError(409, "File changed after it was read; read it again before proposing a replacement");
  }
}

function replacementPlan(candidate: ReplacementCandidate): WorkspaceReplacementPlan {
  return { current: candidate.current, content: candidate.input.content, nextSha256: candidate.nextSha256 };
}

async function loadCreationPlan(
  paths: PathPolicy,
  input: CreateTextInput,
  context: ToolExecutionContext,
): Promise<WorkspaceCreationPlan> {
  if (context.signal?.aborted) throw new ToolBrokerError(499, "Tool execution was cancelled");
  const destination = await loadAbsentDestination(paths, context.cwd, input.path);
  return {
    ...destination,
    content: input.content,
    nextSha256: digest(input.content),
    mode: 0o644,
  };
}

async function loadRenamePlan(
  paths: PathPolicy,
  input: RenameTextInput,
  context: ToolExecutionContext,
): Promise<WorkspaceRenamePlan> {
  const current = await loadTextFile(paths, {
    path: input.sourcePath,
    expectedSha256: input.expectedSha256,
    content: "",
  }, context);
  assertExpectedVersion({
    path: input.sourcePath,
    expectedSha256: input.expectedSha256,
    content: "",
  }, current);
  if (redactWorkspaceSecrets(current.content) !== current.content) {
    throw new ToolBrokerError(403, "Secret-bearing text files cannot be renamed by API tools");
  }
  const destination = await loadAbsentDestination(paths, context.cwd, input.targetPath);
  if (destination.workspace !== current.workspace) {
    throw new ToolBrokerError(400, "Rename must stay inside one workspace");
  }
  return { current, targetPath: input.targetPath, target: destination.target };
}

async function loadAbsentDestination(
  paths: PathPolicy,
  cwd: string,
  requestedPath: string,
): Promise<{ workspace: string; path: string; target: string }> {
  const workspace = await paths.resolveWorkspace(cwd);
  const target = path.join(workspace, requestedPath);
  const parent = path.dirname(target);
  const directParent = await lstatOrNull(parent);
  if (!directParent?.isDirectory() || directParent.isSymbolicLink()) {
    throw new ToolBrokerError(400, "Destination parent must be an existing regular project directory");
  }
  const canonicalParent = await realpath(parent);
  if (canonicalParent !== parent) throw new ToolBrokerError(403, "Symlinked destination parents cannot be modified");
  if (await lstatOrNull(target)) throw new ToolBrokerError(409, "Destination path already exists");
  return { workspace, path: requestedPath, target };
}

async function lstatOrNull(target: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  return lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw new ToolBrokerError(400, "Workspace path could not be inspected");
  });
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

function creationDiff(file: string, content: string): {
  diff: string;
  changedLines: number;
  truncated: boolean;
} {
  const added = content.split("\n");
  const body = [
    "--- /dev/null",
    `+++ b/${file}`,
    `@@ -0,0 +1,${added.length} @@`,
    ...added.map((line) => `+${line}`),
  ];
  const lineTruncated = body.length > MAX_DIFF_LINES;
  let diff = redactWorkspaceSecrets(body.slice(0, MAX_DIFF_LINES).join("\n"));
  const charTruncated = diff.length > MAX_DIFF_CHARS;
  if (charTruncated) diff = diff.slice(0, MAX_DIFF_CHARS);
  if (lineTruncated || charTruncated) diff += "\n[diff truncated]";
  return { diff, changedLines: added.length, truncated: lineTruncated || charTruncated };
}

function renameDiff(sourcePath: string, targetPath: string): string {
  return [
    `diff --git a/${sourcePath} b/${targetPath}`,
    "similarity index 100%",
    `rename from ${sourcePath}`,
    `rename to ${targetPath}`,
  ].join("\n");
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

function validateChangePath(value: unknown): string {
  const requestedPath = requiredSafeRelativePath(value);
  if (isSensitivePath(requestedPath)) {
    throw new ToolBrokerError(403, "Sensitive workspace files cannot be modified by API tools");
  }
  return requestedPath;
}

function validateTextContent(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > MAX_REPLACEMENT_CHARS) {
    throw new ToolBrokerError(400, `${label} must be UTF-8 text up to ${MAX_REPLACEMENT_CHARS} characters`);
  }
  if (value.includes("\0") || Buffer.byteLength(value, "utf8") > MAX_REPLACEMENT_BYTES) {
    throw new ToolBrokerError(400, `${label} exceeds the safe UTF-8 size limit or contains a null byte`);
  }
  if (redactWorkspaceSecrets(value) !== value) {
    throw new ToolBrokerError(403, `${label} appears to contain a credential or private key`);
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
