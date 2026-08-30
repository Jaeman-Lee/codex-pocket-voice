import { spawn } from "node:child_process";

export interface DiagnosticTool {
  id: string;
  label: string;
  required: boolean;
  available: boolean;
  version?: string;
}

export interface SystemDiagnostics {
  ok: boolean;
  platform: "linux";
  architecture: string;
  nodeVersion: string;
  tools: DiagnosticTool[];
  workspaceCount: number;
  creationLocationCount: number;
  checkedAt: string;
}

export async function collectSystemDiagnostics(workspaceCount: number, creationLocationCount: number): Promise<SystemDiagnostics> {
  if (process.platform !== "linux") throw new Error("Pocket Companion은 Linux에서만 지원됩니다.");
  const specs = [
    { id: "codex", label: "Codex CLI", command: process.env.CODEX_BIN ?? "codex", args: ["--version"], required: true },
    { id: "git", label: "Git", command: "git", args: ["--version"], required: true },
    { id: "tmux", label: "tmux", command: "tmux", args: ["-V"], required: true },
    { id: "ssh", label: "OpenSSH", command: "ssh", args: ["-V"], required: true },
    { id: "ffmpeg", label: "ffmpeg", command: "ffmpeg", args: ["-version"], required: false },
    { id: "ollama", label: "Ollama", command: process.env.CODEX_VIDEO_OLLAMA_BIN ?? "ollama", args: ["--version"], required: false },
  ] as const;
  const tools = await Promise.all(specs.map(async (spec): Promise<DiagnosticTool> => {
    const result = await runVersion(spec.command, [...spec.args]);
    return {
      id: spec.id,
      label: spec.label,
      required: spec.required,
      available: result !== undefined,
      ...(result ? { version: result } : {}),
    };
  }));
  return {
    ok: tools.every((tool) => !tool.required || tool.available),
    platform: "linux",
    architecture: process.arch,
    nodeVersion: process.version,
    tools,
    workspaceCount,
    creationLocationCount,
    checkedAt: new Date().toISOString(),
  };
}

function runVersion(command: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const append = (chunk: Buffer) => { output = `${output}${chunk.toString("utf8")}`.slice(0, 1_000); };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.once("error", () => resolve(undefined));
    const timer = setTimeout(() => child.kill("SIGTERM"), 3_000);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? output.trim().split("\n", 1)[0]?.slice(0, 160) : undefined);
    });
  });
}
