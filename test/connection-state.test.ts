import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { initialConnectionState, reduceConnection } from "../client/src/connection-state.js";

test("connection lifecycle ignores stale device and attempt transitions", () => {
  let state = initialConnectionState("linux", "Linux PC");
  state = reduceConnection(state, { type: "begin", attempt: 1, device: "linux", label: "Linux PC" });
  state = reduceConnection(state, { type: "begin", attempt: 2, device: "remote", label: "Workstation" });
  assert.equal(state.device, "remote");
  assert.equal(state.attempt, 2);

  const staleAttempt = reduceConnection(state, {
    type: "initialized",
    attempt: 1,
    device: "linux",
    text: "Old PC",
  });
  assert.equal(staleAttempt, state);
  const wrongDevice = reduceConnection(state, {
    type: "initialized",
    attempt: 2,
    device: "linux",
    text: "Wrong PC",
  });
  assert.equal(wrongDevice, state);

  state = reduceConnection(state, {
    type: "initialized",
    attempt: 2,
    device: "remote",
    text: "Workstation · codex-cli",
  });
  assert.deepEqual(
    { phase: state.phase, status: state.status, text: state.text },
    { phase: "online", status: "online", text: "Workstation · codex-cli" },
  );
});

test("connection lifecycle represents recovery, pairing, rotation, and terminal failure", () => {
  let state = reduceConnection(initialConnectionState("linux", "Linux PC"), {
    type: "begin",
    attempt: 1,
    device: "linux",
    label: "Linux PC",
  });
  state = reduceConnection(state, { type: "reconnecting", attempt: 1, device: "linux" });
  assert.deepEqual({ phase: state.phase, status: state.status }, { phase: "reconnecting", status: "pending" });
  state = reduceConnection(state, { type: "stream_online", attempt: 1, device: "linux", label: "Linux PC" });
  assert.equal(state.text, "Linux PC와 안전하게 연결됨");

  state = reduceConnection(state, { type: "pairing_required", attempt: 1, device: "linux" });
  assert.equal(state.phase, "pairing_required");
  state = reduceConnection(state, { type: "identity_rotation_required", attempt: 1, device: "linux" });
  assert.equal(state.phase, "identity_rotation_required");
  state = reduceConnection(state, { type: "failed", attempt: 1, device: "linux", label: "Linux PC" });
  assert.deepEqual(
    { phase: state.phase, status: state.status, text: state.text },
    { phase: "failed", status: "error", text: "Linux PC 연결 실패" },
  );
});

test("App binds initialize and event subscription callbacks to the active connection attempt", async () => {
  const app = await readFile(new URL("../client/src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /useReducer\(\s*reduceConnection/);
  assert.match(app, /connectionAttemptRef\.current/);
  assert.match(app, /attempt !== connectionAttemptRef\.current/);
  assert.match(app, /nativeTunnelStartRef\.current = nativeTunnelStartRef\.current\.then/);
  assert.match(app, /loadProjectHandoff\(selected, attempt\)/);
  assert.doesNotMatch(app, /initializingRef/);
  assert.doesNotMatch(app, /const \[connection, setConnection\] = useState/);
  assert.doesNotMatch(app, /const \[connectionText, setConnectionText\] = useState/);
});
