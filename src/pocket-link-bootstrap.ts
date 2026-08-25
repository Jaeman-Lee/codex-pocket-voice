const BOOTSTRAP_SCHEME = "codex-pocket:";
const BOOTSTRAP_AUTHORITY = "pair";
const MAX_BOOTSTRAP_LENGTH = 2_048;
const MAX_PAIRING_LIFETIME_MS = 11 * 60_000;

export interface PocketLinkBootstrap {
  version: 1;
  host: string;
  port: number;
  serverPublicKeyPin: string;
  pairingCode: string;
  deviceId: string;
  deviceName: string;
  expiresAt: string;
}

export function createPocketLinkBootstrapUri(input: Omit<PocketLinkBootstrap, "version">): string {
  const url = new URL(`${BOOTSTRAP_SCHEME}//${BOOTSTRAP_AUTHORITY}`);
  url.searchParams.set("v", "1");
  url.searchParams.set("h", input.host);
  url.searchParams.set("p", String(input.port));
  url.searchParams.set("s", input.serverPublicKeyPin);
  url.searchParams.set("c", input.pairingCode);
  url.searchParams.set("d", input.deviceId);
  url.searchParams.set("n", input.deviceName);
  url.searchParams.set("e", String(Date.parse(input.expiresAt)));
  const encoded = url.toString();
  parsePocketLinkBootstrapUri(encoded, Date.parse(input.expiresAt) - 10 * 60_000);
  return encoded;
}

export function parsePocketLinkBootstrapUri(value: string, now = Date.now()): PocketLinkBootstrap {
  if (!value || value.length > MAX_BOOTSTRAP_LENGTH || value.trim() !== value) {
    throw new Error("PocketLink QR 데이터 길이가 올바르지 않습니다.");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("PocketLink QR 형식이 아닙니다.");
  }
  if (url.protocol !== BOOTSTRAP_SCHEME || url.hostname !== BOOTSTRAP_AUTHORITY
      || url.pathname !== "" || url.username || url.password || url.hash) {
    throw new Error("PocketLink QR 형식이 아닙니다.");
  }
  const expected = new Set(["v", "h", "p", "s", "c", "d", "n", "e"]);
  const seen = new Set<string>();
  for (const [key] of url.searchParams) {
    if (!expected.has(key) || seen.has(key)) throw new Error("PocketLink QR 필드가 올바르지 않습니다.");
    seen.add(key);
  }
  if (seen.size !== expected.size || url.searchParams.get("v") !== "1") {
    throw new Error("지원하지 않는 PocketLink QR 버전입니다.");
  }

  const host = url.searchParams.get("h")!;
  const portText = url.searchParams.get("p")!;
  const serverPublicKeyPin = url.searchParams.get("s")!;
  const pairingCode = url.searchParams.get("c")!;
  const deviceId = url.searchParams.get("d")!;
  const deviceName = url.searchParams.get("n")!.trim();
  const expiresText = url.searchParams.get("e")!;
  const port = Number(portText);
  const expiresAtMs = Number(expiresText);

  if (!isConnectionHost(host)) throw new Error("PocketLink QR host가 올바르지 않습니다.");
  if (!/^\d{4,5}$/.test(portText) || !Number.isInteger(port) || port < 1_024 || port > 65_535) {
    throw new Error("PocketLink QR port가 올바르지 않습니다.");
  }
  if (!/^sha256\/[A-Za-z0-9+/]{43}=$/.test(serverPublicKeyPin)) {
    throw new Error("PocketLink QR 인증서 pin이 올바르지 않습니다.");
  }
  if (!/^\d{8}$/.test(pairingCode)) throw new Error("PocketLink QR pairing code가 올바르지 않습니다.");
  if (!/^[A-Za-z0-9._-]{8,128}$/.test(deviceId)) throw new Error("PocketLink QR 장치 ID가 올바르지 않습니다.");
  if (!deviceName || deviceName.length > 60 || /[\u0000-\u001f\u007f]/.test(deviceName)) {
    throw new Error("PocketLink QR 장치 이름이 올바르지 않습니다.");
  }
  if (!/^\d{13}$/.test(expiresText) || !Number.isSafeInteger(expiresAtMs)
      || expiresAtMs <= now || expiresAtMs > now + MAX_PAIRING_LIFETIME_MS) {
    throw new Error("PocketLink QR pairing code가 만료되었거나 유효기간이 올바르지 않습니다.");
  }

  return {
    version: 1,
    host,
    port,
    serverPublicKeyPin,
    pairingCode,
    deviceId,
    deviceName,
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}

function isConnectionHost(value: string): boolean {
  if (!value || value.length > 253 || value === "0.0.0.0" || value === "::"
      || value.toLowerCase() === "localhost") return false;
  if (/^\d+(?:\.\d+){3}$/.test(value)) {
    return value.split(".").every((part) => Number(part) >= 0 && Number(part) <= 255);
  }
  if (value.includes(":")) {
    if (!/^[0-9A-Fa-f:]+$/.test(value)) return false;
    try {
      return new URL(`http://[${value}]/`).hostname.length > 2;
    } catch {
      return false;
    }
  }
  return value.split(".").every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label));
}
