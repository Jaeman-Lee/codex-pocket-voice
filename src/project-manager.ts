import { spawn } from "node:child_process";
import { mkdir, realpath, rm, stat } from "node:fs/promises";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { PathPolicy } from "./path-policy.js";

export interface ProjectLocation {
  path: string;
  name: string;
}

export interface CreatedProject extends ProjectLocation {
  gitInitialized: boolean;
}

export class ProjectCreationError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

export class ProjectManager {
  private constructor(
    private readonly paths: PathPolicy,
    readonly creationRoots: readonly string[],
  ) {}

  static async fromEnvironment(
    paths: PathPolicy,
    value = process.env.CODEX_PROJECT_CREATION_ROOTS,
  ): Promise<ProjectManager> {
    const roots: string[] = [];
    for (const candidate of value?.split(delimiter).filter(Boolean) ?? []) {
      const canonical = await realpath(resolve(candidate)).catch(() => null);
      if (!canonical) continue;
      const info = await stat(canonical).catch(() => null);
      if (info?.isDirectory() && !roots.includes(canonical)) roots.push(canonical);
    }
    return new ProjectManager(paths, roots);
  }

  list(): ProjectLocation[] {
    return this.paths.roots.map((path) => ({ path, name: basename(path) || path }));
  }

  creationLocations(): ProjectLocation[] {
    return this.creationRoots.map((path) => ({ path, name: basename(path) || path }));
  }

  async create(name: string, requestedParent?: string): Promise<CreatedProject> {
    const projectName = validateProjectName(name);
    if (this.creationRoots.length === 0) {
      throw new ProjectCreationError(403, "이 단말에는 새 프로젝트를 만들 위치가 설정되지 않았습니다.");
    }
    const parent = requestedParent
      ? this.creationRoots.find((root) => root === resolve(requestedParent))
      : this.creationRoots[0];
    if (!parent) throw new ProjectCreationError(400, "허용되지 않은 프로젝트 위치입니다.");
    const destination = join(parent, projectName);
    if (dirname(destination) !== parent) throw new ProjectCreationError(400, "프로젝트 이름이 올바르지 않습니다.");
    if (await stat(destination).catch(() => null)) throw new ProjectCreationError(409, "같은 이름의 폴더가 이미 있습니다.");

    await mkdir(destination, { recursive: false, mode: 0o700 });
    try {
      await runGitInit(destination);
      const canonical = await this.paths.addRoot(destination);
      return { path: canonical, name: projectName, gitInitialized: true };
    } catch (error) {
      await rm(destination, { recursive: true, force: true });
      throw error;
    }
  }
}

function validateProjectName(value: string): string {
  const name = value.trim();
  if (!name || name.length > 80 || name === "." || name === "..") {
    throw new ProjectCreationError(400, "프로젝트 이름은 1~80자로 입력하세요.");
  }
  if (/[\\/\u0000-\u001f\u007f]/.test(name)) {
    throw new ProjectCreationError(400, "프로젝트 이름에 경로 문자나 제어 문자를 사용할 수 없습니다.");
  }
  return name;
}

function runGitInit(cwd: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", ["init", "--initial-branch=main"], {
      cwd,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`Git 저장소 초기화 실패${stderr.trim() ? `: ${stderr.trim().slice(-500)}` : ""}`));
    });
  });
}
