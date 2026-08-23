import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { InMemoryApprovalBroker } from "../src/approval-broker.js";
import { PathPolicy } from "../src/path-policy.js";
import { LocalToolBroker } from "../src/tool-broker.js";
import {
  createWorkspaceExecutionTools,
  type WorkspaceSandboxRunner,
} from "../src/workspace-execution-tools.js";

test("project_verify binds the reviewed package script and redacts sandbox output", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-pocket-verify-tool-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageText = JSON.stringify({ scripts: { check: "tsc --noEmit", test: "node test.js", build: "vite build" } });
  await writeFile(join(root, "package.json"), packageText);
  const sha256 = digest(packageText);
  const paths = await PathPolicy.fromEnvironment(undefined, root);
  const approvals = new InMemoryApprovalBroker({ createId: () => "approval-verify" });
  t.after(() => approvals.close());
  const calls: Array<{ cwd: string; command: readonly string[] }> = [];
  const runner: WorkspaceSandboxRunner = {
    async run(cwd, command) {
      calls.push({ cwd, command });
      return {
        code: 0,
        stdout: "OPENAI_API_KEY=sk-abcdefghijklmnop\nchecks passed\n",
        stderr: "",
        durationMs: 25,
        truncated: false,
      };
    },
  };
  const tools = await createWorkspaceExecutionTools(paths, { runner });
  const broker = new LocalToolBroker(tools, approvals, paths);
  const verification = broker.execute(call("verify-check", {
    task: "check",
    expected_package_sha256: sha256,
  }), { cwd: root });
  const pending = await pendingApproval(approvals);
  assert.equal(pending.risk, "execution");
  assert.equal(pending.requiresTouch, true);
  assert.equal(pending.redactedDetails?.command, "npm run check");
  assert.equal(pending.redactedDetails?.network, "disabled");
  assert.throws(() => approvals.resolve(pending.id, "approved", "voice"), /터치/);
  approvals.resolve(pending.id, "approved", "touch");
  const result = await verification;
  assert.equal(result.status, "completed");
  assert.deepEqual(calls, [{ cwd: root, command: ["npm", "run", "check"] }]);
  assert.match(JSON.stringify(result.output), /checks passed/);
  assert.doesNotMatch(JSON.stringify(result.output), /sk-abcdefghijklmnop/);
});

test("project_verify refuses a package script changed after approval", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-pocket-verify-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = JSON.stringify({ scripts: { test: "node safe-test.js" } });
  await writeFile(join(root, "package.json"), original);
  const paths = await PathPolicy.fromEnvironment(undefined, root);
  const approvals = new InMemoryApprovalBroker({ createId: () => "approval-verify-race" });
  t.after(() => approvals.close());
  let executions = 0;
  const runner: WorkspaceSandboxRunner = {
    async run() {
      executions += 1;
      return { code: 0, stdout: "", stderr: "", durationMs: 1, truncated: false };
    },
  };
  const broker = new LocalToolBroker(await createWorkspaceExecutionTools(paths, { runner }), approvals, paths);
  const verification = broker.execute(call("verify-race", {
    task: "test",
    expected_package_sha256: digest(original),
  }), { cwd: root });
  const pending = await pendingApproval(approvals);
  await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "node changed.js" } }));
  approvals.resolve(pending.id, "approved", "touch");
  assert.equal((await verification).status, "failed");
  assert.equal(executions, 0);
});

test("default Linux verifier uses a disposable, secret-masked, network-isolated overlay when available", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-pocket-verify-sandbox-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageText = JSON.stringify({
    scripts: {
      test: "node -e \"const fs=require('node:fs');const os=require('node:os');fs.writeFileSync('sandbox-only.txt','changed');process.stdout.write((fs.readFileSync('.env','utf8')||'masked')+'|'+Object.keys(os.networkInterfaces()).join(','))\"",
    },
  });
  await writeFile(join(root, "package.json"), packageText);
  await writeFile(join(root, ".env"), "PRIVATE_VALUE=must-not-leak\n");
  const paths = await PathPolicy.fromEnvironment(undefined, root);
  const tools = await createWorkspaceExecutionTools(paths);
  if (tools.length === 0) {
    t.skip("unprivileged user/mount/network namespaces are unavailable on this Linux host");
    return;
  }
  const approvals = new InMemoryApprovalBroker({ createId: () => "approval-sandbox" });
  t.after(() => approvals.close());
  const broker = new LocalToolBroker(tools, approvals, paths);
  const verification = broker.execute(call("verify-sandbox", {
    task: "test",
    expected_package_sha256: digest(packageText),
  }), { cwd: root });
  const pending = await pendingApproval(approvals);
  approvals.resolve(pending.id, "approved", "touch");
  const result = await verification;
  assert.equal(result.status, "completed");
  const output = result.output as { exitCode: number; stdout: string; filesystemChangesDiscarded: boolean; networkAccess: boolean };
  assert.equal(output.exitCode, 0);
  assert.equal(output.filesystemChangesDiscarded, true);
  assert.equal(output.networkAccess, false);
  assert.match(output.stdout, /masked\|lo/);
  assert.doesNotMatch(output.stdout, /must-not-leak|eth|wlan/);
  await assert.rejects(access(join(root, "sandbox-only.txt")));
  assert.equal(await readFile(join(root, ".env"), "utf8"), "PRIVATE_VALUE=must-not-leak\n");
});

function call(toolCallId: string, input: unknown) {
  return {
    providerId: "openai",
    conversationId: "verify-conversation",
    runId: "verify-run",
    toolCallId,
    name: "project_verify",
    input,
  };
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function pendingApproval(approvals: InMemoryApprovalBroker) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const pending = approvals.listPending()[0];
    if (pending) return pending;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("Approval request was not created");
}
