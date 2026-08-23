import { readFile, stat } from "node:fs/promises";

const MAX_KEY_BYTES = 8 * 1024;

export interface OpenRouterCredential {
  apiKey: string;
  source: "environment" | "protected_file";
}

export interface OpenRouterCredentialSource {
  load(): Promise<OpenRouterCredential | null>;
}

export class OpenRouterCredentialError extends Error {}

export class EnvironmentOpenRouterCredentialSource implements OpenRouterCredentialSource {
  constructor(private readonly environment: NodeJS.ProcessEnv = process.env) {}

  async load(): Promise<OpenRouterCredential | null> {
    const environmentKey = normalizeKey(this.environment.OPENROUTER_API_KEY);
    if (environmentKey) return { apiKey: environmentKey, source: "environment" };

    const keyFile = this.environment.CODEX_POCKET_OPENROUTER_API_KEY_FILE;
    if (!keyFile) return null;
    const info = await stat(keyFile).catch(() => null);
    if (!info?.isFile()) throw new OpenRouterCredentialError("OpenRouter API key 파일을 찾을 수 없습니다.");
    if (info.size > MAX_KEY_BYTES) throw new OpenRouterCredentialError("OpenRouter API key 파일이 너무 큽니다.");
    if ((info.mode & 0o077) !== 0) {
      throw new OpenRouterCredentialError("OpenRouter API key 파일 권한을 0600으로 제한해 주세요.");
    }
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
      throw new OpenRouterCredentialError("OpenRouter API key 파일 소유자가 Companion 사용자와 다릅니다.");
    }
    const fileKey = normalizeKey(await readFile(keyFile, "utf8"));
    if (!fileKey) throw new OpenRouterCredentialError("OpenRouter API key 파일이 비어 있거나 형식이 잘못됐습니다.");
    return { apiKey: fileKey, source: "protected_file" };
  }
}

function normalizeKey(value: string | undefined): string | null {
  const normalized = value?.trim();
  if (!normalized || normalized.length > MAX_KEY_BYTES || /\s/.test(normalized)) return null;
  return normalized;
}
