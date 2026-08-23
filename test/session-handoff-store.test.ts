import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionHandoffStore } from "../src/session-handoff-store.js";

test("session handoff persists minimal metadata and expires safely", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-pocket-handoff-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateFile = join(directory, "handoff.json");
  let now = Date.parse("2026-08-23T00:00:00.000Z");
  const store = await SessionHandoffStore.create(stateFile, { now: () => now, lifetimeMs: 1_000 });

  const released = await store.release({
    workspace: "/workspace/project",
    threadId: "thread-1",
    operationId: "operation-1",
    releasedBy: { id: "client-1", label: "Phone" },
  });
  assert.equal(store.current()?.id, released.id);
  assert.equal(store.current()?.releasedBy.label, "Phone");
  assert.equal((await stat(stateFile)).mode & 0o777, 0o600);
  assert.doesNotMatch(await readFile(stateFile, "utf8"), /token|credential|prompt/i);

  const reloaded = await SessionHandoffStore.create(stateFile, { now: () => now, lifetimeMs: 1_000 });
  assert.equal(reloaded.current()?.threadId, "thread-1");
  now += 1_001;
  assert.equal(reloaded.current(), null);
});
