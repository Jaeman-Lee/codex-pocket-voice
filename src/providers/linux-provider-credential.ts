import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

const MAX_KEY_BYTES = 8 * 1024;

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

export async function readLinuxProviderCredential(
  filePath: string,
  providerName: string,
  missingAllowed = false,
): Promise<string | null> {
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (missingAllowed && code === "ENOENT") return null;
    if (code === "ELOOP") {
      throw new LinuxProviderCredentialError(`${providerName} API key 파일은 symlink일 수 없습니다.`);
    }
    if (code === "ENOENT") {
      throw new LinuxProviderCredentialError(`${providerName} API key 파일을 찾을 수 없습니다.`);
    }
    throw new LinuxProviderCredentialError(`${providerName} API key 파일을 안전하게 열 수 없습니다.`);
  }

  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      throw new LinuxProviderCredentialError(`${providerName} API key 경로가 일반 파일이 아닙니다.`);
    }
    if (info.size > MAX_KEY_BYTES) {
      throw new LinuxProviderCredentialError(`${providerName} API key 파일이 너무 큽니다.`);
    }
    if ((info.mode & 0o077) !== 0) {
      throw new LinuxProviderCredentialError(`${providerName} API key 파일 권한을 0600 또는 0400으로 제한해 주세요.`);
    }
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
      throw new LinuxProviderCredentialError(`${providerName} API key 파일 소유자가 Companion 사용자와 다릅니다.`);
    }

    const bytes = Buffer.alloc(MAX_KEY_BYTES + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > MAX_KEY_BYTES) {
      throw new LinuxProviderCredentialError(`${providerName} API key 파일이 너무 큽니다.`);
    }
    let decoded: string;
    try {
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytesRead));
    } catch {
      throw new LinuxProviderCredentialError(`${providerName} API key 파일 형식이 잘못됐습니다.`);
    }
    const key = normalizeProviderKey(decoded);
    if (!key) {
      throw new LinuxProviderCredentialError(`${providerName} API key 파일이 비어 있거나 형식이 잘못됐습니다.`);
    }
    return key;
  } finally {
    await handle.close();
  }
}

export function normalizeProviderKey(value: string | undefined): string | null {
  const normalized = value?.trim();
  if (!normalized || Buffer.byteLength(normalized) > MAX_KEY_BYTES
      || /\s|[\u0000-\u001f\u007f]/u.test(normalized)) return null;
  return normalized;
}
