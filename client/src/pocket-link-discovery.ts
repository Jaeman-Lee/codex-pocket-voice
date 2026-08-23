const MAX_REVIEW_AGE_MS = 2 * 60_000;

export interface PocketLinkDiscoveryCandidate {
  name: string;
  host: string;
  port: number;
  expiresAt: number;
}

export function parsePocketLinkDiscoveryResult(value: unknown, now = Date.now()): PocketLinkDiscoveryCandidate[] {
  if (!record(value) || value.windowMs !== 8_000 || !Array.isArray(value.candidates)
      || value.candidates.length > 16 || !hasOnlyKeys(value, ["candidates", "windowMs"])) {
    throw new Error("PocketLink LAN 검색 결과가 올바르지 않습니다.");
  }
  const seen = new Set<string>();
  return value.candidates.map((item) => {
    const normalizedName = record(item) && typeof item.name === "string"
      ? item.name.normalize("NFC").trim()
      : "";
    if (!record(item)
        || !hasOnlyKeys(item, ["expiresAt", "host", "name", "port"])
        || typeof item.name !== "string"
        || !normalizedName
        || normalizedName.length > 60
        || /[\p{Cc}\p{Cf}]/u.test(normalizedName)
        || typeof item.host !== "string"
        || !isPrivateLanLiteral(item.host)
        || !Number.isInteger(item.port)
        || (item.port as number) < 1_024
        || (item.port as number) > 65_535
        || typeof item.expiresAt !== "number"
        || !Number.isSafeInteger(item.expiresAt)
        || item.expiresAt <= now
        || item.expiresAt > now + MAX_REVIEW_AGE_MS + 5_000) {
      throw new Error("PocketLink LAN 검색 후보가 올바르지 않습니다.");
    }
    const candidate = {
      name: normalizedName,
      host: item.host.toLowerCase(),
      port: item.port as number,
      expiresAt: item.expiresAt,
    };
    const key = `${candidate.name}\u0000${candidate.host}\u0000${candidate.port}`;
    if (seen.has(key)) throw new Error("PocketLink LAN 검색 후보가 중복되었습니다.");
    seen.add(key);
    return candidate;
  });
}

export function matchesPocketLinkDiscovery(
  candidate: PocketLinkDiscoveryCandidate | null,
  name: string,
  host: string,
  port: number,
  now = Date.now(),
): boolean {
  return candidate !== null
    && now < candidate.expiresAt
    && candidate.name === name.trim()
    && candidate.host === host.trim().toLowerCase()
    && candidate.port === port;
}

function isPrivateLanLiteral(value: string): boolean {
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value)) {
    const rawParts = value.split(".");
    if (rawParts.some((part) => String(Number(part)) !== part)) return false;
    const parts = rawParts.map(Number);
    if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
    const [first, second] = parts;
    return first === 10
      || (first === 172 && second! >= 16 && second! <= 31)
      || (first === 192 && second === 168)
      || (first === 169 && second === 254);
  }
  if (!validIpv6(value)) return false;
  const firstGroup = value.split(":", 1)[0]!.toLowerCase();
  return firstGroup.startsWith("fc") || firstGroup.startsWith("fd");
}

function validIpv6(value: string): boolean {
  if (!/^[0-9a-f:]+$/i.test(value)) return false;
  const halves = value.split("::");
  if (halves.length > 2) return false;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (![...left, ...right].every((group) => /^[0-9a-f]{1,4}$/i.test(group))) return false;
  return halves.length === 2 ? left.length + right.length < 8 : left.length === 8;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}
