import type { PocketLinkStatus } from "./native";

export const POCKET_LINK_PIN_PROMOTION_MAX_AGE_MS = 120_000;

export function isRecentBackupPinObservation(
  status: PocketLinkStatus | undefined,
  now = Date.now(),
): boolean {
  const observedAt = status?.pinObservedAt;
  if (status?.error || status?.pinSlot !== "backup" || typeof observedAt !== "number" || !Number.isFinite(observedAt)) {
    return false;
  }
  const age = now - observedAt;
  return age >= 0 && age <= POCKET_LINK_PIN_PROMOTION_MAX_AGE_MS;
}

export function pocketLinkSecurityStatus(
  status: PocketLinkStatus | undefined,
  now = Date.now(),
): string {
  if (!status) return "PocketLink TLS · 상태 확인 중";
  const label = status.route === "relay"
    ? "PocketLink relay"
    : status.route === "p2p"
      ? "PocketLink Wi-Fi Direct"
    : status.route === "auto"
      ? status.lastVerifiedRoute === "relay"
        ? "PocketLink 자동→relay"
        : status.lastVerifiedRoute === "p2p"
          ? "PocketLink 자동→P2P"
        : status.lastVerifiedRoute === "direct"
          ? "PocketLink 자동→LAN"
          : "PocketLink 자동"
      : "PocketLink TLS";
  if (status.error) return `${label} · ${status.error}`;
  if (isRecentBackupPinObservation(status, now)) return `${label} · 새 인증서 확인됨`;
  if (status.pinSlot === "backup") return `${label} · 새 인증서 확인 만료`;
  if (status.pinSlot === "primary") return `${label} · 기본 pin 확인`;
  return status.running ? `${label} · 연결 대기` : `${label} · 중지됨`;
}
