import type { DeviceRevocationOutcome } from "./api";
import type { DeviceId, DeviceTarget } from "./types";

export interface DeviceRemovalSteps {
  revokeAuthorization(device: DeviceId): Promise<DeviceRevocationOutcome>;
  removeNativePocketLink(localPort: number): Promise<void>;
  removeLocalRegistration(device: DeviceId): Promise<void>;
}

export async function deleteDeviceRegistration(
  target: DeviceTarget,
  nativeApp: boolean,
  steps: DeviceRemovalSteps,
): Promise<DeviceRevocationOutcome> {
  const outcome = await steps.revokeAuthorization(target.id);
  if (nativeApp && target.transport === "pocketlink") {
    await steps.removeNativePocketLink(deviceTargetLocalPort(target));
  }
  await steps.removeLocalRegistration(target.id);
  return outcome;
}

function deviceTargetLocalPort(target: DeviceTarget): number {
  const url = new URL(target.baseUrl);
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1_024 || port > 65_535) {
    throw new Error("PocketLink 로컬 포트를 확인할 수 없습니다.");
  }
  return port;
}
