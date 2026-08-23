import assert from "node:assert/strict";
import test from "node:test";
import { workspaceIdentityFor, workspaceIdentityLabel } from "../client/src/workspace-identity.js";

test("workspace identity labels keep project branches distinguishable on mobile", () => {
  const workspaces = [{
    path: "/workspace/pocket",
    name: "pocket",
    identity: {
      kind: "git" as const,
      branch: "feature/v2-control-plane",
      changedFiles: 3,
      dirty: true,
      linkedWorktree: true,
      ahead: 2,
      behind: 1,
    },
  }];
  const identity = workspaceIdentityFor(workspaces, "/workspace/pocket");
  assert.equal(
    workspaceIdentityLabel(identity),
    "feature/v2-control-plane · linked worktree · 변경 3 · ↑2 · ↓1",
  );
  assert.equal(workspaceIdentityLabel(undefined), "일반 폴더");
});
