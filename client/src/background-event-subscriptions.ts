import type { DeviceId, DeviceTarget } from "./types";

export interface BackgroundEventSubscription {
  deviceId: string;
  localPort: number;
  token: string;
}

export function collectBackgroundEventSubscriptions(
  targets: DeviceTarget[],
  tokenFor: (deviceId: DeviceId) => string | undefined,
): BackgroundEventSubscription[] {
  const subscriptions: BackgroundEventSubscription[] = [];
  const deviceIds = new Set<string>();
  const ports = new Set<number>();
  for (const target of targets) {
    if (subscriptions.length >= 8 || target.kind !== "linux") continue;
    const token = tokenFor(target.id);
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)
      || !target.id || target.id.length > 120 || /[\x00-\x1f\x7f]/.test(target.id)) continue;
    try {
      const base = new URL(target.baseUrl);
      const localPort = Number(base.port);
      if (base.protocol !== "http:" || (base.hostname !== "127.0.0.1" && base.hostname !== "localhost")
        || base.pathname !== "/" || base.username || base.password || base.search || base.hash
        || !Number.isInteger(localPort) || localPort < 1_024 || localPort > 65_535
        || deviceIds.has(target.id) || ports.has(localPort)) continue;
      subscriptions.push({ deviceId: target.id, localPort, token });
      deviceIds.add(target.id);
      ports.add(localPort);
    } catch {
      // Ignore corrupt or non-loopback targets instead of copying credentials into native state.
    }
  }
  return subscriptions;
}
