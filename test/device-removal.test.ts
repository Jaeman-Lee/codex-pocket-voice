import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { deleteDeviceRegistration, type DeviceRemovalSteps } from "../client/src/device-removal.js";
import type { DeviceTarget } from "../client/src/types.js";

const target: DeviceTarget = {
  id: "linux-pocket",
  name: "Pocket PC",
  kind: "linux",
  baseUrl: "http://127.0.0.1:8791",
  transport: "pocketlink",
  remoteDeviceId: "remote-pocket",
};

test("device removal revokes the exact Companion before native keys and local registration", async () => {
  const calls: string[] = [];
  const outcome = await deleteDeviceRegistration(target, true, steps({
    revokeAuthorization: async (device) => {
      calls.push(`revoke:${device}`);
      return "revoked";
    },
    removeNativePocketLink: async (port) => { calls.push(`native:${port}`); },
    removeLocalRegistration: async (device) => { calls.push(`local:${device}`); },
  }));

  assert.equal(outcome, "revoked");
  assert.deepEqual(calls, ["revoke:linux-pocket", "native:8791", "local:linux-pocket"]);
});

test("an uncertain remote revocation leaves native keys and local registration intact", async () => {
  const calls: string[] = [];
  await assert.rejects(
    deleteDeviceRegistration(target, true, steps({
      revokeAuthorization: async (device) => {
        calls.push(`revoke:${device}`);
        throw new Error("offline");
      },
      removeNativePocketLink: async (port) => { calls.push(`native:${port}`); },
      removeLocalRegistration: async (device) => { calls.push(`local:${device}`); },
    })),
    /offline/,
  );
  assert.deepEqual(calls, ["revoke:linux-pocket"]);
});

test("native cleanup failure leaves the unpaired local registration available for retry", async () => {
  const calls: string[] = [];
  await assert.rejects(
    deleteDeviceRegistration(target, true, steps({
      revokeAuthorization: async (device) => {
        calls.push(`revoke:${device}`);
        return "already_revoked";
      },
      removeNativePocketLink: async (port) => {
        calls.push(`native:${port}`);
        throw new Error("keystore busy");
      },
      removeLocalRegistration: async (device) => { calls.push(`local:${device}`); },
    })),
    /keystore busy/,
  );
  assert.deepEqual(calls, ["revoke:linux-pocket", "native:8791"]);
});

test("non-native and Termux registrations skip PocketLink key cleanup", async () => {
  for (const [candidate, nativeApp] of [
    [target, false],
    [{ ...target, transport: "termux" as const }, true],
  ] as const) {
    const calls: string[] = [];
    await deleteDeviceRegistration(candidate, nativeApp, steps({
      revokeAuthorization: async () => { calls.push("revoke"); return "not_paired"; },
      removeNativePocketLink: async () => { calls.push("native"); },
      removeLocalRegistration: async () => { calls.push("local"); },
    }));
    assert.deepEqual(calls, ["revoke", "local"]);
  }
});

test("App requires a separate touch review before deleting a device", async () => {
  const app = await readFile(new URL("../client/src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /onClick=\{\(\) => reviewLinuxDeviceRemoval\(target\)\}[\s\S]*>삭제<\/button>/);
  assert.match(app, /reviewingDeviceRemovalTarget !== target\.id[\s\S]*deleteDeviceRegistration/);
  assert.match(app, /Companion에서 이 스마트폰의 인증 권한을 먼저 해제합니다/);
  assert.match(app, /"권한 해제 후 삭제"/);
});

function steps(overrides: DeviceRemovalSteps): DeviceRemovalSteps {
  return overrides;
}
