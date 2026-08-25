import {
  enforceProviderCredentialState,
  LinuxProviderCredentialError,
  normalizeProviderKey,
  readLinuxProviderCredential,
  systemdCredentialPath,
} from "./linux-provider-credential.js";

export interface OpenAICredential {
  apiKey: string;
  source: "systemd_credential" | "environment" | "protected_file";
}

export interface OpenAICredentialSource {
  load(): Promise<OpenAICredential | null>;
}

export class OpenAICredentialError extends Error {}

export class EnvironmentOpenAICredentialSource implements OpenAICredentialSource {
  constructor(private readonly environment: NodeJS.ProcessEnv = process.env) {}

  async load(): Promise<OpenAICredential | null> {
    try {
      await enforceProviderCredentialState(
        this.environment,
        "OpenAI",
        "openai-api-key",
        "CODEX_POCKET_OPENAI_CREDENTIAL_GENERATION",
      );
      const credentialPath = systemdCredentialPath(this.environment, "openai-api-key");
      if (credentialPath) {
        const systemdKey = await readLinuxProviderCredential(credentialPath, "OpenAI", true);
        if (systemdKey) return { apiKey: systemdKey, source: "systemd_credential" };
      }
    } catch (error) {
      throw credentialError(error, "OpenAI systemd credential을 읽을 수 없습니다.");
    }

    const environmentKey = normalizeProviderKey(this.environment.OPENAI_API_KEY);
    if (environmentKey) return { apiKey: environmentKey, source: "environment" };

    const keyFile = this.environment.CODEX_POCKET_OPENAI_API_KEY_FILE;
    if (!keyFile) return null;
    try {
      const fileKey = await readLinuxProviderCredential(keyFile, "OpenAI");
      if (!fileKey) throw new OpenAICredentialError("OpenAI API key 파일을 찾을 수 없습니다.");
      return { apiKey: fileKey, source: "protected_file" };
    } catch (error) {
      throw credentialError(error, "OpenAI API key 파일을 읽을 수 없습니다.");
    }
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
    .replace(/((?:OPENAI|OPENROUTER)_API_KEY\s*[:=]\s*)\S+/gi, "$1[REDACTED]");
}

function credentialError(error: unknown, fallback: string): OpenAICredentialError {
  return new OpenAICredentialError(error instanceof LinuxProviderCredentialError ? error.message : fallback);
}
