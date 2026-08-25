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

test("session handoff mutations persist in call order without overlapping writes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-pocket-handoff-serialization-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateFile = join(directory, "handoff.json");
  let tracking = false;
  let activeWrites = 0;
  let maximumActiveWrites = 0;
  let mutationWrites = 0;
  let releaseFirstWrite!: () => void;
  const firstWriteReleased = new Promise<void>((resolve) => {
    releaseFirstWrite = resolve;
  });
  let markFirstWriteStarted!: () => void;
  const firstWriteStarted = new Promise<void>((resolve) => {
    markFirstWriteStarted = resolve;
  });
  const store = await SessionHandoffStore.create(stateFile, {
    now: () => Date.parse("2026-08-25T00:00:00.000Z"),
    writeState: async (path, state) => {
      if (tracking) {
        mutationWrites += 1;
        activeWrites += 1;
        maximumActiveWrites = Math.max(maximumActiveWrites, activeWrites);
        if (mutationWrites === 1) {
          markFirstWriteStarted();
          await firstWriteReleased;
        }
      }
      await writeFile(path, `${JSON.stringify(state)}\n`, { mode: 0o600 });
      if (tracking) activeWrites -= 1;
    },
  });
  tracking = true;

  const firstRelease = store.release({
    workspace: "/workspace/project",
    threadId: "thread-1",
    releasedBy: { id: "client-1", label: "Phone" },
  });
  await firstWriteStarted;
  const secondRelease = store.release({
    workspace: "/workspace/project",
    threadId: "thread-1",
    releasedBy: { id: "client-2", label: "Tablet" },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(maximumActiveWrites, 1);
  assert.equal(mutationWrites, 1);

  releaseFirstWrite();
  const [first, second] = await Promise.all([firstRelease, secondRelease]);
  assert.notEqual(first.id, second.id);
  assert.equal(maximumActiveWrites, 1);
  assert.equal(mutationWrites, 2);
  assert.equal(store.current({ workspace: "/workspace/project" })?.id, second.id);

  const reloaded = await SessionHandoffStore.create(stateFile, {
    now: () => Date.parse("2026-08-25T00:00:00.000Z"),
  });
  assert.equal(reloaded.current({ workspace: "/workspace/project" })?.id, second.id);
  assert.equal(reloaded.list().length, 1);
});

test("a failed handoff persistence never commits the in-memory mutation", async () => {
  let failNextWrite = false;
  const store = await SessionHandoffStore.create("unused-in-memory-state.json", {
    now: () => Date.parse("2026-08-25T00:00:00.000Z"),
    writeState: async () => {
      if (failNextWrite) {
        failNextWrite = false;
        throw new Error("synthetic persistence failure");
      }
    },
  });
  failNextWrite = true;

  await assert.rejects(store.release({
    workspace: "/workspace/project",
    threadId: "thread-failed",
    releasedBy: { id: "client-1", label: "Phone" },
  }), /synthetic persistence failure/);
  assert.equal(store.current({ workspace: "/workspace/project" }), null);

  const recovered = await store.release({
    workspace: "/workspace/project",
    threadId: "thread-recovered",
    releasedBy: { id: "client-1", label: "Phone" },
  });
  assert.equal(store.current({ workspace: "/workspace/project" })?.id, recovered.id);

  failNextWrite = true;
  await assert.rejects(store.claim(recovered.id), /synthetic persistence failure/);
  assert.equal(store.current({ workspace: "/workspace/project" })?.id, recovered.id);
  assert.equal((await store.claim(recovered.id))?.id, recovered.id);
  assert.equal(store.current({ workspace: "/workspace/project" }), null);
});
