import assert from "node:assert/strict";
import test from "node:test";
import {
  boundedFleetTargets,
  MAX_FLEET_DEVICES,
  onlineFleetSnapshot,
  unavailableFleetSnapshot,
} from "../client/src/fleet-state.js";
import type { DeviceTarget } from "../client/src/types.js";

test("fleet targets are bounded and retain the explicitly active Companion", () => {
  const targets = Array.from({ length: 10 }, (_, index) => linux(`linux-${index}`));
  const selected = boundedFleetTargets(targets, "linux-9");
  assert.equal(selected.length, MAX_FLEET_DEVICES);
  assert.equal(selected[0]?.id, "linux-9");
  assert.deepEqual(selected.slice(1).map((target) => target.id), targets.slice(0, 7).map((target) => target.id));
  assert.notEqual(selected[0], targets[9]);
});

test("fleet snapshots accept the exact count-only server schema", () => {
  const now = Date.parse("2026-08-24T12:00:00.000Z");
  const snapshot = onlineFleetSnapshot({
    target: linux("linux-a"),
    response: {
      summary: {
        schema: 1,
        running: 1,
        waitingForApproval: 1,
        unknown: 1,
        failed: 1,
        retainedOperations: 4,
        recoveryBlocked: true,
      },
    },
    now,
  });
  assert.deepEqual(snapshot, {
    deviceId: "linux-a",
    name: "linux-a",
    status: "online",
    running: 1,
    waitingForApproval: 1,
    unknown: 1,
    failed: 1,
    retainedOperations: 4,
    recoveryBlocked: true,
    updatedAt: "2026-08-24T12:00:00.000Z",
  });
  assert.doesNotMatch(JSON.stringify(snapshot), /private|workspace_replace_text|tool-1/);

  const offline = unavailableFleetSnapshot(linux("linux-b"), "offline", now);
  assert.equal(offline.status, "offline");
  assert.equal(offline.retainedOperations, 0);
  assert.equal(unavailableFleetSnapshot(linux("linux-c"), "unsupported", now).status, "unsupported");
});

test("fleet snapshots reject added details and malformed or unbounded counts", () => {
  const valid = {
    summary: {
      schema: 1,
      running: 1,
      waitingForApproval: 0,
      unknown: 0,
      failed: 0,
      retainedOperations: 1,
      recoveryBlocked: false,
    },
  };
  assert.throws(() => onlineFleetSnapshot({
    target: linux("linux-a"),
    response: { ...valid, prompt: "must not cross the Fleet boundary" },
  }), /invalid/);
  assert.throws(() => onlineFleetSnapshot({
    target: linux("linux-a"),
    response: { summary: { ...valid.summary, workspace: "/private/workspace" } },
  }), /invalid/);
  for (const running of [-1, 0.5, 10_001, Number.NaN]) {
    assert.throws(() => onlineFleetSnapshot({
      target: linux("linux-a"),
      response: { summary: { ...valid.summary, running } },
    }), /invalid/);
  }
});

function linux(id: string): DeviceTarget {
  return { id, name: id, kind: "linux", baseUrl: "http://127.0.0.1:8800" };
}
