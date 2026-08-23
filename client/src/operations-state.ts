import type { ApprovalItem, CodexEvent, Operation } from "./types";

const MAX_VISIBLE_OPERATIONS = 500;

export interface OperationCounts {
  running: number;
  waitingForApproval: number;
  completed: number;
  failed: number;
  unknown: number;
}

export interface OperationGroup {
  cwd: string;
  name: string;
  operations: Operation[];
  approvals: ApprovalItem[];
}

export function upsertOperation(current: readonly Operation[], operation: Operation): Operation[] {
  return [operation, ...current.filter((item) => item.id !== operation.id)]
    .sort((left, right) => operationTime(right) - operationTime(left))
    .slice(0, MAX_VISIBLE_OPERATIONS);
}

export function applyApprovalEvent(
  current: readonly ApprovalItem[],
  event: CodexEvent,
  now = Date.now(),
): ApprovalItem[] {
  const approval = event.approval;
  if (!approval) return [...current];
  const remaining = current.filter((item) => item.id !== approval.id && Date.parse(item.expiresAt) > now);
  if (event.action !== "requested" || approval.status !== "pending" || Date.parse(approval.expiresAt) <= now) {
    return remaining;
  }
  return [approval, ...remaining].sort((left, right) => Date.parse(left.expiresAt) - Date.parse(right.expiresAt));
}

export function activeApprovals(current: readonly ApprovalItem[], now = Date.now()): ApprovalItem[] {
  return current.filter((item) => item.status === "pending" && Date.parse(item.expiresAt) > now);
}

export function operationCounts(
  operations: readonly Operation[],
  approvals: readonly ApprovalItem[],
): OperationCounts {
  const waiting = new Set(approvals.map((item) => item.operationId));
  return {
    running: operations.filter((item) => item.status === "running" && !waiting.has(item.id)).length,
    waitingForApproval: waiting.size,
    completed: operations.filter((item) => item.status === "completed" || item.status === "interrupted").length,
    failed: operations.filter((item) => item.status === "failed").length,
    unknown: operations.filter((item) => item.status === "unknown" && !item.acknowledgedAt).length,
  };
}

export function dashboardOperations(
  operations: readonly Operation[],
  includeArchived = false,
): Operation[] {
  return operations.filter((operation) => includeArchived || !operation.archivedAt);
}

export function groupOperations(
  operations: readonly Operation[],
  approvals: readonly ApprovalItem[],
): OperationGroup[] {
  const byWorkspace = new Map<string, OperationGroup>();
  const group = (cwd: string) => {
    let existing = byWorkspace.get(cwd);
    if (!existing) {
      existing = { cwd, name: workspaceName(cwd), operations: [], approvals: [] };
      byWorkspace.set(cwd, existing);
    }
    return existing;
  };
  for (const operation of operations) group(operation.cwd).operations.push(operation);
  for (const approval of approvals) group(approval.cwd).approvals.push(approval);
  for (const workspace of byWorkspace.values()) {
    workspace.operations.sort((left, right) => operationPriority(right) - operationPriority(left)
      || operationTime(right) - operationTime(left));
  }
  return [...byWorkspace.values()].sort((left, right) => {
    const leftPriority = groupPriority(left);
    const rightPriority = groupPriority(right);
    return rightPriority - leftPriority || left.name.localeCompare(right.name);
  });
}

function operationPriority(operation: Operation): number {
  if (operation.status === "running") return 4;
  if (operation.status === "unknown" && !operation.acknowledgedAt) return 3;
  if (operation.pinnedAt) return 2;
  return 1;
}

function groupPriority(group: OperationGroup): number {
  if (group.approvals.length > 0) return 4;
  if (group.operations.some((item) => item.status === "running")) return 3;
  if (group.operations.some((item) => item.status === "unknown" && !item.acknowledgedAt)) return 2;
  return group.operations.length > 0 ? 1 : 0;
}

function operationTime(operation: Operation): number {
  return Date.parse(operation.completedAt ?? operation.startedAt ?? "") || 0;
}

function workspaceName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}
