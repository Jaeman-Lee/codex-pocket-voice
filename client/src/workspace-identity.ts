import type { Workspace, WorkspaceIdentity } from "./types";

export function workspaceIdentityFor(workspaces: readonly Workspace[], workspace: string): WorkspaceIdentity | undefined {
  return workspaces.find((item) => item.path === workspace)?.identity;
}

export function workspaceIdentityLabel(identity: WorkspaceIdentity | undefined): string {
  if (!identity || identity.kind !== "git") return "일반 폴더";
  const target = identity.branch
    ? identity.branch
    : identity.head
      ? `detached@${identity.head}`
      : "detached";
  const details = [
    identity.linkedWorktree ? "linked worktree" : "Git worktree",
    identity.dirty ? `변경 ${identity.changedFiles ?? 0}` : "clean",
    identity.ahead ? `↑${identity.ahead}` : "",
    identity.behind ? `↓${identity.behind}` : "",
  ].filter(Boolean);
  return `${target} · ${details.join(" · ")}`;
}
