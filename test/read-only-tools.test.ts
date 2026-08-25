import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { InMemoryApprovalBroker } from "../src/approval-broker.js";
import { PathPolicy } from "../src/path-policy.js";
import { createReadOnlyWorkspaceTools } from "../src/read-only-tools.js";
import { LocalToolBroker, ToolBrokerError } from "../src/tool-broker.js";

test("read-only workspace tools contain paths, hide secrets, and never request approval", async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), "codex-pocket-read-tools-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const workspace = path.join(base, "workspace");
  const outside = path.join(base, "outside.txt");
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await writeFile(outside, "outside needle\n");
  await writeFile(path.join(workspace, ".env"), "OPENAI_API_KEY=sk-hidden-env-secret-123456\n");
  await writeFile(path.join(workspace, ".codex-pocket-recovery.bak"), "internal transaction copy\n");
  await writeFile(
    path.join(workspace, "src", "app.ts"),
    "export const needle = true;\nOPENAI_API_KEY=sk-source-secret-123456789\n",
  );
  await symlink(outside, path.join(workspace, "escape.txt"));
  await git(workspace, ["init", "-q"]);
  await git(workspace, ["add", "src/app.ts", ".env"]);

  const paths = await PathPolicy.fromEnvironment(workspace);
  const approvals = new InMemoryApprovalBroker();
  t.after(() => approvals.close());
  const broker = new LocalToolBroker(createReadOnlyWorkspaceTools(paths, {
    searchCommand: "codex-pocket-missing-ripgrep-for-fallback-test",
  }), approvals, paths);
  let call = 0;
  const execute = (name: string, input: unknown) => broker.execute({
    providerId: "openai",
    conversationId: "conversation-read-only",
    runId: "run-read-only",
    toolCallId: `call-${call += 1}`,
    name,
    input,
  }, { cwd: workspace });

  const definitions = broker.definitions();
  assert.deepEqual(definitions.map((definition) => definition.name), [
    "workspace_list",
    "workspace_read",
    "workspace_search",
    "git_status",
    "git_diff",
  ]);
  assert.equal(definitions.every((definition) => definition.risk === "observation"), true);

  const listed = await execute("workspace_list", { path: null, max_entries: null });
  assert.equal(listed.status, "completed");
  assert.doesNotMatch(JSON.stringify(listed.output), /\.env|\.git|\.codex-pocket/);

  const read = await execute("workspace_read", {
    path: "src/app.ts",
    start_line: null,
    end_line: null,
  });
  assert.equal(read.status, "completed");
  assert.match(JSON.stringify(read.output), /needle/);
  assert.match((read.output as { sha256: string }).sha256, /^[a-f0-9]{64}$/);
  assert.match(JSON.stringify(read.output), /REDACTED API KEY/);
  assert.doesNotMatch(JSON.stringify(read.output), /sk-source-secret/);

  const search = await execute("workspace_search", {
    query: "needle",
    path: null,
    file_glob: "**/*.ts",
    max_results: null,
  });
  assert.equal(search.status, "completed");
  assert.match(JSON.stringify(search.output), /src\/app\.ts/);
  assert.doesNotMatch(JSON.stringify(search.output), /outside\.txt|\.env/);

  const sensitive = await execute("workspace_read", {
    path: ".env",
    start_line: null,
    end_line: null,
  });
  assert.equal(sensitive.status, "failed");
  const escaped = await execute("workspace_read", {
    path: "escape.txt",
    start_line: null,
    end_line: null,
  });
  assert.equal(escaped.status, "failed");

  const status = await execute("git_status", {});
  assert.equal(status.status, "completed");
  assert.match(JSON.stringify(status.output), /src\/app\.ts/);
  assert.doesNotMatch(JSON.stringify(status.output), /\.env|\.codex-pocket/);

  const diff = await execute("git_diff", { staged: true, path: null });
  assert.equal(diff.status, "completed");
  assert.match(JSON.stringify(diff.output), /src\/app\.ts/);
  assert.match(JSON.stringify(diff.output), /REDACTED API KEY/);
  assert.doesNotMatch(JSON.stringify(diff.output), /sk-source-secret|hidden-env-secret|\.env/);
  assert.equal(approvals.listPending().length, 0);

  await assert.rejects(
    execute("workspace_write", { path: "src/app.ts" }),
    (error: unknown) => error instanceof ToolBrokerError && error.statusCode === 400,
  );
});

function git(cwd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd }, (error) => error ? reject(error) : resolve());
  });
}
