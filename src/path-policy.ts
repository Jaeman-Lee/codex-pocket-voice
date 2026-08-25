import path from "node:path";
import { realpath, stat } from "node:fs/promises";

export class PathPolicy {
  private constructor(private readonly rootValues: string[]) {}

  get roots(): readonly string[] {
    return this.rootValues;
  }

  static async fromEnvironment(
    value = process.env.CODEX_VOICE_ROOTS,
    fallback = process.cwd(),
  ): Promise<PathPolicy> {
    const candidates = value
      ? value.split(path.delimiter).filter(Boolean)
      : [fallback];

    if (candidates.length === 0) {
      throw new Error("CODEX_VOICE_ROOTS does not contain a workspace path");
    }

    const roots: string[] = [];
    for (const candidate of candidates) {
      const canonical = await realpath(path.resolve(candidate));
      const info = await stat(canonical);
      if (!info.isDirectory()) {
        throw new Error(`Allowed workspace is not a directory: ${candidate}`);
      }
      if (!roots.includes(canonical)) roots.push(canonical);
    }
    return new PathPolicy(roots);
  }

  async addRoot(candidate: string): Promise<string> {
    const canonical = await realpath(path.resolve(candidate));
    const info = await stat(canonical);
    if (!info.isDirectory()) throw new Error(`Workspace is not a directory: ${candidate}`);
    if (!this.rootValues.includes(canonical)) this.rootValues.push(canonical);
    return canonical;
  }

  async resolveWorkspace(requested?: string): Promise<string> {
    const canonical = await realpath(path.resolve(requested ?? this.roots[0]!));
    if (!this.isAllowed(canonical)) {
      throw new Error(
        `Workspace is outside CODEX_VOICE_ROOTS: ${canonical}. Allowed: ${this.roots.join(", ")}`,
      );
    }
    return canonical;
  }

  async resolveExistingPath(cwd: string, requested = "."): Promise<string> {
    const workspace = await this.resolveWorkspace(cwd);
    if (path.isAbsolute(requested)) {
      throw new Error("Workspace paths must be relative to the selected project");
    }
    const candidate = path.resolve(workspace, requested);
    if (!isWithin(workspace, candidate)) {
      throw new Error("Workspace path escapes the selected project");
    }
    const canonical = await realpath(candidate);
    if (!isWithin(workspace, canonical)) {
      throw new Error("Workspace path resolves outside the selected project");
    }
    return canonical;
  }

  async resolveRelativePath(cwd: string, requested = "."): Promise<string> {
    const workspace = await this.resolveWorkspace(cwd);
    if (path.isAbsolute(requested)) {
      throw new Error("Workspace paths must be relative to the selected project");
    }
    const candidate = path.resolve(workspace, requested);
    if (!isWithin(workspace, candidate)) {
      throw new Error("Workspace path escapes the selected project");
    }
    return candidate;
  }

  assertAllowed(cwd: string): void {
    const resolved = path.resolve(cwd);
    if (!this.isAllowed(resolved)) {
      throw new Error(`Thread workspace is not allowed: ${resolved}`);
    }
  }

  isAllowed(candidate: string): boolean {
    const resolved = path.resolve(candidate);
    return this.roots.some(
      (root) => resolved === root || resolved.startsWith(`${root}${path.sep}`),
    );
  }
}

function isWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}
