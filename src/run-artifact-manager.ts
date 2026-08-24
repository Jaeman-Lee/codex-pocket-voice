import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  link,
  mkdir,
  open,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import type { PathPolicy } from "./path-policy.js";
import { isSensitivePath, redactWorkspaceSecrets } from "./read-only-tools.js";
import type { RunOperation } from "./run-coordinator.js";
import type { ToolExecutionResult } from "./tool-broker.js";

const MAX_ARTIFACTS_PER_RUN = 8;
const MAX_TEXT_ARTIFACT_BYTES = 512 * 1024;
const MAX_IMAGE_ARTIFACT_BYTES = 25 * 1024 * 1024;
const MAX_APK_ARTIFACT_BYTES = 200 * 1024 * 1024;
const MAX_TOTAL_ARTIFACT_BYTES = 256 * 1024 * 1024;
const MAX_PREVIEW_CHARS = 8_000;
const ARTIFACT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type RunArtifactKind = "test" | "log" | "image" | "apk";

export interface RunArtifact {
  id: string;
  name: string;
  kind: RunArtifactKind;
  mimeType: string;
  size: number;
  sha256: string;
  createdAt: string;
  preview?: string;
}

export interface RunArtifactCandidate {
  kind: "test" | "log";
  name: string;
  content: string;
}

export interface OpenedRunArtifact {
  artifact: RunArtifact;
  handle: FileHandle;
}

export interface RunArtifactManagerOptions {
  rootDir: string;
  retentionMs: number;
  now?: () => number;
  createId?: () => string;
}

export class RunArtifactError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

export class RunArtifactManager {
  readonly rootDir: string;
  private readonly retentionMs: number;
  private readonly now: () => number;
  private readonly createId: () => string;

  constructor(private readonly paths: PathPolicy, options: RunArtifactManagerOptions) {
    this.rootDir = resolve(options.rootDir);
    this.retentionMs = options.retentionMs;
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
  }

  async initialize(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    const root = await lstat(this.rootDir);
    if (!root.isDirectory() || root.isSymbolicLink()
        || (typeof process.getuid === "function" && root.uid !== process.getuid())) {
      throw new Error("Run artifact directory must be an owner-controlled regular directory");
    }
    await chmod(this.rootDir, 0o700);
    const cutoff = this.now() - this.retentionMs;
    for (const entry of await readdir(this.rootDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
      const directory = join(this.rootDir, entry.name);
      const info = await stat(directory).catch(() => null);
      if (info && info.mtimeMs < cutoff) await rm(directory, { recursive: true, force: true });
    }
  }

  async finalizeOperation(
    operation: Pick<RunOperation, "id" | "cwd">,
    rawResult: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const result = structuredClone(rawResult);
    const candidates = artifactCandidates(result.artifactCandidates);
    delete result.artifactCandidates;
    delete result.artifacts;

    const commandLog = commandLogCandidate(result.commands);
    if (commandLog) candidates.push(commandLog);
    stripCommandOutput(result.commands);

    const artifacts: RunArtifact[] = [];
    let totalBytes = 0;
    for (const candidate of candidates.slice(0, MAX_ARTIFACTS_PER_RUN)) {
      const bytes = Buffer.byteLength(candidate.content, "utf8");
      if (bytes === 0 || bytes > MAX_TEXT_ARTIFACT_BYTES || totalBytes + bytes > MAX_TOTAL_ARTIFACT_BYTES) continue;
      const artifact = await this.captureText(operation.id, candidate).catch(() => null);
      if (!artifact) continue;
      artifacts.push(artifact);
      totalBytes += artifact.size;
    }

    for (const requestedPath of changedArtifactPaths(result)) {
      if (artifacts.length >= MAX_ARTIFACTS_PER_RUN || totalBytes >= MAX_TOTAL_ARTIFACT_BYTES) break;
      const artifact = await this.captureWorkspaceFile(operation, requestedPath, MAX_TOTAL_ARTIFACT_BYTES - totalBytes)
        .catch(() => null);
      if (!artifact) continue;
      artifacts.push(artifact);
      totalBytes += artifact.size;
    }
    if (artifacts.length > 0) result.artifacts = artifacts;
    return result;
  }

  async open(operationId: string, artifact: RunArtifact): Promise<OpenedRunArtifact> {
    assertPublicArtifact(artifact);
    const path = this.artifactPath(operationId, artifact.id);
    const before = await lstat(path).catch(() => null);
    if (!before?.isFile() || before.isSymbolicLink() || before.nlink !== 1 || (before.mode & 0o077) !== 0
        || before.size !== artifact.size) {
      throw new RunArtifactError(404, "산출물 파일을 찾을 수 없습니다.");
    }
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => {
      throw new RunArtifactError(404, "산출물 파일을 안전하게 열 수 없습니다.");
    });
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino
          || opened.size !== artifact.size) {
        throw new RunArtifactError(409, "산출물 파일이 검토 후 변경되었습니다.");
      }
      if (await realpath(`/proc/self/fd/${handle.fd}`) !== path) {
        throw new RunArtifactError(409, "산출물 저장 경로가 검토 후 변경되었습니다.");
      }
      if (await digestFileHandle(handle, path) !== artifact.sha256) {
        throw new RunArtifactError(409, "산출물 checksum이 검토 기록과 다릅니다.");
      }
      return { artifact, handle };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async deleteOperations(operationIds: readonly string[]): Promise<void> {
    await Promise.all(operationIds.map((operationId) => (
      rm(this.operationDirectory(operationId), { recursive: true, force: true })
    )));
  }

  private async captureText(operationId: string, candidate: RunArtifactCandidate): Promise<RunArtifact> {
    const content = redactArtifactLog(candidate.content);
    const bytes = Buffer.from(content, "utf8");
    const id = this.newArtifactId();
    const directory = await this.ensureOperationDirectory(operationId);
    const temporary = join(directory, `.${id}.tmp`);
    const target = this.artifactPath(operationId, id);
    try {
      await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
      await link(temporary, target);
      try {
        await chmod(target, 0o400);
      } catch (error) {
        await rm(target, { force: true });
        throw error;
      }
    } finally {
      await rm(temporary, { force: true });
    }
    return {
      id,
      name: safeArtifactName(candidate.name, candidate.kind === "test" ? "verification.log" : "run.log"),
      kind: candidate.kind,
      mimeType: "text/plain; charset=utf-8",
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      createdAt: new Date(this.now()).toISOString(),
      preview: content.length <= MAX_PREVIEW_CHARS ? content : `${content.slice(0, MAX_PREVIEW_CHARS)}\n… [preview truncated]`,
    };
  }

  private async captureWorkspaceFile(
    operation: Pick<RunOperation, "id" | "cwd">,
    requestedPath: string,
    remainingBytes: number,
  ): Promise<RunArtifact | null> {
    const workspace = await this.paths.resolveWorkspace(operation.cwd);
    const relativePath = artifactRelativePath(workspace, requestedPath);
    if (!relativePath || isSensitivePath(relativePath)) return null;
    const fileType = artifactFileType(relativePath);
    if (!fileType) return null;
    const sourcePath = await this.paths.resolveRelativePath(workspace, relativePath);
    if (await realpath(sourcePath) !== sourcePath) return null;
    const before = await lstat(sourcePath);
    const maximum = Math.min(fileType.maximumBytes, remainingBytes);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size === 0 || before.size > maximum) {
      return null;
    }
    const source = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const id = this.newArtifactId();
    const directory = await this.ensureOperationDirectory(operation.id);
    const temporary = join(directory, `.${id}.tmp`);
    const target = this.artifactPath(operation.id, id);
    const digest = createHash("sha256");
    try {
      const opened = await source.stat();
      if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino
          || opened.size !== before.size) return null;
      if (await realpath(`/proc/self/fd/${source.fd}`) !== sourcePath) return null;
      const hashing = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          digest.update(chunk);
          callback(null, chunk);
        },
      });
      await pipeline(
        createReadStream(sourcePath, { fd: source.fd, autoClose: false }),
        hashing,
        createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
      );
      const after = await source.stat();
      if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
          || after.mtimeMs !== opened.mtimeMs) {
        await rm(temporary, { force: true });
        return null;
      }
      await link(temporary, target);
      try {
        await chmod(target, 0o400);
      } catch (error) {
        await rm(target, { force: true });
        throw error;
      }
      await rm(temporary, { force: true });
      return {
        id,
        name: safeArtifactName(basename(relativePath), `artifact${extname(relativePath)}`),
        kind: fileType.kind,
        mimeType: fileType.mimeType,
        size: opened.size,
        sha256: digest.digest("hex"),
        createdAt: new Date(this.now()).toISOString(),
      };
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    } finally {
      await source.close();
    }
  }

  private async ensureOperationDirectory(operationId: string): Promise<string> {
    const directory = this.operationDirectory(operationId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()
        || (typeof process.getuid === "function" && info.uid !== process.getuid())) {
      throw new Error("Run artifact operation directory is not owner-controlled");
    }
    await chmod(directory, 0o700);
    return directory;
  }

  private operationDirectory(operationId: string): string {
    return join(this.rootDir, createHash("sha256").update(`operation\0${operationId}`).digest("hex"));
  }

  private artifactPath(operationId: string, artifactId: string): string {
    if (!ARTIFACT_ID.test(artifactId)) throw new RunArtifactError(404, "산출물 ID가 올바르지 않습니다.");
    return join(this.operationDirectory(operationId), `${artifactId}.bin`);
  }

  private newArtifactId(): string {
    const id = this.createId();
    if (!ARTIFACT_ID.test(id)) throw new Error("Run artifact IDs must be random UUID v4 values");
    return id;
  }
}

export function verificationArtifactCandidate(
  toolName: string,
  result: ToolExecutionResult,
): RunArtifactCandidate | null {
  if (toolName !== "project_verify" || result.status !== "completed" || !isRecord(result.output)) return null;
  const task = result.output.task;
  const command = result.output.command;
  const exitCode = result.output.exitCode;
  const durationMs = result.output.durationMs;
  const stdout = result.output.stdout;
  const stderr = result.output.stderr;
  if ((task !== "check" && task !== "test" && task !== "build") || typeof command !== "string"
      || !Number.isSafeInteger(exitCode) || !Number.isSafeInteger(durationMs)
      || typeof stdout !== "string" || typeof stderr !== "string") return null;
  return {
    kind: "test",
    name: `npm-${task}-${exitCode === 0 ? "passed" : "failed"}.log`,
    content: [
      `task: ${task}`,
      `command: ${command}`,
      `exitCode: ${exitCode}`,
      `durationMs: ${durationMs}`,
      "networkAccess: false",
      "filesystemChangesDiscarded: true",
      "",
      "[stdout]",
      stdout || "(empty)",
      "",
      "[stderr]",
      stderr || "(empty)",
    ].join("\n"),
  };
}

export function runArtifacts(result: Record<string, unknown> | undefined): RunArtifact[] {
  if (!result || !Array.isArray(result.artifacts)) return [];
  return result.artifacts.filter((value): value is RunArtifact => {
    try {
      assertPublicArtifact(value);
      return true;
    } catch {
      return false;
    }
  }).slice(0, MAX_ARTIFACTS_PER_RUN).map((artifact) => ({ ...artifact }));
}

function artifactCandidates(value: unknown): RunArtifactCandidate[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_ARTIFACTS_PER_RUN).flatMap((item) => {
    if (!isRecord(item) || Object.keys(item).some((key) => !["kind", "name", "content"].includes(key))) return [];
    if ((item.kind !== "test" && item.kind !== "log") || typeof item.name !== "string"
        || typeof item.content !== "string" || item.name.length === 0 || item.name.length > 200
        || Buffer.byteLength(item.content, "utf8") > MAX_TEXT_ARTIFACT_BYTES) return [];
    return [{ kind: item.kind, name: item.name, content: item.content }];
  });
}

function commandLogCandidate(value: unknown): RunArtifactCandidate | null {
  if (!Array.isArray(value)) return null;
  const sections = value.slice(0, 32).flatMap((item, index) => {
    if (!isRecord(item) || typeof item.output !== "string" || item.output.length === 0) return [];
    const command = typeof item.command === "string" ? item.command.slice(0, 4_000) : "command";
    const status = typeof item.status === "string" ? item.status.slice(0, 100) : "unknown";
    const exitCode = Number.isSafeInteger(item.exitCode) ? item.exitCode : "unknown";
    return [`[command ${index + 1}]\n$ ${command}\nstatus: ${status}\nexitCode: ${exitCode}\n\n${item.output}`];
  });
  if (sections.length === 0) return null;
  const content = boundedUtf8(sections.join("\n\n"), MAX_TEXT_ARTIFACT_BYTES);
  return { kind: "log", name: "command-output.log", content };
}

function stripCommandOutput(value: unknown): void {
  if (!Array.isArray(value)) return;
  for (const item of value) if (isRecord(item)) delete item.output;
}

function changedArtifactPaths(result: Record<string, unknown>): string[] {
  if (!Array.isArray(result.fileChanges)) return [];
  const paths = new Set<string>();
  for (const item of result.fileChanges.slice(0, 100)) {
    if (!isRecord(item) || !Array.isArray(item.changes)) continue;
    for (const change of item.changes.slice(0, 100)) {
      if (isRecord(change) && typeof change.path === "string" && change.path.length <= 4_096) paths.add(change.path);
    }
  }
  return [...paths];
}

function artifactRelativePath(workspace: string, requestedPath: string): string | null {
  if (!requestedPath || requestedPath.trim() !== requestedPath || /[\u0000-\u001f\u007f]/.test(requestedPath)) return null;
  const candidate = isAbsolute(requestedPath) ? relative(workspace, requestedPath) : requestedPath;
  if (!candidate || isAbsolute(candidate) || candidate === ".." || candidate.startsWith("../") || candidate.startsWith("..\\")) {
    return null;
  }
  return candidate;
}

function artifactFileType(value: string): { kind: "image" | "apk" | "log" | "test"; mimeType: string; maximumBytes: number } | null {
  const extension = extname(value).toLowerCase();
  if (extension === ".png") return { kind: "image", mimeType: "image/png", maximumBytes: MAX_IMAGE_ARTIFACT_BYTES };
  if (extension === ".jpg" || extension === ".jpeg") return { kind: "image", mimeType: "image/jpeg", maximumBytes: MAX_IMAGE_ARTIFACT_BYTES };
  if (extension === ".webp") return { kind: "image", mimeType: "image/webp", maximumBytes: MAX_IMAGE_ARTIFACT_BYTES };
  if (extension === ".gif") return { kind: "image", mimeType: "image/gif", maximumBytes: MAX_IMAGE_ARTIFACT_BYTES };
  if (extension === ".apk") return { kind: "apk", mimeType: "application/vnd.android.package-archive", maximumBytes: MAX_APK_ARTIFACT_BYTES };
  const normalized = value.toLowerCase().replaceAll("\\", "/");
  const reportPath = /(^|\/)(test-results?|reports?|logs?)(\/|$)/.test(normalized);
  if (extension === ".log" && reportPath) return { kind: "log", mimeType: "text/plain; charset=utf-8", maximumBytes: MAX_TEXT_ARTIFACT_BYTES };
  if ((extension === ".xml" || extension === ".json" || extension === ".txt") && reportPath) {
    const mimeType = extension === ".json" ? "application/json" : extension === ".xml" ? "application/xml" : "text/plain; charset=utf-8";
    return { kind: "test", mimeType, maximumBytes: MAX_TEXT_ARTIFACT_BYTES };
  }
  return null;
}

function assertPublicArtifact(value: unknown): asserts value is RunArtifact {
  if (!isRecord(value) || Object.keys(value).some((key) => ![
    "id", "name", "kind", "mimeType", "size", "sha256", "createdAt", "preview",
  ].includes(key)) || !ARTIFACT_ID.test(String(value.id)) || typeof value.name !== "string"
      || value.name.length === 0 || value.name.length > 200
      || (value.kind !== "test" && value.kind !== "log" && value.kind !== "image" && value.kind !== "apk")
      || typeof value.mimeType !== "string" || value.mimeType.length === 0 || value.mimeType.length > 100
      || !Number.isSafeInteger(value.size) || Number(value.size) <= 0 || Number(value.size) > MAX_APK_ARTIFACT_BYTES
      || typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256)
      || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))
      || (value.preview !== undefined && (typeof value.preview !== "string" || value.preview.length > MAX_PREVIEW_CHARS + 30))) {
    throw new RunArtifactError(404, "산출물 정보가 올바르지 않습니다.");
  }
}

function safeArtifactName(value: string, fallback: string): string {
  const validUtf8 = Buffer.from(value, "utf8").toString("utf8");
  const cleaned = basename(validUtf8).replace(/[\u0000-\u001f\u007f"\\]/g, "_").trim().slice(0, 160);
  return cleaned || fallback;
}

function redactArtifactLog(value: string): string {
  return redactWorkspaceSecrets(value)
    .replace(/(https?:\/\/)[^\s/:@]+:[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED TOKEN]")
    .replace(
      /\b([A-Za-z][A-Za-z0-9_.-]*(?:key|token|secret|password|credential))\s*([=:])\s*("[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi,
      "$1$2[REDACTED]",
    );
}

async function digestFileHandle(handle: FileHandle, path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path, { fd: handle.fd, autoClose: false, start: 0 })) {
    digest.update(chunk as Buffer);
  }
  return digest.digest("hex");
}

function boundedUtf8(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maximumBytes) return value;
  return bytes.subarray(0, maximumBytes).toString("utf8").replace(/\uFFFD$/u, "");
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
