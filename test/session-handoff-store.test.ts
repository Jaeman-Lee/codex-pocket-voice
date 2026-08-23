import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionHandoffStore } from "../src/session-handoff-store.js";

test("session handoffs stay isolated by project and expire safely", async (t) => {
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
  const another = await store.release({
    workspace: "/workspace/another-project",
    threadId: "thread-2",
    releasedBy: { id: "client-2", label: "Tablet" },
  });
  assert.equal(store.current()?.id, another.id);
  assert.equal(store.current({ workspace: "/workspace/project" })?.id, released.id);
  assert.equal(store.list().length, 2);
  assert.equal((await stat(stateFile)).mode & 0o777, 0o600);
  assert.doesNotMatch(await readFile(stateFile, "utf8"), /token|credential|prompt/i);

  const reloaded = await SessionHandoffStore.create(stateFile, { now: () => now, lifetimeMs: 1_000 });
  assert.equal(reloaded.current({ workspace: "/workspace/project" })?.threadId, "thread-1");
  assert.equal((await reloaded.claim(released.id))?.threadId, "thread-1");
  assert.equal(reloaded.current({ workspace: "/workspace/project" }), null);
  assert.equal(reloaded.current()?.threadId, "thread-2");
  now += 1_001;
  assert.equal(reloaded.current(), null);
});

test("session handoff state migrates the v1 singleton without losing it", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-pocket-handoff-migration-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateFile = join(directory, "handoff.json");
  const releasedAt = "2026-08-23T00:00:00.000Z";
  await writeFile(stateFile, JSON.stringify({
    version: 1,
    handoff: {
      id: "legacy-handoff",
      workspace: "/workspace/legacy",
      threadId: "legacy-thread",
      releasedBy: { id: "legacy-client", label: "Old phone" },
      releasedAt,
      expiresAt: "2026-08-24T00:00:00.000Z",
    },
  }), { mode: 0o600 });

  const store = await SessionHandoffStore.create(stateFile, {
    now: () => Date.parse("2026-08-23T12:00:00.000Z"),
  });
  assert.equal(store.current({ workspace: "/workspace/legacy" })?.id, "legacy-handoff");
  const persisted = JSON.parse(await readFile(stateFile, "utf8")) as { version: number; handoffs: unknown[] };
  assert.equal(persisted.version, 2);
  assert.equal(persisted.handoffs.length, 1);
});
