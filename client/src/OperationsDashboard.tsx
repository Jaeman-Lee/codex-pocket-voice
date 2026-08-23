import { useEffect, useMemo, useState } from "react";
import {
  activeApprovals,
  groupOperations,
  operationCounts,
} from "./operations-state";
import type { ApprovalItem, Operation } from "./types";

interface OperationsDashboardProps {
  deviceName: string;
  operations: Operation[];
  approvals: ApprovalItem[];
  queuedCount: number;
  decidingApprovalId: string | null;
  onClose(): void;
  onRefresh(): void;
  onOpenOperation(operation: Operation): void;
  onDecision(approval: ApprovalItem, decision: "approved" | "declined"): void;
}

export function OperationsDashboard(props: OperationsDashboardProps) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);
  const approvals = useMemo(() => activeApprovals(props.approvals, now), [now, props.approvals]);
  const counts = useMemo(() => operationCounts(props.operations, approvals), [approvals, props.operations]);
  const groups = useMemo(() => groupOperations(props.operations, approvals), [approvals, props.operations]);

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
            <span>최근 작업 {props.operations.length}건</span>
          </div>
          {groups.length === 0 ? (
            <p className="dashboard-empty">아직 기록된 작업이 없습니다.</p>
          ) : groups.map((group) => (
            <section className="operation-group" key={group.cwd}>
              <header>
                <strong>{group.name}</strong>
                <small title={group.cwd}>{group.cwd}</small>
              </header>
              <div className="operation-list">
                {group.operations.slice(0, 12).map((operation) => (
                  <OperationCard
                    key={operation.id}
                    operation={operation}
                    waiting={approvals.some((item) => item.operationId === operation.id)}
                    now={now}
                    onOpen={props.onOpenOperation}
                  />
                ))}
              </div>
            </section>
          ))}
        </section>
      </div>
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
  waiting,
  now,
  onOpen,
}: {
  operation: Operation;
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
    return JSON.stringify(details, null, 2);
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
