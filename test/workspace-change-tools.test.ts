import assert from "node:assert/strict";
import { link, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { InMemoryApprovalBroker } from "../src/approval-broker.js";
import { PathPolicy } from "../src/path-policy.js";
import { createReadOnlyWorkspaceTools } from "../src/read-only-tools.js";
import { LocalToolBroker } from "../src/tool-broker.js";
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
    ...createWorkspaceChangeTools(paths),
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
    ...createWorkspaceChangeTools(paths),
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
  const broker = new LocalToolBroker(createWorkspaceChangeTools(paths), approvals, paths);
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
