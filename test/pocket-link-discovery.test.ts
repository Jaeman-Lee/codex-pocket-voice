import assert from "node:assert/strict";
import test from "node:test";
import {
  pocketLinkDiscoveryEnabled,
  startPocketLinkDiscoveryAdvertisement,
} from "../src/pocket-link-discovery.js";

test("PocketLink LAN advertisement is explicit and publishes no trust or pairing secret", () => {
  assert.equal(pocketLinkDiscoveryEnabled({}), false);
  assert.equal(pocketLinkDiscoveryEnabled({ CODEX_POCKET_LINK_DISCOVERY: "0" }), false);
  assert.equal(pocketLinkDiscoveryEnabled({ CODEX_POCKET_LINK_DISCOVERY: "1" }), true);
  assert.throws(
    () => pocketLinkDiscoveryEnabled({ CODEX_POCKET_LINK_DISCOVERY: "true" }),
    /must be 0 or 1/,
  );

  let published: Record<string, unknown> | undefined;
  let stopped = 0;
  let destroyed = 0;
  const advertisement = startPocketLinkDiscoveryAdvertisement({
    deviceName: "작업실 Linux",
    port: 8789,
    createBonjour: () => ({
      publish(options) {
        published = options;
        return { stop: () => { stopped += 1; } };
      },
      destroy() { destroyed += 1; },
    }),
  });

  assert.deepEqual(published, {
    name: "작업실 Linux",
    type: "codexpocket",
    protocol: "tcp",
    port: 8789,
    txt: { v: "1" },
    probe: true,
  });
  const serialized = JSON.stringify(published);
  assert.doesNotMatch(serialized, /"(?:pin|pairingCode|token|deviceId|workspace|project)"/i);

  advertisement.close();
  advertisement.close();
  assert.equal(stopped, 1);
  assert.equal(destroyed, 1);
});

test("PocketLink advertisement rejects unbounded identity and invalid ports", () => {
  const createBonjour = () => {
    throw new Error("must not initialize multicast");
  };
  assert.throws(() => startPocketLinkDiscoveryAdvertisement({
    deviceName: "x".repeat(61),
    port: 8789,
    createBonjour,
  }), /device name/);
  assert.throws(() => startPocketLinkDiscoveryAdvertisement({
    deviceName: "Linux\u202ePC",
    port: 8789,
    createBonjour,
  }), /device name/);
  assert.throws(() => startPocketLinkDiscoveryAdvertisement({
    deviceName: "Linux PC",
    port: 80,
    createBonjour,
  }), /port/);
});

test("PocketLink advertisement reports multicast failure at most once", () => {
  let onError = 0;
  let errorCallback: (() => void) | undefined;
  const advertisement = startPocketLinkDiscoveryAdvertisement({
    deviceName: "Linux PC",
    port: 8789,
    onError: () => { onError += 1; },
    createBonjour(callback) {
      errorCallback = callback;
      return {
        publish: () => ({ stop: () => undefined }),
        destroy: () => undefined,
      };
    },
  });
  errorCallback?.();
  errorCallback?.();
  assert.equal(onError, 1);
  advertisement.close();
});
