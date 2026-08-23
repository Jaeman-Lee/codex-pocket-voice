import { readFile, stat } from "node:fs/promises";

const MAX_KEY_BYTES = 8 * 1024;

export interface OpenAICredential {
  apiKey: string;
  source: "environment" | "protected_file";
}

export interface OpenAICredentialSource {
  load(): Promise<OpenAICredential | null>;
}

export class OpenAICredentialError extends Error {}

export class EnvironmentOpenAICredentialSource implements OpenAICredentialSource {
  constructor(private readonly environment: NodeJS.ProcessEnv = process.env) {}

  async load(): Promise<OpenAICredential | null> {
    const environmentKey = normalizeKey(this.environment.OPENAI_API_KEY);
    if (environmentKey) return { apiKey: environmentKey, source: "environment" };

    const keyFile = this.environment.CODEX_POCKET_OPENAI_API_KEY_FILE;
    if (!keyFile) return null;
    const info = await stat(keyFile).catch(() => null);
    if (!info?.isFile()) throw new OpenAICredentialError("OpenAI API key 파일을 찾을 수 없습니다.");
    if (info.size > MAX_KEY_BYTES) throw new OpenAICredentialError("OpenAI API key 파일이 너무 큽니다.");
    if ((info.mode & 0o077) !== 0) {
      throw new OpenAICredentialError("OpenAI API key 파일 권한을 0600으로 제한해 주세요.");
    }
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
      throw new OpenAICredentialError("OpenAI API key 파일 소유자가 Companion 사용자와 다릅니다.");
    }
    const fileKey = normalizeKey(await readFile(keyFile, "utf8"));
    if (!fileKey) throw new OpenAICredentialError("OpenAI API key 파일이 비어 있거나 형식이 잘못됐습니다.");
    return { apiKey: fileKey, source: "protected_file" };
  }
}

export function redactProviderSecrets(value: string, secrets: readonly string[] = []): string {
  let redacted = value;
  for (const secret of secrets) {
    if (secret) redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk|sess)-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/(OPENAI_API_KEY\s*[:=]\s*)\S+/gi, "$1[REDACTED]");
}

function normalizeKey(value: string | undefined): string | null {
  const normalized = value?.trim();
  if (!normalized || normalized.length > MAX_KEY_BYTES || /\s/.test(normalized)) return null;
  return normalized;
}
