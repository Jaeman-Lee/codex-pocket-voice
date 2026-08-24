import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

const MAX_KEY_BYTES = 8 * 1024;
const MAX_STATE_BYTES = 128;
const GENERATION_PATTERN = /^[a-f0-9]{32}$/;

export class LinuxProviderCredentialError extends Error {}

export function systemdCredentialPath(
  environment: NodeJS.ProcessEnv,
  credentialName: string,
): string | null {
  const directory = environment.CREDENTIALS_DIRECTORY;
  if (!directory) return null;
  if (!isAbsolute(directory) || /[\u0000-\u001f\u007f]/.test(directory)) {
    throw new LinuxProviderCredentialError("systemd credential 디렉터리 설정이 잘못됐습니다.");
  }
  return join(directory, credentialName);
}

export async function enforceProviderCredentialState(
  environment: NodeJS.ProcessEnv,
  providerName: string,
  credentialName: string,
  generationEnvironmentName: string,
): Promise<void> {
  const statePath = providerCredentialStatePath(environment, credentialName);
  if (!statePath) return;
  const rawState = await readPrivateUtf8File(
    statePath,
    `${providerName} credential state`,
    MAX_STATE_BYTES,
    true,
  );
  if (rawState === null) return;
  const state = rawState.endsWith("\n") ? rawState.slice(0, -1) : rawState;
  const separator = state.indexOf(":");
  if (separator < 0 || state.includes("\n") || state.includes("\r")) {
    throw new LinuxProviderCredentialError(`${providerName} credential state 형식이 잘못됐습니다.`);
  }
  const status = state.slice(0, separator);
  const generation = state.slice(separator + 1);
  if ((status !== "enabled" && status !== "disabled") || !GENERATION_PATTERN.test(generation)) {
    throw new LinuxProviderCredentialError(`${providerName} credential state 형식이 잘못됐습니다.`);
  }
  if (status === "disabled") {
    throw new LinuxProviderCredentialError(`${providerName} API credential이 해제되어 새 run을 시작할 수 없습니다.`);
  }
  if (environment[generationEnvironmentName] !== generation) {
    throw new LinuxProviderCredentialError(
      `${providerName} API credential 변경을 적용하려면 활성 turn 종료 후 Companion을 다시 시작해 주세요.`,
    );
  }
}

export async function readLinuxProviderCredential(
  filePath: string,
  providerName: string,
  missingAllowed = false,
): Promise<string | null> {
  const decoded = await readPrivateUtf8File(
    filePath,
    `${providerName} API key`,
    MAX_KEY_BYTES,
    missingAllowed,
  );
  if (decoded === null) return null;
  const key = normalizeProviderKey(decoded);
  if (!key) {
    throw new LinuxProviderCredentialError(`${providerName} API key 파일이 비어 있거나 형식이 잘못됐습니다.`);
  }
  return key;
}

export function normalizeProviderKey(value: string | undefined): string | null {
  const normalized = value?.trim();
  if (!normalized || Buffer.byteLength(normalized) > MAX_KEY_BYTES
      || /\s|[\u0000-\u001f\u007f]/u.test(normalized)) return null;
  return normalized;
}

function providerCredentialStatePath(
  environment: NodeJS.ProcessEnv,
  credentialName: string,
): string | null {
  const configured = environment.CODEX_POCKET_PROVIDER_CREDENTIAL_STATE_DIR;
  const directory = configured
    ?? (environment.XDG_CONFIG_HOME
      ? join(environment.XDG_CONFIG_HOME, "codex-pocket-voice", "credentials.encrypted")
      : environment.HOME
        ? join(environment.HOME, ".config", "codex-pocket-voice", "credentials.encrypted")
        : null);
  if (!directory) return null;
  if (!isAbsolute(directory) || /[\u0000-\u001f\u007f]/.test(directory)) {
    throw new LinuxProviderCredentialError("Provider credential state 디렉터리 설정이 잘못됐습니다.");
  }
  return join(directory, `${credentialName}.state`);
}

export async function readPrivateUtf8File(
  filePath: string,
  label: string,
  maximumBytes: number,
  missingAllowed: boolean,
): Promise<string | null> {
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (missingAllowed && code === "ENOENT") return null;
    if (code === "ELOOP") {
      throw new LinuxProviderCredentialError(`${label} 파일은 symlink일 수 없습니다.`);
    }
    if (code === "ENOENT") {
      throw new LinuxProviderCredentialError(`${label} 파일을 찾을 수 없습니다.`);
    }
    throw new LinuxProviderCredentialError(`${label} 파일을 안전하게 열 수 없습니다.`);
  }

  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      throw new LinuxProviderCredentialError(`${label} 경로가 일반 파일이 아닙니다.`);
    }
    if (info.size > maximumBytes) {
      throw new LinuxProviderCredentialError(`${label} 파일이 너무 큽니다.`);
    }
    const privateMode = info.mode & 0o777;
    if (privateMode !== 0o600 && privateMode !== 0o400) {
      throw new LinuxProviderCredentialError(`${label} 파일 권한을 0600 또는 0400으로 제한해 주세요.`);
    }
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
      throw new LinuxProviderCredentialError(`${label} 파일 소유자가 Companion 사용자와 다릅니다.`);
    }

    const bytes = Buffer.alloc(maximumBytes + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > maximumBytes) {
      throw new LinuxProviderCredentialError(`${label} 파일이 너무 큽니다.`);
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytesRead));
    } catch {
      throw new LinuxProviderCredentialError(`${label} 파일 형식이 잘못됐습니다.`);
    }
  } finally {
    await handle.close();
  }
}
