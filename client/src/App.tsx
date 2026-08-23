import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  abortActiveDeviceIdentityRotation,
  api,
  apiBlob,
  activeDeviceTarget,
  addLinuxDevice,
  ApiError,
  beginActiveDeviceIdentityRotation,
  clearActiveDeviceIdentityRotation,
  completeActiveDeviceIdentityRotation,
  deviceTargetLabel,
  finalizeActiveDeviceIdentityRotation,
  inspectActiveDeviceIdentityRotation,
  listDeviceTargets,
  loadActiveDeviceIdentityRotation,
  pairActiveDevice,
  pairingStatus,
  PairingRequiredError,
  PocketLinkIdentityRotationRequiredError,
  removeDeviceTarget,
  setApiDevice,
  subscribeEvents,
  uploadMedia,
  type PairingStatus,
} from "./api";
import {
  isNativeApp,
  NativeSpeech,
  NativeTunnel,
  type NativeSpeechError,
  type NativeSpeechResult,
  type NativeSpeechState,
  type PocketLinkStatus,
} from "./native";
import { mergeSpeechSegments } from "./speech-utils";
import { OperationsDashboard } from "./OperationsDashboard";
import { activeApprovals, applyApprovalEvent, upsertOperation } from "./operations-state";
import { operationBelongsToSession, scopedHandoff } from "./session-scope";
import { workspaceIdentityFor, workspaceIdentityLabel } from "./workspace-identity";
import { createWorkJournal } from "./work-journal";
import { conversationKey, restoredMessages, serializableQueue } from "./work-journal-model";
import { initialSpeechLanguage, initialUiLanguage, translate, type MessageKey, type UiLanguage } from "./i18n";
import { parsePocketLinkBootstrapUri } from "../../src/pocket-link-bootstrap";
import {
  evaluatePocketLinkBootstrap,
  matchesPocketLinkConnection,
  type PendingPocketLinkBootstrap,
} from "./pocket-link-pairing";
import {
  isRecentBackupPinObservation,
  pocketLinkSecurityStatus,
  POCKET_LINK_PIN_PROMOTION_MAX_AGE_MS,
} from "./pocket-link-rotation";
import {
  abortPocketLinkIdentityRotationFlow,
  finishPocketLinkIdentityRotationFlow,
  type PocketLinkIdentityRotationPorts,
} from "./pocket-link-identity-rotation";
import type {
  ChatMessage,
  ApprovalItem,
  ApprovalResolution,
  CodexEvent,
  ConnectionStatus,
  DeviceId,
  DeviceTarget,
  HistoryItem,
  JournalPolicy,
  Operation,
  MediaItem,
  ModelOption,
  ModelResponse,
  PendingAttachment,
  ProviderId,
  ProviderConnectionTest,
  ProviderLoginSession,
  ProviderOption,
  ProviderResponse,
  QueuedPrompt,
  RunResult,
  SessionHandoff,
  SystemDiagnostics,
  ThreadDetail,
  ThreadSummary,
  Workspace,
  WorkspaceResponse,
} from "./types";

interface SpeechRecognitionEventLike {
  results: {
    length: number;
    [index: number]: { [index: number]: { transcript?: string } | undefined };
  };
}

interface SpeechRecognitionErrorLike {
  error: string;
}

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onstart: (() => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorLike) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

interface SpeechRecognitionConstructor {
  new(): SpeechRecognitionLike;
}

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
}

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

interface ActivityState {
  running: boolean;
  text: string;
  detail: string;
}

let localId = 0;
const newId = (prefix: string) => `${prefix}-${Date.now()}-${localId++}`;

export function App() {
  const [device, setDevice] = useState<DeviceId>(() => activeDeviceTarget().id);
  const [deviceTargets, setDeviceTargets] = useState<DeviceTarget[]>(listDeviceTargets);
  const [connection, setConnection] = useState<ConnectionStatus>("pending");
  const [connectionText, setConnectionText] = useState("PC에 연결 중…");
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [workspace, setWorkspace] = useState("");
  const [threadId, setThreadId] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [prompt, setPrompt] = useState("");
  const [operation, setOperation] = useState<Operation | null>(null);
  const [activity, setActivity] = useState<ActivityState>({ running: false, text: "", detail: "" });
  const [tts, setTts] = useState(() => localStorage.getItem("codex-pocket-tts") === "true");
  const [networkAccess, setNetworkAccess] = useState(false);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [providers, setProviders] = useState<ProviderOption[]>([]);
  const [provider, setProvider] = useState<ProviderId>("codex");
  const [accountId, setAccountId] = useState("cli-default");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [dictating, setDictating] = useState(false);
  const [handsFree, setHandsFree] = useState(false);
  const [controlsCollapsed, setControlsCollapsed] = useState(
    () => localStorage.getItem("codex-pocket-controls-open") !== "true",
  );
  const [speechSupported, setSpeechSupported] = useState(true);
  const [toast, setToast] = useState("");
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [mediaBusy, setMediaBusy] = useState(false);
  const [creationLocations, setCreationLocations] = useState<Workspace[]>([]);
  const [showProjectCreator, setShowProjectCreator] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectParent, setNewProjectParent] = useState("");
  const [creatingProject, setCreatingProject] = useState(false);
  const [projectCreatorError, setProjectCreatorError] = useState("");
  const [promptQueue, setPromptQueue] = useState<QueuedPrompt[]>([]);
  const [showConnectionCenter, setShowConnectionCenter] = useState(false);
  const [testingProvider, setTestingProvider] = useState<ProviderId | null>(null);
  const [connectionTest, setConnectionTest] = useState<Partial<Record<ProviderId, ProviderConnectionTest>>>({});
  const [loginSession, setLoginSession] = useState<ProviderLoginSession | null>(null);
  const [providerAliases, setProviderAliases] = useState<Partial<Record<ProviderId, string>>>({});
  const [journalRestored, setJournalRestored] = useState(false);
  const [pairing, setPairing] = useState<PairingStatus | null>(null);
  const [pairingCode, setPairingCode] = useState("");
  const [pairingBusy, setPairingBusy] = useState(false);
  const [authRevision, setAuthRevision] = useState(0);
  const [showDeviceCreator, setShowDeviceCreator] = useState(false);
  const [newDeviceName, setNewDeviceName] = useState("");
  const [newDevicePort, setNewDevicePort] = useState("8790");
  const [newDeviceTransport, setNewDeviceTransport] = useState<"termux" | "pocketlink">("termux");
  const [newPocketLinkHost, setNewPocketLinkHost] = useState("");
  const [newPocketLinkPort, setNewPocketLinkPort] = useState("8789");
  const [newPocketLinkPin, setNewPocketLinkPin] = useState("");
  const [newPocketLinkBackupPin, setNewPocketLinkBackupPin] = useState("");
  const [scanningPocketLinkQr, setScanningPocketLinkQr] = useState(false);
  const [pendingPocketLinkBootstrap, setPendingPocketLinkBootstrap] = useState<PendingPocketLinkBootstrap | null>(null);
  const [pocketLinkStatuses, setPocketLinkStatuses] = useState<Partial<Record<DeviceId, PocketLinkStatus>>>({});
  const [pocketLinkStatusRevision, setPocketLinkStatusRevision] = useState(0);
  const [stagingPinTarget, setStagingPinTarget] = useState<DeviceId | null>(null);
  const [stagedBackupPin, setStagedBackupPin] = useState("");
  const [stagingPinBusy, setStagingPinBusy] = useState(false);
  const [confirmingPinPromotionTarget, setConfirmingPinPromotionTarget] = useState<DeviceId | null>(null);
  const [promotingPinTarget, setPromotingPinTarget] = useState<DeviceId | null>(null);
  const [reviewingIdentityRotationTarget, setReviewingIdentityRotationTarget] = useState<DeviceId | null>(null);
  const [rotatingIdentityTarget, setRotatingIdentityTarget] = useState<DeviceId | null>(null);
  const [uiLanguage, setUiLanguage] = useState<UiLanguage>(initialUiLanguage);
  const [speechLanguage, setSpeechLanguage] = useState(initialSpeechLanguage);
  const [diagnostics, setDiagnostics] = useState<SystemDiagnostics | null>(null);
  const [handoff, setHandoff] = useState<SessionHandoff | null>(null);
  const [showHandoffDialog, setShowHandoffDialog] = useState(false);
  const [handoffBusy, setHandoffBusy] = useState(false);
  const [handoffSupported, setHandoffSupported] = useState(false);
  const [operationSnapshots, setOperationSnapshots] = useState<Operation[]>([]);
  const [approvalInbox, setApprovalInbox] = useState<ApprovalItem[]>([]);
  const [showOperationsDashboard, setShowOperationsDashboard] = useState(false);
  const [decidingApprovalId, setDecidingApprovalId] = useState<string | null>(null);
  const [journalPolicy, setJournalPolicy] = useState<JournalPolicy | null>(null);
  const [exportingWorkspace, setExportingWorkspace] = useState<string | null>(null);
  const [deletingWorkspace, setDeletingWorkspace] = useState<string | null>(null);
  const [journal] = useState(createWorkJournal);
  const tr = (key: MessageKey) => translate(uiLanguage, key);
  const selectedWorkspaceIdentity = workspaceIdentityFor(workspaces, workspace);
  const selectedWorkspaceIdentityText = workspaceIdentityLabel(selectedWorkspaceIdentity);

  const transcriptRef = useRef<HTMLElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const operationRef = useRef<Operation | null>(null);
  const promptQueueRef = useRef<QueuedPrompt[]>([]);
  const messagesRef = useRef<ChatMessage[]>([]);
  const journalQueueReadyRef = useRef<DeviceId | null>(null);
  const queueDispatchingRef = useRef(false);
  const workspaceRef = useRef("");
  const deviceRef = useRef<DeviceId>(device);
  const threadRef = useRef("");
  const providerRef = useRef<ProviderId>("codex");
  const ttsRef = useRef(tts);
  const liveMessageIdRef = useRef<string | null>(null);
  const liveTextRef = useRef("");
  const latestDiffRef = useRef("");
  const pollTimerRef = useRef<number | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const dictationBaseRef = useRef("");
  const nativeFinalRef = useRef("");
  const handsFreeRef = useRef(false);
  const speechLanguageRef = useRef(speechLanguage);
  const longPressTimerRef = useRef<number | null>(null);
  const longPressTriggeredRef = useRef(false);
  const voiceWasActiveRef = useRef(false);
  const initializedRef = useRef(false);
  const onboardingShownRef = useRef(false);
  const initializingRef = useRef(false);
  const handleEventRef = useRef<(event: CodexEvent) => void>(() => undefined);
  const initializeRef = useRef<() => Promise<void>>(async () => undefined);
  const replayingEventsRef = useRef(false);

  useEffect(() => { workspaceRef.current = workspace; }, [workspace]);
  useEffect(() => {
    deviceRef.current = device;
    setApiDevice(device);
    localStorage.setItem("codex-pocket-device", device);
  }, [device]);
  useEffect(() => { threadRef.current = threadId; }, [threadId]);
  useEffect(() => { ttsRef.current = tts; localStorage.setItem("codex-pocket-tts", String(tts)); }, [tts]);
  useEffect(() => { operationRef.current = operation; }, [operation]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  useEffect(() => { handsFreeRef.current = handsFree; }, [handsFree]);
  useEffect(() => {
    if (showConnectionCenter && isNativeApp()) void refreshPocketLinkStatuses(deviceTargets);
  }, [showConnectionCenter, deviceTargets]);
  useEffect(() => {
    if (!showConnectionCenter) return;
    const nextExpiration = Object.values(pocketLinkStatuses)
      .flatMap((status) => status?.pinSlot === "backup" && typeof status.pinObservedAt === "number"
        ? [status.pinObservedAt + POCKET_LINK_PIN_PROMOTION_MAX_AGE_MS + 1 - Date.now()]
        : [])
      .filter((delay) => delay > 0)
      .sort((left, right) => left - right)[0];
    if (nextExpiration === undefined) return;
    const timer = window.setTimeout(() => setPocketLinkStatusRevision((current) => current + 1), nextExpiration);
    return () => window.clearTimeout(timer);
  }, [showConnectionCenter, pocketLinkStatuses, pocketLinkStatusRevision]);
  useEffect(() => {
    speechLanguageRef.current = speechLanguage;
    localStorage.setItem("codex-pocket-speech-language", speechLanguage);
  }, [speechLanguage]);
  useEffect(() => { localStorage.setItem("codex-pocket-ui-language", uiLanguage); }, [uiLanguage]);
  useEffect(() => {
    localStorage.setItem("codex-pocket-controls-open", String(!controlsCollapsed));
  }, [controlsCollapsed]);
  useEffect(() => {
    setProviderAliases({
      codex: localStorage.getItem(providerAliasKey(device, "codex")) ?? "",
      claude: localStorage.getItem(providerAliasKey(device, "claude")) ?? "",
    });
    setConnectionTest({});
    setLoginSession(null);
  }, [device]);

  useEffect(() => {
    let disposed = false;
    journalQueueReadyRef.current = null;
    void journal.loadQueue(device).then((record) => {
      if (disposed || deviceRef.current !== device) return;
      const now = Date.now();
      const prompts = serializableQueue(record?.prompts ?? [])
        .filter((prompt) => !prompt.expiresAt || Date.parse(prompt.expiresAt) > now)
        .map((prompt) => ({ ...prompt, requiresConfirmation: true }));
      promptQueueRef.current = prompts;
      setPromptQueue(prompts);
      journalQueueReadyRef.current = device;
    }).catch(() => undefined);
    return () => { disposed = true; };
  }, [device, journal]);

  useEffect(() => {
    if (!workspace) return;
    let disposed = false;
    const expectedKey = conversationKey(device, workspace, threadId);
    void journal.loadConversation(device, workspace, threadId).then((record) => {
      if (disposed || !record || record.key !== expectedKey || messagesRef.current.length > 0) return;
      const restored = restoredMessages(record.messages);
      if (!restored.length) return;
      messagesRef.current = restored;
      setMessages(restored);
      setJournalRestored(true);
    }).catch(() => undefined);
    return () => { disposed = true; };
  }, [device, journal, threadId, workspace]);

  useEffect(() => {
    if (!workspace || messages.length === 0) return;
    const timer = window.setTimeout(() => {
      void journal.saveConversation({
        key: conversationKey(device, workspace, threadId),
        device,
        workspace,
        threadId,
        messages,
        syncState: operation?.status === "running" ? "running" : connection === "online" ? "synced" : "local",
        updatedAt: new Date().toISOString(),
      }).catch(() => undefined);
    }, 120);
    return () => window.clearTimeout(timer);
  }, [connection, device, journal, messages, operation?.status, threadId, workspace]);

  useEffect(() => {
    if (connection !== "online" || operationRef.current || queueDispatchingRef.current || promptQueueRef.current.length === 0
      || promptQueueRef.current[0]?.requiresConfirmation) return;
    const timer = window.setTimeout(() => startNextQueuedPrompt(""), 250);
    return () => window.clearTimeout(timer);
  }, [connection, operation?.id, operation?.status, promptQueue.length]);

  const showToast = useCallback((text: string) => {
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
    setToast(text);
    toastTimerRef.current = window.setTimeout(() => setToast(""), 4_000);
  }, []);

  const requestPairing = useCallback(async () => {
    try {
      setPairing(await pairingStatus());
    } catch (error) {
      showToast(errorMessage(error));
    }
  }, [showToast]);

  useEffect(() => {
    if (!pairing) return;
    const decision = evaluatePocketLinkBootstrap(
      pendingPocketLinkBootstrap,
      device,
      pairing.device.id,
    );
    if (decision.kind === "wait") return;
    if (decision.kind === "expired") {
      setPendingPocketLinkBootstrap(null);
      showToast("PocketLink QR pairing code가 만료되었습니다. 새 QR을 스캔해 주세요.");
      return;
    }
    if (decision.kind === "device_mismatch") {
      setPendingPocketLinkBootstrap(null);
      showToast("스캔한 QR의 Companion과 현재 연결된 Companion이 다릅니다.");
      return;
    }
    setPairingCode(decision.pairingCode);
    setPendingPocketLinkBootstrap(null);
  }, [device, pairing, pendingPocketLinkBootstrap, showToast]);

  useEffect(() => {
    if (!pendingPocketLinkBootstrap) return;
    const remaining = Date.parse(pendingPocketLinkBootstrap.expiresAt) - Date.now();
    if (remaining <= 0) {
      setPendingPocketLinkBootstrap(null);
      return;
    }
    const timer = window.setTimeout(() => setPendingPocketLinkBootstrap(null), remaining);
    return () => window.clearTimeout(timer);
  }, [pendingPocketLinkBootstrap]);

  useEffect(() => {
    if (!loginSession || (loginSession.status !== "starting" && loginSession.status !== "waiting")) return;
    const timer = window.setTimeout(() => {
      void api<{ login: ProviderLoginSession }>(`/api/provider-logins/${encodeURIComponent(loginSession.id)}`)
        .then((data) => {
          setLoginSession(data.login);
          if (data.login.status === "connected") {
            showToast("계정 연결이 완료되었습니다.");
            void refreshProviders();
          }
        })
        .catch((error) => showToast(errorMessage(error)));
    }, 1_200);
    return () => window.clearTimeout(timer);
  }, [loginSession, showToast]);

  const loadThreads = useCallback(async (
    selectedWorkspace: string,
    preserveSelection: boolean,
    preferredThreadId?: string,
  ) => {
    try {
      const data = await api<{ threads: ThreadSummary[] }>("/api/threads?limit=30");
      const prefix = selectedWorkspace.endsWith("/") ? selectedWorkspace : `${selectedWorkspace}/`;
      const filtered = data.threads.filter(
        (thread) => !selectedWorkspace || thread.cwd === selectedWorkspace || thread.cwd.startsWith(prefix),
      );
      setThreads(filtered);
      const desired = preferredThreadId ?? (preserveSelection ? threadRef.current : "");
      const next = filtered.some((thread) => thread.id === desired) ? desired : "";
      setThreadId(next);
      threadRef.current = next;
    } catch (error) {
      showToast(errorMessage(error));
    }
  }, [showToast]);

  const loadProjectHandoff = useCallback(async (selectedWorkspace: string) => {
    const requestedDevice = deviceRef.current;
    try {
      const suffix = selectedWorkspace ? `?workspace=${encodeURIComponent(selectedWorkspace)}` : "";
      const data = await api<{ handoff: SessionHandoff | null }>(`/api/session/handoff${suffix}`);
      if (deviceRef.current !== requestedDevice || workspaceRef.current !== selectedWorkspace) return;
      setHandoffSupported(true);
      const dismissed = localStorage.getItem(handoffDismissedKey(requestedDevice));
      setHandoff(scopedHandoff(data.handoff, selectedWorkspace, dismissed));
    } catch {
      if (deviceRef.current !== requestedDevice || workspaceRef.current !== selectedWorkspace) return;
      setHandoffSupported(false);
      setHandoff(null);
    }
  }, []);

  const initialize = useCallback(async () => {
    if (initializingRef.current) return;
    initializingRef.current = true;
    try {
      const [health, workspaceData, providerData, codexModelData, runData, approvalData, journalData] = await Promise.all([
        api<{ userAgent: string; device: { name: string } }>("/api/health"),
        api<WorkspaceResponse>("/api/workspaces"),
        api<ProviderResponse>("/api/providers"),
        api<ModelResponse>("/api/models?provider=codex"),
        api<{ operations: Operation[] }>("/api/runs")
          .catch(() => ({ operations: [] })),
        api<{ approvals: ApprovalItem[] }>("/api/approvals")
          .catch(() => ({ approvals: [] })),
        api<{ policy: JournalPolicy }>("/api/journal/policy")
          .catch(() => ({ policy: null })),
      ]);
      setConnectionText(`${health.device.name} · ${health.userAgent}`);
      setConnection("online");
      setWorkspaces(workspaceData.workspaces);
      setCreationLocations(workspaceData.creationLocations);
      setProviders(providerData.providers);
      setOperationSnapshots(runData.operations);
      setApprovalInbox(activeApprovals(approvalData.approvals));
      setJournalPolicy(journalData.policy);
      const storedProvider = localStorage.getItem(storageKey("provider", deviceRef.current));
      let selectedProvider = providerData.providers.find((item) => item.id === storedProvider && item.available)
        ?? providerData.providers.find((item) => item.id === "codex")
        ?? providerData.providers.find((item) => item.available);
      let selectedModelData = codexModelData;
      if (selectedProvider && selectedProvider.id !== "codex") {
        try {
          selectedModelData = await api<ModelResponse>(`/api/models?provider=${encodeURIComponent(selectedProvider.id)}`);
        } catch {
          selectedProvider = providerData.providers.find((item) => item.id === "codex") ?? selectedProvider;
          selectedModelData = codexModelData;
        }
      }
      const selectedProviderId = selectedProvider?.id ?? "codex";
      setProvider(selectedProviderId);
      providerRef.current = selectedProviderId;
      setModels(selectedModelData.models);
      const storedAccount = localStorage.getItem(storageKey("account", deviceRef.current));
      const selectedAccount = selectedProvider?.accounts.find((item) => item.id === storedAccount)
        ?? selectedProvider?.accounts.find((item) => item.connected)
        ?? selectedProvider?.accounts[0];
      setAccountId(selectedAccount?.id ?? "cli-default");
      const storedModel = localStorage.getItem(storageKey("model", deviceRef.current)) ?? "";
      const selectedModel = selectedModelData.models.some((item) => item.id === storedModel) ? storedModel : "";
      setModel(selectedModel);
      const selectedModelInfo = selectedModelData.models.find((item) => item.id === selectedModel)
        ?? selectedModelData.models.find((item) => item.isDefault)
        ?? selectedModelData.models[0];
      const storedEffort = localStorage.getItem(storageKey("effort", deviceRef.current)) ?? "";
      const selectedEffort = selectedModelInfo?.efforts.some((item) => item.id === storedEffort)
        ? storedEffort
        : "";
      setEffort(selectedEffort);
      setNewProjectParent((current) => workspaceData.creationLocations.some((item) => item.path === current)
        ? current
        : (workspaceData.creationLocations[0]?.path ?? ""));

      const stored = localStorage.getItem(storageKey("workspace", deviceRef.current)) ?? "";
      const selected = workspaceData.workspaces.some((item) => item.path === workspaceRef.current)
        ? workspaceRef.current
        : workspaceData.workspaces.some((item) => item.path === stored)
          ? stored
          : (workspaceData.workspaces[0]?.path ?? "");
      setWorkspace(selected);
      workspaceRef.current = selected;
      if (selectedProviderId === "codex") {
        await loadThreads(selected, true, localStorage.getItem(storageKey("thread", deviceRef.current)) ?? "");
        await loadProjectHandoff(selected);
      } else {
        setThreads([]);
        setThreadId("");
        threadRef.current = "";
        setHandoff(null);
      }
      if (selectedProviderId === "codex" && threadRef.current) {
        try {
          const data = await api<{ thread: ThreadDetail }>(`/api/threads/${encodeURIComponent(threadRef.current)}`);
          const restored = historyMessages(data.thread);
          messagesRef.current = restored;
          setMessages(restored);
          setJournalRestored(false);
        } catch {
          // The local work journal effect restores the last saved copy.
        }
      }
      const currentOperation = operationRef.current;
      const currentSnapshot = currentOperation
        ? runData.operations.find((item) => item.id === currentOperation.id)
        : undefined;
      if (currentSnapshot) {
        if (currentSnapshot.status === "unknown" && currentSnapshot.acknowledgedAt) {
          operationRef.current = null;
          setOperation(null);
          stopRunning();
        } else if (currentSnapshot.status === "unknown" && currentOperation?.status === "unknown") {
          operationRef.current = currentSnapshot;
          setOperation(currentSnapshot);
          stopRunning();
        } else {
          handleOperationEvent(operationAction(currentSnapshot), currentSnapshot);
        }
      } else if (!currentOperation) {
        const candidates = runData.operations.filter((item) => (item.status === "running"
          || (item.status === "unknown" && !item.acknowledgedAt))
          && (item.providerId ?? "codex") === selectedProviderId
          && item.cwd === selected
          && (selectedProviderId !== "codex" || !threadRef.current || item.threadId === threadRef.current));
        const activeOperation = threadRef.current ? candidates[0] : candidates.length === 1 ? candidates[0] : undefined;
        if (activeOperation) {
          if (selectedProviderId === "codex" && !threadRef.current && activeOperation.threadId) {
            setThreadId(activeOperation.threadId);
            threadRef.current = activeOperation.threadId;
            localStorage.setItem(storageKey("thread", deviceRef.current), activeOperation.threadId);
          }
          handleOperationEvent(operationAction(activeOperation), activeOperation);
        }
      }
      initializedRef.current = true;
      if (!onboardingShownRef.current && localStorage.getItem("codex-pocket-onboarding-complete") !== "true") {
        onboardingShownRef.current = true;
        setShowConnectionCenter(true);
        void refreshDiagnostics();
      }
    } catch (error) {
      setConnection("error");
      setConnectionText(`${deviceLabel(deviceRef.current)} 연결 실패`);
      const cachedWorkspace = localStorage.getItem(storageKey("workspace", deviceRef.current)) ?? "";
      const cachedThread = localStorage.getItem(storageKey("thread", deviceRef.current)) ?? "";
      if (cachedWorkspace) {
        setWorkspace(cachedWorkspace);
        workspaceRef.current = cachedWorkspace;
        setWorkspaces([{ path: cachedWorkspace, name: workspaceName(cachedWorkspace) }]);
        setThreadId(cachedThread);
        threadRef.current = cachedThread;
      }
      if (error instanceof PocketLinkIdentityRotationRequiredError) {
        setPairing(null);
        setShowConnectionCenter(true);
      } else if (error instanceof PairingRequiredError) {
        void requestPairing();
      }
      showToast(errorMessage(error));
    } finally {
      initializingRef.current = false;
    }
  }, [loadProjectHandoff, loadThreads, requestPairing, showToast]);

  initializeRef.current = initialize;

  useEffect(() => {
    deviceRef.current = device;
    setApiDevice(device);
    initializedRef.current = false;
    setConnection("pending");
    setConnectionText(`${deviceLabel(device)} 연결을 준비하는 중…`);
    void (async () => {
      if (isNativeApp()) {
        try {
          const tunnel = await NativeTunnel.start({ localPort: deviceTargetLocalPort(activeDeviceTarget()) });
          if (tunnel.manual && tunnel.message) showToast(tunnel.message);
        } catch (error) {
          showToast(errorMessage(error));
        }
      }
      await initialize();
    })();
    const abort = new AbortController();
    void (async () => {
      let retry = 0;
      while (!abort.signal.aborted) {
        try {
          await subscribeEvents(() => {
            retry = 0;
            setConnection("online");
            setConnectionText((current) => current.includes("복구") || current.includes("실패")
              ? `${deviceLabel(device)}와 안전하게 연결됨`
              : current);
            if (!initializedRef.current) void initializeRef.current();
          }, (event) => handleEventRef.current(event), abort.signal);
          if (abort.signal.aborted) return;
          throw new Error("실시간 연결이 종료되었습니다.");
        } catch (error) {
          if (abort.signal.aborted) return;
          if (error instanceof PairingRequiredError) {
            void requestPairing();
            setConnection("pending");
            setConnectionText("페어링 필요");
            return;
          }
          if (error instanceof PocketLinkIdentityRotationRequiredError) {
            setPairing(null);
            setShowConnectionCenter(true);
            setConnection("pending");
            setConnectionText("PocketLink 단말 key 교체 확인 필요");
            return;
          }
          setConnection("pending");
          setConnectionText("연결을 복구하는 중…");
          retry += 1;
          await abortableDelay(Math.min(15_000, 500 * (2 ** Math.min(retry, 5))), abort.signal);
        }
      }
    })();
    return () => abort.abort();
  }, [authRevision, device, initialize, requestPairing, showToast]);

  useEffect(() => {
    if (isNativeApp()) return;
    if (!("serviceWorker" in navigator)) return;
    void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  }, []);

  useEffect(() => {
    const onPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as BeforeInstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    return () => window.removeEventListener("beforeinstallprompt", onPrompt);
  }, []);

  useEffect(() => {
    if (!isNativeApp()) return;
    let disposed = false;
    const listeners: Array<{ remove(): Promise<void> }> = [];
    const keep = async (listener: Promise<{ remove(): Promise<void> }>) => {
      const handle = await listener;
      if (disposed) void handle.remove();
      else listeners.push(handle);
    };
    const updateTranscript = (tail: string) => {
      setPrompt(joinDictation(dictationBaseRef.current, mergeSpeechSegments([nativeFinalRef.current, tail])));
    };

    void keep(NativeSpeech.addListener("speechPartial", (event: NativeSpeechResult) => {
      updateTranscript(event.transcript);
    }));
    void keep(NativeSpeech.addListener("speechFinal", (event: NativeSpeechResult) => {
      nativeFinalRef.current = mergeSpeechSegments([nativeFinalRef.current, event.transcript]);
      updateTranscript("");
    }));
    void keep(NativeSpeech.addListener("speechState", (event: NativeSpeechState) => {
      if (event.state === "listening" || event.state === "processing" || event.state === "restarting") {
        setDictating(true);
      } else if (!handsFreeRef.current) {
        setDictating(false);
      }
    }));
    void keep(NativeSpeech.addListener("speechError", (event: NativeSpeechError) => {
      if (!event.recoverable) {
        handsFreeRef.current = false;
        setHandsFree(false);
        setDictating(false);
        showToast(event.message);
      }
    }));

    return () => {
      disposed = true;
      for (const listener of listeners) void listener.remove();
      void NativeSpeech.stop();
    };
  }, [showToast]);

  useEffect(() => {
    if (isNativeApp()) {
      setSpeechSupported(true);
      return;
    }
    const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!Recognition) {
      setSpeechSupported(false);
      return;
    }
    const recognition = new Recognition();
    recognition.lang = speechLanguageRef.current;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.onstart = () => setDictating(true);
    recognition.onresult = (event) => {
      const segments: string[] = [];
      for (let index = 0; index < event.results.length; index += 1) {
        segments.push(event.results[index]?.[0]?.transcript ?? "");
      }
      setPrompt(joinDictation(dictationBaseRef.current, mergeSpeechSegments(segments)));
    };
    recognition.onerror = (event) => {
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        showToast("마이크 권한을 허용해 주세요.");
      } else if (event.error !== "no-speech" && event.error !== "aborted") {
        showToast(`음성 인식 오류: ${event.error}`);
      }
    };
    recognition.onend = () => {
      if (handsFreeRef.current) {
        window.setTimeout(() => {
          if (!handsFreeRef.current) return;
          try {
            recognition.start();
          } catch {
            setDictating(false);
          }
        }, 280);
      } else {
        setDictating(false);
      }
    };
    recognitionRef.current = recognition;
    return () => {
      recognition.abort();
      recognitionRef.current = null;
    };
  }, [showToast]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`;
  }, [prompt]);

  const newestText = messages.at(-1)?.text;
  useLayoutEffect(() => {
    const transcript = transcriptRef.current;
    if (!transcript) return;
    transcript.scrollTo({ top: transcript.scrollHeight, behavior: "smooth" });
  }, [messages.length, newestText]);

  function replaceMessage(id: string, update: Partial<ChatMessage>) {
    setMessages((current) => {
      const next = current.map((message) => message.id === id ? { ...message, ...update } : message);
      messagesRef.current = next;
      return next;
    });
  }

  function ensureLiveMessage(): string {
    if (liveMessageIdRef.current) return liveMessageIdRef.current;
    const id = newId("assistant");
    liveMessageIdRef.current = id;
    setMessages((current) => {
      const next: ChatMessage[] = [...current, { id, role: "assistant", text: "", pending: true }];
      messagesRef.current = next;
      return next;
    });
    return id;
  }

  function buildResultDetails(result: RunResult): string {
    const lines: string[] = [];
    for (const command of result.commands ?? []) {
      lines.push(`$ ${command.command}\n  ${command.status}${command.exitCode == null ? "" : ` · exit ${command.exitCode}`}`);
    }
    for (const fileChange of result.fileChanges ?? []) {
      for (const change of fileChange.changes ?? []) lines.push(`${change.kind}: ${change.path}`);
    }
    if (result.usage) {
      const usage = result.usage;
      lines.push([
        "사용량",
        usage.inputTokens == null ? null : `입력 ${usage.inputTokens.toLocaleString()}`,
        usage.cachedInputTokens == null ? null : `캐시 ${usage.cachedInputTokens.toLocaleString()}`,
        usage.outputTokens == null ? null : `출력 ${usage.outputTokens.toLocaleString()}`,
        usage.reasoningTokens == null ? null : `추론 ${usage.reasoningTokens.toLocaleString()}`,
        usage.totalTokens == null ? null : `합계 ${usage.totalTokens.toLocaleString()}`,
        usage.costCredits == null ? null : `비용 ${usage.costCredits.toFixed(6)} credits`,
      ].filter(Boolean).join(" · "));
    }
    if (latestDiffRef.current) lines.push(`\n--- diff ---\n${latestDiffRef.current}`);
    return lines.join("\n");
  }

  function finishLiveMessage(text: string, isError: boolean, result: RunResult = {}) {
    const id = ensureLiveMessage();
    replaceMessage(id, {
      text,
      pending: false,
      error: isError,
      details: buildResultDetails(result) || undefined,
    });
    liveMessageIdRef.current = null;
    liveTextRef.current = "";
    latestDiffRef.current = "";
    operationRef.current = null;
    setOperation(null);
  }

  function stopRunning() {
    if (pollTimerRef.current !== null) window.clearTimeout(pollTimerRef.current);
    pollTimerRef.current = null;
    setActivity({ running: false, text: "", detail: "" });
  }

  function setRunning(text: string, detail = "") {
    setActivity({ running: true, text, detail });
  }

  function speak(text: string) {
    if (!("speechSynthesis" in window)) return;
    speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text.slice(0, 4_000));
    utterance.lang = speechLanguageRef.current;
    utterance.rate = 1.03;
    const preferredVoice = speechSynthesis.getVoices().find((voice) => voice.lang.toLowerCase().startsWith(speechLanguageRef.current.split("-", 1)[0]!.toLowerCase()));
    if (preferredVoice) utterance.voice = preferredVoice;
    speechSynthesis.speak(utterance);
  }

  async function refreshOperationalSnapshot(silent = false) {
    const requestedDevice = deviceRef.current;
    try {
      const [runData, approvalData, workspaceData, journalData] = await Promise.all([
        api<{ operations: Operation[] }>("/api/runs"),
        api<{ approvals: ApprovalItem[] }>("/api/approvals"),
        api<WorkspaceResponse>("/api/workspaces"),
        api<{ policy: JournalPolicy }>("/api/journal/policy")
          .catch(() => ({ policy: null })),
      ]);
      if (deviceRef.current !== requestedDevice) return;
      setOperationSnapshots(runData.operations);
      setApprovalInbox(activeApprovals(approvalData.approvals));
      setWorkspaces(workspaceData.workspaces);
      setCreationLocations(workspaceData.creationLocations);
      setJournalPolicy(journalData.policy);
      if (!silent) showToast("프로젝트 작업 상태를 새로 확인했습니다.");
    } catch (error) {
      if (!silent && deviceRef.current === requestedDevice) showToast(errorMessage(error));
    }
  }

  function scheduleOperationPoll(operationId: string) {
    if (pollTimerRef.current !== null) window.clearTimeout(pollTimerRef.current);
    pollTimerRef.current = window.setTimeout(() => void pollOperation(operationId), 2_000);
  }

  async function pollOperation(operationId: string) {
    const current = operationRef.current;
    if (!current || current.id !== operationId || current.status !== "running") return;
    try {
      const data = await api<{ operation: Operation }>(`/api/runs/${encodeURIComponent(operationId)}`);
      if (data.operation.status === "running") {
        scheduleOperationPoll(operationId);
        return;
      }
      handleOperationEvent(
        data.operation.status === "unknown" ? "recovered" : data.operation.status === "failed" ? "failed" : "completed",
        data.operation,
      );
    } catch {
      scheduleOperationPoll(operationId);
    }
  }

  function handleOperationEvent(action: string, nextOperation: Operation) {
    setOperationSnapshots((current) => upsertOperation(current, nextOperation));
    const operationProvider = nextOperation.providerId ?? "codex";
    if (action === "acknowledged") {
      if (operationRef.current?.id !== nextOperation.id) return;
      operationRef.current = null;
      setOperation(null);
      stopRunning();
      startNextQueuedPrompt(threadRef.current);
      return;
    }
    if ((action === "started" || action === "recovered") && !operationRef.current) {
      if (nextOperation.cwd !== workspaceRef.current || operationProvider !== providerRef.current) return;
      if (operationProvider === "codex" && nextOperation.threadId !== threadRef.current) return;
      operationRef.current = nextOperation;
      setOperation(nextOperation);
      ensureLiveMessage();
    }
    if (!operationRef.current || nextOperation.id !== operationRef.current.id) return;
    operationRef.current = nextOperation;
    setOperation(nextOperation);

    if (nextOperation.status === "running") {
      setRunning(operationProvider === "codex"
        ? "Codex가 프로젝트를 살펴보고 있습니다…"
        : "AI가 프로젝트를 살펴보고 있습니다…");
      scheduleOperationPoll(nextOperation.id);
    } else if (action === "recovered" || nextOperation.status === "unknown") {
      replaceMessage(ensureLiveMessage(), {
        text: nextOperation.error || "Companion 재시작 전 작업의 최종 상태를 확인할 수 없습니다.",
        pending: false,
        error: true,
      });
      liveMessageIdRef.current = null;
      liveTextRef.current = "";
      latestDiffRef.current = "";
      stopRunning();
    } else if (action === "completed") {
      const result = nextOperation.result ?? {};
      finishLiveMessage(result.finalResponse || statusMessage(nextOperation.status), false, result);
      stopRunning();
      if (result.threadId) {
        setThreadId(result.threadId);
        threadRef.current = result.threadId;
        localStorage.setItem(storageKey("thread", deviceRef.current), result.threadId);
      }
      if (ttsRef.current && result.finalResponse) speak(result.finalResponse);
      if (operationProvider === "codex") void loadThreads(workspaceRef.current, true, result.threadId);
      startNextQueuedPrompt(result.threadId ?? threadRef.current);
    } else if (action === "failed") {
      finishLiveMessage(`작업 실패: ${nextOperation.error || "알 수 없는 오류"}`, true);
      stopRunning();
      startNextQueuedPrompt(threadRef.current);
    }
  }

  function handleEvent(event: CodexEvent) {
    if (event.type === "connected") {
      replayingEventsRef.current = (event.replayed ?? 0) > 0;
      return;
    }
    if (event.type === "journal" && event.action === "replay_complete") {
      replayingEventsRef.current = false;
      void refreshOperationalSnapshot(true);
      return;
    }
    if (event.type === "journal" && event.action === "history_deleted" && event.workspace) {
      setOperationSnapshots((current) => current.filter((item) => item.cwd !== event.workspace));
      setApprovalInbox((current) => current.filter((item) => item.cwd !== event.workspace));
      const current = operationRef.current;
      if (current?.cwd === event.workspace && current.status !== "running"
        && (current.status !== "unknown" || current.acknowledgedAt)) {
        operationRef.current = null;
        setOperation(null);
        stopRunning();
      }
      return;
    }
    if (event.type === "journal" && event.action === "reset") {
      const current = operationRef.current;
      if (event.reason === "database_reset" && current?.status === "running") {
        handleOperationEvent("recovered", {
          ...current,
          status: "unknown",
          completedAt: new Date().toISOString(),
          error: "Companion event journal이 교체되어 이전 실행의 최종 상태를 확인할 수 없습니다.",
        });
      }
      initializedRef.current = false;
      void initializeRef.current();
      showToast("저널 보존 구간이 바뀌어 PC의 현재 작업 상태를 다시 확인합니다.");
      return;
    }
    if (event.type === "media" && event.media) {
      setAttachments((current) => current.map((item) => item.id === event.media!.id
        ? { ...item, ...event.media, previewUrl: item.previewUrl }
        : item));
      return;
    }
    if (event.type === "operation" && event.operation) {
      handleOperationEvent(event.action ?? "", event.operation);
      return;
    }
    if (event.type === "approval" && event.approval) {
      setApprovalInbox((current) => applyApprovalEvent(current, event));
      if (event.action === "requested" && !replayingEventsRef.current) {
        setShowOperationsDashboard(true);
        showToast("화면에서 검토해야 할 도구 승인이 도착했습니다.");
      }
      return;
    }
    if (event.type === "session" && event.action === "released" && event.handoff) {
      if (event.handoff.workspace === workspaceRef.current
        && localStorage.getItem(handoffDismissedKey(deviceRef.current)) !== event.handoff.id) {
        setHandoff(event.handoff);
      }
      return;
    }
    if (event.type === "session" && event.action === "claimed" && event.handoffId) {
      setHandoff((current) => current?.id === event.handoffId ? null : current);
      return;
    }
    const current = operationRef.current;
    if (!current) return;
    if (event.type === "provider") {
      if (event.providerId !== current.providerId
        || event.conversationId !== current.conversationId
        || (event.runId && event.runId !== current.runId)) return;
      switch (event.kind) {
        case "output.delta":
          liveTextRef.current += event.delta ?? "";
          replaceMessage(ensureLiveMessage(), { text: liveTextRef.current });
          setRunning("AI가 답변을 작성하고 있습니다…");
          break;
        case "tool.started":
          setRunning("도구를 실행하고 있습니다…", event.tool?.command ?? event.tool?.paths?.join("\n"));
          break;
        case "tool.completed":
          setRunning(`도구 완료 · ${event.tool?.status || "처리됨"}`, event.tool?.command);
          break;
        case "workspace.diff":
          latestDiffRef.current = event.diff ?? "";
          setRunning("변경 내용을 검토하고 있습니다…");
          break;
        case "run.failed":
          showToast(event.message || "AI 처리 중 오류가 발생했습니다.");
          break;
      }
      return;
    }
    if (event.type !== "codex") return;
    const params = event.params ?? {};
    const turnId = typeof params.turnId === "string" ? params.turnId : undefined;
    if (turnId && turnId !== current.turnId) return;

    switch (event.method) {
      case "item/agentMessage/delta": {
        liveTextRef.current += typeof params.delta === "string" ? params.delta : "";
        replaceMessage(ensureLiveMessage(), { text: liveTextRef.current });
        setRunning("Codex가 답변을 작성하고 있습니다…");
        break;
      }
      case "item/started": {
        const item = asRecord(params.item);
        if (item.type === "commandExecution") {
          setRunning("명령을 실행하고 있습니다…", stringValue(item.command));
        } else if (item.type === "fileChange") {
          setRunning("파일 변경을 적용하고 있습니다…", arrayStrings(item.paths).join("\n"));
        }
        break;
      }
      case "item/completed": {
        const item = asRecord(params.item);
        if (item.type === "commandExecution") {
          setRunning(`명령 완료 · ${stringValue(item.status) || "처리됨"}`, stringValue(item.command));
        }
        break;
      }
      case "turn/diff/updated":
        latestDiffRef.current = stringValue(params.diff);
        setRunning("변경 내용을 검토하고 있습니다…");
        break;
      case "error":
        showToast(stringValue(params.message) || "Codex 처리 중 오류가 발생했습니다.");
        break;
    }
  }

  handleEventRef.current = handleEvent;

  async function addMedia(files: FileList | null) {
    if (!files?.length) return;
    const selected = [...files].slice(0, Math.max(0, 4 - attachments.length));
    if (selected.length < files.length) showToast("첨부 파일은 한 번에 최대 4개까지 보낼 수 있습니다.");
    setMediaBusy(true);
    try {
      for (const file of selected) {
        const localId = newId("upload");
        const previewUrl = file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined;
        const placeholder: PendingAttachment = {
          id: localId,
          name: file.name,
          kind: file.type.startsWith("video/") ? "video" : "image",
          mimeType: file.type,
          size: file.size,
          status: "uploading",
          frameCount: 0,
          progress: 0,
          previewUrl,
        };
        setAttachments((current) => [...current, placeholder]);
        try {
          const uploaded = await uploadMedia<MediaItem>(file, (progress) => {
            setAttachments((current) => current.map((item) => item.id === localId ? { ...item, progress } : item));
          });
          setAttachments((current) => current.map((item) => item.id === localId
            ? { ...uploaded, previewUrl, progress: 100 }
            : item));
          if (uploaded.kind === "video") void analyzeMedia(uploaded.id);
        } catch (error) {
          setAttachments((current) => current.filter((item) => item.id !== localId));
          if (previewUrl) URL.revokeObjectURL(previewUrl);
          showToast(errorMessage(error));
        }
      }
    } finally {
      setMediaBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function analyzeMedia(id: string) {
    try {
      const queued = await api<{ media: MediaItem }>(`/api/media/${encodeURIComponent(id)}/analyze`, {
        method: "POST",
        body: {},
      });
      updateMedia(queued.media);
      const deadline = Date.now() + 6 * 60_000;
      while (Date.now() < deadline && queued.media.status !== "ready") {
        await new Promise((resolve) => window.setTimeout(resolve, 2_000));
        const data = await api<{ media: MediaItem }>(`/api/media/${encodeURIComponent(id)}`);
        updateMedia(data.media);
        if (data.media.status === "ready") return;
        if (data.media.status === "failed") throw new Error(data.media.error || "영상 분석에 실패했습니다.");
      }
      throw new Error("영상 분석 시간이 초과되었습니다. 다시 첨부해 주세요.");
    } catch (error) {
      showToast(errorMessage(error));
    }
  }

  function updateMedia(media: MediaItem) {
    setAttachments((current) => current.map((item) => item.id === media.id
      ? { ...item, ...media, previewUrl: item.previewUrl }
      : item));
  }

  async function removeAttachment(id: string) {
    const uploaded = attachments.find((item) => item.id === id && item.status !== "uploading");
    if (uploaded) await api(`/api/media/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => undefined);
    setAttachments((current) => {
      const removed = current.find((item) => item.id === id);
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
      return current.filter((item) => item.id !== id);
    });
  }

  async function submitPrompt() {
    const text = prompt.trim() || (attachments.length ? "첨부한 매체를 분석하고 요청에 맞게 처리해 주세요." : "");
    const attachmentsReady = attachments.every((item) => item.kind === "image" || item.status === "ready");
    if (!text || !attachmentsReady || mediaBusy) return;
    if (!workspaceRef.current) {
      showToast("프로젝트를 먼저 선택하세요.");
      return;
    }
    if (dictating) await stopDictation();

    const queued: QueuedPrompt = {
      id: newId("queued"),
      text,
      cwd: workspaceRef.current,
      threadId: threadRef.current,
      networkAccess,
      model,
      effort,
      provider,
      accountId,
      attachments: [...attachments],
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
    };
    setPrompt("");
    setAttachments([]);
    if (connection !== "online" || operationRef.current !== null) {
      const nextQueue = [...promptQueueRef.current, queued];
      updatePromptQueue(nextQueue);
      showToast(connection === "online"
        ? operationRef.current?.status === "unknown"
          ? `이전 작업 상태를 확인할 때까지 요청을 대기열 ${nextQueue.length}번째에 보관합니다.`
          : `요청을 대기열 ${nextQueue.length}번째에 추가했습니다.`
        : `오프라인 대기열에 저장했습니다. ${deviceLabel(deviceRef.current)} 연결 후 자동 실행됩니다.`);
      return;
    }
    await executePrompt(queued);
  }

  async function executePrompt(queued: QueuedPrompt, continuedThreadId = "") {
    const userId = newId("user");
    const assistantId = newId("assistant");
    const attachmentLabel = queued.attachments.length
      ? `\n\n📎 ${queued.attachments.map((item) => item.name).join(", ")}`
      : "";
    setMessages((current) => {
      const next: ChatMessage[] = [
        ...current,
        ...(queued.displayed ? [] : [{ id: userId, role: "user" as const, text: `${queued.text}${attachmentLabel}` }]),
        { id: assistantId, role: "assistant", text: "", pending: true },
      ];
      messagesRef.current = next;
      return next;
    });
    setJournalRestored(false);
    liveMessageIdRef.current = assistantId;
    liveTextRef.current = "";
    latestDiffRef.current = "";
    setRunning("Codex가 요청을 시작하고 있습니다…");

    try {
      const data = await api<{ operation: Operation }>("/api/runs", {
        method: "POST",
        body: {
          requestId: queued.id,
          prompt: queued.text,
          cwd: queued.cwd,
          threadId: queued.provider === "codex" ? queued.threadId || continuedThreadId || undefined : undefined,
          networkAccess: queued.networkAccess,
          model: queued.model || undefined,
          effort: queued.effort || undefined,
          provider: queued.provider,
          accountId: queued.accountId,
          attachments: queued.attachments.map((item) => item.id),
        },
      });
      operationRef.current = data.operation;
      setOperation(data.operation);
      setOperationSnapshots((current) => upsertOperation(current, data.operation));
      if (queued.provider === "codex" && data.operation.threadId && !threadRef.current) {
        setThreadId(data.operation.threadId);
        threadRef.current = data.operation.threadId;
        localStorage.setItem(storageKey("thread", deviceRef.current), data.operation.threadId);
      }
      queueDispatchingRef.current = false;
      for (const item of queued.attachments) if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      if (data.operation.status === "running") {
        scheduleOperationPoll(data.operation.id);
        setRunning(queued.provider === "codex"
          ? "Codex가 프로젝트를 살펴보고 있습니다…"
          : "AI가 프로젝트를 살펴보고 있습니다…");
      } else {
        handleOperationEvent(operationAction(data.operation), data.operation);
      }
    } catch (error) {
      queueDispatchingRef.current = false;
      const message = errorMessage(error);
      if (message.includes("연결할 수 없습니다")) {
        setConnection("pending");
        updatePromptQueue([{ ...queued, displayed: true }, ...promptQueueRef.current]);
        finishLiveMessage("단말 연결이 끊겨 요청을 오프라인 대기열로 되돌렸습니다.", true);
        stopRunning();
        return;
      }
      finishLiveMessage(`실행하지 못했습니다: ${message}`, true);
      stopRunning();
      startNextQueuedPrompt(continuedThreadId || threadRef.current);
    }
  }

  function startNextQueuedPrompt(continuedThreadId: string) {
    if (queueDispatchingRef.current) return;
    const [next, ...remaining] = promptQueueRef.current;
    if (!next || next.requiresConfirmation) return;
    if (next.expiresAt && Date.parse(next.expiresAt) <= Date.now()) {
      updatePromptQueue(remaining);
      startNextQueuedPrompt(continuedThreadId);
      return;
    }
    queueDispatchingRef.current = true;
    updatePromptQueue(remaining);
    const effectiveThreadId = next.threadId || continuedThreadId;
    if (workspaceRef.current !== next.cwd || threadRef.current !== effectiveThreadId) {
      setWorkspace(next.cwd);
      workspaceRef.current = next.cwd;
      localStorage.setItem(storageKey("workspace", deviceRef.current), next.cwd);
      setThreadId(effectiveThreadId);
      threadRef.current = effectiveThreadId;
      if (effectiveThreadId) localStorage.setItem(storageKey("thread", deviceRef.current), effectiveThreadId);
      else localStorage.removeItem(storageKey("thread", deviceRef.current));
      messagesRef.current = [];
      setMessages([]);
      setJournalRestored(false);
    }
    window.setTimeout(() => void executePrompt(next, continuedThreadId), 0);
  }

  function removeQueuedPrompt(id: string) {
    const removed = promptQueueRef.current.find((item) => item.id === id);
    for (const attachment of removed?.attachments ?? []) {
      if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
    }
    const remaining = promptQueueRef.current.filter((item) => item.id !== id);
    updatePromptQueue(remaining);
  }

  function updatePromptQueue(next: QueuedPrompt[]) {
    const safe = serializableQueue(next);
    promptQueueRef.current = safe;
    setPromptQueue(safe);
    if (journalQueueReadyRef.current === deviceRef.current) {
      void journal.saveQueue({
        device: deviceRef.current,
        prompts: safe,
        updatedAt: new Date().toISOString(),
      }).catch(() => undefined);
    }
  }

  function confirmRestoredQueue() {
    updatePromptQueue(promptQueueRef.current.map((item) => ({ ...item, requiresConfirmation: false })));
    showToast("저장된 대기열 실행을 재개합니다.");
  }

  function closeConnectionCenter() {
    localStorage.setItem("codex-pocket-onboarding-complete", "true");
    setStagingPinTarget(null);
    setStagedBackupPin("");
    setConfirmingPinPromotionTarget(null);
    setReviewingIdentityRotationTarget(null);
    setShowConnectionCenter(false);
  }

  async function stopOperation() {
    const current = operationRef.current;
    if (!current) return;
    if (!operationBelongsToSession(current, workspaceRef.current, threadRef.current)) {
      showToast("현재 프로젝트의 작업이 아니어서 중단하지 않았습니다.");
      return;
    }
    try {
      await api(`/api/runs/${encodeURIComponent(current.id)}/interrupt`, { method: "POST", body: {} });
      setRunning("중단을 요청했습니다…");
    } catch (error) {
      showToast(errorMessage(error));
    }
  }

  async function acknowledgeUnknownOperation() {
    const current = operationRef.current;
    if (current?.status !== "unknown") return;
    const hadQueuedPrompts = promptQueueRef.current.length > 0;
    try {
      const data = await api<{ operation: Operation }>(`/api/runs/${encodeURIComponent(current.id)}/acknowledge`, {
        method: "POST",
        body: {},
      });
      setOperationSnapshots((snapshots) => upsertOperation(snapshots, data.operation));
      if (operationRef.current?.id === current.id) handleOperationEvent("acknowledged", data.operation);
      showToast(hadQueuedPrompts
        ? "상태 확인을 마쳤습니다. 보관한 대기열을 다시 시작합니다."
        : "상태 확인을 마쳤습니다. 새 작업을 시작할 수 있습니다.");
    } catch (error) {
      showToast(errorMessage(error));
    }
  }

  async function releaseSession() {
    if (handoffBusy) return;
    if (promptQueueRef.current.length > 0) {
      showToast("이 기기에만 저장된 대기열이 있습니다. 모두 실행하거나 취소한 뒤 세션을 반납하세요.");
      return;
    }
    const candidateOperation = operationRef.current;
    const currentOperation = operationBelongsToSession(
      candidateOperation,
      workspaceRef.current,
      threadRef.current,
    ) ? candidateOperation : null;
    const currentThreadId = threadRef.current || currentOperation?.threadId || "";
    if (!currentThreadId) {
      detachLocalSession();
      showToast("아직 저장된 Codex 대화가 없어 이 기기의 새 대화만 닫았습니다.");
      return;
    }
    if (connection !== "online") {
      showToast("PC에 연결된 상태에서 세션을 반납할 수 있습니다.");
      return;
    }
    setHandoffBusy(true);
    try {
      if (workspaceRef.current && messagesRef.current.length > 0) {
        await journal.saveConversation({
          key: conversationKey(deviceRef.current, workspaceRef.current, currentThreadId),
          device: deviceRef.current,
          workspace: workspaceRef.current,
          threadId: currentThreadId,
          messages: messagesRef.current,
          syncState: currentOperation?.status === "running" ? "running" : "synced",
          updatedAt: new Date().toISOString(),
        });
      }
      const data = await api<{ handoff: SessionHandoff }>("/api/session/handoff", {
        method: "POST",
        body: {
          workspace: workspaceRef.current || currentOperation?.cwd,
          threadId: currentThreadId,
          operationId: currentOperation?.status === "running" ? currentOperation.id : undefined,
        },
      });
      localStorage.setItem(handoffDismissedKey(deviceRef.current), data.handoff.id);
      setHandoff(null);
      detachLocalSession();
      showToast(currentOperation?.status === "running"
        ? "세션을 반납했습니다. PC 작업은 계속되며 다른 기기에서 이어받을 수 있습니다."
        : "세션을 반납했습니다. 다른 기기에서 이어받을 수 있습니다.");
    } catch (error) {
      showToast(errorMessage(error));
    } finally {
      setHandoffBusy(false);
    }
  }

  function detachLocalSession() {
    if (pollTimerRef.current !== null) window.clearTimeout(pollTimerRef.current);
    pollTimerRef.current = null;
    operationRef.current = null;
    setOperation(null);
    stopRunning();
    setThreadId("");
    threadRef.current = "";
    localStorage.removeItem(storageKey("thread", deviceRef.current));
    setMessages([]);
    messagesRef.current = [];
    setJournalRestored(false);
    setShowHandoffDialog(false);
  }

  async function resumeHandoff() {
    const pending = handoff;
    if (!pending || handoffBusy) return;
    if (promptQueueRef.current.length > 0) {
      showToast("현재 기기의 대기열을 먼저 실행하거나 취소한 뒤 인계받으세요.");
      return;
    }
    setHandoffBusy(true);
    try {
      if (!workspaces.some((item) => item.path === pending.workspace)) {
        throw new Error("인계된 프로젝트가 현재 PC의 허용 목록에 없습니다.");
      }
      setWorkspace(pending.workspace);
      workspaceRef.current = pending.workspace;
      localStorage.setItem(storageKey("workspace", deviceRef.current), pending.workspace);
      await loadThreads(pending.workspace, false, pending.threadId);
      const data = await api<{ thread: ThreadDetail }>(`/api/threads/${encodeURIComponent(pending.threadId)}`);
      setThreadId(pending.threadId);
      threadRef.current = pending.threadId;
      localStorage.setItem(storageKey("thread", deviceRef.current), pending.threadId);
      const restored = historyMessages(data.thread);
      messagesRef.current = restored;
      setMessages(restored);
      setJournalRestored(false);
      if (pending.operationId) {
        const active = await api<{ operation: Operation }>(`/api/runs/${encodeURIComponent(pending.operationId)}`)
          .catch(() => null);
        if (active?.operation.status === "running") handleOperationEvent("started", active.operation);
        else if (active?.operation.status === "unknown") handleOperationEvent("recovered", active.operation);
        else if (active?.operation.status === "failed") handleOperationEvent("failed", active.operation);
      }
      let claimWarning = "";
      try {
        await api(`/api/session/handoffs/${encodeURIComponent(pending.id)}/claim`, { method: "POST", body: {} });
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 404)) {
          claimWarning = "세션은 연결했지만 다른 기기의 인계 표시를 정리하지 못했습니다.";
        }
      }
      localStorage.setItem(handoffDismissedKey(deviceRef.current), pending.id);
      setHandoff(null);
      showToast(claimWarning || (pending.operationId ? "실행 중인 세션을 이어받았습니다." : "세션을 이어받았습니다."));
    } catch (error) {
      showToast(errorMessage(error));
    } finally {
      setHandoffBusy(false);
    }
  }

  function selectDevice(nextDevice: DeviceId) {
    if (nextDevice === deviceRef.current) return;
    setApiDevice(nextDevice);
    deviceRef.current = nextDevice;
    setDevice(nextDevice);
    setWorkspace("");
    workspaceRef.current = "";
    setThreadId("");
    threadRef.current = "";
    setThreads([]);
    setWorkspaces([]);
    setCreationLocations([]);
    setModels([]);
    setProviders([]);
    setProvider("codex");
    providerRef.current = "codex";
    setAccountId("cli-default");
    setModel("");
    setEffort("");
    setMessages([]);
    messagesRef.current = [];
    operationRef.current = null;
    setOperation(null);
    stopRunning();
    liveMessageIdRef.current = null;
    liveTextRef.current = "";
    latestDiffRef.current = "";
    promptQueueRef.current = [];
    setPromptQueue([]);
    journalQueueReadyRef.current = null;
    queueDispatchingRef.current = false;
    setJournalRestored(false);
    setHandoff(null);
    setShowHandoffDialog(false);
    setHandoffSupported(false);
    setOperationSnapshots([]);
    setApprovalInbox([]);
    setShowOperationsDashboard(false);
    setDecidingApprovalId(null);
    setJournalPolicy(null);
    setExportingWorkspace(null);
    setDeletingWorkspace(null);
    replayingEventsRef.current = false;
  }

  function selectModel(nextModel: string) {
    setModel(nextModel);
    if (nextModel) localStorage.setItem(storageKey("model", deviceRef.current), nextModel);
    else localStorage.removeItem(storageKey("model", deviceRef.current));
    const info = models.find((item) => item.id === nextModel)
      ?? models.find((item) => item.isDefault)
      ?? models[0];
    if (effort && !info?.efforts.some((item) => item.id === effort)) selectEffort("");
  }

  async function selectProvider(nextProvider: ProviderId) {
    if (operationRef.current) {
      showToast("현재 작업 상태를 확인한 뒤 AI 제공자를 바꿔 주세요.");
      return;
    }
    const info = providers.find((item) => item.id === nextProvider);
    if (!info?.available) {
      showToast(info?.detail ?? "이 AI 연결은 현재 사용할 수 없습니다.");
      return;
    }
    setProvider(nextProvider);
    providerRef.current = nextProvider;
    localStorage.setItem(storageKey("provider", deviceRef.current), nextProvider);
    const nextAccount = info.accounts.find((item) => item.connected) ?? info.accounts[0];
    setAccountId(nextAccount?.id ?? "");
    if (nextAccount) localStorage.setItem(storageKey("account", deviceRef.current), nextAccount.id);
    const modelData = await api<ModelResponse>(`/api/models?provider=${encodeURIComponent(nextProvider)}`);
    setModels(modelData.models);
    setModel("");
    setEffort("");
    setThreadId("");
    threadRef.current = "";
    setMessages([]);
    messagesRef.current = [];
    setJournalRestored(false);
    setHandoff(null);
    if (nextProvider === "codex") {
      await loadThreads(
        workspaceRef.current,
        true,
        localStorage.getItem(storageKey("thread", deviceRef.current)) ?? "",
      );
      await loadProjectHandoff(workspaceRef.current);
    } else {
      setThreads([]);
    }
  }

  function selectAccount(nextAccount: string) {
    setAccountId(nextAccount);
    localStorage.setItem(storageKey("account", deviceRef.current), nextAccount);
  }

  async function refreshProviders() {
    try {
      const data = await api<ProviderResponse>("/api/providers");
      setProviders(data.providers);
    } catch (error) {
      showToast(errorMessage(error));
    }
  }

  async function refreshDiagnostics() {
    try {
      const data = await api<{ diagnostics: SystemDiagnostics }>("/api/diagnostics");
      setDiagnostics(data.diagnostics);
    } catch (error) {
      showToast(errorMessage(error));
    }
  }

  async function testProviderConnection(providerId: ProviderId) {
    if (testingProvider) return;
    setTestingProvider(providerId);
    try {
      const data = await api<{ test: ProviderConnectionTest }>(`/api/providers/${encodeURIComponent(providerId)}/test`, {
        method: "POST",
        body: {},
      });
      setConnectionTest((current) => ({ ...current, [providerId]: data.test }));
      showToast(data.test.detail);
      await refreshProviders();
    } catch (error) {
      showToast(errorMessage(error));
    } finally {
      setTestingProvider(null);
    }
  }

  async function startProviderLogin(providerId: ProviderId) {
    try {
      const data = await api<{ login: ProviderLoginSession }>(`/api/providers/${encodeURIComponent(providerId)}/login`, {
        method: "POST",
        body: {},
      });
      setLoginSession(data.login);
    } catch (error) {
      showToast(errorMessage(error));
    }
  }

  async function cancelProviderLogin() {
    if (!loginSession) return;
    try {
      const data = await api<{ login: ProviderLoginSession }>(`/api/provider-logins/${encodeURIComponent(loginSession.id)}/cancel`, {
        method: "POST",
        body: {},
      });
      setLoginSession(data.login);
    } catch (error) {
      showToast(errorMessage(error));
    }
  }

  function saveProviderAlias(providerId: ProviderId, value: string) {
    const alias = value.slice(0, 40);
    setProviderAliases((current) => ({ ...current, [providerId]: alias }));
    if (alias.trim()) localStorage.setItem(providerAliasKey(deviceRef.current, providerId), alias.trim());
    else localStorage.removeItem(providerAliasKey(deviceRef.current, providerId));
  }

  async function copyText(text: string, success: string) {
    try {
      await navigator.clipboard.writeText(text);
      showToast(success);
    } catch {
      showToast("복사하지 못했습니다. 길게 눌러 직접 복사해 주세요.");
    }
  }

  function selectEffort(nextEffort: string) {
    setEffort(nextEffort);
    if (nextEffort) localStorage.setItem(storageKey("effort", deviceRef.current), nextEffort);
    else localStorage.removeItem(storageKey("effort", deviceRef.current));
  }

  async function createProject() {
    const name = newProjectName.trim();
    if (creatingProject) return;
    if (!name) {
      setProjectCreatorError("프로젝트 이름을 입력해 주세요.");
      return;
    }
    if (creationLocations.length === 0) {
      setProjectCreatorError("PC에 프로젝트 생성 위치가 없습니다. Linux Companion을 업데이트한 뒤 다시 연결해 주세요.");
      return;
    }
    setProjectCreatorError("");
    setCreatingProject(true);
    try {
      const data = await api<{ project: Workspace }>("/api/projects", {
        method: "POST",
        body: { name, parent: newProjectParent || undefined },
      });
      setWorkspaces((current) => [...current.filter((item) => item.path !== data.project.path), data.project]);
      setNewProjectName("");
      setShowProjectCreator(false);
      await selectWorkspace(data.project.path);
      showToast(`${deviceLabel(deviceRef.current)}에 ${data.project.name} 프로젝트를 만들었습니다.`);
    } catch (error) {
      const message = errorMessage(error);
      setProjectCreatorError(message);
      showToast(message);
    } finally {
      setCreatingProject(false);
    }
  }

  async function selectWorkspace(path: string) {
    if (operationRef.current) {
      showToast("현재 작업 상태를 확인한 뒤 프로젝트를 바꿔 주세요.");
      return;
    }
    setWorkspace(path);
    workspaceRef.current = path;
    localStorage.setItem(storageKey("workspace", deviceRef.current), path);
    setThreadId("");
    threadRef.current = "";
    localStorage.removeItem(storageKey("thread", deviceRef.current));
    setMessages([]);
    messagesRef.current = [];
    setJournalRestored(false);
    await loadThreads(path, false);
    await loadProjectHandoff(path);
  }

  async function selectThread(id: string) {
    if (operationRef.current) {
      showToast("현재 작업 상태를 확인한 뒤 대화를 바꿔 주세요.");
      return;
    }
    setThreadId(id);
    threadRef.current = id;
    if (id) localStorage.setItem(storageKey("thread", deviceRef.current), id);
    else localStorage.removeItem(storageKey("thread", deviceRef.current));
    setMessages([]);
    messagesRef.current = [];
    setJournalRestored(false);
    if (!id) return;
    try {
      const data = await api<{ thread: ThreadDetail }>(`/api/threads/${encodeURIComponent(id)}`);
      const restored = historyMessages(data.thread);
      messagesRef.current = restored;
      setMessages(restored);
    } catch (error) {
      showToast(errorMessage(error));
    }
  }

  function setHandsFreeMode(enabled: boolean) {
    handsFreeRef.current = enabled;
    setHandsFree(enabled);
  }

  async function startDictation(continuous: boolean) {
    if (dictating || handsFreeRef.current) return;
    dictationBaseRef.current = prompt.trim();
    nativeFinalRef.current = "";
    setHandsFreeMode(continuous);
    setDictating(true);
    textareaRef.current?.blur();

    if (isNativeApp()) {
      try {
        await NativeSpeech.start({
          language: speechLanguageRef.current,
          continuous,
        });
      } catch (error) {
        setHandsFreeMode(false);
        setDictating(false);
        showToast(`음성 인식 오류: ${errorMessage(error)}`);
      }
      return;
    }

    const recognition = recognitionRef.current;
    if (!recognition) {
      setHandsFreeMode(false);
      setDictating(false);
      return;
    }
    try {
      recognition.lang = speechLanguageRef.current;
      recognition.continuous = continuous;
      recognition.start();
    } catch (error) {
      setHandsFreeMode(false);
      setDictating(false);
      showToast(errorMessage(error));
    }
  }

  async function stopDictation() {
    setHandsFreeMode(false);
    setDictating(false);
    if (isNativeApp()) {
      try {
        await NativeSpeech.stop();
      } catch (error) {
        showToast(`음성 입력을 중지하지 못했습니다: ${errorMessage(error)}`);
      }
      return;
    }
    recognitionRef.current?.stop();
  }

  function clearLongPressTimer() {
    if (longPressTimerRef.current === null) return;
    window.clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = null;
  }

  function handleVoicePointerDown(event: ReactPointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    voiceWasActiveRef.current = dictating || handsFreeRef.current;
    longPressTriggeredRef.current = false;
    clearLongPressTimer();
    if (voiceWasActiveRef.current) return;
    longPressTimerRef.current = window.setTimeout(() => {
      longPressTimerRef.current = null;
      longPressTriggeredRef.current = true;
      void startDictation(true);
    }, 620);
  }

  function handleVoicePointerUp(event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const wasActive = voiceWasActiveRef.current;
    const wasLongPress = longPressTriggeredRef.current;
    clearLongPressTimer();
    voiceWasActiveRef.current = false;
    longPressTriggeredRef.current = false;
    if (wasActive) {
      void stopDictation();
    } else if (!wasLongPress) {
      void startDictation(false);
    }
  }

  function handleVoicePointerCancel() {
    clearLongPressTimer();
    voiceWasActiveRef.current = false;
  }

  async function submitPairing() {
    if (pairingBusy || pairingCode.replace(/\D/g, "").length !== 8) return;
    setPairingBusy(true);
    try {
      await pairActiveDevice(pairingCode, "Codex Pocket Android");
      setDeviceTargets(listDeviceTargets());
      setPairing(null);
      setPairingCode("");
      setPendingPocketLinkBootstrap(null);
      initializedRef.current = false;
      setAuthRevision((current) => current + 1);
      showToast("안전한 페어링이 완료되었습니다.");
    } catch (error) {
      showToast(errorMessage(error));
    } finally {
      setPairingBusy(false);
    }
  }

  function cancelPairing() {
    setPairing(null);
    setPairingCode("");
    setPendingPocketLinkBootstrap(null);
  }

  async function refreshPocketLinkStatuses(targets = listDeviceTargets()) {
    if (!isNativeApp()) {
      setPocketLinkStatuses({});
      return;
    }
    const statuses = await Promise.all(targets
      .filter((target) => target.kind === "linux" && target.transport === "pocketlink")
      .map(async (target) => {
        try {
          return [target.id, await NativeTunnel.status({ localPort: deviceTargetLocalPort(target) })] as const;
        } catch {
          return [target.id, {
            configured: true,
            running: false,
            transport: "pocketlink",
            error: "상태를 확인할 수 없습니다.",
          } satisfies PocketLinkStatus] as const;
        }
      }));
    setPocketLinkStatuses(Object.fromEntries(statuses));
  }

  function reviewPocketLinkPinPromotion(target: DeviceTarget) {
    if (pocketLinkStatuses[target.id]?.identityRotationPending) {
      showToast("단말 identity key 교체를 먼저 완료하거나 중단해 주세요.");
      return;
    }
    if (!isRecentBackupPinObservation(pocketLinkStatuses[target.id])) {
      showToast("최근 2분 안에 교체용 pin으로 성공한 연결을 먼저 확인해 주세요.");
      void refreshPocketLinkStatuses(deviceTargets);
      return;
    }
    setStagingPinTarget(null);
    setStagedBackupPin("");
    setReviewingIdentityRotationTarget(null);
    setConfirmingPinPromotionTarget(target.id);
  }

  function openPocketLinkPinStaging(target: DeviceTarget) {
    if (pocketLinkStatuses[target.id]?.identityRotationPending) {
      showToast("단말 identity key 교체를 먼저 완료하거나 중단해 주세요.");
      return;
    }
    setConfirmingPinPromotionTarget(null);
    setReviewingIdentityRotationTarget(null);
    setStagingPinTarget(target.id);
    setStagedBackupPin("");
  }

  function closePocketLinkPinStaging() {
    if (stagingPinBusy) return;
    setStagingPinTarget(null);
    setStagedBackupPin("");
  }

  async function stagePocketLinkBackupPin(target: DeviceTarget) {
    if (stagingPinBusy || !isPocketLinkPin(stagedBackupPin)) return;
    setStagingPinBusy(true);
    try {
      const result = await NativeTunnel.stagePocketLinkBackupPin({
        localPort: deviceTargetLocalPort(target),
        backupPin: stagedBackupPin,
      });
      if (!result.staged) throw new Error("교체용 PocketLink pin 저장 결과를 확인할 수 없습니다.");
      setStagingPinTarget(null);
      setStagedBackupPin("");
      await refreshPocketLinkStatuses(deviceTargets);
      showToast(`${target.name}에 교체용 pin을 준비했습니다. 현재 기본 pin은 그대로 유지됩니다.`);
    } catch (error) {
      showToast(errorMessage(error));
    } finally {
      setStagingPinBusy(false);
    }
  }

  async function clearPocketLinkBackupPin(target: DeviceTarget) {
    if (stagingPinBusy) return;
    setStagingPinBusy(true);
    try {
      const result = await NativeTunnel.clearPocketLinkBackupPin({ localPort: deviceTargetLocalPort(target) });
      if (!result.cleared || !result.retainedPrimaryPin) {
        throw new Error("교체용 PocketLink pin 준비 취소 결과를 확인할 수 없습니다.");
      }
      setStagingPinTarget(null);
      setStagedBackupPin("");
      await refreshPocketLinkStatuses(deviceTargets);
      showToast(`${target.name}의 교체용 pin만 제거했습니다. 현재 기본 pin은 유지됩니다.`);
    } catch (error) {
      showToast(errorMessage(error));
    } finally {
      setStagingPinBusy(false);
    }
  }

  async function promotePocketLinkPin(target: DeviceTarget) {
    if (promotingPinTarget) return;
    setPromotingPinTarget(target.id);
    try {
      const result = await NativeTunnel.promotePocketLinkPin({ localPort: deviceTargetLocalPort(target) });
      if (!result.promoted || !result.retiredPreviousPin) {
        throw new Error("PocketLink pin 교체 결과를 확인할 수 없습니다.");
      }
      setConfirmingPinPromotionTarget(null);
      await refreshPocketLinkStatuses(deviceTargets);
      showToast(`${target.name}의 새 pin을 확정하고 이전 pin을 폐기했습니다.`);
    } catch (error) {
      showToast(errorMessage(error));
      await refreshPocketLinkStatuses(deviceTargets);
    } finally {
      setPromotingPinTarget(null);
    }
  }

  function reviewPocketLinkIdentityRotation(target: DeviceTarget) {
    if (target.id !== deviceRef.current) {
      showToast("위의 ‘확인할 단말’에서 이 Companion을 먼저 선택해 주세요.");
      return;
    }
    if (!target.remoteDeviceId) {
      showToast("단말 identity key 교체 전에 Companion 페어링을 완료해 주세요.");
      return;
    }
    setStagingPinTarget(null);
    setStagedBackupPin("");
    setConfirmingPinPromotionTarget(null);
    setReviewingIdentityRotationTarget(target.id);
  }

  async function waitForPocketLinkIdentity(target: DeviceTarget, pending: boolean): Promise<PocketLinkStatus> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const status = await NativeTunnel.status({ localPort: deviceTargetLocalPort(target) });
      setPocketLinkStatuses((current) => ({ ...current, [target.id]: status }));
      if (status.identityRotationPending === pending && status.identityReady
          && (!pending || status.identityRotationReady)) return status;
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    }
    throw new Error("PocketLink 단말 identity 전환 준비가 끝나지 않았습니다.");
  }

  async function commitLocalPocketLinkIdentityRotation(target: DeviceTarget): Promise<void> {
    const committed = await NativeTunnel.commitPocketLinkIdentityRotation({
      localPort: deviceTargetLocalPort(target),
    });
    if (!committed.committed || !committed.retiredPreviousIdentity) {
      throw new Error("Android의 이전 PocketLink 단말 identity 폐기를 확인할 수 없습니다.");
    }
    await waitForPocketLinkIdentity(target, false);
    await clearActiveDeviceIdentityRotation();
  }

  async function abortLocalPocketLinkIdentityRotation(target: DeviceTarget): Promise<void> {
    const aborted = await NativeTunnel.abortPocketLinkIdentityRotation({
      localPort: deviceTargetLocalPort(target),
    });
    if (!aborted.aborted || !aborted.retainedPreviousIdentity) {
      throw new Error("Android의 기존 PocketLink 단말 identity 복구를 확인할 수 없습니다.");
    }
    await waitForPocketLinkIdentity(target, false);
    await clearActiveDeviceIdentityRotation();
  }

  function pocketLinkIdentityRotationPorts(target: DeviceTarget): PocketLinkIdentityRotationPorts {
    return {
      hasStoredApproval: async () => Boolean(await loadActiveDeviceIdentityRotation()),
      waitForPendingIdentity: async () => { await waitForPocketLinkIdentity(target, true); },
      inspectRemote: inspectActiveDeviceIdentityRotation,
      completeRemote: completeActiveDeviceIdentityRotation,
      finalizeRemote: finalizeActiveDeviceIdentityRotation,
      abortRemote: async () => { await abortActiveDeviceIdentityRotation(); },
      isNewIdentityAuthorized: async () => {
        try {
          await api<{ ok: boolean }>("/api/health");
          return true;
        } catch (error) {
          if (error instanceof PocketLinkIdentityRotationRequiredError) return false;
          throw error;
        }
      },
      commitLocal: async () => { await commitLocalPocketLinkIdentityRotation(target); },
      abortLocal: async () => { await abortLocalPocketLinkIdentityRotation(target); },
    };
  }

  async function beginPocketLinkIdentityRotation(target: DeviceTarget) {
    if (rotatingIdentityTarget) return;
    if (target.id !== deviceRef.current) {
      showToast("위의 ‘확인할 단말’에서 이 Companion을 먼저 선택해 주세요.");
      return;
    }
    setRotatingIdentityTarget(target.id);
    setReviewingIdentityRotationTarget(null);
    try {
      const status = await NativeTunnel.status({ localPort: deviceTargetLocalPort(target) });
      if (!status.identityRotationPending) {
        await waitForPocketLinkIdentity(target, false);
        if (!await loadActiveDeviceIdentityRotation()) await beginActiveDeviceIdentityRotation();
        const prepared = await NativeTunnel.preparePocketLinkIdentityRotation({
          localPort: deviceTargetLocalPort(target),
        });
        if (!prepared.prepared) throw new Error("새 PocketLink 단말 identity 준비 결과를 확인할 수 없습니다.");
      }
      const result = await finishPocketLinkIdentityRotationFlow(pocketLinkIdentityRotationPorts(target));
      initializedRef.current = false;
      setAuthRevision((current) => current + 1);
      showToast(result === "completed"
        ? `${target.name}의 단말 key를 교체하고 이전 key를 폐기했습니다.`
        : `${target.name}의 만료된 key 교체를 중단하고 기존 key를 복구했습니다.`);
    } catch (error) {
      await refreshPocketLinkStatuses(deviceTargets);
      showToast(`${errorMessage(error)} 연결 센터에서 교체 상태를 다시 확인할 수 있습니다.`);
    } finally {
      setRotatingIdentityTarget(null);
    }
  }

  async function abortPocketLinkIdentityRotation(target: DeviceTarget) {
    if (rotatingIdentityTarget) return;
    if (target.id !== deviceRef.current) {
      showToast("위의 ‘확인할 단말’에서 이 Companion을 먼저 선택해 주세요.");
      return;
    }
    setRotatingIdentityTarget(target.id);
    try {
      const result = await abortPocketLinkIdentityRotationFlow(pocketLinkIdentityRotationPorts(target));
      initializedRef.current = false;
      setAuthRevision((current) => current + 1);
      showToast(result === "completed"
        ? `${target.name}에서 이미 승인된 새 단말 key를 확정했습니다.`
        : `${target.name}의 key 교체를 중단하고 기존 단말 key를 유지했습니다.`);
    } catch (error) {
      await refreshPocketLinkStatuses(deviceTargets);
      showToast(errorMessage(error));
    } finally {
      setRotatingIdentityTarget(null);
    }
  }

  async function scanPocketLinkQr() {
    if (!isNativeApp() || scanningPocketLinkQr) return;
    setScanningPocketLinkQr(true);
    try {
      const result = await NativeTunnel.scanPocketLinkQr();
      if (result.cancelled || !result.value) return;
      const bootstrap = parsePocketLinkBootstrapUri(result.value);
      setNewDeviceTransport("pocketlink");
      setNewDeviceName(bootstrap.deviceName);
      setNewPocketLinkHost(bootstrap.host);
      setNewPocketLinkPort(String(bootstrap.port));
      setNewPocketLinkPin(bootstrap.serverPublicKeyPin);
      setNewPocketLinkBackupPin("");
      setPendingPocketLinkBootstrap(bootstrap);
      showToast("PocketLink QR을 읽었습니다. PC 정보와 pin을 확인한 뒤 등록하세요.");
    } catch (error) {
      setPendingPocketLinkBootstrap(null);
      showToast(errorMessage(error));
    } finally {
      setScanningPocketLinkQr(false);
    }
  }

  async function createLinuxDevice() {
    let target: DeviceTarget | null = null;
    let configuredPocketLinkPort: number | null = null;
    try {
      const localPort = Number(newDevicePort);
      const qrBootstrap = newDeviceTransport === "pocketlink"
        && matchesPocketLinkConnection(
          pendingPocketLinkBootstrap,
          newPocketLinkHost,
          Number(newPocketLinkPort),
          newPocketLinkPin,
        ) ? pendingPocketLinkBootstrap : null;
      target = await addLinuxDevice(newDeviceName, localPort, newDeviceTransport);
      if (newDeviceTransport === "pocketlink") {
        if (!isNativeApp()) throw new Error("PocketLink 등록은 Android 앱에서만 할 수 있습니다.");
        await NativeTunnel.configurePocketLink({
          label: newDeviceName,
          localPort,
          host: newPocketLinkHost,
          remotePort: Number(newPocketLinkPort),
          primaryPin: newPocketLinkPin,
          backupPin: newPocketLinkBackupPin || undefined,
        });
        configuredPocketLinkPort = localPort;
      }
      setPendingPocketLinkBootstrap(qrBootstrap ? { ...qrBootstrap, targetId: target.id } : null);
      setDeviceTargets(listDeviceTargets());
      setNewDeviceName("");
      setNewDevicePort(String(Number(newDevicePort) + 1));
      setNewPocketLinkHost("");
      setNewPocketLinkPin("");
      setNewPocketLinkBackupPin("");
      setShowDeviceCreator(false);
      selectDevice(target.id);
      showToast(newDeviceTransport === "pocketlink"
        ? `${target.name}의 인증서 pin을 고정했습니다. Companion 페어링 코드를 입력하세요.`
        : `${target.name}을 등록했습니다. 로컬 터널을 연결한 뒤 페어링하세요.`);
    } catch (error) {
      if (configuredPocketLinkPort !== null) {
        await NativeTunnel.removePocketLink({ localPort: configuredPocketLinkPort }).catch(() => undefined);
      }
      if (target) await removeDeviceTarget(target.id).catch(() => undefined);
      showToast(errorMessage(error));
    }
  }

  async function deleteLinuxDevice(target: DeviceTarget) {
    try {
      if (target.transport === "pocketlink" && isNativeApp()) {
        await NativeTunnel.removePocketLink({ localPort: deviceTargetLocalPort(target) });
      }
      await removeDeviceTarget(target.id);
      if (deviceRef.current === target.id) selectDevice(listDeviceTargets()[0]!.id);
      const remainingTargets = listDeviceTargets();
      setDeviceTargets(remainingTargets);
      setPocketLinkStatuses((current) => {
        const remaining = { ...current };
        delete remaining[target.id];
        return remaining;
      });
      setConfirmingPinPromotionTarget((current) => current === target.id ? null : current);
      setReviewingIdentityRotationTarget((current) => current === target.id ? null : current);
      setStagingPinTarget((current) => current === target.id ? null : current);
      if (stagingPinTarget === target.id) setStagedBackupPin("");
      showToast(`${target.name} 등록을 삭제했습니다.`);
    } catch (error) {
      showToast(errorMessage(error));
    }
  }

  async function decideApproval(approval: ApprovalItem, decision: "approved" | "declined") {
    if (decidingApprovalId) return;
    setDecidingApprovalId(approval.id);
    try {
      const data = await api<{ approval: ApprovalItem; resolution: ApprovalResolution }>(
        `/api/approvals/${encodeURIComponent(approval.id)}/decision`,
        { method: "POST", body: { decision } },
      );
      setApprovalInbox((current) => applyApprovalEvent(current, {
        type: "approval",
        action: "resolved",
        approval: data.approval,
        resolution: data.resolution,
      }));
      showToast(decision === "approved" ? "검토한 도구 실행을 승인했습니다." : "도구 실행을 거절했습니다.");
    } catch (error) {
      await refreshOperationalSnapshot(true);
      showToast(errorMessage(error));
    } finally {
      setDecidingApprovalId(null);
    }
  }

  async function exportCompanionJournal(targetWorkspace: string) {
    if (exportingWorkspace || deletingWorkspace) return;
    setExportingWorkspace(targetWorkspace);
    let objectUrl = "";
    try {
      const blob = await apiBlob(`/api/journal/export?workspace=${encodeURIComponent(targetWorkspace)}`);
      objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = `codex-pocket-${safeFilename(workspaceName(targetWorkspace))}-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      showToast("이 프로젝트의 Companion 실행 기록을 JSON으로 내보냈습니다.");
    } catch (error) {
      showToast(errorMessage(error));
    } finally {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setExportingWorkspace(null);
    }
  }

  async function deleteCompanionJournal(targetWorkspace: string) {
    if (deletingWorkspace || exportingWorkspace) return;
    setDeletingWorkspace(targetWorkspace);
    try {
      const data = await api<{ deletedOperations: number; deletedEvents: number }>("/api/journal/workspace", {
        method: "DELETE",
        body: { workspace: targetWorkspace, confirm: "delete-companion-history" },
      });
      setOperationSnapshots((current) => current.filter((item) => item.cwd !== targetWorkspace));
      setApprovalInbox((current) => current.filter((item) => item.cwd !== targetWorkspace));
      const current = operationRef.current;
      if (current?.cwd === targetWorkspace && current.status !== "running"
        && (current.status !== "unknown" || current.acknowledgedAt)) {
        operationRef.current = null;
        setOperation(null);
        stopRunning();
      }
      showToast(`Companion 기록 ${data.deletedOperations}건과 이벤트 ${data.deletedEvents}건을 삭제했습니다.`);
    } catch (error) {
      showToast(errorMessage(error));
    } finally {
      setDeletingWorkspace(null);
    }
  }

  function openOperationFromDashboard(nextOperation: Operation) {
    const nextProvider = nextOperation.providerId ?? "codex";
    const nextThread = nextProvider === "codex"
      ? nextOperation.threadId ?? nextOperation.conversationId ?? ""
      : "";
    stopRunning();
    operationRef.current = null;
    setOperation(null);
    liveMessageIdRef.current = null;
    liveTextRef.current = "";
    latestDiffRef.current = "";

    setProvider(nextProvider);
    providerRef.current = nextProvider;
    localStorage.setItem(storageKey("provider", deviceRef.current), nextProvider);
    setAccountId(nextOperation.accountId ?? "");
    if (nextOperation.accountId) {
      localStorage.setItem(storageKey("account", deviceRef.current), nextOperation.accountId);
    }
    setModel(nextOperation.model ?? "");
    setEffort(nextOperation.effort ?? "");
    setNetworkAccess(nextOperation.networkAccess === true);
    setWorkspace(nextOperation.cwd);
    workspaceRef.current = nextOperation.cwd;
    localStorage.setItem(storageKey("workspace", deviceRef.current), nextOperation.cwd);
    setThreadId(nextThread);
    threadRef.current = nextThread;
    if (nextThread) localStorage.setItem(storageKey("thread", deviceRef.current), nextThread);
    else localStorage.removeItem(storageKey("thread", deviceRef.current));
    setThreads((current) => current.filter((item) => item.cwd === nextOperation.cwd));
    setHandoff(null);
    setJournalRestored(false);

    const assistantId = newId("operation-assistant");
    const terminalText = nextOperation.status === "failed"
      ? `작업 실패: ${nextOperation.error || "알 수 없는 오류"}`
      : nextOperation.status === "unknown"
        ? nextOperation.error || "Companion 재시작 전 작업의 최종 상태를 확인할 수 없습니다."
        : nextOperation.result?.finalResponse || statusMessage(nextOperation.status);
    const restored: ChatMessage[] = [
      { id: newId("operation-user"), role: "user", text: nextOperation.prompt },
      {
        id: assistantId,
        role: "assistant",
        text: nextOperation.status === "running" ? "" : terminalText,
        pending: nextOperation.status === "running",
        error: nextOperation.status === "failed" || nextOperation.status === "unknown",
        details: nextOperation.status === "running" ? undefined : buildResultDetails(nextOperation.result ?? {}) || undefined,
      },
    ];
    messagesRef.current = restored;
    setMessages(restored);

    if (nextOperation.status === "running") {
      liveMessageIdRef.current = assistantId;
      operationRef.current = nextOperation;
      setOperation(nextOperation);
      handleOperationEvent("started", nextOperation);
    } else if (nextOperation.status === "unknown" && !nextOperation.acknowledgedAt) {
      operationRef.current = nextOperation;
      setOperation(nextOperation);
      handleOperationEvent("recovered", nextOperation);
    }
    setShowOperationsDashboard(false);
    if (nextProvider === "codex") void loadProjectHandoff(nextOperation.cwd);
    void api<ModelResponse>(`/api/models?provider=${encodeURIComponent(nextProvider)}`)
      .then((data) => {
        if (providerRef.current === nextProvider) setModels(data.models);
      })
      .catch(() => undefined);
  }

  const pendingApprovalCount = activeApprovals(approvalInbox).length;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">C</span>
          <div>
            <h1>Codex Pocket</h1>
            <p>{connectionText}</p>
          </div>
        </div>
        <div className="top-actions">
          <button
            className="icon-button operations-button"
            type="button"
            aria-label="프로젝트 작업 대시보드 열기"
            title="이 PC의 프로젝트별 작업과 승인"
            onClick={() => {
              setShowOperationsDashboard(true);
              void refreshOperationalSnapshot(true);
            }}
          >
            <span aria-hidden="true">▤</span>
            {pendingApprovalCount > 0 && <b aria-label={`승인 필요 ${pendingApprovalCount}건`}>{Math.min(99, pendingApprovalCount)}</b>}
          </button>
          <button
            className="icon-button handoff-button"
            type="button"
            aria-label="선택한 프로젝트의 현재 세션 반납"
            title={handoffSupported ? `${workspaceName(workspace)} · ${selectedWorkspaceIdentityText} 세션 반납` : "Companion 1.8.0 이상에서 사용할 수 있습니다"}
            disabled={!handoffSupported || handoffBusy || (!threadId && !operationBelongsToSession(operation, workspace, threadId))}
            onClick={() => {
              setShowHandoffDialog(true);
              void refreshOperationalSnapshot(true);
            }}
          >⇥</button>
          <button
            className="icon-button"
            type="button"
            aria-label="AI 연결 센터 열기"
            title="AI 연결 센터"
            onClick={() => {
              setShowConnectionCenter(true);
              void refreshProviders();
              void refreshDiagnostics();
            }}
          >◎</button>
          <button
            className={`icon-button selector-toggle${controlsCollapsed ? " collapsed" : ""}`}
            type="button"
            aria-label={controlsCollapsed ? "프로젝트와 대화 선택 열기" : "프로젝트와 대화 선택 닫기"}
            aria-expanded={!controlsCollapsed}
            onClick={() => setControlsCollapsed((current) => !current)}
          >
            <span aria-hidden="true">⌃</span>
          </button>
          {installPrompt && (
            <button className="icon-button" type="button" aria-label="홈 화면에 설치" onClick={() => {
              void installPrompt.prompt();
              setInstallPrompt(null);
            }}>＋</button>
          )}
          <span className={`status-dot ${connection}`} aria-hidden="true" />
        </div>
      </header>

      {showOperationsDashboard && (
        <OperationsDashboard
          deviceName={deviceLabel(device)}
          operations={operationSnapshots}
          approvals={approvalInbox}
          workspaces={workspaces}
          queuedCount={promptQueue.length}
          decidingApprovalId={decidingApprovalId}
          journalPolicy={journalPolicy}
          exportingWorkspace={exportingWorkspace}
          deletingWorkspace={deletingWorkspace}
          onClose={() => setShowOperationsDashboard(false)}
          onRefresh={() => void refreshOperationalSnapshot(false)}
          onOpenOperation={openOperationFromDashboard}
          onDecision={(approval, decision) => void decideApproval(approval, decision)}
          onExportWorkspace={exportCompanionJournal}
          onDeleteWorkspaceHistory={deleteCompanionJournal}
        />
      )}

      {pairing && (
        <section className="pairing-dialog" role="dialog" aria-modal="true" aria-labelledby="pairing-title">
          <div className="pairing-card">
            <span className="pairing-lock" aria-hidden="true">⌁</span>
            <h2 id="pairing-title">{pairing.device.name} 페어링</h2>
            <p>Companion 터미널에 표시된 8자리 코드를 입력하세요. 코드는 10분 동안만 유효합니다.</p>
            <input
              value={pairingCode}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={9}
              placeholder="0000 0000"
              aria-label="8자리 페어링 코드"
              onChange={(event) => setPairingCode(formatPairingCode(event.target.value))}
              onKeyDown={(event) => { if (event.key === "Enter") void submitPairing(); }}
            />
            <div className="pairing-actions">
              <button type="button" disabled={pairingBusy || pairingCode.replace(/\D/g, "").length !== 8} onClick={() => void submitPairing()}>
                {pairingBusy ? "확인 중…" : "안전하게 연결"}
              </button>
              <button type="button" className="secondary" disabled={pairingBusy} onClick={cancelPairing}>나중에</button>
            </div>
            <small>장치 ID {pairing.device.id.slice(0, 8)} · 인증정보는 이 기기의 보안 저장소에 보관됩니다.</small>
          </div>
        </section>
      )}

      {showHandoffDialog && (
        <section className="project-dialog" role="dialog" aria-modal="true" aria-labelledby="handoff-dialog-title">
          <div className="project-dialog-card handoff-dialog-card">
            <div className="project-dialog-head">
              <div>
                <strong id="handoff-dialog-title">{workspaceName(workspace)} 프로젝트 세션 반납</strong>
                <small>아래의 정확한 연결 대상만 이 기기에서 분리합니다.</small>
              </div>
              <button type="button" aria-label="닫기" onClick={() => setShowHandoffDialog(false)}>×</button>
            </div>
            <div className="handoff-summary">
              <span><strong>프로젝트</strong>{workspaceName(workspace)}</span>
              <span><strong>정확한 경로</strong><code>{workspace}</code></span>
              <span><strong>브랜치</strong>{selectedWorkspaceIdentityText}</span>
              <span><strong>대화</strong>{threadId ? short(threads.find((item) => item.id === threadId)?.name || threads.find((item) => item.id === threadId)?.preview || threadId, 42) : "새 대화"}</span>
              <span><strong>PC 작업</strong>{operationBelongsToSession(operation, workspace, threadId) && operation?.status === "running"
                ? "반납 후에도 계속 실행"
                : "현재 실행 중인 작업 없음"}</span>
            </div>
            {promptQueue.length > 0 && (
              <p className="project-dialog-error">대기열 {promptQueue.length}건은 이 기기에만 저장되어 있습니다. 먼저 실행하거나 취소해야 안전하게 반납할 수 있습니다.</p>
            )}
            <button className="create-project-button" type="button" disabled={handoffBusy || promptQueue.length > 0} onClick={() => void releaseSession()}>
              {handoffBusy ? "반납 중…" : "세션 반납"}
            </button>
            <p className="handoff-note">‘작업 중단’과 다릅니다. 위 프로젝트의 모바일 연결만 반납하며 실행 중인 Codex는 PC에서 계속됩니다.</p>
          </div>
        </section>
      )}

      <section className={`selectors${controlsCollapsed ? " collapsed" : ""}`} aria-label="작업 대상" aria-hidden={controlsCollapsed}>
        <label>
          <span>{tr("target")}</span>
          <select
            value={device}
            disabled={operation !== null || controlsCollapsed}
            aria-label="Codex 실행 단말 선택"
            onChange={(event) => selectDevice(event.target.value as DeviceId)}
          >
            {deviceTargets.map((target) => <option key={target.id} value={target.id}>{target.name}</option>)}
          </select>
        </label>
        <label>
          <span>{tr("provider")}</span>
          <select
            value={provider}
            disabled={operation !== null || controlsCollapsed}
            aria-label="AI 제공자 선택"
            title={activeProvider(providers, provider)?.detail}
            onChange={(event) => void selectProvider(event.target.value as ProviderId)}
          >
            {providers.length === 0 && <option value="codex">OpenAI Codex</option>}
            {providers.map((item) => (
              <option key={item.id} value={item.id} disabled={!item.available}>
                {item.name}{item.available ? "" : item.status === "not_installed" ? " · 설치 필요" : " · 연결 준비 중"}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>{tr("project")}</span>
          <div className="select-row">
            <select value={workspace} disabled={operation !== null || controlsCollapsed} aria-label="프로젝트 선택" onChange={(event) => void selectWorkspace(event.target.value)}>
              {workspaces.length === 0 && <option value="">{tr("noProject")}</option>}
              {workspaces.map((item) => <option key={item.path} value={item.path}>{item.name}</option>)}
            </select>
            <button
              className="icon-button"
              type="button"
              disabled={operation !== null || controlsCollapsed}
              aria-label={`${deviceLabel(device)}에 새 프로젝트 만들기`}
              onClick={() => {
                setProjectCreatorError(creationLocations.length === 0
                  ? "PC에 프로젝트 생성 위치가 없습니다. Linux Companion을 업데이트한 뒤 다시 연결해 주세요."
                  : "");
                setShowProjectCreator(true);
              }}
            >＋</button>
          </div>
        </label>
        <label>
          <span>{tr("conversation")}</span>
          <div className="select-row">
            <select value={threadId} disabled={operation !== null || controlsCollapsed} aria-label="Codex 대화 선택" onChange={(event) => void selectThread(event.target.value)}>
              <option value="">{tr("newConversation")}</option>
              {threads.map((thread) => (
                <option key={thread.id} value={thread.id}>{short(thread.name || thread.preview || tr("unnamed"), 42)}</option>
              ))}
            </select>
            <button className="icon-button" type="button" disabled={operation !== null || controlsCollapsed} aria-label="대화 새로고침" onClick={() => void loadThreads(workspaceRef.current, true)}>↻</button>
          </div>
        </label>
      </section>

      {showConnectionCenter && (
        <section className="connection-center" role="dialog" aria-modal="true" aria-labelledby="connection-center-title">
          <div className="connection-center-sheet">
            <div className="connection-center-head">
              <div>
                <strong id="connection-center-title">AI 연결 센터</strong>
                <small>비밀번호 입력 없이 CLI 계정을 연결합니다.</small>
              </div>
              <button type="button" aria-label="닫기" onClick={closeConnectionCenter}>×</button>
            </div>

            <label className="connection-device">
              <span>확인할 단말</span>
              <select value={device} disabled={activity.running || rotatingIdentityTarget !== null} onChange={(event) => selectDevice(event.target.value as DeviceId)}>
                {deviceTargets.map((target) => <option key={target.id} value={target.id}>{target.name}</option>)}
              </select>
            </label>

            <section className="preference-grid" aria-label="언어 설정">
              <label>
                <span>{tr("uiLanguage")}</span>
                <select value={uiLanguage} onChange={(event) => setUiLanguage(event.target.value as UiLanguage)}>
                  <option value="ko">한국어</option>
                  <option value="en">English</option>
                </select>
              </label>
              <label>
                <span>{tr("speechLanguage")}</span>
                <select value={speechLanguage} onChange={(event) => setSpeechLanguage(event.target.value)}>
                  <option value="ko-KR">한국어 · 대한민국</option>
                  <option value="en-US">English · United States</option>
                  <option value="en-GB">English · United Kingdom</option>
                  <option value="ja-JP">日本語</option>
                  <option value="zh-CN">中文 · 简体</option>
                  <option value="es-ES">Español</option>
                </select>
              </label>
            </section>

            {diagnostics && (
              <section className={`diagnostics ${diagnostics.ok ? "ok" : "warning"}`}>
                <div className="diagnostics-head">
                  <strong>{tr("diagnostics")}</strong>
                  <small>{diagnostics.platform} {diagnostics.architecture} · Node {diagnostics.nodeVersion}</small>
                </div>
                <div className="diagnostic-tools">
                  {diagnostics.tools.map((tool) => (
                    <span className={tool.available ? "available" : "missing"} key={tool.id} title={tool.version}>
                      {tool.available ? "✓" : "!"} {tool.label} · {tool.available ? tr("connected") : tr("missing")}
                    </span>
                  ))}
                </div>
              </section>
            )}

            <section className="device-manager" aria-label="실행 단말 관리">
              <div className="device-manager-head">
                <div><strong>Linux Companion</strong><small>여러 PC는 서로 다른 로컬 터널 포트로 등록합니다.</small></div>
                <div className="device-manager-actions">
                  {isNativeApp() && <button type="button" onClick={() => void refreshPocketLinkStatuses(deviceTargets)}>↻ 상태</button>}
                  <button type="button" onClick={() => setShowDeviceCreator((current) => !current)}>＋ PC</button>
                </div>
              </div>
              {showDeviceCreator && (
                <div className="device-create-card">
                  <select value={newDeviceTransport} aria-label="Linux PC 연결 방식" onChange={(event) => setNewDeviceTransport(event.target.value as "termux" | "pocketlink") }>
                    <option value="termux">Termux / SSH · rollback</option>
                    {isNativeApp() && <option value="pocketlink">PocketLink · TLS pin 고정</option>}
                  </select>
                  {isNativeApp() && (
                    <button type="button" className="pocket-link-qr-scan" disabled={scanningPocketLinkQr} onClick={() => void scanPocketLinkQr()}>
                      {scanningPocketLinkQr ? "QR 카메라 여는 중…" : "PocketLink QR 스캔"}
                    </button>
                  )}
                  <div className="device-create-row">
                    <input value={newDeviceName} maxLength={60} placeholder="예: 작업실 PC" aria-label="Linux PC 이름" onChange={(event) => setNewDeviceName(event.target.value)} />
                    <input value={newDevicePort} inputMode="numeric" maxLength={5} placeholder="8790" aria-label="로컬 터널 포트" onChange={(event) => setNewDevicePort(event.target.value.replace(/\D/g, ""))} />
                    {newDeviceTransport === "termux" && <button type="button" onClick={() => void createLinuxDevice()}>등록</button>}
                  </div>
                  {newDeviceTransport === "pocketlink" && (
                    <div className="pocket-link-fields">
                      {pendingPocketLinkBootstrap && (
                        <div className="pocket-link-qr-review">
                          <strong>QR에서 읽음 · 반드시 PC 화면과 대조</strong>
                          <small>장치 {pendingPocketLinkBootstrap.deviceId.slice(0, 8)} · {new Date(pendingPocketLinkBootstrap.expiresAt).toLocaleTimeString()} 만료</small>
                        </div>
                      )}
                      <input value={newPocketLinkHost} maxLength={253} autoCapitalize="none" spellCheck={false} placeholder="Companion LAN 호스트" aria-label="PocketLink Companion 호스트" onChange={(event) => setNewPocketLinkHost(event.target.value)} />
                      <input value={newPocketLinkPort} inputMode="numeric" maxLength={5} placeholder="8789" aria-label="PocketLink TLS 포트" onChange={(event) => setNewPocketLinkPort(event.target.value.replace(/\D/g, ""))} />
                      <input className="pin" value={newPocketLinkPin} maxLength={51} autoCapitalize="none" spellCheck={false} placeholder="sha256/… 기본 SPKI pin" aria-label="PocketLink 기본 SPKI pin" onChange={(event) => setNewPocketLinkPin(event.target.value.trim())} />
                      <input className="pin" value={newPocketLinkBackupPin} maxLength={51} autoCapitalize="none" spellCheck={false} placeholder="sha256/… 교체용 pin · 선택" aria-label="PocketLink 교체용 SPKI pin" onChange={(event) => setNewPocketLinkBackupPin(event.target.value.trim())} />
                      <button type="button" onClick={() => void createLinuxDevice()}>pin 확인 후 등록</button>
                    </div>
                  )}
                  <small>{newDeviceTransport === "pocketlink"
                    ? "Companion 터미널 QR을 스캔하거나 호스트·포트·SPKI pin을 직접 입력합니다. QR 결과는 등록 전 다시 보여주며 설정은 Keystore로 보호되고 SSH로 자동 우회하지 않습니다."
                    : "현재 검증된 Termux/SSH 연결을 rollback 호환 경로로 유지합니다."}</small>
                </div>
              )}
              <div className="device-list">
                {deviceTargets.filter((target) => target.kind === "linux").map((target) => {
                  const pocketLinkStatus = target.transport === "pocketlink" ? pocketLinkStatuses[target.id] : undefined;
                  const canReviewPinPromotion = isRecentBackupPinObservation(pocketLinkStatus);
                  const stagingPin = stagingPinTarget === target.id;
                  const confirmingPinPromotion = confirmingPinPromotionTarget === target.id;
                  const identityRotationPending = pocketLinkStatus?.identityRotationPending === true;
                  const reviewingIdentityRotation = reviewingIdentityRotationTarget === target.id;
                  const rotatingIdentity = rotatingIdentityTarget === target.id;
                  return (
                    <div key={target.id}>
                      <div className="device-list-row">
                        <span>
                          <strong>{target.name}</strong>
                          <small>
                            {target.transport === "pocketlink" ? pocketLinkSecurityStatus(pocketLinkStatus) : "Termux / SSH"}
                            {target.transport === "pocketlink" && pocketLinkStatus?.backupPinConfigured && !canReviewPinPromotion ? " · 교체 pin 준비됨" : ""}
                            {identityRotationPending ? " · 단말 key 교체 확인 필요" : ""}
                            {` · ${target.baseUrl || "현재 주소"}`}{target.remoteDeviceId ? ` · ${target.remoteDeviceId.slice(0, 8)}` : " · 미페어링"}
                          </small>
                        </span>
                        <div className="device-list-actions">
                          {canReviewPinPromotion && !confirmingPinPromotion && !identityRotationPending && !reviewingIdentityRotation && (
                            <button type="button" className="pin-promotion" onClick={() => reviewPocketLinkPinPromotion(target)}>새 pin 교체 검토</button>
                          )}
                          {isNativeApp() && target.transport === "pocketlink" && !canReviewPinPromotion && !stagingPin && !identityRotationPending && !reviewingIdentityRotation && (
                            <button type="button" className="pin-promotion" onClick={() => openPocketLinkPinStaging(target)}>
                              {pocketLinkStatus?.backupPinConfigured ? "교체 pin 변경" : "교체 pin 준비"}
                            </button>
                          )}
                          {isNativeApp() && target.transport === "pocketlink" && target.remoteDeviceId
                              && !identityRotationPending && !reviewingIdentityRotation && !stagingPin && !confirmingPinPromotion
                              && !canReviewPinPromotion && (
                            <button type="button" className="identity-rotation" onClick={() => reviewPocketLinkIdentityRotation(target)}>단말 key 교체</button>
                          )}
                          {identityRotationPending && (
                            <button type="button" className="identity-rotation" disabled={rotatingIdentityTarget !== null} onClick={() => void beginPocketLinkIdentityRotation(target)}>
                              {rotatingIdentity ? "확인 중…" : "단말 key 교체 계속"}
                            </button>
                          )}
                          {!target.builtIn && <button type="button" className="danger" disabled={rotatingIdentityTarget !== null} onClick={() => void deleteLinuxDevice(target)}>삭제</button>}
                        </div>
                      </div>
                      {stagingPin && (
                        <div className="pin-staging-review">
                          <strong>{target.name}에 새 서버 pin을 준비합니다.</strong>
                          <small>Companion에서 새 인증서를 별도 생성한 뒤 표시된 SPKI pin을 대조해 입력하세요. 현재 기본 pin은 유지되며 자동 승격되지 않습니다.</small>
                          <input
                            value={stagedBackupPin}
                            maxLength={51}
                            autoCapitalize="none"
                            spellCheck={false}
                            placeholder="sha256/… 새 교체용 SPKI pin"
                            aria-label={`${target.name} 교체용 SPKI pin`}
                            onChange={(event) => setStagedBackupPin(event.target.value.trim())}
                          />
                          <div className={pocketLinkStatus?.backupPinConfigured ? "three-actions" : undefined}>
                            <button type="button" disabled={stagingPinBusy} onClick={closePocketLinkPinStaging}>취소</button>
                            {pocketLinkStatus?.backupPinConfigured && (
                              <button type="button" className="danger" disabled={stagingPinBusy} onClick={() => void clearPocketLinkBackupPin(target)}>준비한 pin 제거</button>
                            )}
                            <button type="button" disabled={stagingPinBusy || !isPocketLinkPin(stagedBackupPin)} onClick={() => void stagePocketLinkBackupPin(target)}>
                              {stagingPinBusy ? "저장 중…" : "교체용 pin 저장"}
                            </button>
                          </div>
                        </div>
                      )}
                      {confirmingPinPromotion && pocketLinkStatus?.pinObservedAt && (
                        <div className="pin-promotion-review" role="alert">
                          <strong>{target.name}의 서버 인증서를 교체합니다.</strong>
                          <small>
                            {new Date(pocketLinkStatus.pinObservedAt).toLocaleTimeString()}에 교체용 pin으로 TLS 연결이 성공했습니다.
                            확정하면 새 pin만 유지하고 이전 pin은 즉시 폐기하며 SSH로 자동 우회하지 않습니다.
                          </small>
                          <div>
                            <button type="button" disabled={promotingPinTarget === target.id} onClick={() => setConfirmingPinPromotionTarget(null)}>취소</button>
                            <button type="button" className="danger" disabled={promotingPinTarget !== null} onClick={() => void promotePocketLinkPin(target)}>
                              {promotingPinTarget === target.id ? "교체 중…" : "새 pin 확정 · 이전 pin 폐기"}
                            </button>
                          </div>
                        </div>
                      )}
                      {reviewingIdentityRotation && !identityRotationPending && (
                        <div className="identity-rotation-review">
                          <strong>{target.name}의 Android 단말 identity key를 교체합니다.</strong>
                          <small>
                            새 P-256 private key는 Android Keystore 안에서 생성되어 밖으로 나오지 않습니다.
                            Companion이 새 key의 실제 mTLS proof를 확인한 뒤에만 기존 key를 폐기하며, 응답이 불확실하면 자동으로 되돌리지 않고 복구 상태를 유지합니다.
                          </small>
                          <div>
                            <button type="button" disabled={rotatingIdentityTarget !== null} onClick={() => setReviewingIdentityRotationTarget(null)}>취소</button>
                            <button type="button" className="danger" disabled={rotatingIdentityTarget !== null} onClick={() => void beginPocketLinkIdentityRotation(target)}>
                              {rotatingIdentity ? "교체 중…" : "새 단말 key 생성 · 교체 시작"}
                            </button>
                          </div>
                        </div>
                      )}
                      {identityRotationPending && (
                        <div className="identity-rotation-review pending" role="alert">
                          <strong>{target.name}의 단말 key 교체 결과를 확인해야 합니다.</strong>
                          <small>
                            새 key와 기존 key 중 어느 쪽이 Companion에 확정됐는지 1회용 승인과 실제 TLS proof로 다시 확인합니다.
                            결과를 추측해 key를 폐기하거나 SSH로 자동 우회하지 않습니다.
                          </small>
                          <div>
                            <button type="button" disabled={rotatingIdentityTarget !== null} onClick={() => void abortPocketLinkIdentityRotation(target)}>
                              {rotatingIdentity ? "확인 중…" : "교체 중단 · 기존 key 유지"}
                            </button>
                            <button type="button" className="identity-rotation" disabled={rotatingIdentityTarget !== null} onClick={() => void beginPocketLinkIdentityRotation(target)}>
                              {rotatingIdentity ? "확인 중…" : "교체 상태 확인 · 계속"}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>

            <div className="connection-steps" aria-label="연결 단계">
              <span>1 CLI 확인</span><span>2 브라우저 연결</span><span>3 무료 테스트</span>
            </div>

            <div className="provider-cards">
              {providers.map((item) => {
                const test = connectionTest[item.id];
                const ownLogin = loginSession?.provider === item.id ? loginSession : null;
                const loginActive = ownLogin?.status === "starting" || ownLogin?.status === "waiting";
                return (
                  <article className={`provider-card ${item.status}`} key={item.id}>
                    <div className="provider-card-head">
                      <div>
                        <strong>{item.name}</strong>
                        <small>{item.version ?? (item.installed ? "CLI 설치됨" : "CLI 없음")}</small>
                      </div>
                      <span className={`provider-badge ${item.status}`}>{providerStatusLabel(item)}</span>
                    </div>
                    <p>{item.detail}</p>
                    <div className="provider-capabilities" aria-label={`${item.name} 작업 권한`}>
                      {item.capabilities.workspaceRead && <span>프로젝트 읽기</span>}
                      {item.capabilities.workspaceWrite && <span className="approval">터치 승인 파일 변경</span>}
                      {item.capabilities.commandExecution && <span className="approval">터치 승인 명령</span>}
                      {item.capabilities.usageAccounting && <span>사용량 기록</span>}
                      {!item.capabilities.workspaceWrite && item.capabilities.workspaceRead && <span>쓰기 차단</span>}
                    </div>

                    <label className="alias-field">
                      <span>내 별명 <small>선택 · 이 폰에만 저장</small></span>
                      <input
                        type="text"
                        maxLength={40}
                        value={providerAliases[item.id] ?? ""}
                        placeholder="예: 개인 계정"
                        onChange={(event) => saveProviderAlias(item.id, event.target.value)}
                      />
                    </label>

                    {!item.installed && (
                      <div className="install-guide">
                        <strong>설치 필요</strong>
                        <p>{item.installGuide.summary}</p>
                        <code>{item.installGuide.command}</code>
                        <div className="provider-actions">
                          <button type="button" onClick={() => void copyText(item.installGuide.command, "설치 명령을 복사했습니다.")}>명령 복사</button>
                          <a href={item.installGuide.docsUrl} target="_blank" rel="noreferrer">공식 안내</a>
                        </div>
                      </div>
                    )}

                    {ownLogin && (
                      <div className={`login-session ${ownLogin.status}`}>
                        <strong>{loginStatusLabel(ownLogin.status)}</strong>
                        {ownLogin.verificationUrl && (
                          <button type="button" className="login-link" onClick={() => window.open(ownLogin.verificationUrl, "_blank", "noopener,noreferrer")}>
                            브라우저에서 계정 연결
                          </button>
                        )}
                        {ownLogin.userCode && (
                          <button type="button" className="login-code" onClick={() => void copyText(ownLogin.userCode!, "인증 코드를 복사했습니다.")}>
                            코드 {ownLogin.userCode} · 복사
                          </button>
                        )}
                        <pre>{ownLogin.output}</pre>
                      </div>
                    )}

                    {test && <p className="test-result">✓ {test.detail}</p>}

                    <div className="provider-actions primary">
                      {item.canLogin && (
                        <button type="button" disabled={loginActive} onClick={() => void startProviderLogin(item.id)}>
                          {item.status === "connected" ? "다른 계정 연결" : loginActive ? "연결 대기 중…" : "브라우저로 연결"}
                        </button>
                      )}
                      {item.canTest && (
                        <button type="button" disabled={testingProvider !== null} onClick={() => void testProviderConnection(item.id)}>
                          {testingProvider === item.id ? "확인 중…" : "무료 연결 테스트"}
                        </button>
                      )}
                      {loginActive && <button type="button" className="danger" onClick={() => void cancelProviderLogin()}>취소</button>}
                    </div>
                    {item.status === "connected" && !item.available && <small className="adapter-note">계정은 연결됐지만 대화 실행 모듈은 아직 준비 중입니다.</small>}
                  </article>
                );
              })}
            </div>
            <p className="privacy-note">비밀번호·API 키를 받거나 저장하지 않습니다. 로그인은 각 CLI의 공식 브라우저 인증을 사용합니다.</p>
          </div>
        </section>
      )}

      {showProjectCreator && (
        <section className="project-dialog" role="dialog" aria-modal="true" aria-labelledby="project-dialog-title">
          <div className="project-dialog-card">
            <div className="project-dialog-head">
              <div>
                <strong id="project-dialog-title">새 프로젝트</strong>
                <small>Git 저장소로 안전하게 초기화합니다.</small>
              </div>
              <button type="button" aria-label="닫기" onClick={() => setShowProjectCreator(false)}>×</button>
            </div>
            <label>
              <span>생성할 단말</span>
              <select value={device} disabled={creatingProject} onChange={(event) => selectDevice(event.target.value as DeviceId)}>
                {deviceTargets.map((target) => <option key={target.id} value={target.id}>{target.name}</option>)}
              </select>
            </label>
            <label>
              <span>위치</span>
              <select value={newProjectParent} disabled={creatingProject || creationLocations.length === 0} onChange={(event) => setNewProjectParent(event.target.value)}>
                {creationLocations.map((item) => <option key={item.path} value={item.path}>{item.name}</option>)}
              </select>
            </label>
            <label>
              <span>프로젝트 이름</span>
              <input
                type="text"
                maxLength={80}
                value={newProjectName}
                placeholder="예: my-new-app"
                autoFocus
                disabled={creatingProject}
                onChange={(event) => {
                  setNewProjectName(event.target.value);
                  if (projectCreatorError) setProjectCreatorError("");
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void createProject();
                }}
              />
            </label>
            {projectCreatorError && <p className="project-dialog-error" role="alert">{projectCreatorError}</p>}
            <button className="create-project-button" type="button" disabled={creatingProject} onClick={() => void createProject()}>
              {creatingProject ? "만드는 중…" : `${deviceLabel(device)}에 만들기`}
            </button>
          </div>
        </section>
      )}

      <main ref={transcriptRef} className="transcript" aria-live="polite">
        {handoff && (
          <div className="handoff-banner" role="status">
            <div>
              <strong>다른 기기에서 반납한 세션</strong>
              <span>{workspaceName(handoff.workspace)} · {workspaceIdentityLabel(workspaceIdentityFor(workspaces, handoff.workspace))} · {handoff.operationId ? "PC 작업 실행 중" : "대화 이어가기"}</span>
            </div>
            <button type="button" disabled={handoffBusy} onClick={() => void resumeHandoff()}>{handoffBusy ? "연결 중…" : "이어받기"}</button>
          </div>
        )}
        {(journalRestored || (connection !== "online" && (messages.length > 0 || promptQueue.length > 0))) && (
          <div className="journal-banner" role="status">
            <strong>{connection === "online" ? "로컬 기록 복원됨" : "오프라인 기록"}</strong>
            <span>{connection === "online"
              ? "CLI 기록과 다시 동기화합니다."
              : `대화는 이 앱에 보존되며 예약 ${promptQueue.length}건은 ${deviceLabel(device)} 연결 후 실행됩니다.`}</span>
          </div>
        )}
        {messages.length === 0 ? (
          <section className="empty-state">
            <div className="empty-orbit" aria-hidden="true"><span /></div>
            <h2>{tr("emptyTitle")}</h2>
            <p>{tr("emptyBody")}</p>
            <div className="suggestions">
              <button type="button" onClick={() => setPrompt(uiLanguage === "ko" ? "이 프로젝트의 현재 상태를 확인하고 다음 할 일을 알려주세요." : "Inspect this project and tell me the best next step.")}>{tr("statusPrompt")}</button>
              <button type="button" onClick={() => setPrompt(uiLanguage === "ko" ? "테스트를 실행하고 실패 원인을 고쳐주세요." : "Run the tests and fix any failures.")}>{tr("testPrompt")}</button>
            </div>
          </section>
        ) : messages.map((message) => <Message key={message.id} message={message} />)}
      </main>

      {activity.running && (
        <section className="activity-panel" aria-live="polite">
          <div className="activity-head">
            <span className="spinner" aria-hidden="true" />
            <strong>{activity.text}</strong>
            <button className="stop-button" type="button" onClick={() => void stopOperation()}>중단</button>
          </div>
          {activity.detail && <pre>{activity.detail}</pre>}
        </section>
      )}

      {operationBelongsToSession(operation, workspace, threadId) && operation?.status === "unknown" && (
        <section className="unknown-operation" role="status">
          <div>
            <strong>이전 작업 상태 확인 필요</strong>
            <span>Companion 재시작 전 실행은 성공이나 실패로 단정하지 않았습니다. PC 결과와 Git 상태를 확인하세요.</span>
          </div>
          <button type="button" onClick={() => void acknowledgeUnknownOperation()}>확인하고 계속</button>
        </section>
      )}

      <footer className="composer-wrap">
        {promptQueue.length > 0 && (
          <div className="prompt-queue" aria-label="예약 요청">
            <div className="prompt-queue-head">
              <strong>대기열 {promptQueue.length}</strong>
              <span>현재 작업이 끝나면 순서대로 실행</span>
              {promptQueue.some((item) => item.requiresConfirmation) && (
                <button type="button" onClick={confirmRestoredQueue}>실행 재개</button>
              )}
            </div>
            {promptQueue.map((item, index) => (
              <div className="prompt-queue-item" key={item.id}>
                <span>{index + 1}</span>
                <p>{short(item.text, 72)}</p>
                <button type="button" aria-label={`${index + 1}번째 예약 요청 취소`} onClick={() => removeQueuedPrompt(item.id)}>×</button>
              </div>
            ))}
          </div>
        )}
        <div className={`composer${handsFree ? " hands-free" : ""}`}>
          {models.length > 0 && (
            <div className="model-bar" aria-label="Codex 모델 설정">
              <label>
                <span>{tr("account")}</span>
                <select value={accountId} aria-label="AI 계정 프로필" onChange={(event) => selectAccount(event.target.value)}>
                  {(activeProvider(providers, provider)?.accounts ?? []).map((item) => (
                    <option key={item.id} value={item.id}>{item.label}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>{tr("model")}</span>
                <select
                  value={model}
                  aria-label="Codex 모델"
                  onChange={(event) => selectModel(event.target.value)}
                >
                  <option value="">{tr("automatic")} · {defaultModel(models)?.displayName ?? "Codex"}</option>
                  {models.map((item) => (
                    <option key={item.id} value={item.id}>{item.displayName}{item.isDefault ? " · 기본" : ""}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>{tr("performance")}</span>
                <select
                  value={effort}
                  aria-label="추론 성능"
                  onChange={(event) => selectEffort(event.target.value)}
                >
                  <option value="">기본 · {effortLabel(activeModel(models, model)?.defaultEffort ?? "medium")}</option>
                  {(activeModel(models, model)?.efforts ?? []).map((item) => (
                    <option key={item.id} value={item.id}>{effortLabel(item.id)}</option>
                  ))}
                </select>
              </label>
            </div>
          )}
          {attachments.length > 0 && (
            <div className="attachment-tray" aria-label="첨부 파일">
              {attachments.map((item) => (
                <article className={`attachment-card ${item.status}`} key={item.id}>
                  {item.previewUrl && <img src={item.previewUrl} alt="" />}
                  {item.kind === "video" && item.status === "ready" && item.frameCount > 0 && (
                    <AuthorizedImage path={`/api/media/${encodeURIComponent(item.id)}/frames/0`} alt="영상 첫 대표 프레임" />
                  )}
                  <div>
                    <strong>{item.kind === "video" ? "🎬" : "🖼️"} {short(item.name, 28)}</strong>
                    <span>{mediaStatusText(item, device)}</span>
                    {item.analysis?.summary && <small>{short(item.analysis.summary, 72)}</small>}
                  </div>
                  <button type="button" aria-label={`${item.name} 첨부 제거`} onClick={() => void removeAttachment(item.id)}>×</button>
                </article>
              ))}
            </div>
          )}
          <div className="composer-input-row">
            {handsFree ? (
              <div className="voice-preview" role="status" aria-live="polite">
                <strong>연속 받아쓰기</strong>
                <p>{prompt || "말씀해 주세요…"}</p>
              </div>
            ) : (
              <textarea
                ref={textareaRef}
                lang={speechLanguage}
                inputMode="text"
                rows={2}
                maxLength={100_000}
                value={prompt}
                placeholder={tr("speechPlaceholder")}
                aria-label="Codex에게 보낼 요청"
                onChange={(event) => setPrompt(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                    event.preventDefault();
                    void submitPrompt();
                  }
                }}
              />
            )}
            <button
              className={`voice-button${dictating ? " listening" : ""}${handsFree ? " hands-free" : ""}`}
              type="button"
              disabled={!speechSupported}
              aria-label={dictating ? "음성 입력 중지" : "짧게 누르면 받아쓰기, 길게 누르면 연속 받아쓰기"}
              aria-pressed={dictating}
              title={speechSupported ? undefined : "이 브라우저는 앱 내 음성 인식을 지원하지 않습니다."}
              onPointerDown={handleVoicePointerDown}
              onPointerUp={handleVoicePointerUp}
              onPointerCancel={handleVoicePointerCancel}
              onContextMenu={(event) => event.preventDefault()}
              onClick={(event) => {
                if (event.detail !== 0) return;
                if (dictating || handsFreeRef.current) void stopDictation();
                else void startDictation(false);
              }}
            >
              <span aria-hidden="true">🎙</span><small>{handsFree ? tr("continuous") : dictating ? tr("listening") : tr("speech")}</small>
            </button>
          </div>
          <p className={`voice-help${handsFree ? " active" : ""}`}>
            {handsFree ? tr("speechActive") : tr("speechHelp")}
          </p>
          <div className="composer-bar">
            <input
              ref={fileInputRef}
              className="hidden"
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime,video/x-matroska"
              multiple
              onChange={(event) => void addMedia(event.target.files)}
            />
            <button
              className="attach-button"
              type="button"
              disabled={mediaBusy || attachments.length >= 4}
              aria-label="이미지 또는 영상 첨부"
              onClick={() => fileInputRef.current?.click()}
            >📎 <span>{tr("attachment")}</span></button>
            <label className="toggle">
              <input type="checkbox" checked={tts} onChange={(event) => setTts(event.target.checked)} />
              <span aria-hidden="true" />
              {tr("readAnswer")}
            </label>
            <label className="toggle network-toggle" title="패키지 설치 등 꼭 필요한 경우에만 켜세요">
              <input type="checkbox" checked={networkAccess} onChange={(event) => setNetworkAccess(event.target.checked)} />
              <span aria-hidden="true" />
              {tr("network")}
            </label>
            <button
              className="send-button"
              type="button"
              disabled={dictating || mediaBusy || (!prompt.trim() && attachments.length === 0) || attachments.some((item) => item.kind === "video" && item.status !== "ready")}
              aria-label={activity.running ? "요청을 대기열에 추가" : "요청 전송"}
              onClick={() => void submitPrompt()}
            >
              {activity.running ? tr("queue") : tr("send")} <span aria-hidden="true">{activity.running ? "+" : "↑"}</span>
            </button>
          </div>
        </div>
        <p className="safety-note">{tr("safeNote")}</p>
      </footer>

      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}

function Message({ message }: { message: ChatMessage }) {
  return (
    <article className={`message ${message.role}${message.pending ? " pending" : ""}${message.error ? " error" : ""}`}>
      <div className="bubble">
        <div className="message-label">{message.role === "user" ? "나" : "AI"}</div>
        <p className="message-text">{message.text}</p>
        {message.details && (
          <details className="details">
            <summary>작업 세부정보 보기</summary>
            <pre>{message.details}</pre>
          </details>
        )}
      </div>
    </article>
  );
}

function AuthorizedImage({ path, alt }: { path: string; alt: string }) {
  const [source, setSource] = useState("");
  useEffect(() => {
    let disposed = false;
    let objectUrl = "";
    void apiBlob(path).then((blob) => {
      if (disposed) return;
      objectUrl = URL.createObjectURL(blob);
      setSource(objectUrl);
    }).catch(() => undefined);
    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path]);
  return source ? <img src={source} alt={alt} /> : null;
}

function historyMessages(thread: ThreadDetail): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const turn of thread.turns) {
    for (const item of turn.items) {
      const message = historyMessage(item);
      if (message) messages.push(message);
    }
  }
  return messages;
}

function historyMessage(item: HistoryItem): ChatMessage | null {
  if (item.type === "userMessage" && item.text) return { id: newId("history-user"), role: "user", text: item.text };
  if (item.type === "agentMessage" && item.text) return { id: newId("history-agent"), role: "assistant", text: item.text };
  if (item.type === "commandExecution") {
    return { id: newId("history-command"), role: "assistant", text: "작업 기록", details: `$ ${item.command ?? ""}\n${item.output ?? ""}`.trim() };
  }
  if (item.type === "fileChange") {
    const details = (item.changes ?? []).map((change) => `${change.kind}: ${change.path}`).join("\n");
    return details ? { id: newId("history-files"), role: "assistant", text: "작업 기록", details } : null;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function arrayStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function joinDictation(...parts: string[]): string {
  return parts.map((part) => part.trim()).filter(Boolean).join(" ");
}

function short(text: string, length: number): string {
  return text.length <= length ? text : `${text.slice(0, length - 1)}…`;
}

function formatPairingCode(value: string): string {
  const digits = value.replace(/\D/g, "").slice(0, 8);
  return digits.length > 4 ? `${digits.slice(0, 4)} ${digits.slice(4)}` : digits;
}

function isPocketLinkPin(value: string): boolean {
  return /^sha256\/[A-Za-z0-9+/]{43}=$/.test(value);
}

function workspaceName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function safeFilename(value: string): string {
  const normalized = value.normalize("NFKC").replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "");
  return normalized.slice(0, 80) || "workspace";
}

function deviceTargetLocalPort(target: DeviceTarget): number {
  try {
    const parsed = new URL(target.baseUrl);
    const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
    return Number.isInteger(port) && port >= 1_024 && port <= 65_535 ? port : 8_788;
  } catch {
    return 8_788;
  }
}

function statusMessage(status: Operation["status"]): string {
  if (status === "unknown") return "작업의 최종 상태를 확인할 수 없습니다.";
  if (status === "interrupted") return "작업이 중단되었습니다.";
  if (status === "failed") return "작업이 실패했습니다.";
  return "작업이 완료되었습니다.";
}

function operationAction(operation: Operation): "started" | "recovered" | "completed" | "failed" | "acknowledged" {
  if (operation.acknowledgedAt) return "acknowledged";
  if (operation.status === "running") return "started";
  if (operation.status === "unknown") return "recovered";
  if (operation.status === "failed") return "failed";
  return "completed";
}

function mediaStatusText(item: PendingAttachment, device: DeviceId): string {
  if (item.status === "uploading") return `${deviceLabel(device)}로 전송 중 · ${item.progress ?? 0}%`;
  if (item.status === "queued") return "4B 영상 분석 대기 중";
  if (item.status === "analyzing") return "4B가 대표 장면 분석 중 · 약 2~3분";
  if (item.status === "failed") return item.error || "분석 실패";
  if (item.kind === "video" && item.status === "ready") {
    return `분석 완료 · ${item.frameCount}개 대표 장면`;
  }
  return `${Math.max(1, Math.round(item.size / 1024))}KB · 전송 완료`;
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    let settled = false;
    let timer = 0;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    signal.addEventListener("abort", finish, { once: true });
    timer = window.setTimeout(finish, milliseconds);
    if (signal.aborted) finish();
  });
}

function providerAliasKey(device: DeviceId, provider: ProviderId): string {
  return `codex-pocket-provider-alias-${device}-${provider}`;
}

function handoffDismissedKey(device: DeviceId): string {
  return `codex-pocket-handoff-dismissed-${device}`;
}

function providerStatusLabel(provider: ProviderOption): string {
  if (provider.status === "connected") return provider.available ? "사용 가능" : "계정 연결됨";
  if (provider.status === "login_required") return "로그인 필요";
  return "설치 필요";
}

function loginStatusLabel(status: ProviderLoginSession["status"]): string {
  if (status === "connected") return "연결 완료";
  if (status === "failed") return "연결 실패";
  if (status === "cancelled") return "연결 취소됨";
  return "브라우저 인증 대기 중";
}

function storageKey(kind: "workspace" | "thread" | "model" | "effort" | "provider" | "account", device: DeviceId): string {
  return `codex-pocket-${kind}-${device}`;
}

function activeProvider(providers: ProviderOption[], provider: ProviderId): ProviderOption | undefined {
  return providers.find((item) => item.id === provider);
}

function defaultModel(models: ModelOption[]): ModelOption | undefined {
  return models.find((item) => item.isDefault) ?? models[0];
}

function activeModel(models: ModelOption[], model: string): ModelOption | undefined {
  return models.find((item) => item.id === model) ?? defaultModel(models);
}

function effortLabel(effort: string): string {
  const labels: Record<string, string> = {
    none: "없음 · 즉시",
    minimal: "최소 · 매우 빠름",
    low: "낮음 · 빠름",
    medium: "중간 · 균형",
    high: "높음 · 정밀",
    xhigh: "매우 높음 · 심층",
    max: "최대 · 최고 품질",
    ultra: "울트라 · 작업 분담",
  };
  return labels[effort] ?? effort;
}

function deviceLabel(device: DeviceId): string {
  return deviceTargetLabel(device);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
