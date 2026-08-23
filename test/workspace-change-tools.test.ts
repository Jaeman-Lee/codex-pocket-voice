import assert from "node:assert/strict";
import { chmod, link, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { InMemoryApprovalBroker } from "../src/approval-broker.js";
import { PathPolicy } from "../src/path-policy.js";
import { createReadOnlyWorkspaceTools } from "../src/read-only-tools.js";
import { LocalToolBroker } from "../src/tool-broker.js";
import { SimulatedWorkspaceChangeCrash } from "../src/workspace-change-engine.js";
import { createWorkspaceChangeTools } from "../src/workspace-change-tools.js";

test("workspace_replace_text shows a bounded diff and atomically applies only the approved version", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-pocket-change-tool-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "sample.txt");
  await writeFile(file, "alpha\nbeta\n", { mode: 0o640 });
  const paths = await PathPolicy.fromEnvironment(undefined, root);
  const approvals = new InMemoryApprovalBroker({ createId: () => "approval-replace" });
  t.after(() => approvals.close());
  const broker = new LocalToolBroker([
    ...createReadOnlyWorkspaceTools(paths),
    ...await createWorkspaceChangeTools(paths, { transactionDirectory: join(root, ".change-transactions") }),
  ], approvals, paths);
  const read = await broker.execute(call("read-1", "workspace_read", {
    path: "sample.txt",
    start_line: null,
    end_line: null,
  }), { cwd: root });
  const sha256 = (read.output as { sha256: string }).sha256;

  const replacement = broker.execute(call("replace-1", "workspace_replace_text", {
    path: "sample.txt",
    expected_sha256: sha256,
    content: "alpha\ngamma\n",
  }), { cwd: root });
  const pending = await pendingApproval(approvals);
  assert.equal(pending.requiresTouch, true);
  assert.equal(pending.risk, "change");
  assert.equal(pending.redactedDetails?.path, "sample.txt");
  assert.match(String(pending.redactedDetails?.diff), /-beta\n\+gamma/);
  assert.throws(() => approvals.resolve(pending.id, "approved", "voice"), /터치/);
  approvals.resolve(pending.id, "approved", "touch");
  const result = await replacement;
  assert.equal(result.status, "completed");
  assert.equal(await readFile(file, "utf8"), "alpha\ngamma\n");
  assert.equal((await stat(file)).mode & 0o777, 0o640);
  assert.equal((await readdir(root)).some((name) => name.startsWith(".codex-pocket-")), false);
});

test("workspace_replace_text never overwrites a file changed after review", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-pocket-change-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "race.txt");
  await writeFile(file, "before\n");
  const paths = await PathPolicy.fromEnvironment(undefined, root);
  const approvals = new InMemoryApprovalBroker({ createId: () => "approval-race" });
  t.after(() => approvals.close());
  const broker = new LocalToolBroker([
    ...createReadOnlyWorkspaceTools(paths),
    ...await createWorkspaceChangeTools(paths, { transactionDirectory: join(root, ".change-transactions") }),
  ], approvals, paths);
  const read = await broker.execute(call("read-race", "workspace_read", {
    path: "race.txt", start_line: null, end_line: null,
  }), { cwd: root });
  const replacement = broker.execute(call("replace-race", "workspace_replace_text", {
    path: "race.txt",
    expected_sha256: (read.output as { sha256: string }).sha256,
    content: "approved proposal\n",
  }), { cwd: root });
  const pending = await pendingApproval(approvals);
  await writeFile(file, "concurrent edit\n");
  approvals.resolve(pending.id, "approved", "touch");
  assert.equal((await replacement).status, "failed");
  assert.equal(await readFile(file, "utf8"), "concurrent edit\n");
});

test("workspace_replace_text rejects sensitive, linked, secret-bearing, and escaping targets", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-pocket-change-deny-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "plain.txt"), "plain\n");
  await writeFile(join(root, ".env"), "SAFE=value\n");
  await symlink("plain.txt", join(root, "linked.txt"));
  await link(join(root, "plain.txt"), join(root, "hardlinked.txt"));
  const paths = await PathPolicy.fromEnvironment(undefined, root);
  const approvals = new InMemoryApprovalBroker();
  t.after(() => approvals.close());
  const broker = new LocalToolBroker(
    await createWorkspaceChangeTools(paths, { transactionDirectory: join(root, ".change-transactions") }),
    approvals,
    paths,
  );
  const digest = "0".repeat(64);
  const replace = (id: string, target: string, content = "next\n") => broker.execute(
    call(id, "workspace_replace_text", { path: target, expected_sha256: digest, content }),
    { cwd: root },
  );

  await assert.rejects(replace("sensitive", ".env"), /Sensitive/);
  await assert.rejects(replace("symlink", "linked.txt"), /non-linked|Symlinked/);
  await assert.rejects(replace("hardlink", "hardlinked.txt"), /non-linked/);
  await assert.rejects(replace("escape", "../outside.txt"), /parent/);
  await assert.rejects(replace("secret", "plain.txt", "OPENAI_API_KEY=sk-abcdefghijklmnop\n"), /credential/);
  assert.equal(approvals.listPending().length, 0);
});

test("workspace_replace_text_batch reviews and commits multiple files with one touch approval", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-pocket-change-batch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const firstFile = join(root, "first.txt");
  const secondFile = join(root, "second.txt");
  await writeFile(firstFile, "first before\n", { mode: 0o640 });
  await writeFile(secondFile, "second before\n", { mode: 0o600 });
  const paths = await PathPolicy.fromEnvironment(undefined, root);
  const approvals = new InMemoryApprovalBroker({ createId: () => "approval-batch" });
  t.after(() => approvals.close());
  const broker = new LocalToolBroker([
    ...createReadOnlyWorkspaceTools(paths),
    ...await createWorkspaceChangeTools(paths, { transactionDirectory: join(root, ".change-transactions") }),
  ], approvals, paths);
  assert.deepEqual(
    broker.definitions().filter((definition) => definition.risk === "change").map((definition) => definition.name),
    [
      "workspace_replace_text",
      "workspace_replace_text_batch",
      "workspace_create_text",
      "workspace_rename_text",
    ],
  );
  const first = await readSha(broker, root, "batch-read-first", "first.txt");
  const second = await readSha(broker, root, "batch-read-second", "second.txt");

  const replacement = broker.execute(call("batch-replace", "workspace_replace_text_batch", {
    files: [
      { path: "first.txt", expected_sha256: first, content: "first after\n" },
      { path: "second.txt", expected_sha256: second, content: "second after\n" },
    ],
  }), { cwd: root });
  const pending = await pendingApproval(approvals);
  assert.equal(pending.requiresTouch, true);
  assert.equal(pending.redactedDetails?.fileCount, 2);
  assert.equal((pending.redactedDetails?.files as unknown[] | undefined)?.length, 2);
  assert.match(String(pending.redactedDetails?.diff), /first\.txt[\s\S]*second\.txt/);
  assert.throws(() => approvals.resolve(pending.id, "approved", "voice"), /터치/);
  approvals.resolve(pending.id, "approved", "touch");

  const result = await replacement;
  assert.equal(result.status, "completed");
  assert.equal((result.output as { fileCount?: number }).fileCount, 2);
  assert.equal(await readFile(firstFile, "utf8"), "first after\n");
  assert.equal(await readFile(secondFile, "utf8"), "second after\n");
  assert.equal((await stat(firstFile)).mode & 0o777, 0o640);
  assert.equal((await stat(secondFile)).mode & 0o777, 0o600);
  assert.equal((await readdir(root)).some((name) => name.startsWith(".codex-pocket-")), false);
});

test("workspace_replace_text_batch rolls back earlier files when a later file races the commit", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-pocket-change-batch-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const firstFile = join(root, "first.txt");
  const secondFile = join(root, "second.txt");
  await writeFile(firstFile, "first original\n");
  await writeFile(secondFile, "second original\n");
  const paths = await PathPolicy.fromEnvironment(undefined, root);
  const approvals = new InMemoryApprovalBroker({ createId: () => "approval-batch-race" });
  t.after(() => approvals.close());
  const broker = new LocalToolBroker([
    ...createReadOnlyWorkspaceTools(paths),
    ...await createWorkspaceChangeTools(paths, {
      transactionDirectory: join(root, ".change-transactions"),
      beforeBatchCommit: async (index) => {
        if (index === 1) await writeFile(secondFile, "concurrent edit\n");
      },
    }),
  ], approvals, paths);
  const first = await readSha(broker, root, "batch-race-read-first", "first.txt");
  const second = await readSha(broker, root, "batch-race-read-second", "second.txt");

  const replacement = broker.execute(call("batch-race", "workspace_replace_text_batch", {
    files: [
      { path: "first.txt", expected_sha256: first, content: "first proposed\n" },
      { path: "second.txt", expected_sha256: second, content: "second proposed\n" },
    ],
  }), { cwd: root });
  const pending = await pendingApproval(approvals);
  approvals.resolve(pending.id, "approved", "touch");
  assert.equal((await replacement).status, "failed");
  assert.equal(await readFile(firstFile, "utf8"), "first original\n");
  assert.equal(await readFile(secondFile, "utf8"), "concurrent edit\n");
  assert.equal((await readdir(root)).some((name) => name.startsWith(".codex-pocket-")), false);
});

test("workspace_replace_text_batch rejects duplicate, undersized, and sensitive proposals before approval", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-pocket-change-batch-deny-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "plain.txt"), "plain\n");
  await writeFile(join(root, "other.txt"), "other\n");
  const paths = await PathPolicy.fromEnvironment(undefined, root);
  const approvals = new InMemoryApprovalBroker();
  t.after(() => approvals.close());
  const broker = new LocalToolBroker(
    await createWorkspaceChangeTools(paths, { transactionDirectory: join(root, ".change-transactions") }),
    approvals,
    paths,
  );
  const sha = "0".repeat(64);
  const execute = (id: string, files: unknown[]) => broker.execute(
    call(id, "workspace_replace_text_batch", { files }),
    { cwd: root },
  );

  await assert.rejects(execute("batch-one", [
    { path: "plain.txt", expected_sha256: sha, content: "next\n" },
  ]), /2-8/);
  await assert.rejects(execute("batch-duplicate", [
    { path: "plain.txt", expected_sha256: sha, content: "first\n" },
    { path: "plain.txt", expected_sha256: sha, content: "second\n" },
  ]), /unique/);
  await assert.rejects(execute("batch-secret", [
    { path: "plain.txt", expected_sha256: sha, content: "safe\n" },
    { path: "other.txt", expected_sha256: sha, content: "OPENAI_API_KEY=sk-abcdefghijklmnop\n" },
  ]), /credential/);
  assert.equal(approvals.listPending().length, 0);
});

test("workspace_replace_text_batch bounds escaped approval JSON below the broker limit", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-pocket-change-batch-preview-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = await PathPolicy.fromEnvironment(undefined, root);
  const approvals = new InMemoryApprovalBroker({ createId: () => "approval-batch-preview" });
  t.after(() => approvals.close());
  const broker = new LocalToolBroker([
    ...createReadOnlyWorkspaceTools(paths),
    ...await createWorkspaceChangeTools(paths, { transactionDirectory: join(root, ".change-transactions") }),
  ], approvals, paths);
  const files = [];
  for (let index = 0; index < 4; index += 1) {
    const name = `preview-${index}.txt`;
    await writeFile(join(root, name), `before ${index}\n`);
    files.push({
      path: name,
      expected_sha256: await readSha(broker, root, `preview-read-${index}`, name),
      content: "\\".repeat(12_000),
    });
  }

  const replacement = broker.execute(call("batch-preview", "workspace_replace_text_batch", { files }), { cwd: root });
  const pending = await pendingApproval(approvals);
  assert.equal(pending.redactedDetails?.diffTruncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(pending.redactedDetails)) <= 30 * 1024);
  approvals.resolve(pending.id, "declined", "touch");
  assert.equal((await replacement).status, "denied");
});

test("workspace_create_text and workspace_rename_text require review and never overwrite destinations", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-pocket-create-rename-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = await PathPolicy.fromEnvironment(undefined, root);
  const approvals = new InMemoryApprovalBroker({ createId: sequentialIds("approval-create", "approval-rename") });
  t.after(() => approvals.close());
  const broker = new LocalToolBroker([
    ...createReadOnlyWorkspaceTools(paths),
    ...await createWorkspaceChangeTools(paths, { transactionDirectory: join(root, ".change-transactions") }),
  ], approvals, paths);

  const creation = broker.execute(call("create-text", "workspace_create_text", {
    path: "created.txt",
    content: "created safely\n",
  }), { cwd: root });
  const createApproval = await pendingApproval(approvals);
  assert.equal(createApproval.requiresTouch, true);
  assert.match(String(createApproval.redactedDetails?.diff), /--- \/dev\/null[\s\S]*\+created safely/);
  assert.throws(() => approvals.resolve(createApproval.id, "approved", "voice"), /터치/);
  approvals.resolve(createApproval.id, "approved", "touch");
  assert.equal((await creation).status, "completed");
  assert.equal(await readFile(join(root, "created.txt"), "utf8"), "created safely\n");
  assert.equal((await stat(join(root, "created.txt"))).mode & 0o777, 0o644);

  const sha256 = await readSha(broker, root, "read-created", "created.txt");
  const renameResult = broker.execute(call("rename-text", "workspace_rename_text", {
    source_path: "created.txt",
    expected_sha256: sha256,
    target_path: "renamed.txt",
  }), { cwd: root });
  const renameApproval = await pendingApproval(approvals);
  assert.match(String(renameApproval.redactedDetails?.diff), /rename from created\.txt[\s\S]*rename to renamed\.txt/);
  approvals.resolve(renameApproval.id, "approved", "touch");
  assert.equal((await renameResult).status, "completed");
  await assert.rejects(readFile(join(root, "created.txt")), /ENOENT/);
  assert.equal(await readFile(join(root, "renamed.txt"), "utf8"), "created safely\n");
  assert.deepEqual(await readdir(join(root, ".change-transactions")), []);
});

test("workspace_create_text preserves a destination created after approval", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-pocket-create-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, "raced.txt");
  const paths = await PathPolicy.fromEnvironment(undefined, root);
  const approvals = new InMemoryApprovalBroker({ createId: () => "approval-create-race" });
  t.after(() => approvals.close());
  const broker = new LocalToolBroker(
    await createWorkspaceChangeTools(paths, {
      transactionDirectory: join(root, ".change-transactions"),
      beforeBatchCommit: async () => writeFile(target, "external winner\n"),
    }),
    approvals,
    paths,
  );

  const creation = broker.execute(call("create-race", "workspace_create_text", {
    path: "raced.txt",
    content: "approved content\n",
  }), { cwd: root });
  const pending = await pendingApproval(approvals);
  approvals.resolve(pending.id, "approved", "touch");
  assert.equal((await creation).status, "failed");
  assert.equal(await readFile(target, "utf8"), "external winner\n");
  assert.deepEqual(await readdir(join(root, ".change-transactions")), []);
});

test("workspace create and rename reject sensitive, secret-bearing, and occupied paths before approval", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-pocket-create-rename-deny-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "plain.txt"), "plain\n");
  await writeFile(join(root, "occupied.txt"), "occupied\n");
  await writeFile(join(root, "secret.txt"), "OPENAI_API_KEY=sk-abcdefghijklmnop\n");
  const paths = await PathPolicy.fromEnvironment(undefined, root);
  const approvals = new InMemoryApprovalBroker();
  t.after(() => approvals.close());
  const broker = new LocalToolBroker([
    ...createReadOnlyWorkspaceTools(paths),
    ...await createWorkspaceChangeTools(paths, { transactionDirectory: join(root, ".change-transactions") }),
  ], approvals, paths);

  await assert.rejects(broker.execute(call("create-sensitive", "workspace_create_text", {
    path: ".env",
    content: "safe=value\n",
  }), { cwd: root }), /Sensitive/);
  await assert.rejects(broker.execute(call("create-secret", "workspace_create_text", {
    path: "new.txt",
    content: "OPENROUTER_API_KEY=sk-or-v1-secret-example\n",
  }), { cwd: root }), /credential/);
  const plainSha = await readSha(broker, root, "deny-read-plain", "plain.txt");
  await assert.rejects(broker.execute(call("rename-sensitive", "workspace_rename_text", {
    source_path: "plain.txt",
    expected_sha256: plainSha,
    target_path: ".git/config",
  }), { cwd: root }), /Sensitive/);
  await assert.rejects(broker.execute(call("rename-occupied", "workspace_rename_text", {
    source_path: "plain.txt",
    expected_sha256: plainSha,
    target_path: "occupied.txt",
  }), { cwd: root }), /already exists/);
  const secretSha = await readSha(broker, root, "deny-read-secret", "secret.txt");
  await assert.rejects(broker.execute(call("rename-secret", "workspace_rename_text", {
    source_path: "secret.txt",
    expected_sha256: secretSha,
    target_path: "moved-secret.txt",
  }), { cwd: root }), /Secret-bearing/);
  assert.equal(approvals.listPending().length, 0);
});

test("workspace change journal removes staged files after a pre-commit restart", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-pocket-change-staging-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = join(root, ".change-transactions");
  const target = join(root, "staged.txt");
  await writeFile(target, "original\n");
  const paths = await PathPolicy.fromEnvironment(undefined, root);
  const approvals = new InMemoryApprovalBroker({ createId: () => "approval-staging-crash" });
  t.after(() => approvals.close());
  const broker = new LocalToolBroker([
    ...createReadOnlyWorkspaceTools(paths),
    ...await createWorkspaceChangeTools(paths, {
      transactionDirectory: state,
      afterMutation: async (mutation) => {
        if (mutation === "file-staged") throw new SimulatedWorkspaceChangeCrash("staging crash");
      },
    }),
  ], approvals, paths);
  const sha256 = await readSha(broker, root, "staging-read", "staged.txt");
  const replacement = broker.execute(call("staging-replace", "workspace_replace_text", {
    path: "staged.txt",
    expected_sha256: sha256,
    content: "proposed\n",
  }), { cwd: root });
  approvals.resolve((await pendingApproval(approvals)).id, "approved", "touch");
  assert.equal((await replacement).status, "failed");
  assert.equal(await readFile(target, "utf8"), "original\n");
  assert.equal((await readdir(root)).some((name) => /^\.codex-pocket-.*\.tmp$/.test(name)), true);

  const manifest = (await readdir(state)).find((name) => name.endsWith(".json"))!;
  await chmod(join(state, manifest), 0o644);
  await assert.rejects(
    createWorkspaceChangeTools(paths, { transactionDirectory: state }),
    /private bounded file/,
  );
  assert.equal(await readFile(target, "utf8"), "original\n");
  await chmod(join(state, manifest), 0o600);

  await createWorkspaceChangeTools(paths, { transactionDirectory: state });
  assert.equal(await readFile(target, "utf8"), "original\n");
  assert.equal((await readdir(root)).some((name) => /^\.codex-pocket-.*\.tmp$/.test(name)), false);
  assert.deepEqual(await readdir(state), []);
});

test("workspace change journal rolls back prepared replacements and renames after restart", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-pocket-change-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = join(root, ".change-transactions");
  await writeFile(join(root, "first.txt"), "first original\n");
  await writeFile(join(root, "second.txt"), "second original\n");
  const paths = await PathPolicy.fromEnvironment(undefined, root);
  const approvals = new InMemoryApprovalBroker({ createId: sequentialIds("approval-crash-batch", "approval-crash-rename") });
  t.after(() => approvals.close());
  let crashMode: "replace" | "rename" = "replace";
  const crashingTools = await createWorkspaceChangeTools(paths, {
    transactionDirectory: state,
    afterMutation: async (mutation, index) => {
      if (crashMode === "replace" && mutation === "replace-installed" && index === 0) {
        throw new SimulatedWorkspaceChangeCrash("replacement crash");
      }
      if (crashMode === "rename" && mutation === "rename-source-removed") {
        throw new SimulatedWorkspaceChangeCrash("rename crash");
      }
    },
  });
  const broker = new LocalToolBroker([
    ...createReadOnlyWorkspaceTools(paths),
    ...crashingTools,
  ], approvals, paths);
  const firstSha = await readSha(broker, root, "recovery-read-first", "first.txt");
  const secondSha = await readSha(broker, root, "recovery-read-second", "second.txt");

  const replacement = broker.execute(call("recovery-batch", "workspace_replace_text_batch", {
    files: [
      { path: "first.txt", expected_sha256: firstSha, content: "first proposed\n" },
      { path: "second.txt", expected_sha256: secondSha, content: "second proposed\n" },
    ],
  }), { cwd: root });
  approvals.resolve((await pendingApproval(approvals)).id, "approved", "touch");
  assert.equal((await replacement).status, "failed");
  assert.equal(await readFile(join(root, "first.txt"), "utf8"), "first proposed\n");
  const pendingManifests = await readdir(state);
  assert.equal(pendingManifests.filter((name) => name.endsWith(".json")).length, 1);
  assert.equal((await stat(state)).mode & 0o777, 0o700);
  assert.equal((await stat(join(state, pendingManifests.find((name) => name.endsWith(".json"))!))).mode & 0o777, 0o600);

  await createWorkspaceChangeTools(paths, { transactionDirectory: state });
  assert.equal(await readFile(join(root, "first.txt"), "utf8"), "first original\n");
  assert.equal(await readFile(join(root, "second.txt"), "utf8"), "second original\n");
  assert.deepEqual(await readdir(state), []);
  assert.equal((await readdir(root)).some((name) => /^\.codex-pocket-.*\.(tmp|bak)$/.test(name)), false);

  crashMode = "rename";
  const renameResult = broker.execute(call("recovery-rename", "workspace_rename_text", {
    source_path: "first.txt",
    expected_sha256: firstSha,
    target_path: "moved.txt",
  }), { cwd: root });
  approvals.resolve((await pendingApproval(approvals)).id, "approved", "touch");
  assert.equal((await renameResult).status, "failed");
  await assert.rejects(readFile(join(root, "first.txt")), /ENOENT/);
  assert.equal(await readFile(join(root, "moved.txt"), "utf8"), "first original\n");

  await createWorkspaceChangeTools(paths, { transactionDirectory: state });
  assert.equal(await readFile(join(root, "first.txt"), "utf8"), "first original\n");
  await assert.rejects(readFile(join(root, "moved.txt")), /ENOENT/);
  assert.deepEqual(await readdir(state), []);
});

test("workspace change journal keeps committed creation and refuses ambiguous recovery overwrite", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-pocket-change-recovery-boundary-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = join(root, ".change-transactions");
  const paths = await PathPolicy.fromEnvironment(undefined, root);
  const committedApprovals = new InMemoryApprovalBroker({ createId: () => "approval-committed-create" });
  t.after(() => committedApprovals.close());
  const committedBroker = new LocalToolBroker(
    await createWorkspaceChangeTools(paths, {
      transactionDirectory: state,
      afterMutation: async (mutation) => {
        if (mutation === "transaction-committed") throw new SimulatedWorkspaceChangeCrash("committed crash");
      },
    }),
    committedApprovals,
    paths,
  );
  const creation = committedBroker.execute(call("committed-create", "workspace_create_text", {
    path: "committed.txt",
    content: "durable result\n",
  }), { cwd: root });
  committedApprovals.resolve((await pendingApproval(committedApprovals)).id, "approved", "touch");
  assert.equal((await creation).status, "failed");
  await createWorkspaceChangeTools(paths, { transactionDirectory: state });
  assert.equal(await readFile(join(root, "committed.txt"), "utf8"), "durable result\n");
  assert.deepEqual(await readdir(state), []);

  const victim = join(root, "victim.txt");
  await writeFile(victim, "original\n");
  const crashApprovals = new InMemoryApprovalBroker({ createId: () => "approval-ambiguous" });
  t.after(() => crashApprovals.close());
  const crashBroker = new LocalToolBroker([
    ...createReadOnlyWorkspaceTools(paths),
    ...await createWorkspaceChangeTools(paths, {
      transactionDirectory: state,
      afterMutation: async (mutation) => {
        if (mutation === "replace-installed") throw new SimulatedWorkspaceChangeCrash("prepared crash");
      },
    }),
  ], crashApprovals, paths);
  const sha256 = await readSha(crashBroker, root, "ambiguous-read", "victim.txt");
  const replacement = crashBroker.execute(call("ambiguous-replace", "workspace_replace_text", {
    path: "victim.txt",
    expected_sha256: sha256,
    content: "proposed\n",
  }), { cwd: root });
  crashApprovals.resolve((await pendingApproval(crashApprovals)).id, "approved", "touch");
  assert.equal((await replacement).status, "failed");
  await writeFile(victim, "external after crash\n");
  await assert.rejects(
    createWorkspaceChangeTools(paths, { transactionDirectory: state }),
    /stopped safely|changed independently/,
  );
  assert.equal(await readFile(victim, "utf8"), "external after crash\n");
  assert.equal((await readdir(state)).some((name) => name.endsWith(".json")), true);
});

function call(toolCallId: string, name: string, input: unknown) {
  return {
    providerId: "openai",
    conversationId: "conversation-change",
    runId: "run-change",
    toolCallId,
    name,
    input,
  };
}

async function pendingApproval(approvals: InMemoryApprovalBroker) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const pending = approvals.listPending()[0];
    if (pending) return pending;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("Approval request was not created");
}

async function readSha(
  broker: LocalToolBroker,
  cwd: string,
  toolCallId: string,
  path: string,
): Promise<string> {
  const result = await broker.execute(call(toolCallId, "workspace_read", {
    path,
    start_line: null,
    end_line: null,
  }), { cwd });
  return (result.output as { sha256: string }).sha256;
}

function sequentialIds(...ids: string[]): () => string {
  return () => ids.shift() ?? "unexpected-approval";
}
