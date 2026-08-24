import { useEffect, useMemo, useState } from "react";
import {
  activeApprovals,
  dashboardOperations,
  groupOperations,
  operationCounts,
  type OperationGroup,
} from "./operations-state";
import { workspaceIdentityFor, workspaceIdentityLabel } from "./workspace-identity";
import type {
  ApprovalItem,
  JournalPolicy,
  JournalPolicyLimits,
  Operation,
  OperationMetadataPatch,
  ProviderModelVerification,
  Workspace,
  WorkspaceChangeRecoveryStatus,
  WorkspaceIdentity,
} from "./types";

interface OperationsDashboardProps {
  deviceName: string;
  operations: Operation[];
  approvals: ApprovalItem[];
  workspaces: Workspace[];
  queuedCount: number;
  workspaceRecovery: WorkspaceChangeRecoveryStatus | null;
  retryingWorkspaceRecovery: boolean;
  decidingApprovalId: string | null;
  journalPolicy: JournalPolicy | null;
  journalPolicyLimits: JournalPolicyLimits | null;
  updatingJournalPolicy: boolean;
  exportingWorkspace: string | null;
  deletingWorkspace: string | null;
  updatingOperationId: string | null;
  onClose(): void;
  onRefresh(): void;
  onRetryWorkspaceRecovery(): Promise<boolean>;
  onOpenOperation(operation: Operation): void;
  onUpdateOperation(operation: Operation, patch: OperationMetadataPatch): Promise<boolean>;
  onUpdateJournalPolicy(policy: JournalPolicy): Promise<boolean>;
  onDecision(approval: ApprovalItem, decision: "approved" | "declined"): void;
  onExportWorkspace(workspace: string): Promise<void>;
  onDeleteWorkspaceHistory(workspace: string): Promise<void>;
}

export function OperationsDashboard(props: OperationsDashboardProps) {
  const [now, setNow] = useState(Date.now());
  const [confirmingWorkspace, setConfirmingWorkspace] = useState<string | null>(null);
  const [confirmingRecovery, setConfirmingRecovery] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [showPolicyEditor, setShowPolicyEditor] = useState(false);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);
  const approvals = useMemo(() => activeApprovals(props.approvals, now), [now, props.approvals]);
  const archivedCount = useMemo(() => props.operations.filter((operation) => operation.archivedAt).length, [props.operations]);
  const visibleOperations = useMemo(
    () => dashboardOperations(props.operations, showArchived),
    [props.operations, showArchived],
  );
  const counts = useMemo(() => operationCounts(visibleOperations, approvals), [approvals, visibleOperations]);
  const groups = useMemo(() => groupOperations(visibleOperations, approvals), [approvals, visibleOperations]);
  useEffect(() => {
    const confirmingGroup = groups.find((group) => group.cwd === confirmingWorkspace);
    if (confirmingWorkspace && (!confirmingGroup || deletionProtected(confirmingGroup))) {
      setConfirmingWorkspace(null);
    }
  }, [confirmingWorkspace, groups]);
  useEffect(() => {
    if (!props.workspaceRecovery?.blocked) setConfirmingRecovery(false);
  }, [props.workspaceRecovery?.blocked]);

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

        {props.workspaceRecovery?.blocked && (
          <WorkspaceRecoveryCard
            status={props.workspaceRecovery}
            busy={props.retryingWorkspaceRecovery}
            confirming={confirmingRecovery}
            onConfirming={setConfirmingRecovery}
            onRetry={props.onRetryWorkspaceRecovery}
          />
        )}

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
            <div className="dashboard-section-tools">
              <span>{journalPolicyLabel(props.operations.length, props.journalPolicy)}</span>
              {archivedCount > 0 && (
                <button type="button" aria-pressed={showArchived} onClick={() => setShowArchived((current) => !current)}>
                  보관됨 {archivedCount}건 {showArchived ? "숨기기" : "보기"}
                </button>
              )}
              {props.journalPolicy && props.journalPolicyLimits && (
                <button type="button" aria-expanded={showPolicyEditor} onClick={() => setShowPolicyEditor((current) => !current)}>
                  보존 설정
                </button>
              )}
            </div>
          </div>
          {showPolicyEditor && props.journalPolicy && props.journalPolicyLimits && (
            <RetentionPolicyEditor
              policy={props.journalPolicy}
              limits={props.journalPolicyLimits}
              busy={props.updatingJournalPolicy}
              onClose={() => setShowPolicyEditor(false)}
              onUpdate={props.onUpdateJournalPolicy}
            />
          )}
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
              updatingOperationId={props.updatingOperationId}
              onOpenOperation={props.onOpenOperation}
              onUpdateOperation={props.onUpdateOperation}
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

function WorkspaceRecoveryCard({
  status,
  busy,
  confirming,
  onConfirming,
  onRetry,
}: {
  status: WorkspaceChangeRecoveryStatus;
  busy: boolean;
  confirming: boolean;
  onConfirming(confirming: boolean): void;
  onRetry(): Promise<boolean>;
}) {
  const retry = async () => {
    if (busy) return;
    if (!confirming) {
      onConfirming(true);
      return;
    }
    try {
      await onRetry();
    } finally {
      onConfirming(false);
    }
  };
  const visibleTransactions = status.pendingTransactions.slice(0, 8);
  return (
    <section className="workspace-recovery" role="alert" aria-labelledby="workspace-recovery-title">
      <header>
        <strong id="workspace-recovery-title">Workspace 변경 복구가 멈췄습니다</strong>
        <span>읽기 작업은 계속 사용할 수 있지만 파일 변경 도구는 안전을 위해 차단됐습니다.</span>
      </header>
      {status.error && <p className="workspace-recovery-error">{status.error}</p>}
      {status.pendingCountKnown ? (
        visibleTransactions.length > 0 && (
          <ol className="workspace-recovery-transactions">
            {visibleTransactions.map((transaction) => (
              <li key={transaction.id}>
                <strong>{recoveryOperationLabel(transaction.operation)} · {recoveryPhaseLabel(transaction.phase)}</strong>
                <code title={transaction.workspace}>{transaction.workspace}</code>
                <div>
                  {transaction.paths.map((item) => <code key={item} title={item}>{item}</code>)}
                </div>
              </li>
            ))}
            {status.pendingTransactions.length > visibleTransactions.length && (
              <li className="workspace-recovery-more">그 밖의 transaction {status.pendingTransactions.length - visibleTransactions.length}건</li>
            )}
          </ol>
        )
      ) : (
        <p>비공개 transaction journal을 안전하게 해석하지 못해 파일 경로를 추측하지 않습니다.</p>
      )}
      <p>Linux PC에서 위 workspace와 상대 경로를 확인하고 필요한 내용을 보존한 뒤 다시 시도하세요.</p>
      <p className="workspace-recovery-safety">재시도는 journal을 버리거나 파일을 강제로 덮어쓰거나 삭제하지 않습니다. 같은 안전 검사를 다시 실행합니다.</p>
      {confirming && (
        <strong className="workspace-recovery-confirm">PC에서 파일 상태를 확인했다면 한 번 더 눌러 재시도하세요.</strong>
      )}
      <div className="workspace-recovery-actions">
        {confirming && <button type="button" disabled={busy} onClick={() => onConfirming(false)}>취소</button>}
        <button
          type="button"
          className={confirming ? "confirm-recovery" : undefined}
          disabled={busy}
          onClick={() => void retry()}
        >{busy ? "안전 복구 확인 중…" : confirming ? "확인하고 안전 복구 재시도" : "안전 복구 재시도 검토"}</button>
      </div>
    </section>
  );
}

function recoveryOperationLabel(operation: WorkspaceChangeRecoveryStatus["pendingTransactions"][number]["operation"]): string {
  if (operation === "replace") return "파일 교체";
  if (operation === "create") return "파일 생성";
  return "파일 이름 변경";
}

function recoveryPhaseLabel(phase: WorkspaceChangeRecoveryStatus["pendingTransactions"][number]["phase"]): string {
  if (phase === "staging") return "준비 중";
  if (phase === "prepared") return "원복 대기";
  return "정리 대기";
}

function RetentionPolicyEditor({
  policy,
  limits,
  busy,
  onClose,
  onUpdate,
}: {
  policy: JournalPolicy;
  limits: JournalPolicyLimits;
  busy: boolean;
  onClose(): void;
  onUpdate(policy: JournalPolicy): Promise<boolean>;
}) {
  const dayMs = 24 * 60 * 60_000;
  const [days, setDays] = useState(String(policy.retentionMs / dayMs));
  const [maxOperations, setMaxOperations] = useState(String(policy.maxOperations));
  const [maxEvents, setMaxEvents] = useState(String(policy.maxEvents));
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    setDays(String(policy.retentionMs / dayMs));
    setMaxOperations(String(policy.maxOperations));
    setMaxEvents(String(policy.maxEvents));
    setConfirming(false);
  }, [policy]);
  const retentionMs = Number(days) * dayMs;
  const operationCount = Number(maxOperations);
  const eventCount = Number(maxEvents);
  const valid = Number.isInteger(Number(days))
    && Number.isSafeInteger(retentionMs)
    && retentionMs >= limits.retentionMs.minimum && retentionMs <= limits.retentionMs.maximum
    && Number.isSafeInteger(operationCount)
    && operationCount >= limits.maxOperations.minimum && operationCount <= limits.maxOperations.maximum
    && Number.isSafeInteger(eventCount)
    && eventCount >= limits.maxEvents.minimum && eventCount <= limits.maxEvents.maximum;
  const changed = retentionMs !== policy.retentionMs
    || operationCount !== policy.maxOperations
    || eventCount !== policy.maxEvents;
  const change = (setter: (value: string) => void) => (value: string) => {
    setter(value);
    setConfirming(false);
  };
  const submit = async () => {
    if (!valid || !changed || busy) return;
    if (!confirming) {
      setConfirming(true);
      return;
    }
    const saved = await onUpdate({
      ...policy,
      retentionMs,
      maxOperations: operationCount,
      maxEvents: eventCount,
    });
    if (saved) onClose();
  };
  return (
    <section className="retention-policy-editor" aria-labelledby="retention-policy-title">
      <div>
        <strong id="retention-policy-title">Companion 기록 보존</strong>
        <button type="button" disabled={busy} onClick={onClose}>닫기</button>
      </div>
      <div className="retention-policy-fields">
        <label>
          <span>기간 (일)</span>
          <input
            type="number"
            inputMode="numeric"
            min={limits.retentionMs.minimum / dayMs}
            max={limits.retentionMs.maximum / dayMs}
            value={days}
            disabled={busy}
            onChange={(event) => change(setDays)(event.target.value)}
          />
        </label>
        <label>
          <span>작업 수</span>
          <input
            type="number"
            inputMode="numeric"
            min={limits.maxOperations.minimum}
            max={limits.maxOperations.maximum}
            value={maxOperations}
            disabled={busy}
            onChange={(event) => change(setMaxOperations)(event.target.value)}
          />
        </label>
        <label>
          <span>이벤트 수</span>
          <input
            type="number"
            inputMode="numeric"
            min={limits.maxEvents.minimum}
            max={limits.maxEvents.maximum}
            value={maxEvents}
            disabled={busy}
            onChange={(event) => change(setMaxEvents)(event.target.value)}
          />
        </label>
      </div>
      <small>
        범위: {limits.retentionMs.minimum / dayMs}–{limits.retentionMs.maximum / dayMs}일 · 작업 {limits.maxOperations.minimum.toLocaleString()}–{limits.maxOperations.maximum.toLocaleString()} · 이벤트 {limits.maxEvents.minimum.toLocaleString()}–{limits.maxEvents.maximum.toLocaleString()}
      </small>
      <p>저장하면 한도를 넘은 오래된 종료·실패·중단·상태 미상 기록이 즉시 삭제됩니다. 실행 중 작업은 유지되지만 고정·보관 기록도 예외가 아닙니다. 필요한 프로젝트 기록은 먼저 JSON으로 내보내세요.</p>
      {confirming && <strong className="retention-confirm">이 변경으로 삭제되는 기록은 복구할 수 없습니다. 다시 눌러 적용하세요.</strong>}
      <button
        type="button"
        className={confirming ? "confirm-retention" : undefined}
        disabled={busy || !valid || !changed}
        onClick={() => void submit()}
      >{busy ? "적용 중…" : confirming ? "확인하고 보존 정책 적용" : "보존 정책 검토"}</button>
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
  updatingOperationId,
  onOpenOperation,
  onUpdateOperation,
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
  updatingOperationId: string | null;
  onOpenOperation(operation: Operation): void;
  onUpdateOperation(operation: Operation, patch: OperationMetadataPatch): Promise<boolean>;
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
            busy={updatingOperationId === operation.id}
            onOpen={onOpenOperation}
            onUpdate={onUpdateOperation}
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
  busy,
  onOpen,
  onUpdate,
}: {
  operation: Operation;
  identity: WorkspaceIdentity | undefined;
  waiting: boolean;
  now: number;
  busy: boolean;
  onOpen(operation: Operation): void;
  onUpdate(operation: Operation, patch: OperationMetadataPatch): Promise<boolean>;
}) {
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(operation.goalName ?? "");
  useEffect(() => {
    if (!editingName) setNameDraft(operation.goalName ?? "");
  }, [editingName, operation.goalName]);
  const usage = operation.result?.usage;
  const model = operation.model || stringResult(operation.result, "model") || "기본 모델";
  const routedProvider = operation.result?.routing?.actualUpstream
    ? `${operation.result.routing.actualUpstream}${operation.result.routing.actualProvider ? ` (${operation.result.routing.actualProvider})` : ""}`
    : operation.result?.routing?.actualProvider ?? operation.result?.routedProvider;
  const modelVerification = operation.result?.modelVerification;
  const status = waiting ? "waiting" : operation.status;
  const archiveBlocked = waiting || operation.status === "running"
    || (operation.status === "unknown" && !operation.acknowledgedAt);
  const saveName = async () => {
    if (await onUpdate(operation, { goalName: nameDraft.trim() || null })) setEditingName(false);
  };
  return (
    <article className={`operation-card status-${status}${operation.archivedAt ? " archived" : ""}`}>
      <div className="operation-card-head">
        <span>{operation.pinnedAt ? "고정 · " : ""}{statusLabel(status, operation.acknowledgedAt)}</span>
        <small>{elapsed(operation, now)}</small>
      </div>
      <strong>{short(operation.goalName ?? operation.prompt, 100)}</strong>
      {operation.goalName && <small className="operation-prompt">{short(operation.prompt, 140)}</small>}
      <div className="operation-facts">
        <span>{operation.providerId ?? "codex"}</span>
        <span>{model}</span>
        {routedProvider && <span>실제 {routedProvider}</span>}
        {operation.routing?.allowFallbacks && <span>승인 fallback {operation.routing.upstreams.length}개</span>}
        {modelVerification && <span>{operationVerificationLabel(modelVerification)}</span>}
        <span>{workspaceIdentityLabel(identity)}</span>
        {usage?.totalTokens !== undefined && <span>{usage.totalTokens.toLocaleString()} tokens</span>}
        {usage?.costCredits !== undefined && <span>{usage.costCredits.toFixed(6)} credits</span>}
      </div>
      {editingName && (
        <form className="operation-name-editor" onSubmit={(event) => { event.preventDefault(); void saveName(); }}>
          <label htmlFor={`goal-name-${operation.id}`}>목표 이름</label>
          <input
            id={`goal-name-${operation.id}`}
            value={nameDraft}
            maxLength={120}
            autoFocus
            placeholder="이 작업의 이름"
            disabled={busy}
            onChange={(event) => setNameDraft(event.target.value)}
          />
          <div>
            <button type="button" disabled={busy} onClick={() => setEditingName(false)}>취소</button>
            <button type="submit" disabled={busy}>{busy ? "저장 중…" : "저장"}</button>
          </div>
        </form>
      )}
      <div className="operation-card-actions">
        <button type="button" disabled={busy} onClick={() => onOpen(operation)}>열기</button>
        <button type="button" disabled={busy} onClick={() => setEditingName((current) => !current)}>이름</button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void onUpdate(operation, { pinned: !operation.pinnedAt })}
        >{operation.pinnedAt ? "고정 해제" : "고정"}</button>
        <button
          type="button"
          disabled={busy || archiveBlocked}
          title={archiveBlocked ? "실행·승인·확인 필요 작업은 보관할 수 없습니다." : undefined}
          onClick={() => void onUpdate(operation, { archived: !operation.archivedAt })}
        >{operation.archivedAt ? "복원" : "보관"}</button>
      </div>
    </article>
  );
}

function operationVerificationLabel(verification: ProviderModelVerification): string {
  if (verification.coding === "pass" && verification.projectRead === "pass") return "코딩 eval 통과";
  if (verification.projectRead === "pass") return "읽기 eval 통과";
  if (verification.projectRead === "expired" || verification.coding === "expired") return "eval 만료 · 도구 차단";
  if (verification.projectRead === "invalid" || verification.coding === "invalid") return "eval 오류 · 도구 차단";
  if (verification.projectRead === "fail" || verification.coding === "fail") return "eval 미통과 · 도구 차단";
  return "project eval 미실행 · chat-only";
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
