import assert from "node:assert/strict";
import { chmod, link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { EventJournal, EventJournalExportError } from "../src/event-journal.js";
import {
  RunCoordinator,
  type RunProviderRegistry,
} from "../src/run-coordinator.js";
import type {
  ProviderEvent,
  ProviderRun,
  ProviderRunCompletion,
  ProviderRunInput,
} from "../src/providers/types.js";

test("encrypted event journal restores running work as unknown and preserves idempotency", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-pocket-event-journal-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databaseFile = join(directory, "events.sqlite3");
  let now = Date.parse("2026-08-24T01:00:00.000Z");
  const ids = ["event-started", "event-recovered", "event-acknowledged", "event-metadata"];
  const firstJournal = await EventJournal.create(databaseFile, {
    now: () => now,
    createId: () => ids.shift() ?? "unexpected-event",
  });
  const firstProviders = new JournalFakeProviders();
  const firstCoordinator = new RunCoordinator(firstProviders, {
    stateStore: firstJournal,
    createId: () => "operation-durable",
  });
  const command = {
    providerId: "fake",
    accountId: "account-a",
    prompt: "super-private-prompt",
    input: {
      cwd: "/private/workspace",
      prompt: "super-private-prompt",
      routing: { upstreams: ["strict-primary", "strict-backup"], allowFallbacks: true },
    },
    workspaceIdentity: {
      kind: "git" as const,
      branch: "feature/private-identity",
      head: "1234567890ab",
      changedFiles: 2,
      dirty: true,
      linkedWorktree: true,
    },
    idempotencyKey: "paired-client:request-1",
  };
  const running = await firstCoordinator.start(command);
  const streamed = firstJournal.appendEvent(running.id, running.cwd, {
    type: "provider",
    kind: "output.delta",
    delta: "secret-output",
  });
  assert.equal(streamed.cursor, 1);
  assert.equal(firstJournal.replayAfter(0).events[0]?.event.delta, "secret-output");
  assert.equal((await stat(`${databaseFile}-wal`)).mode & 0o777, 0o600);
  assert.equal((await stat(`${databaseFile}-shm`)).mode & 0o777, 0o600);
  firstCoordinator.close();
  firstJournal.close();

  assert.equal((await stat(databaseFile)).mode & 0o777, 0o600);
  assert.equal((await stat(`${databaseFile}.key`)).mode & 0o777, 0o600);
  const rawDatabase = await readFile(databaseFile, "utf8");
  const rawKey = await readFile(`${databaseFile}.key`, "utf8");
  for (const secret of ["super-private-prompt", "/private/workspace", "feature/private-identity", "secret-output", "paired-client:request-1"]) {
    assert.doesNotMatch(rawDatabase, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(rawKey, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  now += 1_000;
  const restoredJournal = await EventJournal.create(databaseFile, {
    now: () => now,
    createId: () => ids.shift() ?? "unexpected-event",
  });
  const restoredProviders = new JournalFakeProviders();
  const restoredCoordinator = new RunCoordinator(restoredProviders, { stateStore: restoredJournal });
  const recovered = restoredCoordinator.get(running.id);
  assert.equal(recovered?.status, "unknown");
  assert.equal(recovered?.workspaceIdentity?.branch, "feature/private-identity");
  assert.deepEqual(recovered?.routing, { upstreams: ["strict-primary", "strict-backup"], allowFallbacks: true });
  assert.match(recovered?.error ?? "", /최종 상태/);
  assert.equal((await restoredCoordinator.start(command)).id, running.id);
  assert.equal(restoredProviders.starts.length, 0);

  const replay = restoredJournal.replayAfter(streamed.cursor);
  assert.equal(replay.gapBefore, false);
  assert.equal(replay.journalReset, false);
  assert.equal(replay.events.length, 1);
  assert.equal(replay.events[0]?.event.action, "recovered");
  assert.equal((replay.events[0]?.event.operation as { status?: string }).status, "unknown");
  const stopMirroring = restoredCoordinator.subscribe((event) => {
    if (event.type === "operation") restoredJournal.appendEvent(event.operation.id, event.operation.cwd, event);
  });
  const acknowledged = restoredCoordinator.acknowledge(running.id);
  assert.equal(acknowledged.status, "unknown");
  assert.equal(typeof acknowledged.acknowledgedAt, "string");
  assert.equal(restoredCoordinator.acknowledge(running.id).acknowledgedAt, acknowledged.acknowledgedAt);
  const organized = restoredCoordinator.updateMetadata(running.id, { goalName: "Recovered audit", pinned: true });
  assert.equal(organized.goalName, "Recovered audit");
  assert.equal(typeof organized.pinnedAt, "string");
  const acknowledgedReplay = restoredJournal.replayAfter(replay.events[0]!.cursor);
  assert.equal(acknowledgedReplay.events[0]?.event.action, "acknowledged");
  assert.equal(acknowledgedReplay.events[1]?.event.action, "metadata_updated");
  stopMirroring();
  restoredCoordinator.close();
  restoredJournal.close();

  const verifiedJournal = await EventJournal.create(databaseFile, { now: () => now + 1_000 });
  const verifiedCoordinator = new RunCoordinator(new JournalFakeProviders(), { stateStore: verifiedJournal });
  assert.equal(verifiedCoordinator.get(running.id)?.acknowledgedAt, acknowledged.acknowledgedAt);
  assert.equal(verifiedCoordinator.get(running.id)?.goalName, "Recovered audit");
  assert.equal(verifiedCoordinator.get(running.id)?.pinnedAt, organized.pinnedAt);
  verifiedCoordinator.close();
  verifiedJournal.close();
});

test("event journal detects retention gaps, resets foreign cursors, and rejects tampering", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-pocket-event-retention-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databaseFile = join(directory, "events.sqlite3");
  const journal = await EventJournal.create(databaseFile, {
    maxEvents: 2,
    createId: sequentialIds("one", "two", "three", "four"),
  });
  journal.saveOperation(operation("operation-retained", "completed"));
  journal.appendEvent("operation-retained", "/workspace/a", { type: "event", value: 1 });
  journal.appendEvent("operation-retained", "/workspace/a", { type: "event", value: 2 });
  journal.appendEvent("operation-retained", "/workspace/a", { type: "event", value: 3 });
  journal.appendEvent("operation-retained", "/workspace/a", { type: "event", value: 4 });

  const gap = journal.replayAfter(1);
  assert.equal(gap.gapBefore, true);
  assert.deepEqual(gap.events.map((event) => event.event.value), [3, 4]);
  const reset = journal.replayAfter(999);
  assert.equal(reset.journalReset, true);
  assert.deepEqual(reset.events.map((event) => event.event.value), [3, 4]);
  assert.deepEqual(journal.workspaceSummary("/workspace/a"), {
    operationCount: 1,
    eventCount: 2,
    oldestEventAt: gap.events[0]!.createdAt,
    newestEventAt: gap.events[1]!.createdAt,
  });
  const exported = journal.exportWorkspace("/workspace/a");
  assert.equal(exported.version, 1);
  assert.equal(exported.workspace, "/workspace/a");
  assert.equal(exported.policy.maxEvents, 2);
  assert.equal(exported.operations[0]?.id, "operation-retained");
  assert.deepEqual(exported.events.map((event) => event.event.value), [3, 4]);
  assert.deepEqual(journal.workspaceSummary("/workspace/another"), { operationCount: 0, eventCount: 0 });
  journal.close();

  const raw = new Database(databaseFile);
  raw.prepare("UPDATE events SET envelope = ? WHERE cursor = (SELECT MAX(cursor) FROM events)").run("tampered");
  raw.close();
  const reopened = await EventJournal.create(databaseFile);
  assert.throws(() => reopened.replayAfter(0), /cannot be authenticated|malformed/);
  reopened.close();
});

test("workspace journal export enforces the configured response size cap", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-pocket-event-export-cap-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const journal = await EventJournal.create(join(directory, "events.sqlite3"), { maxExportBytes: 700 });
  journal.saveOperation({
    ...operation("operation-export-cap", "completed"),
    prompt: "private-export-value".repeat(40),
  });
  assert.equal(journal.policy().maxExportBytes, 700);
  assert.throws(
    () => journal.exportWorkspace("/workspace/a"),
    (error: unknown) => error instanceof EventJournalExportError && error.statusCode === 413,
  );
  journal.close();
});

test("event journal encrypts provider replay state and omits it from workspace export", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-pocket-event-resume-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databaseFile = join(directory, "events.sqlite3");
  const resumeSecret = "opaque-provider-replay-secret";
  const journal = await EventJournal.create(databaseFile);
  journal.saveOperation({
    ...operation("operation-resumable", "completed"),
    model: "model-a",
    resumeState: {
      version: 1,
      providerId: "fake",
      model: "model-a",
      data: { value: resumeSecret },
    },
  });
  const exported = journal.exportWorkspace("/workspace/a");
  assert.equal(exported.operations[0]?.resumable, true);
  assert.equal("resumeState" in exported.operations[0]!, false);
  assert.doesNotMatch(JSON.stringify(exported), new RegExp(resumeSecret));
  journal.close();

  assert.doesNotMatch(await readFile(databaseFile, "utf8"), new RegExp(resumeSecret));
  const reopened = await EventJournal.create(databaseFile);
  assert.equal(
    (reopened.load().operations[0]?.resumeState?.data as { value?: string } | undefined)?.value,
    resumeSecret,
  );
  reopened.close();
});

test("event journal rejects a permissive or symlinked key file", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-pocket-event-key-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const key = join(directory, "journal.key");
  await writeFile(key, `${Buffer.alloc(32, 7).toString("base64url")}\n`, { mode: 0o600 });
  await chmod(key, 0o644);
  await assert.rejects(
    EventJournal.create(join(directory, "events.sqlite3"), { keyFile: key }),
    /permissions must be 0600/,
  );
  await chmod(key, 0o600);
  const linkedKey = join(directory, "linked.key");
  await symlink(key, linkedKey);
  await assert.rejects(
    EventJournal.create(join(directory, "linked.sqlite3"), { keyFile: linkedKey }),
    /regular file/,
  );

  const hardLinkedKey = join(directory, "hard-linked.key");
  await link(key, hardLinkedKey);
  await assert.rejects(
    EventJournal.create(join(directory, "hard-linked.sqlite3"), { keyFile: hardLinkedKey }),
    /must not be hard-linked/,
  );

  const sharedPath = join(directory, "shared.sqlite3");
  await assert.rejects(
    EventJournal.create(sharedPath, { keyFile: sharedPath }),
    /must use different files/,
  );

  const permissiveDirectory = join(directory, "permissive");
  await mkdir(permissiveDirectory, { mode: 0o755 });
  await assert.rejects(
    EventJournal.create(join(permissiveDirectory, "events.sqlite3")),
    /permissions must not allow group or other access/,
  );
});

test("event journal authenticates operation and event metadata", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-pocket-event-metadata-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const operationDatabase = join(directory, "operation.sqlite3");
  const operationJournal = await EventJournal.create(operationDatabase);
  operationJournal.saveOperation(operation("operation-metadata", "completed"));
  operationJournal.close();
  const rawOperation = new Database(operationDatabase);
  rawOperation.prepare("UPDATE operations SET status = 'running'").run();
  rawOperation.close();
  const reopenedOperation = await EventJournal.create(operationDatabase);
  assert.throws(() => reopenedOperation.load(), /cannot be authenticated/);
  reopenedOperation.close();

  const eventDatabase = join(directory, "event.sqlite3");
  const eventJournal = await EventJournal.create(eventDatabase);
  eventJournal.saveOperation(operation("event-metadata", "completed"));
  eventJournal.appendEvent("event-metadata", "/workspace/a", { type: "event", value: 1 });
  eventJournal.close();
  const rawEvent = new Database(eventDatabase);
  rawEvent.prepare("UPDATE events SET created_at = created_at + 1").run();
  rawEvent.close();
  const reopenedEvent = await EventJournal.create(eventDatabase);
  assert.throws(() => reopenedEvent.replayAfter(0), /cannot be authenticated/);
  reopenedEvent.close();
});

test("event journal persists bounded retention settings and applies them immediately", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-pocket-event-policy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databaseFile = join(directory, "events.sqlite3");
  let now = Date.parse("2026-08-24T04:00:00.000Z");
  const journal = await EventJournal.create(databaseFile, { now: () => now });
  for (let index = 0; index < 51; index += 1) {
    journal.saveOperation({ ...operation(`terminal-${index}`, "completed"), startedAt: new Date(now + index).toISOString() });
  }
  journal.saveOperation({
    ...operation("running-policy", "completed"),
    status: "running",
    startedAt: new Date(now).toISOString(),
    completedAt: undefined,
  });
  journal.appendEvent("running-policy", "/workspace/a", { type: "event", value: "old" });
  assert.throws(
    () => journal.updatePolicy({ retentionMs: 60_000, maxOperations: 50, maxEvents: 200 }),
    /retentionMs must be an integer between/,
  );
  now += 2 * 24 * 60 * 60_000;
  const policy = journal.updatePolicy({
    retentionMs: 24 * 60 * 60_000,
    maxOperations: 50,
    maxEvents: 200,
  });
  assert.equal(policy.retentionMs, 24 * 60 * 60_000);
  assert.equal(journal.workspaceSummary("/workspace/a").operationCount, 1);
  assert.equal(journal.workspaceSummary("/workspace/a").eventCount, 0);
  journal.close();

  const reopened = await EventJournal.create(databaseFile, { now: () => now });
  assert.deepEqual(reopened.policy(), policy);
  assert.deepEqual(reopened.policyLimits().maxOperations, { minimum: 50, maximum: 2_000 });
  reopened.close();
  const tampered = new Database(databaseFile);
  tampered.prepare("UPDATE journal_settings SET value_integer = value_integer + 1 WHERE key = 'max_events'").run();
  tampered.close();
  await assert.rejects(EventJournal.create(databaseFile), /retention policy cannot be authenticated/);
});

test("event journal authenticates the complete server-authored run policy", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-pocket-run-policy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databaseFile = join(directory, "events.sqlite3");
  const journal = await EventJournal.create(databaseFile);
  assert.equal(journal.runPolicy().emergencyStop, false);
  const policy = journal.updateRunPolicy({
    emergencyStop: true,
    maxOutputTokens: 2_048,
    maxTotalTokens: 20_000,
    maxRunCostMicrosUsd: 500_000,
    dailyTokenWarning: 100_000,
    monthlyCostSoftLimitMicrosUsd: 5_000_000,
  });
  assert.equal(policy.emergencyStop, true);
  assert.throws(() => journal.updateRunPolicy({ ...policy, maxTotalTokens: 1_000 }), /at least maxOutputTokens/);
  journal.close();

  const reopened = await EventJournal.create(databaseFile);
  assert.deepEqual(reopened.runPolicy(), policy);
  reopened.close();
  const tampered = new Database(databaseFile);
  tampered.prepare("UPDATE journal_settings SET value_integer = value_integer + 1 WHERE key = 'run_max_total_tokens'").run();
  tampered.close();
  await assert.rejects(EventJournal.create(databaseFile), /Run policy settings cannot be authenticated/);

  const partialFile = join(directory, "partial.sqlite3");
  const partial = await EventJournal.create(partialFile);
  partial.close();
  const partialRaw = new Database(partialFile);
  partialRaw.prepare("INSERT INTO journal_settings (key, value_integer, auth_tag) VALUES (?, ?, ?)")
    .run("run_emergency_stop", 0, "0".repeat(64));
  partialRaw.close();
  await assert.rejects(EventJournal.create(partialFile), /Run policy settings are incomplete/);
});

class JournalFakeProviders implements RunProviderRegistry {
  readonly starts: ProviderRunInput[] = [];
  private readonly listeners = new Set<(event: ProviderEvent) => void>();

  async startRun(providerId: unknown, _accountId: unknown, input: ProviderRunInput): Promise<ProviderRun> {
    this.starts.push(input);
    const completion = new Promise<ProviderRunCompletion>(() => undefined);
    return {
      providerId: String(providerId),
      conversationId: input.conversationId ?? "conversation-durable",
      runId: "run-durable",
      cwd: input.cwd,
      completion,
    };
  }

  async cancelRun(): Promise<void> {}

  subscribe(listener: (event: ProviderEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

function operation(id: string, status: "completed") {
  return {
    id,
    providerId: "fake",
    conversationId: "conversation-retained",
    runId: "run-retained",
    cwd: "/workspace/a",
    prompt: "private",
    status,
    startedAt: "2026-08-24T00:00:00.000Z",
    completedAt: "2026-08-24T00:00:01.000Z",
  };
}

function sequentialIds(...values: string[]): () => string {
  return () => values.shift() ?? "unexpected-id";
}
