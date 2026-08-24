import { useEffect, useMemo, useState } from "react";
import {
  activeApprovals,
  dashboardOperations,
  groupOperations,
  operationCounts,
  type OperationGroup,
} from "./operations-state";
import { workspaceIdentityFor, workspaceIdentityLabel } from "./workspace-identity";
import type { FleetDeviceSnapshot } from "./fleet-state";
import {
  buildApprovalFeedback,
  MAX_APPROVAL_FEEDBACK_COMMENT_LENGTH,
  MAX_APPROVAL_FEEDBACK_LINES,
  parseDiffReview,
  type DiffReviewLine,
} from "./diff-review";
import type {
  ApprovalFeedback,
  ApprovalItem,
  JournalPolicy,
  JournalPolicyLimits,
  Operation,
  OperationMetadataPatch,
  ProviderModelVerification,
  RunPolicyConfig,
  RunPolicyConfigLimits,
  Workspace,
  WorkspaceChangeRecoveryStatus,
  WorkspaceIdentity,
} from "./types";

interface OperationsDashboardProps {
  deviceId: string;
  deviceName: string;
  fleetSnapshots: FleetDeviceSnapshot[];
  refreshingFleet: boolean;
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
  runPolicy: RunPolicyConfig | null;
  runPolicyLimits: RunPolicyConfigLimits | null;
  updatingRunPolicy: boolean;
  exportingWorkspace: string | null;
  deletingWorkspace: string | null;
  updatingOperationId: string | null;
  onClose(): void;
  onRefresh(): void;
  onOpenFleetDevice(deviceId: string): void;
  onRetryWorkspaceRecovery(): Promise<boolean>;
  onOpenOperation(operation: Operation): void;
  onUpdateOperation(operation: Operation, patch: OperationMetadataPatch): Promise<boolean>;
  onUpdateJournalPolicy(policy: JournalPolicy): Promise<boolean>;
  onUpdateRunPolicy(policy: RunPolicyConfig): Promise<boolean>;
  onDecision(approval: ApprovalItem, decision: "approved" | "declined", feedback?: ApprovalFeedback): void;
  onExportWorkspace(workspace: string): Promise<void>;
  onDeleteWorkspaceHistory(workspace: string): Promise<void>;
}

export function OperationsDashboard(props: OperationsDashboardProps) {
  const [now, setNow] = useState(Date.now());
  const [confirmingWorkspace, setConfirmingWorkspace] = useState<string | null>(null);
  const [confirmingRecovery, setConfirmingRecovery] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [showPolicyEditor, setShowPolicyEditor] = useState(false);
  const [showRunPolicyEditor, setShowRunPolicyEditor] = useState(false);
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
            <small>{props.deviceName} 선택됨 · {props.fleetSnapshots.length}대 요약</small>
          </div>
          <button type="button" disabled={props.refreshingFleet} onClick={props.onRefresh} aria-label="모든 PC 작업 새로고침">↻</button>
          <button type="button" onClick={props.onClose} aria-label="작업 대시보드 닫기">×</button>
        </header>

        <FleetOverview
          snapshots={props.fleetSnapshots}
          activeDeviceId={props.deviceId}
          refreshing={props.refreshingFleet}
          onOpen={props.onOpenFleetDevice}
        />

        <div className="dashboard-section-title selected-companion-title">
          <strong>{props.deviceName}</strong>
          <span>상세 작업·승인·정책 변경은 이 PC에만 적용됩니다.</span>
        </div>
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

        {props.runPolicy && props.runPolicyLimits && (
          <section className={`run-policy-dashboard${props.runPolicy.emergencyStop ? " stopped" : ""}`} aria-labelledby="run-policy-dashboard-title">
            <div className="dashboard-section-title">
              <div>
                <strong id="run-policy-dashboard-title">API 비용·token 보호</strong>
                <span>{props.runPolicy.emergencyStop ? "OpenAI·OpenRouter 긴급 중단 중" : "OpenAI·OpenRouter 실행 전 Companion이 검사"}</span>
              </div>
              <button type="button" aria-expanded={showRunPolicyEditor} onClick={() => setShowRunPolicyEditor((current) => !current)}>
                정책 설정
              </button>
            </div>
            <div className="run-policy-summary">
              <span>출력 {props.runPolicy.maxOutputTokens.toLocaleString()}</span>
              <span>합계 {props.runPolicy.maxTotalTokens.toLocaleString()} tokens</span>
              <span>run hard cap {formatUsdMicros(props.runPolicy.maxRunCostMicrosUsd)}</span>
              <span>월 soft limit {formatUsdMicros(props.runPolicy.monthlyCostSoftLimitMicrosUsd)}</span>
            </div>
            {showRunPolicyEditor && (
              <RunPolicyEditor
                policy={props.runPolicy}
                limits={props.runPolicyLimits}
                busy={props.updatingRunPolicy}
                onClose={() => setShowRunPolicyEditor(false)}
                onUpdate={props.onUpdateRunPolicy}
              />
            )}
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

function FleetOverview({
  snapshots,
  activeDeviceId,
  refreshing,
  onOpen,
}: {
  snapshots: FleetDeviceSnapshot[];
  activeDeviceId: string;
  refreshing: boolean;
  onOpen(deviceId: string): void;
}) {
  return (
    <section className="fleet-overview" aria-labelledby="fleet-overview-title">
      <div className="dashboard-section-title">
        <div>
          <strong id="fleet-overview-title">Linux Companion Fleet</strong>
          <span>모든 등록 PC를 읽기 전용으로 확인합니다. 승인·수정은 PC를 연 뒤 수행합니다.</span>
        </div>
        {refreshing && <small role="status">확인 중…</small>}
      </div>
      {snapshots.length === 0 ? (
        <p className="dashboard-empty">등록 PC 요약을 불러오는 중입니다.</p>
      ) : (
        <div className="fleet-device-grid">
          {snapshots.map((snapshot) => {
            const active = snapshot.deviceId === activeDeviceId;
            return (
              <article
                key={snapshot.deviceId}
                className={`fleet-device status-${snapshot.status}${active ? " active" : ""}`}
              >
                <header>
                  <div>
                    <strong>{snapshot.name}</strong>
                    <small>{active ? "현재 선택 · " : ""}{fleetStatusLabel(snapshot.status)}</small>
                  </div>
                  <span className={`fleet-status-dot ${snapshot.status}`} aria-hidden="true" />
                </header>
                {snapshot.status === "online" ? (
                  <div className="fleet-device-facts">
                    <span>실행 {snapshot.running}</span>
                    <span>승인 {snapshot.waitingForApproval}</span>
                    <span>확인 {snapshot.unknown}</span>
                    <span>실패 {snapshot.failed}</span>
                    {snapshot.recoveryBlocked && <span className="warning">복구 필요</span>}
                    <span>기록 {snapshot.retainedOperations}</span>
                  </div>
                ) : (
                  <p>{fleetStatusHelp(snapshot.status)}</p>
                )}
                {!active && (
                  <button type="button" onClick={() => onOpen(snapshot.deviceId)}>
                    이 PC 작업 열기
                  </button>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function fleetStatusLabel(status: FleetDeviceSnapshot["status"]): string {
  if (status === "online") return "온라인";
  if (status === "pairing-required") return "페어링 필요";
  if (status === "identity-review-required") return "단말 key 확인 필요";
  if (status === "unsupported") return "Fleet API 미지원";
  return "연결 안 됨";
}

function fleetStatusHelp(status: FleetDeviceSnapshot["status"]): string {
  if (status === "pairing-required") return "이 PC를 열어 페어링을 완료해야 작업을 볼 수 있습니다.";
  if (status === "identity-review-required") return "이 PC를 열어 PocketLink 단말 key 교체를 검토하세요.";
  if (status === "unsupported") return "이 Companion은 Fleet 요약을 지원하지 않습니다. 기존 Codex 경로는 PC를 열어 사용하세요.";
  return "다른 PC로 자동 우회하지 않습니다. 터널·Companion 상태를 확인하세요.";
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

function RunPolicyEditor({
  policy,
  limits,
  busy,
  onClose,
  onUpdate,
}: {
  policy: RunPolicyConfig;
  limits: RunPolicyConfigLimits;
  busy: boolean;
  onClose(): void;
  onUpdate(policy: RunPolicyConfig): Promise<boolean>;
}) {
  const [emergencyStop, setEmergencyStop] = useState(policy.emergencyStop);
  const [maxOutputTokens, setMaxOutputTokens] = useState(String(policy.maxOutputTokens));
  const [maxTotalTokens, setMaxTotalTokens] = useState(String(policy.maxTotalTokens));
  const [maxRunUsd, setMaxRunUsd] = useState(String(policy.maxRunCostMicrosUsd / 1_000_000));
  const [dailyTokenWarning, setDailyTokenWarning] = useState(String(policy.dailyTokenWarning));
  const [monthlyUsd, setMonthlyUsd] = useState(String(policy.monthlyCostSoftLimitMicrosUsd / 1_000_000));
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    setEmergencyStop(policy.emergencyStop);
    setMaxOutputTokens(String(policy.maxOutputTokens));
    setMaxTotalTokens(String(policy.maxTotalTokens));
    setMaxRunUsd(String(policy.maxRunCostMicrosUsd / 1_000_000));
    setDailyTokenWarning(String(policy.dailyTokenWarning));
    setMonthlyUsd(String(policy.monthlyCostSoftLimitMicrosUsd / 1_000_000));
    setConfirming(false);
  }, [policy]);
  const next = {
    emergencyStop,
    maxOutputTokens: Number(maxOutputTokens),
    maxTotalTokens: Number(maxTotalTokens),
    maxRunCostMicrosUsd: Math.round(Number(maxRunUsd) * 1_000_000),
    dailyTokenWarning: Number(dailyTokenWarning),
    monthlyCostSoftLimitMicrosUsd: Math.round(Number(monthlyUsd) * 1_000_000),
  };
  const valid = bounded(next.maxOutputTokens, limits.maxOutputTokens)
    && bounded(next.maxTotalTokens, limits.maxTotalTokens)
    && next.maxTotalTokens >= next.maxOutputTokens
    && bounded(next.maxRunCostMicrosUsd, limits.maxRunCostMicrosUsd)
    && bounded(next.dailyTokenWarning, limits.dailyTokenWarning)
    && bounded(next.monthlyCostSoftLimitMicrosUsd, limits.monthlyCostSoftLimitMicrosUsd);
  const changed = Object.keys(next).some((key) => (
    next[key as keyof RunPolicyConfig] !== policy[key as keyof RunPolicyConfig]
  ));
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
    const saved = await onUpdate(next);
    if (saved) onClose();
  };
  return (
    <section className="run-policy-editor" aria-labelledby="run-policy-editor-title">
      <div>
        <strong id="run-policy-editor-title">서버 강제 실행 정책</strong>
        <button type="button" disabled={busy} onClick={onClose}>닫기</button>
      </div>
      <label className={`run-policy-stop${emergencyStop ? " active" : ""}`}>
        <input
          type="checkbox"
          checked={emergencyStop}
          disabled={busy}
          onChange={(event) => { setEmergencyStop(event.target.checked); setConfirming(false); }}
        />
        <span>API 실행 긴급 중단</span>
        <small>OpenAI·OpenRouter만 차단합니다. Codex와 실행 중 작업은 중단하지 않습니다.</small>
      </label>
      <div className="run-policy-fields">
        <PolicyNumber label="출력 token hard limit" value={maxOutputTokens} limits={limits.maxOutputTokens} busy={busy} onChange={change(setMaxOutputTokens)} />
        <PolicyNumber label="run 합계 token hard limit" value={maxTotalTokens} limits={limits.maxTotalTokens} busy={busy} onChange={change(setMaxTotalTokens)} />
        <PolicyNumber label="24시간 token 경고" value={dailyTokenWarning} limits={limits.dailyTokenWarning} busy={busy} onChange={change(setDailyTokenWarning)} />
        <PolicyNumber label="run 비용 hard cap · USD" value={maxRunUsd} limits={{ minimum: limits.maxRunCostMicrosUsd.minimum / 1_000_000, maximum: limits.maxRunCostMicrosUsd.maximum / 1_000_000 }} busy={busy} step="0.01" onChange={change(setMaxRunUsd)} />
        <PolicyNumber label="월 비용 soft limit · USD" value={monthlyUsd} limits={{ minimum: limits.monthlyCostSoftLimitMicrosUsd.minimum / 1_000_000, maximum: limits.monthlyCostSoftLimitMicrosUsd.maximum / 1_000_000 }} busy={busy} step="0.01" onChange={change(setMonthlyUsd)} />
      </div>
      <p>가격이 확인된 모델은 가장 비싼 승인 route 기준 상한을 검사합니다. 가격이 없으면 추측하지 않고 ‘가격 확인 필요’로 표시합니다.</p>
      {confirming && <strong className="run-policy-confirm">이 설정은 다음 API 실행부터 서버에서 강제됩니다. 다시 눌러 적용하세요.</strong>}
      <button
        type="button"
        className={confirming ? "confirm-run-policy" : undefined}
        disabled={busy || !valid || !changed}
        onClick={() => void submit()}
      >{busy ? "적용 중…" : confirming ? "확인하고 API 정책 적용" : "API 정책 검토"}</button>
    </section>
  );
}

function PolicyNumber({
  label,
  value,
  limits,
  busy,
  step = "1",
  onChange,
}: {
  label: string;
  value: string;
  limits: { minimum: number; maximum: number };
  busy: boolean;
  step?: string;
  onChange(value: string): void;
}) {
  return (
    <label>
      <span>{label}</span>
      <input
        type="number"
        inputMode="decimal"
        min={limits.minimum}
        max={limits.maximum}
        step={step}
        value={value}
        disabled={busy}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
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
  onDecision(approval: ApprovalItem, decision: "approved" | "declined", feedback?: ApprovalFeedback): void;
}) {
  const [selectedLines, setSelectedLines] = useState<string[]>([]);
  const [comments, setComments] = useState<Record<string, string>>({});
  const seconds = Math.max(0, Math.ceil((Date.parse(approval.expiresAt) - now) / 1_000));
  const diff = typeof approval.redactedDetails?.diff === "string" ? approval.redactedDetails.diff : "";
  const review = useMemo(() => diff ? parseDiffReview(diff) : null, [diff]);
  const details = approval.redactedDetails ? safeNonDiffDetails(approval.redactedDetails) : "";
  const feedback = review ? buildApprovalFeedback(review.lines, comments) : undefined;
  const feedbackReady = selectedLines.length === 0 || feedback?.lines.length === selectedLines.length;
  const feedbackUnavailable = selectedLines.length > 0
    && selectedLines.every((lineId) => (comments[lineId]?.trim().length ?? 0) > 0)
    && !feedback;
  const toggleLine = (line: DiffReviewLine) => {
    if (!line.selectable || busy) return;
    if (selectedLines.includes(line.id)) {
      setSelectedLines((current) => current.filter((id) => id !== line.id));
      setComments((current) => {
        const next = { ...current };
        delete next[line.id];
        return next;
      });
      return;
    }
    if (selectedLines.length < MAX_APPROVAL_FEEDBACK_LINES) {
      setSelectedLines((current) => [...current, line.id]);
    }
  };
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
      {details && <pre className="approval-details">{details}</pre>}
      {review && (
        <ApprovalDiffReview
          review={review}
          selectedLines={selectedLines}
          comments={comments}
          busy={busy}
          onToggle={toggleLine}
          onComment={(lineId, comment) => setComments((current) => ({ ...current, [lineId]: comment }))}
        />
      )}
      {feedbackUnavailable && (
        <small className="approval-feedback-error" role="alert">
          의견 형식이나 전체 크기를 안전하게 전송할 수 없습니다. 내용을 줄이거나 선택 줄을 해제해 주세요.
        </small>
      )}
      <div className="approval-actions">
        <button
          type="button"
          className="decline"
          disabled={busy || !feedbackReady}
          title={!feedbackReady
            ? feedbackUnavailable
              ? "의견 형식이나 전체 크기를 수정하거나 선택 줄을 해제해 주세요."
              : "선택한 각 줄에 피드백을 입력하거나 선택을 해제해 주세요."
            : undefined}
          onClick={() => onDecision(approval, "declined", feedback)}
        >{feedback ? "거절하고 피드백 전송" : "거절"}</button>
        <button
          type="button"
          className="approve"
          disabled={busy || selectedLines.length > 0}
          title={selectedLines.length > 0 ? "줄 피드백 선택을 해제한 뒤 승인할 수 있습니다." : undefined}
          onClick={() => onDecision(approval, "approved")}
        >
          {busy ? "처리 중…" : approval.requiresTouch ? "검토 후 터치 승인" : "승인"}
        </button>
      </div>
    </article>
  );
}

function ApprovalDiffReview({
  review,
  selectedLines,
  comments,
  busy,
  onToggle,
  onComment,
}: {
  review: ReturnType<typeof parseDiffReview>;
  selectedLines: string[];
  comments: Record<string, string>;
  busy: boolean;
  onToggle(line: DiffReviewLine): void;
  onComment(lineId: string, comment: string): void;
}) {
  return (
    <section className="approval-diff-review" aria-label="줄 단위 변경 diff 검토">
      <header>
        <div>
          <strong>변경 diff</strong>
          <small>추가·삭제 줄을 눌러 최대 {MAX_APPROVAL_FEEDBACK_LINES}개의 수정 의견을 같은 run에 돌려보낼 수 있습니다.</small>
        </div>
        <span>{review.changedLines}줄{review.truncated ? " · 표시 제한" : ""}</span>
      </header>
      <ol className="approval-diff-lines">
        {review.lines.map((line) => {
          const selected = selectedLines.includes(line.id);
          const location = line.oldLine === undefined
            ? `새 ${line.newLine ?? ""}`
            : line.newLine === undefined ? `이전 ${line.oldLine}` : `이전 ${line.oldLine} · 새 ${line.newLine}`;
          return (
            <li className={`diff-${line.kind}${selected ? " selected" : ""}`} key={line.id}>
              {line.selectable ? (
                <button
                  type="button"
                  aria-pressed={selected}
                  aria-label={`${line.path} ${location}줄 피드백 ${selected ? "해제" : "선택"}`}
                  disabled={busy || (!selected && selectedLines.length >= MAX_APPROVAL_FEEDBACK_LINES)}
                  onClick={() => onToggle(line)}
                >
                  <DiffLineNumbers line={line} />
                  <code><b aria-hidden="true">{line.prefix}</b>{line.content}</code>
                </button>
              ) : (
                <div>
                  <DiffLineNumbers line={line} />
                  <code><b aria-hidden="true">{line.prefix}</b>{line.content}</code>
                </div>
              )}
              {selected && (
                <label>
                  <span>{line.path} · {location}줄 수정 의견</span>
                  <textarea
                    rows={2}
                    maxLength={MAX_APPROVAL_FEEDBACK_COMMENT_LENGTH}
                    disabled={busy}
                    value={comments[line.id] ?? ""}
                    placeholder="예: null일 때 기존 값을 유지해 주세요."
                    aria-label={`${line.path} ${location}줄에 보낼 피드백`}
                    onChange={(event) => onComment(line.id, event.target.value)}
                  />
                  <small>{(comments[line.id] ?? "").length}/{MAX_APPROVAL_FEEDBACK_COMMENT_LENGTH} · Provider에 전송됩니다. 비밀정보는 입력하지 마세요.</small>
                </label>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function DiffLineNumbers({ line }: { line: DiffReviewLine }) {
  return (
    <span className="approval-diff-numbers" aria-hidden="true">
      <i>{line.oldLine ?? ""}</i><i>{line.newLine ?? ""}</i>
    </span>
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
  const policyUsage = operation.result?.policyUsage;
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
      {(operation.steers?.length ?? 0) > 0 && (
        <small className="operation-steer">
          ↪ 방향 수정 {operation.steers!.length}회 · {short(operation.steers!.at(-1)?.prompt ?? "", 120)}
        </small>
      )}
      <div className="operation-facts">
        <span>{operation.providerId ?? "codex"}</span>
        <span>{model}</span>
        {operation.fork && (
          <span>
            Fork {operation.fork.sourceProviderId} → {operation.fork.targetProviderId}
            {operation.fork.truncated ? " · 일부 전송" : " · 검토 범위 전송"}
            {` · 약 ${operation.fork.estimatedInputTokens.toLocaleString()} tokens`}
          </span>
        )}
        {routedProvider && <span>실제 {routedProvider}</span>}
        {operation.routing?.allowFallbacks && <span>승인 fallback {operation.routing.upstreams.length}개</span>}
        {modelVerification && <span>{operationVerificationLabel(modelVerification)}</span>}
        {operation.runPolicy && <span>{privacyProfileLabel(operation.runPolicy.privacyProfile)}</span>}
        {operation.runPolicy?.limits && (
          <span>상한 {operation.runPolicy.limits.maxTotalTokens.toLocaleString()} tokens · {formatUsdMicros(operation.runPolicy.limits.maxRunCostMicrosUsd)}</span>
        )}
        {operation.runPolicy?.pricing.status === "unknown" && <span>가격 확인 필요</span>}
        <span>{workspaceIdentityLabel(identity)}</span>
        {usage?.totalTokens !== undefined && <span>{usage.totalTokens.toLocaleString()} tokens</span>}
        {usage?.costCredits !== undefined && <span>{usage.costCredits.toFixed(6)} credits</span>}
        {policyUsage?.costMicrosUsd !== undefined && (
          <span>{policyUsage.status === "provider-reported" ? "Provider 비용" : "catalog 추정"} {formatUsdMicros(policyUsage.costMicrosUsd)}</span>
        )}
        {policyUsage?.status === "unknown" && <span>실제 비용 확인 필요</span>}
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

function privacyProfileLabel(profile: NonNullable<Operation["runPolicy"]>["privacyProfile"]): string {
  if (profile === "openai-store-false") return "OpenAI store:false";
  if (profile === "openrouter-strict-zdr") return "OpenRouter strict ZDR";
  if (profile === "codex-managed") return "Codex 관리 연결";
  return "Provider privacy 확인";
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

function safeNonDiffDetails(details: Record<string, unknown>): string {
  try {
    const metadata = Object.fromEntries(Object.entries(details).filter(([key]) => key !== "diff" && key !== "script"));
    const script = details.script;
    return [
      Object.keys(metadata).length > 0 ? JSON.stringify(metadata, null, 2) : "",
      typeof script === "string" ? `script:\n${script}` : "",
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

function bounded(value: number, limits: { minimum: number; maximum: number }): boolean {
  return Number.isSafeInteger(value) && value >= limits.minimum && value <= limits.maximum;
}

function formatUsdMicros(value: number): string {
  return `$${(value / 1_000_000).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;
}

function deletionProtected(group: OperationGroup): boolean {
  return group.approvals.length > 0 || group.operations.some((operation) =>
    operation.status === "running" || (operation.status === "unknown" && !operation.acknowledgedAt));
}
