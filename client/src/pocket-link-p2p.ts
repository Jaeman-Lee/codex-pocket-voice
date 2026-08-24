const MAX_REVIEW_AGE_MS = 2 * 60_000;

export interface PocketLinkP2pCandidate {
  id: string;
  name: string;
  expiresAt: number;
}

export function parsePocketLinkP2pResult(value: unknown, now = Date.now()): PocketLinkP2pCandidate[] {
  if (!record(value) || value.windowMs !== 12_000 || !Array.isArray(value.candidates)
      || value.candidates.length > 16 || !hasOnlyKeys(value, ["candidates", "windowMs"])) {
    throw new Error("PocketLink Wi-Fi Direct 검색 결과가 올바르지 않습니다.");
  }
  const seen = new Set<string>();
  return value.candidates.map((item) => {
    const normalizedName = record(item) && typeof item.name === "string"
      ? item.name.normalize("NFC").trim()
      : "";
    if (!record(item)
        || !hasOnlyKeys(item, ["expiresAt", "id", "name"])
        || typeof item.id !== "string"
        || !/^[A-Za-z0-9_-]{24}$/.test(item.id)
        || typeof item.name !== "string"
        || !normalizedName
        || normalizedName.length > 60
        || /[\p{Cc}\p{Cf}]/u.test(normalizedName)
        || typeof item.expiresAt !== "number"
        || !Number.isSafeInteger(item.expiresAt)
        || item.expiresAt <= now
        || item.expiresAt > now + MAX_REVIEW_AGE_MS + 5_000) {
      throw new Error("PocketLink Wi-Fi Direct 후보가 올바르지 않습니다.");
    }
    if (seen.has(item.id)) throw new Error("PocketLink Wi-Fi Direct 후보가 중복되었습니다.");
    seen.add(item.id);
    return { id: item.id, name: normalizedName, expiresAt: item.expiresAt };
  });
}

export function isCurrentPocketLinkP2pCandidate(
  candidate: PocketLinkP2pCandidate | null,
  now = Date.now(),
): boolean {
  return candidate !== null && now < candidate.expiresAt;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}
