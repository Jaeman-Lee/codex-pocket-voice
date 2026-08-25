import assert from "node:assert/strict";
import test from "node:test";
import { collectBackgroundEventSubscriptions } from "../client/src/background-event-subscriptions.js";
import type { DeviceTarget } from "../client/src/types.js";

const token = (suffix = "A") => `${suffix}${"a".repeat(42)}`;

test("native background subscriptions accept only unique authenticated loopback Linux targets", () => {
  const targets: DeviceTarget[] = [
    linux("pc", "http://127.0.0.1:8788"),
    linux("second", "http://localhost:8790"),
    linux("duplicate-port", "http://127.0.0.1:8790"),
    linux("remote", "http://192.168.1.8:8788"),
    linux("credentials", "http://user:pass@127.0.0.1:8791"),
    { ...linux("android", "http://127.0.0.1:8792"), kind: "android" },
  ];
  const tokens = new Map([
    ["pc", token("A")],
    ["second", token("B")],
    ["duplicate-port", token("C")],
    ["remote", token("D")],
    ["credentials", token("E")],
    ["android", token("F")],
  ]);

  assert.deepEqual(collectBackgroundEventSubscriptions(targets, (id) => tokens.get(id)), [
    { deviceId: "pc", localPort: 8788, token: token("A") },
    { deviceId: "second", localPort: 8790, token: token("B") },
  ]);
});

test("native background subscriptions are bounded to eight and skip malformed credentials", () => {
  const targets = Array.from({ length: 10 }, (_, index) => linux(`linux-${index}`, `http://127.0.0.1:${8800 + index}`));
  const subscriptions = collectBackgroundEventSubscriptions(targets, (id) => id === "linux-0" ? "not-a-token" : token("A"));
  assert.equal(subscriptions.length, 8);
  assert.equal(subscriptions.some((item) => item.deviceId === "linux-0"), false);
  assert.equal(subscriptions.at(-1)?.deviceId, "linux-8");
});

function linux(id: string, baseUrl: string): DeviceTarget {
  return { id, name: id, kind: "linux", baseUrl, transport: "termux" };
}
