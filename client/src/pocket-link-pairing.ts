import type { PocketLinkBootstrap } from "../../src/pocket-link-bootstrap";

export type PendingPocketLinkBootstrap = PocketLinkBootstrap & { targetId?: string };

export type PocketLinkBootstrapDecision =
  | { kind: "wait" }
  | { kind: "expired" }
  | { kind: "device_mismatch" }
  | { kind: "ready"; pairingCode: string };

export function matchesPocketLinkConnection(
  bootstrap: PocketLinkBootstrap | null,
  host: string,
  port: number,
  serverPublicKeyPin: string,
): bootstrap is PocketLinkBootstrap {
  return bootstrap !== null
    && bootstrap.host === host
    && bootstrap.port === port
    && bootstrap.serverPublicKeyPin === serverPublicKeyPin;
}

export function evaluatePocketLinkBootstrap(
  bootstrap: PendingPocketLinkBootstrap | null,
  activeTargetId: string,
  remoteDeviceId: string,
  now = Date.now(),
): PocketLinkBootstrapDecision {
  if (!bootstrap?.targetId || bootstrap.targetId !== activeTargetId) return { kind: "wait" };
  if (Date.parse(bootstrap.expiresAt) <= now) return { kind: "expired" };
  if (bootstrap.deviceId !== remoteDeviceId) return { kind: "device_mismatch" };
  return { kind: "ready", pairingCode: bootstrap.pairingCode };
}
