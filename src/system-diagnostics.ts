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

export interface DiagnosticSupportBundle {
  schemaVersion: 1;
  generatedAt: string;
  companion: {
    appVersion: string;
    protocol: {
      minimum: number;
      maximum: number;
      capabilities: Record<string, boolean>;
    };
  };
  system: SystemDiagnostics;
  privacy: {
    mode: "allowlist-only";
    omitted: string[];
  };
}

export interface DiagnosticSupportBundleOptions {
  appVersion: string;
  minimumProtocol: number;
  maximumProtocol: number;
  capabilities: Readonly<Record<string, boolean>>;
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
    const version = result === undefined ? undefined : sanitizeDiagnosticVersion(spec.id, result);
    return {
      id: spec.id,
      label: spec.label,
      required: spec.required,
      available: result !== undefined,
      ...(version ? { version } : {}),
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

export function createDiagnosticSupportBundle(
  diagnostics: SystemDiagnostics,
  options: DiagnosticSupportBundleOptions,
): DiagnosticSupportBundle {
  return {
    schemaVersion: 1,
    generatedAt: diagnostics.checkedAt,
    companion: {
      appVersion: options.appVersion,
      protocol: {
        minimum: options.minimumProtocol,
        maximum: options.maximumProtocol,
        capabilities: Object.fromEntries(
          Object.entries(options.capabilities).sort(([left], [right]) => left.localeCompare(right)),
        ),
      },
    },
    system: structuredClone(diagnostics),
    privacy: {
      mode: "allowlist-only",
      omitted: [
        "credentials and environment variables",
        "device identifiers and network addresses",
        "workspace paths and Git metadata",
        "prompts, responses, command output, and error text",
        "journal, approval, and artifact content",
      ],
    },
  };
}

export function sanitizeDiagnosticVersion(toolId: string, output: string): string | undefined {
  const patterns: Record<string, RegExp> = {
    codex: /\bcodex(?:-cli)?\s+v?([0-9][0-9A-Za-z.+_~-]{0,63})\b/i,
    git: /\bgit\s+version\s+v?([0-9][0-9A-Za-z.+_~-]{0,63})\b/i,
    tmux: /\btmux\s+v?([0-9][0-9A-Za-z.+_~-]{0,63})\b/i,
    ssh: /\bOpenSSH[_\s]v?([0-9][0-9A-Za-z.+_~-]{0,63})\b/i,
    ffmpeg: /\bffmpeg\s+version\s+v?([0-9][0-9A-Za-z.+_~-]{0,63})\b/i,
    ollama: /\bollama\s+version(?:\s+is)?\s+v?([0-9][0-9A-Za-z.+_~-]{0,63})\b/i,
  };
  return patterns[toolId]?.exec(output)?.[1];
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
