import {
  enforceProviderCredentialState,
  LinuxProviderCredentialError,
  normalizeProviderKey,
  readLinuxProviderCredential,
  systemdCredentialPath,
} from "./linux-provider-credential.js";

export interface OpenRouterCredential {
  apiKey: string;
  source: "systemd_credential" | "environment" | "protected_file";
}

export interface OpenRouterCredentialSource {
  load(): Promise<OpenRouterCredential | null>;
}

export class OpenRouterCredentialError extends Error {}

export class EnvironmentOpenRouterCredentialSource implements OpenRouterCredentialSource {
  constructor(private readonly environment: NodeJS.ProcessEnv = process.env) {}

  async load(): Promise<OpenRouterCredential | null> {
    try {
      await enforceProviderCredentialState(
        this.environment,
        "OpenRouter",
        "openrouter-api-key",
        "CODEX_POCKET_OPENROUTER_CREDENTIAL_GENERATION",
      );
      const credentialPath = systemdCredentialPath(this.environment, "openrouter-api-key");
      if (credentialPath) {
        const systemdKey = await readLinuxProviderCredential(credentialPath, "OpenRouter", true);
        if (systemdKey) return { apiKey: systemdKey, source: "systemd_credential" };
      }
    } catch (error) {
      throw credentialError(error, "OpenRouter systemd credential을 읽을 수 없습니다.");
    }

    const environmentKey = normalizeProviderKey(this.environment.OPENROUTER_API_KEY);
    if (environmentKey) return { apiKey: environmentKey, source: "environment" };

    const keyFile = this.environment.CODEX_POCKET_OPENROUTER_API_KEY_FILE;
    if (!keyFile) return null;
    try {
      const fileKey = await readLinuxProviderCredential(keyFile, "OpenRouter");
      if (!fileKey) throw new OpenRouterCredentialError("OpenRouter API key 파일을 찾을 수 없습니다.");
      return { apiKey: fileKey, source: "protected_file" };
    } catch (error) {
      throw credentialError(error, "OpenRouter API key 파일을 읽을 수 없습니다.");
    }
  }
}

function credentialError(error: unknown, fallback: string): OpenRouterCredentialError {
  return new OpenRouterCredentialError(error instanceof LinuxProviderCredentialError ? error.message : fallback);
}
