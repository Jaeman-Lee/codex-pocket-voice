import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PathPolicy } from "../src/path-policy.js";

test("PathPolicy allows descendants and blocks paths and symlinks outside roots", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "codex-voice-policy-"));
  const root = path.join(base, "allowed");
  const child = path.join(root, "project");
  const outside = path.join(base, "outside");
  await mkdir(child, { recursive: true });
  await mkdir(outside);
  await symlink(outside, path.join(root, "escape"));

  try {
    const policy = await PathPolicy.fromEnvironment(root);
    assert.equal(await policy.resolveWorkspace(child), child);
    await assert.rejects(() => policy.resolveWorkspace(outside), /outside CODEX_VOICE_ROOTS/);
    await assert.rejects(() => policy.resolveWorkspace(path.join(root, "escape")), /outside CODEX_VOICE_ROOTS/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
