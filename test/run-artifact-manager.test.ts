import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PathPolicy } from "../src/path-policy.js";
import {
  RunArtifactManager,
  runArtifacts,
  verificationArtifactCandidate,
} from "../src/run-artifact-manager.js";

test("run artifacts snapshot bounded redacted logs and allowlisted changed files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-pocket-run-artifacts-"));
  const workspace = join(root, "workspace");
  const artifactRoot = join(root, "private-artifacts");
  await mkdir(join(workspace, "build"), { recursive: true });
  await mkdir(join(workspace, "screens"), { recursive: true });
  await mkdir(join(workspace, ".ssh"), { recursive: true });
  await writeFile(join(workspace, "build", "app-debug.apk"), Buffer.from("PK\u0003\u0004signed-apk"));
  await writeFile(join(workspace, "screens", "mobile.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  await writeFile(join(workspace, ".ssh", "secret.png"), "private");
  await symlink(join(workspace, "screens", "mobile.png"), join(workspace, "screens", "linked.png"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const paths = await PathPolicy.fromEnvironment(undefined, workspace);
  let id = 0;
  const manager = new RunArtifactManager(paths, {
    rootDir: artifactRoot,
    retentionMs: 60_000,
    now: () => Date.parse("2026-08-24T00:00:00.000Z"),
    createId: () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
  });
  await manager.initialize();

  const result = await manager.finalizeOperation({ id: "operation-one", cwd: workspace }, {
    finalResponse: "done",
    artifactCandidates: [{
      kind: "test",
      name: "npm-test.log",
      content: "OPENAI_API_KEY=sk-abcdefghijklmnop\nDATABASE_PASSWORD=private-value\n42 checks passed",
    }],
    commands: [{ command: "npm test", status: "completed", exitCode: 0, output: "command output" }],
    fileChanges: [{
      changes: [
        { kind: "add", path: "build/app-debug.apk" },
        { kind: "add", path: join(workspace, "screens", "mobile.png") },
        { kind: "add", path: ".ssh/secret.png" },
        { kind: "add", path: "screens/linked.png" },
        { kind: "add", path: "../../outside.apk" },
      ],
    }],
  });

  assert.equal("artifactCandidates" in result, false);
  assert.equal((result.commands as Array<Record<string, unknown>>)[0]?.output, undefined);
  const artifacts = runArtifacts(result);
  assert.deepEqual(artifacts.map((artifact) => artifact.kind), ["test", "log", "apk", "image"]);
  assert.match(artifacts[0]?.preview ?? "", /42 checks passed/);
  assert.doesNotMatch(JSON.stringify(result), /sk-abcdefghijklmnop|private-value/);
  assert.equal(artifacts.some((artifact) => artifact.name === "secret.png"), false);
  assert.equal(artifacts.some((artifact) => artifact.name === "linked.png"), false);

  const apk = artifacts.find((artifact) => artifact.kind === "apk")!;
  const opened = await manager.open("operation-one", apk);
  assert.equal((await opened.handle.readFile()).toString(), "PK\u0003\u0004signed-apk");
  await opened.handle.close();
  const operationDirectory = createHash("sha256").update("operation\0operation-one").digest("hex");
  const apkSnapshot = join(artifactRoot, operationDirectory, `${apk.id}.bin`);
  await chmod(apkSnapshot, 0o600);
  await writeFile(apkSnapshot, "x".repeat(apk.size));
  await assert.rejects(manager.open("operation-one", apk), /checksum/);
  await manager.deleteOperations(["operation-one"]);
  await assert.rejects(manager.open("operation-one", apk), /찾을 수 없습니다/);
});

test("verification tool output becomes a downloadable test report candidate", () => {
  const candidate = verificationArtifactCandidate("project_verify", {
    toolCallId: "tool-one",
    status: "completed",
    output: {
      task: "test",
      command: "npm test",
      exitCode: 1,
      stdout: "10 passed",
      stderr: "1 failed",
      durationMs: 320,
      outputTruncated: false,
      filesystemChangesDiscarded: true,
      networkAccess: false,
    },
  });
  assert.equal(candidate?.kind, "test");
  assert.equal(candidate?.name, "npm-test-failed.log");
  assert.match(candidate?.content ?? "", /exitCode: 1/);
  assert.match(candidate?.content ?? "", /1 failed/);
  assert.equal(verificationArtifactCandidate("workspace_read", {
    toolCallId: "tool-two",
    status: "completed",
    output: {},
  }), null);
});

test("artifact initialization removes only expired managed operation directories", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-pocket-run-artifact-retention-"));
  const workspace = join(root, "workspace");
  const artifactRoot = join(root, "artifacts");
  await mkdir(workspace);
  await mkdir(artifactRoot);
  const expired = join(artifactRoot, "a".repeat(64));
  const unrelated = join(artifactRoot, "keep-me");
  await mkdir(expired);
  await mkdir(unrelated);
  const old = new Date("2026-08-20T00:00:00.000Z");
  const { utimes } = await import("node:fs/promises");
  await utimes(expired, old, old);
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = await PathPolicy.fromEnvironment(undefined, workspace);
  const manager = new RunArtifactManager(paths, {
    rootDir: artifactRoot,
    retentionMs: 24 * 60 * 60_000,
    now: () => Date.parse("2026-08-24T00:00:00.000Z"),
  });
  await manager.initialize();
  await assert.rejects(access(expired));
  await access(unrelated);
});
