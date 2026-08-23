import { useEffect, useMemo, useState } from "react";
import {
  activeApprovals,
  groupOperations,
  operationCounts,
  type OperationGroup,
} from "./operations-state";
import { workspaceIdentityFor, workspaceIdentityLabel } from "./workspace-identity";
import type { ApprovalItem, JournalPolicy, Operation, Workspace, WorkspaceIdentity } from "./types";

interface OperationsDashboardProps {
  deviceName: string;
  operations: Operation[];
  approvals: ApprovalItem[];
  workspaces: Workspace[];
  queuedCount: number;
  decidingApprovalId: string | null;
  journalPolicy: JournalPolicy | null;
  exportingWorkspace: string | null;
  deletingWorkspace: string | null;
  onClose(): void;
  onRefresh(): void;
  onOpenOperation(operation: Operation): void;
  onDecision(approval: ApprovalItem, decision: "approved" | "declined"): void;
  onExportWorkspace(workspace: string): Promise<void>;
  onDeleteWorkspaceHistory(workspace: string): Promise<void>;
}

export function OperationsDashboard(props: OperationsDashboardProps) {
  const [now, setNow] = useState(Date.now());
  const [confirmingWorkspace, setConfirmingWorkspace] = useState<string | null>(null);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);
  const approvals = useMemo(() => activeApprovals(props.approvals, now), [now, props.approvals]);
  const counts = useMemo(() => operationCounts(props.operations, approvals), [approvals, props.operations]);
  const groups = useMemo(() => groupOperations(props.operations, approvals), [approvals, props.operations]);
  useEffect(() => {
    const confirmingGroup = groups.find((group) => group.cwd === confirmingWorkspace);
    if (confirmingWorkspace && (!confirmingGroup || deletionProtected(confirmingGroup))) {
      setConfirmingWorkspace(null);
    }
  }, [confirmingWorkspace, groups]);

  return (
    <section className="operations-dashboard" role="dialog" aria-modal="true" aria-labelledby="operations-title">
      <div className="operations-sheet">
        <header className="operations-head">
          <div>
            <strong id="operations-title">작업 대시보드</strong>
            <small>{props.deviceName} · 프로젝트별 실행과 승인</small>
          </div>
          <button type="button" onClick={props.onRefresh} aria-label="작업 새로고침">↻</button>
          <button type="button" onClick={props.onClose} aria-label="작업 대시보드 닫기">×</button>
        </header>

        <div className="operation-counts" aria-label="작업 요약">
          <Count label="실행 중" value={counts.running} tone="running" />
          <Count label="승인 필요" value={counts.waitingForApproval} tone="approval" />
          <Count label="대기열" value={props.queuedCount} tone="queued" />
          <Count label="확인 필요" value={counts.unknown} tone="unknown" />
          <Count label="완료" value={counts.completed} tone="completed" />
          <Count label="실패" value={counts.failed} tone="failed" />
        </div>

        {approvals.length > 0 && (
          <section className="approval-inbox" aria-labelledby="approval-inbox-title">
            <div className="dashboard-section-title">
              <strong id="approval-inbox-title">승인함</strong>
              <span>음성으로 승인되지 않으며 화면에서 직접 검토합니다.</span>
            </div>
            {approvals.map((approval) => (
              <ApprovalCard
                key={approval.id}
                approval={approval}
                now={now}
                busy={props.decidingApprovalId === approval.id}
                onDecision={props.onDecision}
              />
            ))}
          </section>
        )}

        <section className="workspace-operations" aria-labelledby="workspace-operations-title">
          <div className="dashboard-section-title">
            <strong id="workspace-operations-title">프로젝트 작업</strong>
            <span>{journalPolicyLabel(props.operations.length, props.journalPolicy)}</span>
          </div>
          {groups.length === 0 ? (
            <p className="dashboard-empty">아직 기록된 작업이 없습니다.</p>
          ) : groups.map((group) => (
            <WorkspaceOperationGroup
              key={group.cwd}
              group={group}
              workspaces={props.workspaces}
              approvals={approvals}
              now={now}
              journalManagement={props.journalPolicy !== null}
              confirmingDelete={confirmingWorkspace === group.cwd}
              exportingWorkspace={props.exportingWorkspace}
              deletingWorkspace={props.deletingWorkspace}
              onOpenOperation={props.onOpenOperation}
              onConfirmDelete={(confirming) => setConfirmingWorkspace(confirming ? group.cwd : null)}
              onExportWorkspace={props.onExportWorkspace}
              onDeleteWorkspaceHistory={props.onDeleteWorkspaceHistory}
            />
          ))}
        </section>
      </div>
    </section>
  );
}

function WorkspaceOperationGroup({
  group,
  workspaces,
  approvals,
  now,
  journalManagement,
  confirmingDelete,
  exportingWorkspace,
  deletingWorkspace,
  onOpenOperation,
  onConfirmDelete,
  onExportWorkspace,
  onDeleteWorkspaceHistory,
}: {
  group: OperationGroup;
  workspaces: Workspace[];
  approvals: ApprovalItem[];
  now: number;
  journalManagement: boolean;
  confirmingDelete: boolean;
  exportingWorkspace: string | null;
  deletingWorkspace: string | null;
  onOpenOperation(operation: Operation): void;
  onConfirmDelete(confirming: boolean): void;
  onExportWorkspace(workspace: string): Promise<void>;
  onDeleteWorkspaceHistory(workspace: string): Promise<void>;
}) {
  const protectedHistory = deletionProtected(group);
  const busy = exportingWorkspace !== null || deletingWorkspace !== null;
  return (
    <section className="operation-group">
      <header>
        <strong>
          {group.name}
          <em>{workspaceIdentityLabel(workspaceIdentityFor(workspaces, group.cwd))}</em>
        </strong>
        <small title={group.cwd}>{group.cwd}</small>
      </header>
      <div className="operation-list">
        {group.operations.slice(0, 12).map((operation) => (
          <OperationCard
            key={operation.id}
            operation={operation}
            identity={operation.workspaceIdentity ?? workspaceIdentityFor(workspaces, operation.cwd)}
            waiting={approvals.some((item) => item.operationId === operation.id)}
            now={now}
            onOpen={onOpenOperation}
          />
        ))}
      </div>
      {journalManagement && (
        <div className="journal-controls">
          <div className="journal-actions">
            <button type="button" disabled={busy} onClick={() => void onExportWorkspace(group.cwd)}>
              {exportingWorkspace === group.cwd ? "내보내는 중…" : "JSON 내보내기"}
            </button>
            <button
              type="button"
              className="journal-delete-entry"
              disabled={busy || protectedHistory}
              onClick={() => onConfirmDelete(!confirmingDelete)}
            >
              기록 삭제
            </button>
          </div>
          <small className="journal-export-note">내보낸 JSON에는 프로젝트 경로·프롬프트·결과가 포함되므로 안전하게 보관하세요.</small>
          {protectedHistory && (
            <small className="journal-protected">실행·승인·확인 필요 작업을 먼저 끝내야 기록을 삭제할 수 있습니다.</small>
          )}
          {confirmingDelete && !protectedHistory && (
            <div className="journal-delete-confirm" role="group" aria-label="Companion 실행 기록 삭제 확인">
              <strong>이 프로젝트의 Companion 실행 기록을 삭제할까요?</strong>
              <code title={group.cwd}>{group.cwd}</code>
              <p>프로젝트 파일과 휴대폰의 암호화된 대화·대기열은 삭제되지 않습니다. 필요한 기록은 먼저 JSON으로 내보내세요.</p>
              <div>
                <button type="button" disabled={busy} onClick={() => onConfirmDelete(false)}>취소</button>
                <button
                  type="button"
                  className="confirm-delete"
                  disabled={busy}
                  onClick={() => void onDeleteWorkspaceHistory(group.cwd)}
                >
                  {deletingWorkspace === group.cwd ? "삭제 중…" : "확인하고 기록 삭제"}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function Count({ label, value, tone }: { label: string; value: number; tone: string }) {
  return <div className={`operation-count ${tone}`}><strong>{value}</strong><span>{label}</span></div>;
}

function ApprovalCard({
  approval,
  now,
  busy,
  onDecision,
}: {
  approval: ApprovalItem;
  now: number;
  busy: boolean;
  onDecision(approval: ApprovalItem, decision: "approved" | "declined"): void;
}) {
  const seconds = Math.max(0, Math.ceil((Date.parse(approval.expiresAt) - now) / 1_000));
  return (
    <article className={`approval-card risk-${approval.risk}`}>
      <div className="approval-meta">
        <span>{riskLabel(approval.risk)}</span>
        <small>{seconds}초 뒤 자동 거절</small>
      </div>
      <strong>{approval.redactedSummary}</strong>
      <small className="approval-context" title={approval.cwd}>
        {workspaceName(approval.cwd)} · {approval.providerId}
      </small>
      {approval.redactedDetails && <pre>{safeDetails(approval.redactedDetails)}</pre>}
      <div className="approval-actions">
        <button type="button" className="decline" disabled={busy} onClick={() => onDecision(approval, "declined")}>거절</button>
        <button type="button" className="approve" disabled={busy} onClick={() => onDecision(approval, "approved")}>
          {busy ? "처리 중…" : approval.requiresTouch ? "검토 후 터치 승인" : "승인"}
        </button>
      </div>
    </article>
  );
}

function OperationCard({
  operation,
  identity,
  waiting,
  now,
  onOpen,
}: {
  operation: Operation;
  identity: WorkspaceIdentity | undefined;
  waiting: boolean;
  now: number;
  onOpen(operation: Operation): void;
}) {
  const usage = operation.result?.usage;
  const model = operation.model || stringResult(operation.result, "model") || "기본 모델";
  const status = waiting ? "waiting" : operation.status;
  return (
    <article className={`operation-card status-${status}`}>
      <div className="operation-card-head">
        <span>{statusLabel(status, operation.acknowledgedAt)}</span>
        <small>{elapsed(operation, now)}</small>
      </div>
      <strong>{short(operation.prompt, 100)}</strong>
      <div className="operation-facts">
        <span>{operation.providerId ?? "codex"}</span>
        <span>{model}</span>
        <span>{workspaceIdentityLabel(identity)}</span>
        {usage?.totalTokens !== undefined && <span>{usage.totalTokens.toLocaleString()} tokens</span>}
        {usage?.costCredits !== undefined && <span>{usage.costCredits.toFixed(6)} credits</span>}
      </div>
      <button type="button" onClick={() => onOpen(operation)}>작업 열기</button>
    </article>
  );
}

function elapsed(operation: Operation, now: number): string {
  const start = Date.parse(operation.startedAt ?? "");
  if (!Number.isFinite(start)) return "시각 미상";
  const end = operation.completedAt ? Date.parse(operation.completedAt) : now;
  const seconds = Math.max(0, Math.floor((end - start) / 1_000));
  if (seconds < 60) return `${seconds}초`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}분`;
  return `${Math.floor(minutes / 60)}시간 ${minutes % 60}분`;
}

function statusLabel(status: string, acknowledgedAt?: string): string {
  if (status === "waiting") return "승인 필요";
  if (status === "running") return "실행 중";
  if (status === "unknown") return acknowledgedAt ? "확인 완료" : "상태 확인 필요";
  if (status === "completed") return "완료";
  if (status === "interrupted") return "중단됨";
  return "실패";
}

function riskLabel(risk: ApprovalItem["risk"]): string {
  if (risk === "external_effect") return "외부 효과";
  if (risk === "high_risk") return "고위험";
  if (risk === "execution") return "명령 실행";
  if (risk === "change") return "파일 변경";
  return "읽기";
}

function safeDetails(details: Record<string, unknown>): string {
  try {
    const { diff, script, ...metadata } = details;
    return [
      Object.keys(metadata).length > 0 ? JSON.stringify(metadata, null, 2) : "",
      typeof script === "string" ? `script:\n${script}` : "",
      typeof diff === "string" ? `diff:\n${diff}` : "",
    ].filter(Boolean).join("\n\n");
  } catch {
    return "검토 세부 정보를 표시할 수 없습니다.";
  }
}

function stringResult(result: Operation["result"], key: string): string | undefined {
  const value = result?.[key as keyof typeof result];
  return typeof value === "string" ? value : undefined;
}

function short(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

function workspaceName(value: string): string {
  return value.split(/[\\/]/).filter(Boolean).at(-1) ?? value;
}

function journalPolicyLabel(operationCount: number, policy: JournalPolicy | null): string {
  if (!policy) return `최근 작업 ${operationCount}건`;
  const days = policy.retentionMs / (24 * 60 * 60_000);
  const retention = Number.isInteger(days) ? `${days}일` : `${Math.round(policy.retentionMs / 3_600_000)}시간`;
  const exportMiB = policy.maxExportBytes / (1024 * 1024);
  return `최근 작업 ${operationCount}건 · 보존 ${retention} · 작업 ${policy.maxOperations.toLocaleString()} · 이벤트 ${policy.maxEvents.toLocaleString()} · 내보내기 ${exportMiB.toLocaleString()} MiB`;
}

function deletionProtected(group: OperationGroup): boolean {
  return group.approvals.length > 0 || group.operations.some((operation) =>
    operation.status === "running" || (operation.status === "unknown" && !operation.acknowledgedAt));
}
