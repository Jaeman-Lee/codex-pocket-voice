import assert from "node:assert/strict";
import test from "node:test";
import {
  abortPocketLinkIdentityRotationFlow,
  finishPocketLinkIdentityRotationFlow,
  type PocketLinkIdentityRotationPorts,
} from "../client/src/pocket-link-identity-rotation";

function fakePorts(overrides: Partial<PocketLinkIdentityRotationPorts> = {}) {
  const calls: string[] = [];
  const ports: PocketLinkIdentityRotationPorts = {
    hasStoredApproval: async () => { calls.push("stored"); return true; },
    waitForPendingIdentity: async () => { calls.push("wait-pending"); },
    inspectRemote: async () => { calls.push("inspect"); return { status: "pending" }; },
    completeRemote: async () => { calls.push("complete"); return { status: "completed" }; },
    finalizeRemote: async () => { calls.push("finalize"); return { finalized: true }; },
    abortRemote: async () => { calls.push("abort-remote"); },
    isNewIdentityAuthorized: async () => { calls.push("health"); return false; },
    commitLocal: async () => { calls.push("commit-local"); },
    abortLocal: async () => { calls.push("abort-local"); },
    ...overrides,
  };
  return { calls, ports };
}

test("identity rotation completes remote proof and metadata before deleting the old local key", async () => {
  const { calls, ports } = fakePorts();
  assert.equal(await finishPocketLinkIdentityRotationFlow(ports), "completed");
  assert.deepEqual(calls, ["stored", "wait-pending", "inspect", "complete", "finalize", "commit-local"]);
});

test("identity rotation reconciles a lost finalize response using authorization by the pending key", async () => {
  const { calls, ports } = fakePorts({
    inspectRemote: async () => {
      calls.push("inspect");
      throw Object.assign(new Error("missing"), { code: "TLS_KEY_ROTATION_NOT_PENDING" });
    },
    isNewIdentityAuthorized: async () => { calls.push("health"); return true; },
  });
  assert.equal(await finishPocketLinkIdentityRotationFlow(ports), "completed");
  assert.deepEqual(calls, ["stored", "wait-pending", "inspect", "health", "commit-local"]);
});

test("identity rotation aborts the pending local key when the uncompleted remote approval expires", async () => {
  const { calls, ports } = fakePorts({
    inspectRemote: async () => {
      calls.push("inspect");
      throw Object.assign(new Error("expired"), { code: "TLS_KEY_ROTATION_EXPIRED" });
    },
  });
  assert.equal(await finishPocketLinkIdentityRotationFlow(ports), "aborted");
  assert.deepEqual(calls, ["stored", "wait-pending", "inspect", "abort-local"]);
});

test("an abort request cannot roll back a key the Companion already completed", async () => {
  const { calls, ports } = fakePorts({
    abortRemote: async () => {
      calls.push("abort-remote");
      throw Object.assign(new Error("completed"), { code: "TLS_KEY_ROTATION_ALREADY_COMPLETED" });
    },
    inspectRemote: async () => { calls.push("inspect"); return { status: "completed" }; },
  });
  assert.equal(await abortPocketLinkIdentityRotationFlow(ports), "completed");
  assert.deepEqual(calls, [
    "abort-remote", "stored", "wait-pending", "inspect", "finalize", "commit-local",
  ]);
});

test("network uncertainty leaves both local key slots intact for a later retry", async () => {
  const networkError = new Error("offline");
  const { calls, ports } = fakePorts({
    inspectRemote: async () => { calls.push("inspect"); throw networkError; },
  });
  await assert.rejects(finishPocketLinkIdentityRotationFlow(ports), networkError);
  assert.deepEqual(calls, ["stored", "wait-pending", "inspect"]);
});
