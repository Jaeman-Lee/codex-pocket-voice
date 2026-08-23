import { createHash, createPrivateKey, createPublicKey, X509Certificate } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, resolve } from "node:path";
import { createSecureContext } from "node:tls";

const DEFAULT_PORT = 8789;
const MAX_PEM_BYTES = 64 * 1024;

export interface PocketLinkTlsConfig {
  host: string;
  port: number;
  advertiseHost: string;
  certificate: Buffer;
  privateKey: Buffer;
  publicKeyPin: string;
}

export async function loadPocketLinkTlsConfig(
  environment: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
): Promise<PocketLinkTlsConfig | undefined> {
  const enabledValues = [
    environment.CODEX_POCKET_LINK_HOST,
    environment.CODEX_POCKET_LINK_PORT,
    environment.CODEX_POCKET_LINK_ADVERTISE_HOST,
    environment.CODEX_POCKET_LINK_CERT_FILE,
    environment.CODEX_POCKET_LINK_KEY_FILE,
  ];
  if (enabledValues.every((value) => !value)) return undefined;

  const host = requiredHost(environment.CODEX_POCKET_LINK_HOST, "CODEX_POCKET_LINK_HOST");
  const advertiseHost = requiredHost(
    environment.CODEX_POCKET_LINK_ADVERTISE_HOST ?? (isWildcardHost(host) ? undefined : host),
    "CODEX_POCKET_LINK_ADVERTISE_HOST",
  );
  if (isWildcardHost(advertiseHost)) {
    throw new Error("CODEX_POCKET_LINK_ADVERTISE_HOST must identify the Linux Companion");
  }
  const port = optionalPort(environment.CODEX_POCKET_LINK_PORT);
  const certificateFile = resolve(requiredPath(environment.CODEX_POCKET_LINK_CERT_FILE, "CODEX_POCKET_LINK_CERT_FILE"));
  const privateKeyFile = resolve(requiredPath(environment.CODEX_POCKET_LINK_KEY_FILE, "CODEX_POCKET_LINK_KEY_FILE"));
  if (certificateFile === privateKeyFile) throw new Error("PocketLink certificate and private key must use different files");

  await assertPrivateDirectory(dirname(privateKeyFile));
  const [certificate, privateKey] = await Promise.all([
    readSafeFile(certificateFile, "PocketLink certificate", false),
    readSafeFile(privateKeyFile, "PocketLink private key", true),
  ]);

  let parsed: X509Certificate;
  try {
    parsed = new X509Certificate(certificate);
    const key = createPrivateKey(privateKey);
    if (!createPublicKey(key).equals(parsed.publicKey)) {
      throw new Error("certificate and key do not match");
    }
    createSecureContext({ cert: certificate, key: privateKey, minVersion: "TLSv1.2" });
  } catch {
    throw new Error("PocketLink certificate and private key are invalid or do not match");
  }
  if (now < Date.parse(parsed.validFrom) || now > Date.parse(parsed.validTo)) {
    throw new Error("PocketLink certificate is not currently valid");
  }
  const covered = isIP(advertiseHost)
    ? parsed.checkIP(advertiseHost)
    : parsed.checkHost(advertiseHost, { subject: "never" });
  if (!parsed.subjectAltName || !covered) {
    throw new Error("PocketLink certificate does not cover CODEX_POCKET_LINK_ADVERTISE_HOST");
  }

  return {
    host,
    port,
    advertiseHost,
    certificate,
    privateKey,
    publicKeyPin: publicKeyPin(parsed),
  };
}

export function publicKeyPin(certificate: X509Certificate): string {
  const encoded = certificate.publicKey.export({ type: "spki", format: "der" });
  return `sha256/${createHash("sha256").update(encoded).digest("base64")}`;
}

function requiredHost(value: string | undefined, name: string): string {
  const host = value?.trim();
  if (!host || host.length > 253 || (!isIP(host) && !isHostname(host))) {
    throw new Error(`${name} is invalid`);
  }
  return host;
}

function isHostname(value: string): boolean {
  return value.split(".").every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label));
}

function isWildcardHost(value: string): boolean {
  return value === "0.0.0.0" || value === "::";
}

function optionalPort(value: string | undefined): number {
  if (value === undefined || value === "") return DEFAULT_PORT;
  if (!/^[0-9]{1,5}$/.test(value)) throw new Error("CODEX_POCKET_LINK_PORT is invalid");
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1_024 || port > 65_535) {
    throw new Error("CODEX_POCKET_LINK_PORT must be between 1024 and 65535");
  }
  return port;
}

function requiredPath(value: string | undefined, name: string): string {
  if (!value || !value.trim() || value.includes("\0")) throw new Error(`${name} is required`);
  return value;
}

async function assertPrivateDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    throw new Error("PocketLink private key directory permissions must be 0700");
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error("PocketLink private key directory owner does not match the Companion user");
  }
}

async function readSafeFile(path: string, label: string, privateKey: boolean): Promise<Buffer> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new Error(`${label} must not be a symlink`);
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1) throw new Error(`${label} must be a regular single-link file`);
    if (info.size < 1 || info.size > MAX_PEM_BYTES) throw new Error(`${label} size is invalid`);
    if (privateKey && (info.mode & 0o077) !== 0) throw new Error("PocketLink private key permissions must be 0600");
    if (privateKey && typeof process.getuid === "function" && info.uid !== process.getuid()) {
      throw new Error("PocketLink private key owner does not match the Companion user");
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}
