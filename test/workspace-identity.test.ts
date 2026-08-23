import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectWorkspaceIdentity } from "../src/workspace-identity.js";

test("workspace identity reports branch, commit, dirty state, and linked worktrees", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-pocket-workspace-identity-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repository = join(directory, "repository");
  const linked = join(directory, "linked");
  await mkdir(repository);
  await git(repository, "init", "--quiet");
  await git(repository, "symbolic-ref", "HEAD", "refs/heads/main");
  await writeFile(join(repository, "tracked.txt"), "first\n", "utf8");
  await git(repository, "add", "tracked.txt");
  await git(repository, "-c", "user.name=Pocket Test", "-c", "user.email=pocket@example.invalid", "commit", "--quiet", "-m", "first");

  const clean = await inspectWorkspaceIdentity(repository);
  assert.equal(clean.kind, "git");
  assert.equal(clean.branch, "main");
  assert.match(clean.head ?? "", /^[a-f0-9]{12}$/);
  assert.equal(clean.dirty, false);
  assert.equal(clean.changedFiles, 0);
  assert.equal(clean.linkedWorktree, false);

  await writeFile(join(repository, "tracked.txt"), "changed\n", "utf8");
  const dirty = await inspectWorkspaceIdentity(repository);
  assert.equal(dirty.dirty, true);
  assert.equal(dirty.changedFiles, 1);

  await git(repository, "worktree", "add", "--quiet", "--detach", linked, "HEAD");
  const worktree = await inspectWorkspaceIdentity(linked);
  assert.equal(worktree.kind, "git");
  assert.equal(worktree.detached, true);
  assert.equal(worktree.linkedWorktree, true);
});

test("workspace identity treats a non-Git project as a normal directory", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-pocket-directory-identity-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.deepEqual(await inspectWorkspaceIdentity(directory), { kind: "directory" });
});

function git(cwd: string, ...args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, shell: false, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git ${args[0]} failed: ${stderr.trim()}`));
    });
  });
}
