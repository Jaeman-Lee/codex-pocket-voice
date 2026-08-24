import type { DeviceId, DeviceTarget } from "./types";

export const MAX_FLEET_DEVICES = 8;

export type FleetDeviceStatus = "online" | "offline" | "unsupported" | "pairing-required" | "identity-review-required";

export interface FleetDeviceSnapshot {
  deviceId: DeviceId;
  name: string;
  status: FleetDeviceStatus;
  running: number;
  waitingForApproval: number;
  unknown: number;
  failed: number;
  retainedOperations: number;
  recoveryBlocked: boolean;
  updatedAt: string;
}

export interface FleetSummary {
  schema: 1;
  running: number;
  waitingForApproval: number;
  unknown: number;
  failed: number;
  retainedOperations: number;
  recoveryBlocked: boolean;
}

export function boundedFleetTargets(
  targets: readonly DeviceTarget[],
  activeDevice: DeviceId,
): DeviceTarget[] {
  const linux = targets.filter((target) => target.kind === "linux");
  const active = linux.find((target) => target.id === activeDevice);
  const selected = linux.slice(0, MAX_FLEET_DEVICES);
  if (!active || selected.some((target) => target.id === active.id)) return selected.map(cloneTarget);
  return [active, ...selected.slice(0, MAX_FLEET_DEVICES - 1)].map(cloneTarget);
}

export function onlineFleetSnapshot(input: {
  target: DeviceTarget;
  response: unknown;
  now?: number;
}): FleetDeviceSnapshot {
  const summary = parseFleetSummary(input.response);
  return {
    deviceId: input.target.id,
    name: input.target.name,
    status: "online",
    running: summary.running,
    waitingForApproval: summary.waitingForApproval,
    unknown: summary.unknown,
    failed: summary.failed,
    retainedOperations: summary.retainedOperations,
    recoveryBlocked: summary.recoveryBlocked,
    updatedAt: new Date(input.now ?? Date.now()).toISOString(),
  };
}

export function unavailableFleetSnapshot(
  target: DeviceTarget,
  status: Exclude<FleetDeviceStatus, "online">,
  now = Date.now(),
): FleetDeviceSnapshot {
  return {
    deviceId: target.id,
    name: target.name,
    status,
    running: 0,
    waitingForApproval: 0,
    unknown: 0,
    failed: 0,
    retainedOperations: 0,
    recoveryBlocked: false,
    updatedAt: new Date(now).toISOString(),
  };
}

function cloneTarget(target: DeviceTarget): DeviceTarget {
  return { ...target };
}

function parseFleetSummary(response: unknown): FleetSummary {
  if (!isRecord(response) || !hasExactKeys(response, ["summary"]) || !isRecord(response.summary)) {
    throw new Error("Fleet summary response is invalid");
  }
  const summary = response.summary;
  if (!hasExactKeys(summary, [
    "schema",
    "running",
    "waitingForApproval",
    "unknown",
    "failed",
    "retainedOperations",
    "recoveryBlocked",
  ]) || summary.schema !== 1 || typeof summary.recoveryBlocked !== "boolean") {
    throw new Error("Fleet summary response is invalid");
  }
  return {
    schema: 1,
    running: fleetCount(summary.running),
    waitingForApproval: fleetCount(summary.waitingForApproval),
    unknown: fleetCount(summary.unknown),
    failed: fleetCount(summary.failed),
    retainedOperations: fleetCount(summary.retainedOperations),
    recoveryBlocked: summary.recoveryBlocked,
  };
}

function fleetCount(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 10_000) {
    throw new Error("Fleet summary response is invalid");
  }
  return value as number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && actual.every((key) => expected.includes(key));
}
