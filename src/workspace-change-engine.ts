import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import type { PathPolicy } from "./path-policy.js";
import { isSensitivePath } from "./read-only-tools.js";
import { ToolBrokerError } from "./tool-broker.js";

const TRANSACTION_VERSION = 1;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_RECOVERY_FILE_BYTES = 1024 * 1024;
const UUID_SOURCE = "[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}";
const UUID_PATTERN = new RegExp(`^${UUID_SOURCE}$`);
const TRANSACTION_FILE = new RegExp(`^(${UUID_SOURCE})\\.json$`);
const STALE_JOURNAL_TEMP = new RegExp(`^\\.codex-pocket-(${UUID_SOURCE})\\.tmp$`);

export interface WorkspaceFileSnapshot {
  workspace: string;
  path: string;
  target: string;
  content: string;
  sha256: string;
  mode: number;
  device: number;
  inode: number;
}

export interface WorkspaceReplacementPlan {
  current: WorkspaceFileSnapshot;
  content: string;
  nextSha256: string;
}

export interface WorkspaceCreationPlan {
  workspace: string;
  path: string;
  target: string;
  content: string;
  nextSha256: string;
  mode: number;
}

export interface WorkspaceRenamePlan {
  current: WorkspaceFileSnapshot;
  targetPath: string;
  target: string;
}

export type WorkspaceChangeMutation =
  | "file-staged"
  | "replace-installed"
  | "create-installed"
  | "rename-target-linked"
  | "rename-source-removed"
  | "transaction-committed";

export class SimulatedWorkspaceChangeCrash extends Error {}

export interface WorkspaceChangeEngineOptions {
  transactionDirectory: string;
  beforeCommit?: (index: number, path: string) => Promise<void>;
  afterMutation?: (mutation: WorkspaceChangeMutation, index: number, path: string) => Promise<void>;
}

interface ReplacementManifestItem {
  kind: "replace";
  path: string;
  expectedSha256: string;
  nextSha256: string;
  mode: number;
  device: number;
  inode: number;
}

interface CreationManifestItem {
  kind: "create";
  path: string;
  nextSha256: string;
  mode: number;
}

interface RenameManifestItem {
  kind: "rename";
  sourcePath: string;
  targetPath: string;
  expectedSha256: string;
  device: number;
  inode: number;
}

type WorkspaceChangeManifest =
  | {
      version: 1;
      id: string;
      workspace: string;
      phase: "staging" | "prepared" | "committed";
      operation: "replace";
      items: ReplacementManifestItem[];
    }
  | {
      version: 1;
      id: string;
      workspace: string;
      phase: "staging" | "prepared" | "committed";
      operation: "create";
      items: [CreationManifestItem];
    }
  | {
      version: 1;
      id: string;
      workspace: string;
      phase: "staging" | "prepared" | "committed";
      operation: "rename";
      items: [RenameManifestItem];
    };

interface InspectedFile {
  sha256: string;
  device: number;
  inode: number;
  links: number;
}

export class WorkspaceChangeEngine {
  private tail: Promise<void> = Promise.resolve();
  private failure: unknown;

  private constructor(
    private readonly paths: PathPolicy,
    private readonly journal: WorkspaceTransactionJournal,
    private readonly options: WorkspaceChangeEngineOptions,
  ) {}

  static async create(
    paths: PathPolicy,
    options: WorkspaceChangeEngineOptions,
  ): Promise<WorkspaceChangeEngine> {
    const journal = await WorkspaceTransactionJournal.create(options.transactionDirectory);
    const engine = new WorkspaceChangeEngine(paths, journal, options);
    await engine.recoverAll();
    return engine;
  }

  replace(
    plans: readonly WorkspaceReplacementPlan[],
    signal?: AbortSignal,
  ): Promise<{ cleanupPending: boolean }> {
    return this.exclusive(() => this.replaceExclusive(plans, signal));
  }

  createFile(
    plan: WorkspaceCreationPlan,
    signal?: AbortSignal,
  ): Promise<{ cleanupPending: boolean }> {
    return this.exclusive(() => this.createExclusive(plan, signal));
  }

  renameFile(
    plan: WorkspaceRenamePlan,
    signal?: AbortSignal,
  ): Promise<{ cleanupPending: boolean }> {
    return this.exclusive(() => this.renameExclusive(plan, signal));
  }

  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const guarded = () => {
      if (this.failure) throw this.failure;
      return action();
    };
    const result = this.tail.then(guarded, guarded);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async recoverAll(): Promise<void> {
    for (const manifest of await this.journal.list()) {
      await this.assertManifestWorkspace(manifest);
      if (manifest.phase === "staging") await this.cleanupStaging(manifest);
      else if (manifest.phase === "prepared") await this.rollbackPrepared(manifest);
      else await this.finishCommitted(manifest);
    }
  }

  private async replaceExclusive(
    plans: readonly WorkspaceReplacementPlan[],
    signal?: AbortSignal,
  ): Promise<{ cleanupPending: boolean }> {
    if (plans.length === 0) throw new ToolBrokerError(400, "Replacement transaction is empty");
    const workspace = plans[0]!.current.workspace;
    if (plans.some((plan) => plan.current.workspace !== workspace)) {
      throw new ToolBrokerError(400, "Replacement transaction spans multiple workspaces");
    }
    const manifest: WorkspaceChangeManifest = {
      version: TRANSACTION_VERSION,
      id: randomUUID(),
      workspace,
      phase: "staging",
      operation: "replace",
      items: plans.map((plan) => ({
        kind: "replace",
        path: plan.current.path,
        expectedSha256: plan.current.sha256,
        nextSha256: plan.nextSha256,
        mode: plan.current.mode,
        device: plan.current.device,
        inode: plan.current.inode,
      })),
    };
    await this.journal.persist(manifest);
    try {
      for (let index = 0; index < plans.length; index += 1) {
        await stageFile(artifactPath(manifest, index, "tmp"), plans[index]!.content, plans[index]!.current.mode, signal);
        await this.options.afterMutation?.("file-staged", index, plans[index]!.current.path);
      }
      manifest.phase = "prepared";
      await this.journal.persist(manifest);
      for (let index = 0; index < plans.length; index += 1) {
        const plan = plans[index]!;
        await this.options.beforeCommit?.(index, plan.current.path);
        assertNotCancelled(signal);
        const backup = artifactPath(manifest, index, "bak");
        await link(plan.current.target, backup);
        await assertFile(backup, {
          sha256: plan.current.sha256,
          device: plan.current.device,
          inode: plan.current.inode,
          links: 2,
        });
        await rename(artifactPath(manifest, index, "tmp"), plan.current.target);
        await this.options.afterMutation?.("replace-installed", index, plan.current.path);
      }
      await syncDirectories(plans.map((plan) => path.dirname(plan.current.target)));
      manifest.phase = "committed";
      await this.journal.persist(manifest);
      await this.options.afterMutation?.("transaction-committed", plans.length - 1, plans.at(-1)!.current.path);
    } catch (error) {
      if (error instanceof SimulatedWorkspaceChangeCrash) throw error;
      await this.rollbackAfterFailure(manifest, error);
    }
    return { cleanupPending: !(await this.tryFinishCommitted(manifest)) };
  }

  private async createExclusive(
    plan: WorkspaceCreationPlan,
    signal?: AbortSignal,
  ): Promise<{ cleanupPending: boolean }> {
    const manifest: WorkspaceChangeManifest = {
      version: TRANSACTION_VERSION,
      id: randomUUID(),
      workspace: plan.workspace,
      phase: "staging",
      operation: "create",
      items: [{ kind: "create", path: plan.path, nextSha256: plan.nextSha256, mode: plan.mode }],
    };
    await this.journal.persist(manifest);
    try {
      const temporary = artifactPath(manifest, 0, "tmp");
      await stageFile(temporary, plan.content, plan.mode, signal);
      await this.options.afterMutation?.("file-staged", 0, plan.path);
      manifest.phase = "prepared";
      await this.journal.persist(manifest);
      await this.options.beforeCommit?.(0, plan.path);
      assertNotCancelled(signal);
      await link(temporary, plan.target);
      await this.options.afterMutation?.("create-installed", 0, plan.path);
      await syncDirectories([path.dirname(plan.target)]);
      manifest.phase = "committed";
      await this.journal.persist(manifest);
      await this.options.afterMutation?.("transaction-committed", 0, plan.path);
    } catch (error) {
      if (error instanceof SimulatedWorkspaceChangeCrash) throw error;
      await this.rollbackAfterFailure(manifest, error);
    }
    return { cleanupPending: !(await this.tryFinishCommitted(manifest)) };
  }

  private async renameExclusive(
    plan: WorkspaceRenamePlan,
    signal?: AbortSignal,
  ): Promise<{ cleanupPending: boolean }> {
    const manifest: WorkspaceChangeManifest = {
      version: TRANSACTION_VERSION,
      id: randomUUID(),
      workspace: plan.current.workspace,
      phase: "prepared",
      operation: "rename",
      items: [{
        kind: "rename",
        sourcePath: plan.current.path,
        targetPath: plan.targetPath,
        expectedSha256: plan.current.sha256,
        device: plan.current.device,
        inode: plan.current.inode,
      }],
    };
    await this.journal.persist(manifest);
    try {
      await this.options.beforeCommit?.(0, plan.current.path);
      assertNotCancelled(signal);
      await link(plan.current.target, plan.target);
      await assertFile(plan.target, {
        sha256: plan.current.sha256,
        device: plan.current.device,
        inode: plan.current.inode,
        links: 2,
      });
      await this.options.afterMutation?.("rename-target-linked", 0, plan.current.path);
      await syncDirectories([path.dirname(plan.target)]);
      await assertFile(plan.current.target, {
        sha256: plan.current.sha256,
        device: plan.current.device,
        inode: plan.current.inode,
        links: 2,
      });
      await unlink(plan.current.target);
      await this.options.afterMutation?.("rename-source-removed", 0, plan.current.path);
      await syncDirectories([path.dirname(plan.current.target)]);
      manifest.phase = "committed";
      await this.journal.persist(manifest);
      await this.options.afterMutation?.("transaction-committed", 0, plan.targetPath);
    } catch (error) {
      if (error instanceof SimulatedWorkspaceChangeCrash) throw error;
      await this.rollbackAfterFailure(manifest, error);
    }
    return { cleanupPending: !(await this.tryFinishCommitted(manifest)) };
  }

  private async rollbackPrepared(manifest: WorkspaceChangeManifest): Promise<void> {
    if (manifest.operation === "replace") await this.rollbackReplacements(manifest);
    else if (manifest.operation === "create") await this.rollbackCreation(manifest);
    else await this.rollbackRename(manifest);
    await this.journal.remove(manifest.id);
  }

  private async rollbackAfterFailure(manifest: WorkspaceChangeManifest, original: unknown): Promise<never> {
    try {
      if (manifest.phase === "staging") await this.cleanupStaging(manifest);
      else if (manifest.phase === "prepared") await this.rollbackPrepared(manifest);
      else await this.finishCommitted(manifest);
    } catch (recoveryFailure) {
      this.failure = recoveryFailure;
      throw recoveryFailure;
    }
    throw original;
  }

  private async cleanupStaging(manifest: WorkspaceChangeManifest): Promise<void> {
    if (manifest.operation === "rename") {
      throw recoveryError("Rename transaction cannot have a staging phase");
    }
    const directories: string[] = [];
    for (let index = 0; index < manifest.items.length; index += 1) {
      const item = manifest.items[index]!;
      const target = await this.targetPath(manifest.workspace, item.path);
      const temporary = artifactPath(manifest, index, "tmp");
      const backup = artifactPath(manifest, index, "bak");
      directories.push(path.dirname(target));
      if (await inspectFile(backup)) {
        throw recoveryError(`A backup exists before commit started for ${item.path}`);
      }
      const temporaryInfo = await inspectFile(temporary);
      if (temporaryInfo) {
        if (temporaryInfo.links !== 1) {
          throw recoveryError(`Staging artifact has unexpected links for ${item.path}`);
        }
        await unlink(temporary);
      }
    }
    await syncDirectories(directories);
    await this.journal.remove(manifest.id);
  }

  private async rollbackReplacements(
    manifest: Extract<WorkspaceChangeManifest, { operation: "replace" }>,
  ): Promise<void> {
    const directories: string[] = [];
    for (let index = manifest.items.length - 1; index >= 0; index -= 1) {
      const item = manifest.items[index]!;
      const target = await this.targetPath(manifest.workspace, item.path);
      const temporary = artifactPath(manifest, index, "tmp");
      const backup = artifactPath(manifest, index, "bak");
      directories.push(path.dirname(target));
      const backupInfo = await inspectFile(backup);
      const targetInfo = await inspectFile(target);
      const temporaryInfo = await inspectFile(temporary);
      if (temporaryInfo && temporaryInfo.sha256 !== item.nextSha256) {
        throw recoveryError(`Staged replacement is untrusted while recovering ${item.path}`);
      }
      if (backupInfo) {
        if (isSnapshot(backupInfo, item.expectedSha256, item.device, item.inode)) {
          if (targetInfo && !sameIdentity(targetInfo, backupInfo)
              && targetInfo.sha256 !== item.expectedSha256 && targetInfo.sha256 !== item.nextSha256) {
            throw recoveryError(`Target changed independently while recovering ${item.path}`);
          }
          if (targetInfo && sameIdentity(targetInfo, backupInfo)) await unlink(backup);
          else await rename(backup, target);
        } else if (targetInfo && sameIdentity(targetInfo, backupInfo)) {
          // The source raced before installation. Remove only our hard-link and preserve the external edit.
          await unlink(backup);
        } else {
          throw recoveryError(`Original backup is untrusted while recovering ${item.path}`);
        }
      } else if (!temporaryInfo && (!targetInfo || !isSnapshot(
        targetInfo,
        item.expectedSha256,
        item.device,
        item.inode,
      ))) {
        throw recoveryError(`Original backup is unavailable while recovering ${item.path}`);
      }
      if (temporaryInfo) await unlink(temporary);
    }
    await syncDirectories(directories);
  }

  private async rollbackCreation(
    manifest: Extract<WorkspaceChangeManifest, { operation: "create" }>,
  ): Promise<void> {
    const item = manifest.items[0];
    const target = await this.targetPath(manifest.workspace, item.path);
    const temporary = artifactPath(manifest, 0, "tmp");
    const targetInfo = await inspectFile(target);
    const temporaryInfo = await inspectFile(temporary);
    if (temporaryInfo && temporaryInfo.sha256 !== item.nextSha256) {
      throw recoveryError(`Staged creation is untrusted while recovering ${item.path}`);
    }
    if (targetInfo && temporaryInfo && sameIdentity(targetInfo, temporaryInfo)) await unlink(target);
    if (temporaryInfo) await unlink(temporary);
    await syncDirectories([path.dirname(target)]);
  }

  private async rollbackRename(
    manifest: Extract<WorkspaceChangeManifest, { operation: "rename" }>,
  ): Promise<void> {
    const item = manifest.items[0];
    const source = await this.targetPath(manifest.workspace, item.sourcePath);
    const target = await this.targetPath(manifest.workspace, item.targetPath);
    const sourceInfo = await inspectFile(source);
    const targetInfo = await inspectFile(target);
    if (sourceInfo && targetInfo && sameIdentity(sourceInfo, targetInfo)) {
      // The target link belongs to this transaction even if the source content raced before verification.
      await unlink(target);
      await syncDirectories([path.dirname(source), path.dirname(target)]);
      return;
    }
    if (sourceInfo && isSnapshot(sourceInfo, item.expectedSha256, item.device, item.inode)) {
      await syncDirectories([path.dirname(source), path.dirname(target)]);
      return;
    }
    if (!sourceInfo && targetInfo && isSnapshot(targetInfo, item.expectedSha256, item.device, item.inode)) {
      await link(target, source);
      await assertFile(source, {
        sha256: item.expectedSha256,
        device: item.device,
        inode: item.inode,
        links: 2,
      });
      await unlink(target);
      await syncDirectories([path.dirname(source), path.dirname(target)]);
      return;
    }
    throw recoveryError(`Rename cannot be rolled back without overwriting ${item.sourcePath}`);
  }

  private async tryFinishCommitted(manifest: WorkspaceChangeManifest): Promise<boolean> {
    try {
      await this.finishCommitted(manifest);
      return true;
    } catch (error) {
      this.failure = error;
      return false;
    }
  }

  private async finishCommitted(manifest: WorkspaceChangeManifest): Promise<void> {
    const directories: string[] = [];
    if (manifest.operation === "replace") {
      for (let index = 0; index < manifest.items.length; index += 1) {
        const item = manifest.items[index]!;
        const target = await this.targetPath(manifest.workspace, item.path);
        directories.push(path.dirname(target));
        await removeVerifiedArtifact(artifactPath(manifest, index, "bak"), item.expectedSha256);
        await removeVerifiedArtifact(artifactPath(manifest, index, "tmp"), item.nextSha256);
      }
    } else if (manifest.operation === "create") {
      const item = manifest.items[0];
      const target = await this.targetPath(manifest.workspace, item.path);
      directories.push(path.dirname(target));
      await removeVerifiedArtifact(artifactPath(manifest, 0, "tmp"), item.nextSha256);
    } else {
      const item = manifest.items[0];
      directories.push(
        path.dirname(await this.targetPath(manifest.workspace, item.sourcePath)),
        path.dirname(await this.targetPath(manifest.workspace, item.targetPath)),
      );
    }
    await syncDirectories(directories);
    await this.journal.remove(manifest.id);
  }

  private async assertManifestWorkspace(manifest: WorkspaceChangeManifest): Promise<void> {
    const workspace = await this.paths.resolveWorkspace(manifest.workspace).catch(() => null);
    if (!workspace || workspace !== manifest.workspace) {
      throw recoveryError("A pending transaction references an unavailable workspace");
    }
    for (const item of manifest.items) {
      if (item.kind === "rename") {
        await this.targetPath(workspace, item.sourcePath);
        await this.targetPath(workspace, item.targetPath);
      } else {
        await this.targetPath(workspace, item.path);
      }
    }
  }

  private async targetPath(workspace: string, relativePath: string): Promise<string> {
    validateManifestPath(relativePath);
    const target = path.join(workspace, relativePath);
    const parent = path.dirname(target);
    const canonicalParent = await realpath(parent).catch(() => null);
    if (!canonicalParent || canonicalParent !== parent) {
      throw recoveryError(`Transaction path has a missing or linked parent: ${relativePath}`);
    }
    return target;
  }
}

class WorkspaceTransactionJournal {
  private constructor(readonly directory: string) {}

  static async create(requestedDirectory: string): Promise<WorkspaceTransactionJournal> {
    const resolved = path.resolve(requestedDirectory);
    await mkdir(resolved, { recursive: true, mode: 0o700 });
    const direct = await lstat(resolved);
    if (!direct.isDirectory() || direct.isSymbolicLink()) {
      throw recoveryError("Workspace transaction path must be a private directory");
    }
    const canonical = await realpath(resolved);
    if (canonical !== resolved) throw recoveryError("Workspace transaction directory cannot be symlinked");
    await chmod(canonical, 0o700);
    return new WorkspaceTransactionJournal(canonical);
  }

  async list(): Promise<WorkspaceChangeManifest[]> {
    const manifests: WorkspaceChangeManifest[] = [];
    const entries = await readdir(this.directory, { withFileTypes: true });
    for (const entry of entries) {
      const stale = STALE_JOURNAL_TEMP.exec(entry.name);
      if (stale) {
        if (!entry.isFile()) throw recoveryError("Workspace transaction journal contains an unsafe temporary entry");
        await unlink(path.join(this.directory, entry.name));
        continue;
      }
      const match = TRANSACTION_FILE.exec(entry.name);
      if (!match) continue;
      if (!entry.isFile()) throw recoveryError("Workspace transaction journal contains an unsafe manifest entry");
      const manifestPath = path.join(this.directory, entry.name);
      const direct = await lstat(manifestPath);
      if (!direct.isFile() || direct.isSymbolicLink() || direct.nlink !== 1 || direct.size > MAX_MANIFEST_BYTES
          || (direct.mode & 0o077) !== 0) {
        throw recoveryError("Workspace transaction manifest is not a private bounded file");
      }
      const bytes = await readPrivateManifest(manifestPath, direct.dev, direct.ino);
      const manifest = parseManifest(bytes);
      if (manifest.id !== match[1]) throw recoveryError("Workspace transaction filename does not match its ID");
      manifests.push(manifest);
    }
    return manifests.sort((left, right) => left.id.localeCompare(right.id));
  }

  async persist(manifest: WorkspaceChangeManifest): Promise<void> {
    const bytes = Buffer.from(JSON.stringify(manifest), "utf8");
    if (bytes.length > MAX_MANIFEST_BYTES) throw recoveryError("Workspace transaction manifest is too large");
    const destination = path.join(this.directory, `${manifest.id}.json`);
    const temporary = path.join(this.directory, `.codex-pocket-${manifest.id}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, destination);
      await syncDirectories([this.directory]);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  async remove(id: string): Promise<void> {
    await unlink(path.join(this.directory, `${id}.json`));
    await syncDirectories([this.directory]);
  }
}

function parseManifest(bytes: Buffer): WorkspaceChangeManifest {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw recoveryError("Workspace transaction manifest is invalid JSON");
  }
  if (!isRecord(value) || !hasExactKeys(value, ["version", "id", "workspace", "phase", "operation", "items"])
      || value.version !== TRANSACTION_VERSION || typeof value.id !== "string" || !UUID_PATTERN.test(value.id)
      || typeof value.workspace !== "string" || value.workspace.length < 1 || value.workspace.length > 4_096
      || (value.phase !== "staging" && value.phase !== "prepared" && value.phase !== "committed")
      || !Array.isArray(value.items)) {
    throw recoveryError("Workspace transaction manifest has an unsupported shape");
  }
  if (value.operation === "replace" && value.items.length >= 1 && value.items.length <= 8
      && value.items.every(isReplacementManifestItem)) {
    return value as unknown as Extract<WorkspaceChangeManifest, { operation: "replace" }>;
  }
  if (value.operation === "create" && value.items.length === 1 && isCreationManifestItem(value.items[0])) {
    return value as unknown as Extract<WorkspaceChangeManifest, { operation: "create" }>;
  }
  if (value.operation === "rename" && value.items.length === 1 && isRenameManifestItem(value.items[0])) {
    return value as unknown as Extract<WorkspaceChangeManifest, { operation: "rename" }>;
  }
  throw recoveryError("Workspace transaction manifest contains unsupported operations");
}

function isReplacementManifestItem(value: unknown): value is ReplacementManifestItem {
  return isRecord(value) && hasExactKeys(value, [
    "kind", "path", "expectedSha256", "nextSha256", "mode", "device", "inode",
  ]) && value.kind === "replace" && validPathAndHashes(value, "path", "expectedSha256", "nextSha256")
    && validMode(value.mode) && validIdentity(value.device, value.inode);
}

function isCreationManifestItem(value: unknown): value is CreationManifestItem {
  return isRecord(value) && hasExactKeys(value, ["kind", "path", "nextSha256", "mode"])
    && value.kind === "create" && validPathAndHashes(value, "path", "nextSha256")
    && validMode(value.mode);
}

function isRenameManifestItem(value: unknown): value is RenameManifestItem {
  return isRecord(value) && hasExactKeys(value, [
    "kind", "sourcePath", "targetPath", "expectedSha256", "device", "inode",
  ]) && value.kind === "rename"
    && validPathAndHashes(value, "sourcePath", "targetPath", "expectedSha256")
    && value.sourcePath !== value.targetPath && validIdentity(value.device, value.inode);
}

function validPathAndHashes(value: Record<string, unknown>, ...keys: string[]): boolean {
  return keys.every((key) => {
    const item = value[key];
    if (key.toLowerCase().includes("sha")) return typeof item === "string" && /^[a-f0-9]{64}$/.test(item);
    return typeof item === "string" && safeManifestPath(item);
  });
}

function validMode(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0o777;
}

function validIdentity(device: unknown, inode: unknown): boolean {
  return typeof device === "number" && Number.isSafeInteger(device) && device >= 0
    && typeof inode === "number" && Number.isSafeInteger(inode) && inode > 0;
}

function safeManifestPath(value: string): boolean {
  if (value.length < 1 || value.length > 500 || value.includes("\0") || value.includes("\\") || path.isAbsolute(value)) {
    return false;
  }
  const components = value.split("/");
  return !components.some((component) => !component || component === "." || component === "..")
    && !isSensitivePath(value);
}

function validateManifestPath(value: string): void {
  if (!safeManifestPath(value)) throw recoveryError("Workspace transaction contains an unsafe relative path");
}

function artifactPath(manifest: WorkspaceChangeManifest, index: number, suffix: "tmp" | "bak"): string {
  const item = manifest.items[index];
  if (!item) throw recoveryError("Workspace transaction artifact index is invalid");
  const relative = item.kind === "rename" ? item.sourcePath : item.path;
  return path.join(
    path.dirname(path.join(manifest.workspace, relative)),
    `.codex-pocket-${manifest.id}-${index}.${suffix}`,
  );
}

async function stageFile(target: string, content: string, mode: number, signal?: AbortSignal): Promise<void> {
  assertNotCancelled(signal);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(target, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.chmod(mode);
    await handle.close();
    handle = undefined;
    assertNotCancelled(signal);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(target).catch(() => undefined);
    throw error;
  }
}

async function inspectFile(target: string): Promise<InspectedFile | null> {
  const direct = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!direct) return null;
  if (!direct.isFile() || direct.isSymbolicLink() || direct.size > MAX_RECOVERY_FILE_BYTES) {
    throw recoveryError(`Recovery path is not a bounded regular file: ${path.basename(target)}`);
  }
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== direct.dev || opened.ino !== direct.ino || opened.size > MAX_RECOVERY_FILE_BYTES) {
      throw recoveryError(`Recovery path changed while being checked: ${path.basename(target)}`);
    }
    const bytes = await handle.readFile();
    return {
      sha256: createHash("sha256").update(bytes).digest("hex"),
      device: opened.dev,
      inode: opened.ino,
      links: opened.nlink,
    };
  } finally {
    await handle.close();
  }
}

async function assertFile(
  target: string,
  expected: { sha256: string; device?: number; inode?: number; links?: number },
): Promise<void> {
  const actual = await inspectFile(target);
  if (!actual || actual.sha256 !== expected.sha256
      || (expected.device !== undefined && actual.device !== expected.device)
      || (expected.inode !== undefined && actual.inode !== expected.inode)
      || (expected.links !== undefined && actual.links !== expected.links)) {
    throw new ToolBrokerError(409, "File changed while the approved transaction was being committed");
  }
}

async function readPrivateManifest(target: string, device: number, inode: number): Promise<Buffer> {
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== device || opened.ino !== inode
        || opened.size > MAX_MANIFEST_BYTES || (opened.mode & 0o077) !== 0) {
      throw recoveryError("Workspace transaction manifest changed while it was being read");
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function isSnapshot(actual: InspectedFile, sha256: string, device: number, inode: number): boolean {
  return actual.sha256 === sha256 && actual.device === device && actual.inode === inode;
}

function sameIdentity(left: InspectedFile, right: InspectedFile): boolean {
  return left.device === right.device && left.inode === right.inode;
}

async function removeVerifiedArtifact(target: string, expectedSha256: string): Promise<void> {
  const actual = await inspectFile(target);
  if (!actual) return;
  if (actual.sha256 !== expectedSha256) {
    throw recoveryError(`Internal transaction artifact changed unexpectedly: ${path.basename(target)}`);
  }
  await unlink(target);
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

function assertNotCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ToolBrokerError(499, "Tool execution was cancelled");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && actual.every((key) => expected.includes(key));
}

function recoveryError(message: string): ToolBrokerError {
  return new ToolBrokerError(500, `Workspace change recovery stopped safely: ${message}`);
}
