import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  abortActiveDeviceIdentityRotation,
  api,
  apiBlob,
  activeDeviceTarget,
  addLinuxDevice,
  ApiError,
  beginActiveDeviceIdentityRotation,
  backgroundEventSubscriptions,
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
  NativeNotifications,
  NativeSpeech,
  NativeTunnel,
  NativeUpdate,
  type NativeSpeechError,
  type NativeSpeechResult,
  type NativeSpeechState,
  type NativeNotificationAction,
  type NativeOfficialReleaseStatus,
  type NativeUpdateReview,
  type PocketLinkStatus,
  type PocketLinkRoute,
} from "./native";
import { mergeSpeechSegments } from "./speech-utils";
import { initialConnectionState, reduceConnection } from "./connection-state";
import {
  activeRunOwnsOperation,
  activeRunScope,
  activeRunScopeMatches,
  initialActiveRunState,
  reduceActiveRun,
  type ActiveRunAction,
  type ActiveRunScope,
  type RunActivityState,
} from "./active-run-state";
import { initialVoiceInputState, reduceVoiceInput } from "./voice-input-state";
import {
  initialMediaComposerState,
  MAX_COMPOSER_ATTACHMENTS,
  mediaComposerBusy,
  reduceMediaComposer,
  type MediaComposerAction,
} from "./media-composer-state";
import { OperationsDashboard } from "./OperationsDashboard";
import { activeApprovals, applyApprovalEvent, upsertOperation } from "./operations-state";
import { operationBelongsToSession, scopedHandoff } from "./session-scope";
import { providerConversationMessages, providerConversationThreads } from "./provider-conversations";
import { workspaceIdentityFor, workspaceIdentityLabel } from "./workspace-identity";
import { createWorkJournal } from "./work-journal";
import { conversationKey, restoredMessages, serializableQueue } from "./work-journal-model";
import {
  conversationJournalRestored,
  initialJournalState,
  mergeRestoredPrompts,
  queueJournalReady,
  queueLoadMatches,
  reduceJournalState,
  type JournalAction,
} from "./journal-state";
import { initialSpeechLanguage, initialUiLanguage, translate, type MessageKey, type UiLanguage } from "./i18n";
import { parsePocketLinkBootstrapUri } from "../../src/pocket-link-bootstrap";
import {
  evaluatePocketLinkBootstrap,
} from "./pocket-link-pairing";
import {
  matchesPocketLinkDiscovery,
  parsePocketLinkDiscoveryResult,
  type PocketLinkDiscoveryCandidate,
} from "./pocket-link-discovery";
import {
  isCurrentPocketLinkP2pCandidate,
  parsePocketLinkP2pResult,
  type PocketLinkP2pCandidate,
} from "./pocket-link-p2p";
import {
  initialPocketLinkBootstrapState,
  reducePocketLinkBootstrap,
} from "./pocket-link-bootstrap-state";
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
  DeviceId,
  DeviceTarget,
  HistoryItem,
  JournalPolicy,
  JournalPolicyLimits,
  Operation,
  OperationMetadataPatch,
  MediaItem,
  ModelOption,
  ModelResponse,
  PendingAttachment,
  ProviderId,
  ProviderConnectionTest,
  ProviderCatalogPricing,
  ProviderLoginSession,
  ProviderModelGrade,
  ProviderModelVerification,
  ProviderOption,
  ProviderRoutingSelection,
  ProviderRoutingOption,
  ProviderResponse,
  QueuedPrompt,
  RunResult,
  RunPolicyConfig,
  RunPolicyConfigLimits,
  RunPolicyPreflight,
  RunPolicySnapshot,
  SessionHandoff,
  SystemDiagnostics,
  ThreadDetail,
  ThreadSummary,
  Workspace,
  WorkspaceChangeRecoveryResponse,
  WorkspaceChangeRecoveryStatus,
  WorkspaceResponse,
} from "./types";

interface PendingRunPolicyReview {
  queued: QueuedPrompt;
  continuedThreadId: string;
  preflight?: RunPolicyPreflight;
  error?: string;
}

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

let localId = 0;
const newId = (prefix: string) => `${prefix}-${Date.now()}-${localId++}`;

export function App() {
  const [device, setDevice] = useState<DeviceId>(() => activeDeviceTarget().id);
  const [deviceTargets, setDeviceTargets] = useState<DeviceTarget[]>(listDeviceTargets);
  const [connectionState, dispatchConnection] = useReducer(
    reduceConnection,
    initialConnectionState(device, deviceLabel(device)),
  );
  const { status: connection, text: connectionText } = connectionState;
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [workspace, setWorkspace] = useState("");
  const [threadId, setThreadId] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [prompt, setPrompt] = useState("");
  const [composerRunMode, setComposerRunMode] = useState<"queue" | "steer">("queue");
  const [steering, setSteering] = useState(false);
  const [activeRun, dispatchActiveRunState] = useReducer(reduceActiveRun, initialActiveRunState(device));
  const { operation, activity } = activeRun;
  const [tts, setTts] = useState(() => localStorage.getItem("codex-pocket-tts") === "true");
  const [notificationsEnabled, setNotificationsEnabled] = useState(
    () => localStorage.getItem("codex-pocket-notifications") === "true",
  );
  const [networkAccess, setNetworkAccess] = useState(false);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [providers, setProviders] = useState<ProviderOption[]>([]);
  const [provider, setProvider] = useState<ProviderId>("codex");
  const [accountId, setAccountId] = useState("cli-default");
  const [model, setModel] = useState("");
  const [routingPrimary, setRoutingPrimary] = useState("");
  const [routingBackup, setRoutingBackup] = useState("");
  const [effort, setEffort] = useState("");
  const [voiceInput, dispatchVoiceInput] = useReducer(reduceVoiceInput, initialVoiceInputState);
  const { dictating, handsFree, supported: speechSupported } = voiceInput;
  const [controlsCollapsed, setControlsCollapsed] = useState(
    () => localStorage.getItem("codex-pocket-controls-open") !== "true",
  );
  const [toast, setToast] = useState("");
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [mediaComposer, dispatchMediaComposerState] = useReducer(reduceMediaComposer, initialMediaComposerState);
  const attachments = mediaComposer.attachments;
  const mediaBusy = mediaComposerBusy(mediaComposer);
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
  const [updateReview, setUpdateReview] = useState<NativeUpdateReview | null>(null);
  const [updateDiscovery, setUpdateDiscovery] = useState<NativeOfficialReleaseStatus | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateError, setUpdateError] = useState("");
  const [updateInstallPermissionRequired, setUpdateInstallPermissionRequired] = useState(false);
  const [loginSession, setLoginSession] = useState<ProviderLoginSession | null>(null);
  const [providerAliases, setProviderAliases] = useState<Partial<Record<ProviderId, string>>>({});
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
  const [newPocketLinkRoute, setNewPocketLinkRoute] = useState<PocketLinkRoute>("direct");
  const [newPocketRelayHost, setNewPocketRelayHost] = useState("");
  const [newPocketRelayPort, setNewPocketRelayPort] = useState("9443");
  const [newPocketRelayServerName, setNewPocketRelayServerName] = useState("");
  const [newPocketRelayPin, setNewPocketRelayPin] = useState("");
  const [newPocketRelaySlot, setNewPocketRelaySlot] = useState("");
  const [newPocketRelaySecret, setNewPocketRelaySecret] = useState("");
  const [pocketLinkBootstrap, dispatchPocketLinkBootstrap] = useReducer(
    reducePocketLinkBootstrap,
    initialPocketLinkBootstrapState,
  );
  const scanningPocketLinkQr = pocketLinkBootstrap.phase === "scanning_qr";
  const discoveringPocketLinks = pocketLinkBootstrap.phase === "discovering_lan";
  const discoveringPocketLinkPeers = pocketLinkBootstrap.phase === "discovering_p2p";
  const pocketLinkDiscoveryCandidates = pocketLinkBootstrap.discoveryCandidates;
  const selectedPocketLinkDiscovery = pocketLinkBootstrap.selectedDiscovery;
  const pocketLinkP2pCandidates = pocketLinkBootstrap.p2pCandidates;
  const selectedPocketLinkP2p = pocketLinkBootstrap.selectedP2p;
  const pendingPocketLinkBootstrap = pocketLinkBootstrap.pendingQr;
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
  const [updatingOperationId, setUpdatingOperationId] = useState<string | null>(null);
  const [journalPolicy, setJournalPolicy] = useState<JournalPolicy | null>(null);
  const [journalPolicyLimits, setJournalPolicyLimits] = useState<JournalPolicyLimits | null>(null);
  const [updatingJournalPolicy, setUpdatingJournalPolicy] = useState(false);
  const [runPolicy, setRunPolicy] = useState<RunPolicyConfig | null>(null);
  const [runPolicyLimits, setRunPolicyLimits] = useState<RunPolicyConfigLimits | null>(null);
  const [updatingRunPolicy, setUpdatingRunPolicy] = useState(false);
  const [lastRunPolicyPreflight, setLastRunPolicyPreflight] = useState<RunPolicySnapshot | null>(null);
  const [pendingRunPolicyReview, setPendingRunPolicyReview] = useState<PendingRunPolicyReview | null>(null);
  const [workspaceRecovery, setWorkspaceRecovery] = useState<WorkspaceChangeRecoveryStatus | null>(null);
  const [retryingWorkspaceRecovery, setRetryingWorkspaceRecovery] = useState(false);
  const [exportingWorkspace, setExportingWorkspace] = useState<string | null>(null);
  const [deletingWorkspace, setDeletingWorkspace] = useState<string | null>(null);
  const [journal] = useState(createWorkJournal);
  const [journalState, dispatchJournalState] = useReducer(reduceJournalState, initialJournalState);
  const selectedJournalKey = workspace ? conversationKey(device, workspace, threadId, provider) : "";
  const journalRestored = conversationJournalRestored(journalState, selectedJournalKey);
  const tr = (key: MessageKey) => translate(uiLanguage, key);
  const selectedWorkspaceIdentity = workspaceIdentityFor(workspaces, workspace);
  const selectedWorkspaceIdentityText = workspaceIdentityLabel(selectedWorkspaceIdentity);

  const transcriptRef = useRef<HTMLElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const activeRunRef = useRef(activeRun);
  const activeRunGenerationRef = useRef(0);
  const promptQueueRef = useRef<QueuedPrompt[]>([]);
  const messagesRef = useRef<ChatMessage[]>([]);
  const mediaComposerRef = useRef(mediaComposer);
  const journalStateRef = useRef(journalState);
  const conversationJournalGenerationRef = useRef(0);
  const queueJournalGenerationRef = useRef(0);
  const queueDispatchingRef = useRef(false);
  const pendingRunPolicyReviewRef = useRef<PendingRunPolicyReview | null>(null);
  const steerRequestRef = useRef<{ fingerprint: string; requestId: string } | null>(null);
  const workspaceRef = useRef("");
  const deviceRef = useRef<DeviceId>(device);
  const threadRef = useRef("");
  const providerRef = useRef<ProviderId>("codex");
  const ttsRef = useRef(tts);
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
  const connectionAttemptRef = useRef(0);
  const initializingAttemptRef = useRef<number | null>(null);
  const nativeTunnelStartRef = useRef<Promise<void>>(Promise.resolve());
  const handleEventRef = useRef<(event: CodexEvent) => void>(() => undefined);
  const initializeRef = useRef<() => Promise<void>>(async () => undefined);
  const replayingEventsRef = useRef(false);
  const notificationsEnabledRef = useRef(notificationsEnabled);
  const pendingNotificationActionRef = useRef<NativeNotificationAction | null>(null);
  const openOperationFromDashboardRef = useRef<(operation: Operation) => void>(() => undefined);

  const dispatchActiveRun = (action: ActiveRunAction) => {
    const current = activeRunRef.current;
    const next = reduceActiveRun(current, action);
    if (next !== current) {
      activeRunRef.current = next;
      dispatchActiveRunState(action);
    }
    return next;
  };

  const dispatchJournal = (action: JournalAction) => {
    const current = journalStateRef.current;
    const next = reduceJournalState(current, action);
    if (next !== current) {
      journalStateRef.current = next;
      dispatchJournalState(action);
    }
    return next;
  };

  const dispatchMediaComposer = (action: MediaComposerAction) => {
    mediaComposerRef.current = reduceMediaComposer(mediaComposerRef.current, action);
    dispatchMediaComposerState(action);
  };

  useEffect(() => { workspaceRef.current = workspace; }, [workspace]);
  useEffect(() => {
    deviceRef.current = device;
    setApiDevice(device);
    localStorage.setItem("codex-pocket-device", device);
  }, [device]);
  useEffect(() => { threadRef.current = threadId; }, [threadId]);
  useEffect(() => { ttsRef.current = tts; localStorage.setItem("codex-pocket-tts", String(tts)); }, [tts]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  useEffect(() => { mediaComposerRef.current = mediaComposer; }, [mediaComposer]);
  useEffect(() => { handsFreeRef.current = handsFree; }, [handsFree]);
  useEffect(() => {
    const current = activeRunRef.current.operation;
    const canSteer = current?.status === "running"
      && current.providerId === "codex"
      && activeProvider(providers, "codex")?.capabilities.steering === true;
    if (!canSteer) {
      setComposerRunMode("queue");
      steerRequestRef.current = null;
    }
  }, [operation?.id, operation?.status, providers]);
  useEffect(() => {
    notificationsEnabledRef.current = notificationsEnabled;
    localStorage.setItem("codex-pocket-notifications", String(notificationsEnabled));
  }, [notificationsEnabled]);
  useEffect(() => {
    if (provider === "codex") return;
    const available = providerConversationThreads(operationSnapshots, provider, workspace);
    setThreads(available);
    if (!threadId || available.some((item) => item.id === threadId)) return;
    const activeConversation = operationSnapshots.some((item) => item.providerId === provider
      && item.cwd === workspace
      && item.conversationId === threadId
      && (item.status === "running" || (item.status === "unknown" && !item.acknowledgedAt)));
    if (activeConversation) return;
    setThreadId("");
    threadRef.current = "";
    persistConversationSelection(deviceRef.current, provider, workspace, "");
  }, [operationSnapshots, provider, threadId, workspace]);
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
    const generation = Math.max(queueJournalGenerationRef.current, journalStateRef.current.queue.generation) + 1;
    queueJournalGenerationRef.current = generation;
    dispatchJournal({ type: "queue_begin", generation, device });
    void journal.loadQueue(device).then((record) => {
      const journalSnapshot = journalStateRef.current;
      if (disposed || deviceRef.current !== device || !queueLoadMatches(journalSnapshot, generation, device)) return;
      const now = Date.now();
      const restored = serializableQueue(record?.prompts ?? [])
        .filter((prompt) => !prompt.expiresAt || Date.parse(prompt.expiresAt) > now);
      const prompts = mergeRestoredPrompts(
        restored,
        journalSnapshot.queue.changedDuringLoad ? promptQueueRef.current : [],
      );
      promptQueueRef.current = prompts;
      setPromptQueue(prompts);
      dispatchJournal({ type: "queue_loaded", generation, device });
      if (journalSnapshot.queue.changedDuringLoad) {
        void journal.saveQueue({
          device,
          prompts: serializableQueue(prompts),
          updatedAt: new Date().toISOString(),
        }).catch(() => undefined);
      }
    }).catch(() => {
      if (disposed || deviceRef.current !== device
          || !queueLoadMatches(journalStateRef.current, generation, device)) return;
      dispatchJournal({ type: "queue_loaded", generation, device });
      if (promptQueueRef.current.length > 0) {
        void journal.saveQueue({
          device,
          prompts: serializableQueue(promptQueueRef.current),
          updatedAt: new Date().toISOString(),
        }).catch(() => undefined);
      }
    });
    return () => { disposed = true; };
  }, [device, journal]);

  useEffect(() => {
    if (!workspace) return;
    let disposed = false;
    const expectedKey = conversationKey(device, workspace, threadId, provider);
    const generation = Math.max(
      conversationJournalGenerationRef.current,
      journalStateRef.current.conversation.generation,
    ) + 1;
    conversationJournalGenerationRef.current = generation;
    dispatchJournal({ type: "conversation_begin", generation, key: expectedKey });
    void journal.loadConversation(device, workspace, threadId, provider).then((record) => {
      const currentJournal = journalStateRef.current.conversation;
      if (disposed || currentJournal.generation !== generation || currentJournal.key !== expectedKey) return;
      if (!record || record.key !== expectedKey || messagesRef.current.length > 0) {
        dispatchJournal({ type: "conversation_loaded", generation, key: expectedKey, restored: false });
        return;
      }
      const restored = restoredMessages(record.messages);
      if (!restored.length) {
        dispatchJournal({ type: "conversation_loaded", generation, key: expectedKey, restored: false });
        return;
      }
      messagesRef.current = restored;
      setMessages(restored);
      dispatchJournal({ type: "conversation_loaded", generation, key: expectedKey, restored: true });
    }).catch(() => {
      const currentJournal = journalStateRef.current.conversation;
      if (!disposed && currentJournal.generation === generation && currentJournal.key === expectedKey) {
        dispatchJournal({ type: "conversation_loaded", generation, key: expectedKey, restored: false });
      }
    });
    return () => { disposed = true; };
  }, [device, journal, provider, threadId, workspace]);

  useEffect(() => {
    if (!workspace || messages.length === 0) return;
    const timer = window.setTimeout(() => {
      void journal.saveConversation({
        key: conversationKey(device, workspace, threadId, provider),
        device,
        workspace,
        threadId,
        messages,
        syncState: activeRun.requestId || operation?.status === "running"
          ? "running"
          : connection === "online" ? "synced" : "local",
        updatedAt: new Date().toISOString(),
      }).catch(() => undefined);
    }, 120);
    return () => window.clearTimeout(timer);
  }, [activeRun.requestId, connection, device, journal, messages, operation?.status, provider, threadId, workspace]);

  useEffect(() => {
    if (connection !== "online" || activeRunRef.current.operation || activeRunRef.current.requestId
      || queueDispatchingRef.current
      || pendingRunPolicyReviewRef.current
      || promptQueueRef.current.length === 0
      || promptQueueRef.current[0]?.requiresConfirmation) return;
    const timer = window.setTimeout(() => startNextQueuedPrompt(""), 250);
    return () => window.clearTimeout(timer);
  }, [activeRun.requestId, connection, operation?.id, operation?.status, promptQueue.length]);

  const showToast = useCallback((text: string) => {
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
    setToast(text);
    toastTimerRef.current = window.setTimeout(() => setToast(""), 4_000);
  }, []);

  useEffect(() => {
    if (!isNativeApp()) return;
    const consume = () => {
      if (document.visibilityState === "visible") void consumeNativeNotificationAction();
    };
    consume();
    document.addEventListener("visibilitychange", consume);
    return () => document.removeEventListener("visibilitychange", consume);
  }, [showToast]);

  useEffect(() => {
    if (!isNativeApp()) return;
    let disposed = false;
    if (!notificationsEnabled) {
      void NativeNotifications.disable().catch(() => undefined);
      return () => { disposed = true; };
    }
    void NativeNotifications.configure({ subscriptions: backgroundEventSubscriptions() }).catch((error) => {
      if (disposed) return;
      notificationsEnabledRef.current = false;
      setNotificationsEnabled(false);
      showToast(errorMessage(error));
    });
    return () => { disposed = true; };
  }, [authRevision, deviceTargets, notificationsEnabled, showToast]);

  const requestPairing = useCallback(async () => {
    const attempt = connectionAttemptRef.current;
    const selectedDevice = deviceRef.current;
    try {
      const status = await pairingStatus();
      if (attempt === connectionAttemptRef.current && selectedDevice === deviceRef.current) setPairing(status);
    } catch (error) {
      if (attempt === connectionAttemptRef.current && selectedDevice === deviceRef.current) {
        showToast(errorMessage(error));
      }
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
      dispatchPocketLinkBootstrap({ type: "clear_qr" });
      showToast("PocketLink QR pairing code가 만료되었습니다. 새 QR을 스캔해 주세요.");
      return;
    }
    if (decision.kind === "device_mismatch") {
      dispatchPocketLinkBootstrap({ type: "clear_qr" });
      showToast("스캔한 QR의 Companion과 현재 연결된 Companion이 다릅니다.");
      return;
    }
    setPairingCode(decision.pairingCode);
    dispatchPocketLinkBootstrap({ type: "clear_qr" });
  }, [device, pairing, pendingPocketLinkBootstrap, showToast]);

  useEffect(() => {
    if (!pendingPocketLinkBootstrap) return;
    const remaining = Date.parse(pendingPocketLinkBootstrap.expiresAt) - Date.now();
    if (remaining <= 0) {
      dispatchPocketLinkBootstrap({ type: "clear_qr" });
      return;
    }
    const timer = window.setTimeout(() => dispatchPocketLinkBootstrap({ type: "clear_qr" }), remaining);
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
    attempt?: number,
    runScope?: ActiveRunScope,
  ) => {
    try {
      const data = await api<{ threads: ThreadSummary[] }>("/api/threads?limit=30");
      if ((attempt !== undefined && attempt !== connectionAttemptRef.current)
          || (runScope && !activeRunScopeMatches(activeRunRef.current, runScope))) return;
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
      if ((attempt !== undefined && attempt !== connectionAttemptRef.current)
          || (runScope && !activeRunScopeMatches(activeRunRef.current, runScope))) return;
      showToast(errorMessage(error));
    }
  }, [showToast]);

  const loadProjectHandoff = useCallback(async (
    selectedWorkspace: string,
    attempt?: number,
    runScope?: ActiveRunScope,
  ) => {
    const requestedDevice = deviceRef.current;
    try {
      const suffix = selectedWorkspace ? `?workspace=${encodeURIComponent(selectedWorkspace)}` : "";
      const data = await api<{ handoff: SessionHandoff | null }>(`/api/session/handoff${suffix}`);
      if (deviceRef.current !== requestedDevice || workspaceRef.current !== selectedWorkspace
          || (attempt !== undefined && attempt !== connectionAttemptRef.current)
          || (runScope && !activeRunScopeMatches(activeRunRef.current, runScope))) return;
      setHandoffSupported(true);
      const dismissed = localStorage.getItem(handoffDismissedKey(requestedDevice));
      setHandoff(scopedHandoff(data.handoff, selectedWorkspace, dismissed));
    } catch {
      if (deviceRef.current !== requestedDevice || workspaceRef.current !== selectedWorkspace
          || (attempt !== undefined && attempt !== connectionAttemptRef.current)
          || (runScope && !activeRunScopeMatches(activeRunRef.current, runScope))) return;
      setHandoffSupported(false);
      setHandoff(null);
    }
  }, []);

  const initialize = useCallback(async (attempt = connectionAttemptRef.current) => {
    const selectedDevice = deviceRef.current;
    if (attempt !== connectionAttemptRef.current || initializingAttemptRef.current === attempt) return;
    initializingAttemptRef.current = attempt;
    try {
      const [health, workspaceData, providerData, codexModelData, runData, approvalData, journalData, runPolicyData, recoveryData] = await Promise.all([
        api<{ userAgent: string; device: { name: string } }>("/api/health"),
        api<WorkspaceResponse>("/api/workspaces"),
        api<ProviderResponse>("/api/providers"),
        api<ModelResponse>("/api/models?provider=codex"),
        api<{ operations: Operation[] }>("/api/runs")
          .catch(() => ({ operations: [] })),
        api<{ approvals: ApprovalItem[] }>("/api/approvals")
          .catch(() => ({ approvals: [] })),
        api<{ policy: JournalPolicy; limits: JournalPolicyLimits }>("/api/journal/policy")
          .catch(() => ({ policy: null, limits: null })),
        api<{ policy: RunPolicyConfig; limits: RunPolicyConfigLimits }>("/api/run-policy")
          .catch(() => ({ policy: null, limits: null })),
        api<WorkspaceChangeRecoveryResponse>("/api/workspace-changes/recovery")
          .catch(() => ({ supported: false, status: null })),
      ]);
      if (attempt !== connectionAttemptRef.current || deviceRef.current !== selectedDevice) return;
      dispatchConnection({
        type: "initialized",
        attempt,
        device: selectedDevice,
        text: `${health.device.name} · ${health.userAgent}`,
      });
      setWorkspaces(workspaceData.workspaces);
      setCreationLocations(workspaceData.creationLocations);
      setProviders(providerData.providers);
      setOperationSnapshots(runData.operations);
      setApprovalInbox(activeApprovals(approvalData.approvals));
      setJournalPolicy(journalData.policy);
      setJournalPolicyLimits(journalData.limits);
      setRunPolicy(runPolicyData.policy);
      setRunPolicyLimits(runPolicyData.limits);
      setWorkspaceRecovery(recoveryData.status);
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
      if (attempt !== connectionAttemptRef.current || deviceRef.current !== selectedDevice) return;
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
      const selectedModel = selectedModelData.models.some((item) => item.id === storedModel)
        ? storedModel
        : selectedProviderId === "codex" ? "" : defaultModel(selectedModelData.models)?.id ?? "";
      setModel(selectedModel);
      const selectedModelInfo = selectedModelData.models.find((item) => item.id === selectedModel)
        ?? selectedModelData.models.find((item) => item.isDefault)
        ?? selectedModelData.models[0];
      const storedEffort = localStorage.getItem(storageKey("effort", deviceRef.current)) ?? "";
      const selectedEffort = selectedModelInfo?.efforts.some((item) => item.id === storedEffort)
        ? storedEffort
        : "";
      setEffort(selectedEffort);
      restoreRoutingSelection(selectedProviderId, selectedModelInfo);
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
        await loadThreads(
          selected,
          true,
          localStorage.getItem(storageKey("thread", selectedDevice)) ?? "",
          attempt,
        );
        await loadProjectHandoff(selected, attempt);
      } else {
        const availableConversations = providerConversationThreads(runData.operations, selectedProviderId, selected);
        const storedConversation = localStorage.getItem(
          providerConversationKey(deviceRef.current, selectedProviderId, selected),
        ) ?? "";
        const selectedConversation = availableConversations.some((item) => item.id === storedConversation)
          ? storedConversation
          : "";
        setThreads(availableConversations);
        setThreadId(selectedConversation);
        threadRef.current = selectedConversation;
        messagesRef.current = [];
        setMessages([]);
        beginConversationJournalScope();
        if (selectedConversation) {
          const restored = providerConversationMessages(
            runData.operations,
            selectedProviderId,
            selected,
            selectedConversation,
          );
          messagesRef.current = restored;
          setMessages(restored);
        }
        setHandoff(null);
      }
      if (attempt !== connectionAttemptRef.current || deviceRef.current !== selectedDevice) return;
      if (selectedProviderId === "codex" && threadRef.current) {
        try {
          const data = await api<{ thread: ThreadDetail }>(`/api/threads/${encodeURIComponent(threadRef.current)}`);
          if (attempt !== connectionAttemptRef.current || deviceRef.current !== selectedDevice) return;
          const restored = historyMessages(data.thread);
          messagesRef.current = restored;
          setMessages(restored);
          markConversationJournalLive();
        } catch {
          // The local work journal effect restores the last saved copy.
        }
      }
      if (attempt !== connectionAttemptRef.current || deviceRef.current !== selectedDevice) return;
      const currentOperation = activeRunRef.current.operation;
      const currentSnapshot = currentOperation
        ? runData.operations.find((item) => item.id === currentOperation.id)
        : undefined;
      if (currentSnapshot) {
        if (currentSnapshot.status === "unknown" && currentSnapshot.acknowledgedAt) {
          dispatchActiveRun({
            type: "acknowledge",
            ...activeRunScope(activeRunRef.current),
            operationId: currentSnapshot.id,
          });
          clearOperationPoll();
        } else if (currentSnapshot.status === "unknown" && currentOperation?.status === "unknown") {
          dispatchActiveRun({
            type: "update",
            ...activeRunScope(activeRunRef.current),
            operationId: currentSnapshot.id,
            operation: currentSnapshot,
          });
          stopRunning();
        } else {
          handleOperationEvent(operationAction(currentSnapshot), currentSnapshot);
        }
      } else if (!currentOperation) {
        const candidates = runData.operations.filter((item) => (item.status === "running"
          || (item.status === "unknown" && !item.acknowledgedAt))
          && (item.providerId ?? "codex") === selectedProviderId
          && item.cwd === selected
          && (!threadRef.current || (selectedProviderId === "codex"
            ? item.threadId === threadRef.current
            : item.conversationId === threadRef.current)));
        const activeOperation = threadRef.current ? candidates[0] : candidates.length === 1 ? candidates[0] : undefined;
        if (activeOperation) {
          const activeConversation = selectedProviderId === "codex"
            ? activeOperation.threadId
            : activeOperation.conversationId;
          if (!threadRef.current && activeConversation) {
            setThreadId(activeConversation);
            threadRef.current = activeConversation;
            persistConversationSelection(
              deviceRef.current,
              selectedProviderId,
              selected,
              activeConversation,
            );
          }
          handleOperationEvent(operationAction(activeOperation), activeOperation);
        }
      }
      resolvePendingNotificationAction(runData.operations);
      initializedRef.current = true;
      if (!onboardingShownRef.current && localStorage.getItem("codex-pocket-onboarding-complete") !== "true") {
        onboardingShownRef.current = true;
        setShowConnectionCenter(true);
        void refreshDiagnostics();
      }
    } catch (error) {
      if (attempt !== connectionAttemptRef.current || deviceRef.current !== selectedDevice) return;
      const cachedWorkspace = localStorage.getItem(storageKey("workspace", selectedDevice)) ?? "";
      const cachedThread = localStorage.getItem(storageKey("thread", selectedDevice)) ?? "";
      if (cachedWorkspace) {
        setWorkspace(cachedWorkspace);
        workspaceRef.current = cachedWorkspace;
        setWorkspaces([{ path: cachedWorkspace, name: workspaceName(cachedWorkspace) }]);
        setThreadId(cachedThread);
        threadRef.current = cachedThread;
      }
      if (error instanceof PocketLinkIdentityRotationRequiredError) {
        dispatchConnection({ type: "identity_rotation_required", attempt, device: selectedDevice });
        setPairing(null);
        setShowConnectionCenter(true);
      } else if (error instanceof PairingRequiredError) {
        dispatchConnection({ type: "pairing_required", attempt, device: selectedDevice });
        void requestPairing();
      } else {
        dispatchConnection({
          type: "failed",
          attempt,
          device: selectedDevice,
          label: deviceLabel(selectedDevice),
        });
      }
      showToast(errorMessage(error));
    } finally {
      if (initializingAttemptRef.current === attempt) initializingAttemptRef.current = null;
    }
  }, [loadProjectHandoff, loadThreads, requestPairing, showToast]);

  initializeRef.current = initialize;

  useEffect(() => {
    deviceRef.current = device;
    setApiDevice(device);
    initializedRef.current = false;
    const attempt = connectionAttemptRef.current + 1;
    connectionAttemptRef.current = attempt;
    dispatchConnection({ type: "begin", attempt, device, label: deviceLabel(device) });
    void (async () => {
      if (isNativeApp()) {
        nativeTunnelStartRef.current = nativeTunnelStartRef.current.then(async () => {
          if (attempt !== connectionAttemptRef.current || deviceRef.current !== device) return;
          try {
            const tunnel = await NativeTunnel.start({ localPort: deviceTargetLocalPort(activeDeviceTarget()) });
            if (attempt === connectionAttemptRef.current && tunnel.manual && tunnel.message) {
              showToast(tunnel.message);
            }
          } catch (error) {
            if (attempt === connectionAttemptRef.current) showToast(errorMessage(error));
          }
        });
        await nativeTunnelStartRef.current;
      }
      if (attempt === connectionAttemptRef.current && deviceRef.current === device) await initialize(attempt);
    })();
    const abort = new AbortController();
    void (async () => {
      let retry = 0;
      while (!abort.signal.aborted) {
        try {
          await subscribeEvents(() => {
            if (attempt !== connectionAttemptRef.current || deviceRef.current !== device) return;
            retry = 0;
            dispatchConnection({ type: "stream_online", attempt, device, label: deviceLabel(device) });
            if (!initializedRef.current) void initialize(attempt);
          }, (event) => {
            if (attempt === connectionAttemptRef.current && deviceRef.current === device) {
              handleEventRef.current(event);
            }
          }, abort.signal);
          if (abort.signal.aborted) return;
          throw new Error("실시간 연결이 종료되었습니다.");
        } catch (error) {
          if (abort.signal.aborted || attempt !== connectionAttemptRef.current || deviceRef.current !== device) return;
          if (error instanceof PairingRequiredError) {
            void requestPairing();
            dispatchConnection({ type: "pairing_required", attempt, device });
            return;
          }
          if (error instanceof PocketLinkIdentityRotationRequiredError) {
            setPairing(null);
            setShowConnectionCenter(true);
            dispatchConnection({ type: "identity_rotation_required", attempt, device });
            return;
          }
          dispatchConnection({ type: "reconnecting", attempt, device });
          retry += 1;
          await abortableDelay(Math.min(15_000, 500 * (2 ** Math.min(retry, 5))), abort.signal);
        }
      }
    })();
    return () => {
      abort.abort();
      if (connectionAttemptRef.current === attempt) connectionAttemptRef.current = attempt + 1;
    };
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
        dispatchVoiceInput({ type: "recognition_active" });
      } else {
        dispatchVoiceInput({ type: "recognition_idle" });
      }
    }));
    void keep(NativeSpeech.addListener("speechError", (event: NativeSpeechError) => {
      if (!event.recoverable) {
        handsFreeRef.current = false;
        dispatchVoiceInput({ type: "fatal_error" });
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
      dispatchVoiceInput({ type: "support_changed", supported: true });
      return;
    }
    const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!Recognition) {
      dispatchVoiceInput({ type: "support_changed", supported: false });
      return;
    }
    const recognition = new Recognition();
    recognition.lang = speechLanguageRef.current;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.onstart = () => dispatchVoiceInput({ type: "recognition_active" });
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
            handsFreeRef.current = false;
            dispatchVoiceInput({ type: "fatal_error" });
          }
        }, 280);
      } else {
        dispatchVoiceInput({ type: "recognition_idle" });
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

  function beginActiveRun(
    nextDevice: DeviceId,
    options: { requestId?: string; liveMessageId?: string; activity?: RunActivityState } = {},
  ): ActiveRunScope {
    clearOperationPoll();
    const generation = Math.max(activeRunGenerationRef.current, activeRunRef.current.generation) + 1;
    activeRunGenerationRef.current = generation;
    dispatchActiveRun({ type: "begin", generation, device: nextDevice, ...options });
    return { generation, device: nextDevice };
  }

  function resetActiveRun(nextDevice = deviceRef.current) {
    return beginActiveRun(nextDevice);
  }

  function beginConversationJournalScope() {
    const key = workspaceRef.current
      ? conversationKey(deviceRef.current, workspaceRef.current, threadRef.current, providerRef.current)
      : "";
    const generation = Math.max(
      conversationJournalGenerationRef.current,
      journalStateRef.current.conversation.generation,
    ) + 1;
    conversationJournalGenerationRef.current = generation;
    dispatchJournal({ type: "conversation_begin", generation, key });
  }

  function beginQueueJournalScope(nextDevice: DeviceId) {
    const generation = Math.max(queueJournalGenerationRef.current, journalStateRef.current.queue.generation) + 1;
    queueJournalGenerationRef.current = generation;
    dispatchJournal({ type: "queue_begin", generation, device: nextDevice });
  }

  function markConversationJournalLive() {
    const current = journalStateRef.current.conversation;
    const key = workspaceRef.current
      ? conversationKey(deviceRef.current, workspaceRef.current, threadRef.current, providerRef.current)
      : "";
    if (current.key !== key) return;
    dispatchJournal({ type: "conversation_live", generation: current.generation, key });
  }

  function activeOwner(state = activeRunRef.current): { requestId?: string; operationId?: string } {
    if (state.operation) return { operationId: state.operation.id };
    if (state.requestId) return { requestId: state.requestId };
    return {};
  }

  function ensureLiveMessage(scope = activeRunScope(activeRunRef.current)): string | null {
    const current = activeRunRef.current;
    if (!activeRunScopeMatches(current, scope)) return null;
    if (current.liveMessageId) return current.liveMessageId;
    const id = newId("assistant");
    const next = dispatchActiveRun({
      type: "set_live_message",
      ...scope,
      ...activeOwner(current),
      messageId: id,
    });
    if (next.liveMessageId !== id) return null;
    setMessages((current) => {
      const next: ChatMessage[] = [...current, { id, role: "assistant", text: "", pending: true }];
      messagesRef.current = next;
      return next;
    });
    return id;
  }

  function buildResultDetails(result: RunResult, latestDiff = activeRunRef.current.latestDiff): string {
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
    if (result.policyUsage) {
      lines.push(result.policyUsage.costMicrosUsd === undefined
        ? `정책 비용 · ${result.policyUsage.status} · 실제 비용 확인 필요`
        : `정책 비용 · ${result.policyUsage.status} · ${formatPolicyUsd(result.policyUsage.costMicrosUsd)} · 요청 ${result.policyUsage.requestCount}회`);
    }
    if (result.routing) {
      const requested = result.routing.requestedUpstreams.length > 0
        ? result.routing.requestedUpstreams.join(" → ")
        : "OpenRouter 자동 선택";
      const actualRoute = result.routing.actualUpstream
        ? `${result.routing.actualUpstream}${result.routing.actualProvider ? ` (${result.routing.actualProvider})` : ""}`
        : result.routing.actualProvider;
      lines.push(`라우팅 · strict ZDR · ${requested} · ${result.routing.allowFallbacks ? "승인 목록 내 fallback" : "fallback 없음"}${actualRoute ? ` · 실제 ${actualRoute}` : ""}`);
    }
    if (latestDiff) lines.push(`\n--- diff ---\n${latestDiff}`);
    return lines.join("\n");
  }

  function finishLiveMessage(
    text: string,
    isError: boolean,
    result: RunResult = {},
    scope = activeRunScope(activeRunRef.current),
    owner = activeOwner(activeRunRef.current),
  ) {
    const current = activeRunRef.current;
    if (!activeRunScopeMatches(current, scope)) return false;
    const id = ensureLiveMessage(scope);
    if (!id) return false;
    replaceMessage(id, {
      text,
      pending: false,
      error: isError,
      details: buildResultDetails(result, current.latestDiff) || undefined,
    });
    dispatchActiveRun({ type: "finish", ...scope, ...owner });
    clearOperationPoll();
    markConversationJournalLive();
    return true;
  }

  function clearOperationPoll() {
    if (pollTimerRef.current !== null) window.clearTimeout(pollTimerRef.current);
    pollTimerRef.current = null;
  }

  function stopRunning(scope = activeRunScope(activeRunRef.current), owner = activeOwner(activeRunRef.current)) {
    clearOperationPoll();
    dispatchActiveRun({
      type: "set_activity",
      ...scope,
      ...owner,
      activity: { running: false, text: "", detail: "" },
    });
  }

  function setRunning(
    text: string,
    detail = "",
    scope = activeRunScope(activeRunRef.current),
    owner = activeOwner(activeRunRef.current),
  ) {
    dispatchActiveRun({
      type: "set_activity",
      ...scope,
      ...owner,
      activity: { running: true, text, detail },
    });
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
      const [runData, approvalData, workspaceData, journalData, runPolicyData, recoveryData] = await Promise.all([
        api<{ operations: Operation[] }>("/api/runs"),
        api<{ approvals: ApprovalItem[] }>("/api/approvals"),
        api<WorkspaceResponse>("/api/workspaces"),
        api<{ policy: JournalPolicy; limits: JournalPolicyLimits }>("/api/journal/policy")
          .catch(() => ({ policy: null, limits: null })),
        api<{ policy: RunPolicyConfig; limits: RunPolicyConfigLimits }>("/api/run-policy")
          .catch(() => ({ policy: null, limits: null })),
        api<WorkspaceChangeRecoveryResponse>("/api/workspace-changes/recovery")
          .catch(() => ({ supported: false, status: null })),
      ]);
      if (deviceRef.current !== requestedDevice) return;
      setOperationSnapshots(runData.operations);
      setApprovalInbox(activeApprovals(approvalData.approvals));
      setWorkspaces(workspaceData.workspaces);
      setCreationLocations(workspaceData.creationLocations);
      setJournalPolicy(journalData.policy);
      setJournalPolicyLimits(journalData.limits);
      setRunPolicy(runPolicyData.policy);
      setRunPolicyLimits(runPolicyData.limits);
      setWorkspaceRecovery(recoveryData.status);
      if (!silent) showToast("프로젝트 작업 상태를 새로 확인했습니다.");
    } catch (error) {
      if (!silent && deviceRef.current === requestedDevice) showToast(errorMessage(error));
    }
  }

  function scheduleOperationPoll(
    operationId: string,
    scope = activeRunScope(activeRunRef.current),
  ) {
    if (!activeRunOwnsOperation(activeRunRef.current, scope, operationId)) return;
    clearOperationPoll();
    pollTimerRef.current = window.setTimeout(() => void pollOperation(operationId, scope), 2_000);
  }

  async function pollOperation(operationId: string, scope: ActiveRunScope) {
    const current = activeRunRef.current.operation;
    if (!activeRunOwnsOperation(activeRunRef.current, scope, operationId) || current?.status !== "running") return;
    try {
      const data = await api<{ operation: Operation }>(`/api/runs/${encodeURIComponent(operationId)}`);
      if (!activeRunOwnsOperation(activeRunRef.current, scope, operationId)) return;
      if (data.operation.status === "running") {
        syncSteerMessages(data.operation);
        dispatchActiveRun({ type: "update", ...scope, operationId, operation: data.operation });
        scheduleOperationPoll(operationId, scope);
        return;
      }
      handleOperationEvent(
        data.operation.status === "unknown" ? "recovered" : data.operation.status === "failed" ? "failed" : "completed",
        data.operation,
        scope,
      );
    } catch {
      if (activeRunOwnsOperation(activeRunRef.current, scope, operationId)) {
        scheduleOperationPoll(operationId, scope);
      }
    }
  }

  function handleOperationEvent(
    action: string,
    nextOperation: Operation,
    expectedScope = activeRunScope(activeRunRef.current),
    requestId?: string,
  ) {
    if (!activeRunScopeMatches(activeRunRef.current, expectedScope)) return;
    const operationProvider = nextOperation.providerId ?? "codex";
    const updateSnapshots = (current: Operation[]) => {
      const retired = nextOperation.status === "completed"
          && operationProvider !== "codex" && nextOperation.conversationId
        ? current.map((item) => item.id !== nextOperation.id
            && item.providerId === operationProvider
            && item.cwd === nextOperation.cwd
            && item.conversationId === nextOperation.conversationId
          ? { ...item, resumable: false }
          : item)
        : current;
      return upsertOperation(retired, nextOperation);
    };
    setOperationSnapshots(updateSnapshots);
    if (action === "acknowledged") {
      if (activeRunRef.current.operation?.id !== nextOperation.id) return;
      dispatchActiveRun({
        type: "acknowledge",
        ...expectedScope,
        operationId: nextOperation.id,
      });
      clearOperationPoll();
      startNextQueuedPrompt(threadRef.current);
      return;
    }
    if ((requestId !== undefined || action === "started" || action === "recovered")
        && !activeRunRef.current.operation) {
      if (nextOperation.cwd !== workspaceRef.current || operationProvider !== providerRef.current) return;
      const operationConversation = operationProvider === "codex"
        ? nextOperation.threadId
        : nextOperation.conversationId;
      if (threadRef.current && operationConversation !== threadRef.current) return;
      if (!threadRef.current && operationConversation) {
        setThreadId(operationConversation);
        threadRef.current = operationConversation;
        persistConversationSelection(
          deviceRef.current,
          operationProvider,
          nextOperation.cwd,
          operationConversation,
        );
      }
      const adopted = dispatchActiveRun({
        type: "adopt",
        ...expectedScope,
        ...(requestId === undefined ? {} : { requestId }),
        operation: nextOperation,
      });
      if (adopted.operation?.id !== nextOperation.id) return;
      ensureLiveMessage(expectedScope);
    }
    if (activeRunRef.current.operation?.id !== nextOperation.id) return;
    syncSteerMessages(nextOperation);
    dispatchActiveRun({
      type: "update",
      ...expectedScope,
      operationId: nextOperation.id,
      operation: nextOperation,
    });

    if (nextOperation.status === "running") {
      setRunning(operationProvider === "codex"
        ? "Codex가 프로젝트를 살펴보고 있습니다…"
        : "AI가 프로젝트를 살펴보고 있습니다…", "", expectedScope, { operationId: nextOperation.id });
      scheduleOperationPoll(nextOperation.id, expectedScope);
    } else if (action === "recovered" || nextOperation.status === "unknown") {
      const messageId = ensureLiveMessage(expectedScope);
      if (!messageId) return;
      replaceMessage(messageId, {
        text: nextOperation.error || "Companion 재시작 전 작업의 최종 상태를 확인할 수 없습니다.",
        pending: false,
        error: true,
      });
      dispatchActiveRun({
        type: "mark_unknown",
        ...expectedScope,
        operationId: nextOperation.id,
        operation: nextOperation,
      });
      clearOperationPoll();
    } else if (action === "completed") {
      const result = nextOperation.result ?? {};
      finishLiveMessage(
        result.finalResponse || statusMessage(nextOperation.status),
        false,
        result,
        expectedScope,
        { operationId: nextOperation.id },
      );
      if (result.threadId) {
        setThreadId(result.threadId);
        threadRef.current = result.threadId;
        localStorage.setItem(storageKey("thread", deviceRef.current), result.threadId);
      }
      if (operationProvider !== "codex" && nextOperation.status === "completed" && nextOperation.conversationId) {
        const conversationId = nextOperation.conversationId;
        if (nextOperation.resumable) {
          setThreadId(conversationId);
          threadRef.current = conversationId;
          persistConversationSelection(
            deviceRef.current,
            operationProvider,
            nextOperation.cwd,
            conversationId,
          );
        } else {
          setThreadId("");
          threadRef.current = "";
          persistConversationSelection(deviceRef.current, operationProvider, nextOperation.cwd, "");
          showToast("이 응답의 replay context를 안전하게 저장하지 못해 새 대화로만 계속할 수 있습니다.");
        }
      }
      if (ttsRef.current && result.finalResponse) speak(result.finalResponse);
      if (operationProvider === "codex") {
        void loadThreads(workspaceRef.current, true, result.threadId, undefined, expectedScope);
      }
      startNextQueuedPrompt(result.threadId ?? nextOperation.conversationId ?? threadRef.current);
    } else if (action === "failed") {
      finishLiveMessage(
        `작업 실패: ${nextOperation.error || "알 수 없는 오류"}`,
        true,
        {},
        expectedScope,
        { operationId: nextOperation.id },
      );
      startNextQueuedPrompt(threadRef.current);
    }
  }

  function syncSteerMessages(nextOperation: Operation) {
    const additions = (nextOperation.steers ?? []).flatMap((steer, index) => {
      const id = `steer-${nextOperation.id}-${steer.acceptedAt}-${index}`;
      if (messagesRef.current.some((message) => message.id === id)) return [];
      const attachmentLabel = steer.attachmentCount > 0 ? `\n\n📎 첨부 ${steer.attachmentCount}개` : "";
      return [{
        id,
        role: "user" as const,
        text: `↪ 지금 방향 수정\n${steer.prompt}${attachmentLabel}`,
      }];
    });
    if (additions.length === 0) return;
    setMessages((current) => {
      const liveMessageId = activeRunRef.current.liveMessageId;
      const liveIndex = liveMessageId ? current.findIndex((message) => message.id === liveMessageId) : -1;
      const next = liveIndex >= 0
        ? [...current.slice(0, liveIndex), ...additions, ...current.slice(liveIndex)]
        : [...current, ...additions];
      messagesRef.current = next;
      return next;
    });
    markConversationJournalLive();
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
      const current = activeRunRef.current.operation;
      if (current?.cwd === event.workspace && current.status !== "running"
        && (current.status !== "unknown" || current.acknowledgedAt)) {
        dispatchActiveRun({
          type: "finish",
          ...activeRunScope(activeRunRef.current),
          operationId: current.id,
        });
        clearOperationPoll();
      }
      return;
    }
    if (event.type === "journal" && event.action === "policy_updated" && event.policy) {
      setJournalPolicy(event.policy);
      void refreshOperationalSnapshot(true);
      return;
    }
    if (event.type === "run_policy" && event.action === "updated" && event.runPolicy) {
      setRunPolicy(event.runPolicy);
      setLastRunPolicyPreflight(null);
      return;
    }
    if (event.type === "journal" && event.action === "reset") {
      const current = activeRunRef.current.operation;
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
      dispatchMediaComposer({ type: "server_update", media: event.media });
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
    const current = activeRunRef.current.operation;
    if (!current) return;
    const scope = activeRunScope(activeRunRef.current);
    if (event.type === "provider") {
      if (event.providerId !== current.providerId
        || event.conversationId !== current.conversationId
        || (event.runId && event.runId !== current.runId)) return;
      switch (event.kind) {
        case "output.delta": {
          const messageId = ensureLiveMessage(scope);
          if (!messageId) return;
          const next = dispatchActiveRun({
            type: "append_output",
            ...scope,
            operationId: current.id,
            messageId,
            delta: event.delta ?? "",
          });
          replaceMessage(messageId, { text: next.liveText });
          setRunning("AI가 답변을 작성하고 있습니다…");
          break;
        }
        case "tool.started":
          setRunning("도구를 실행하고 있습니다…", event.tool?.command ?? event.tool?.paths?.join("\n"));
          break;
        case "tool.completed":
          setRunning(`도구 완료 · ${event.tool?.status || "처리됨"}`, event.tool?.command);
          break;
        case "workspace.diff": {
          const diff = event.diff ?? "";
          dispatchActiveRun({
            type: "set_diff",
            ...scope,
            operationId: current.id,
            diff,
          });
          setRunning("변경 내용을 검토하고 있습니다…", diff);
          break;
        }
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
        const messageId = ensureLiveMessage(scope);
        if (!messageId) return;
        const next = dispatchActiveRun({
          type: "append_output",
          ...scope,
          operationId: current.id,
          messageId,
          delta: typeof params.delta === "string" ? params.delta : "",
        });
        replaceMessage(messageId, { text: next.liveText });
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
      case "turn/diff/updated": {
        const diff = stringValue(params.diff);
        dispatchActiveRun({
          type: "set_diff",
          ...scope,
          operationId: current.id,
          diff,
        });
        setRunning("변경 내용을 검토하고 있습니다…", diff);
        break;
      }
      case "error":
        showToast(stringValue(params.message) || "Codex 처리 중 오류가 발생했습니다.");
        break;
    }
  }

  async function toggleNativeNotifications() {
    if (!isNativeApp()) return;
    if (notificationsEnabledRef.current) {
      try {
        await NativeNotifications.disable();
        notificationsEnabledRef.current = false;
        setNotificationsEnabled(false);
        showToast("Android 작업 알림을 껐습니다.");
      } catch (error) {
        showToast(errorMessage(error));
      }
      return;
    }
    try {
      const permission = await NativeNotifications.requestPermission();
      if (permission.state !== "granted") {
        showToast(permission.state === "denied"
          ? "Android 설정에서 Codex Pocket Voice 알림을 허용해 주세요."
          : "작업 알림 권한을 허용해야 켤 수 있습니다.");
        return;
      }
      const subscriptions = backgroundEventSubscriptions();
      if (subscriptions.length === 0) {
        showToast("먼저 알림을 받을 Linux Companion을 페어링해 주세요.");
        return;
      }
      await NativeNotifications.configure({ subscriptions });
      notificationsEnabledRef.current = true;
      setNotificationsEnabled(true);
      showToast("앱 프로세스가 종료되어도 완료·승인·오류 알림을 확인합니다.");
    } catch (error) {
      showToast(errorMessage(error));
    }
  }

  async function selectSignedUpdateBundle() {
    if (!isNativeApp() || updateBusy) return;
    setUpdateBusy(true);
    setUpdateError("");
    setUpdateInstallPermissionRequired(false);
    try {
      const selected = await NativeUpdate.selectBundle();
      if (selected.cancelled) return;
      setUpdateDiscovery(null);
      setUpdateReview(selected);
      showToast(`서명과 APK를 확인했습니다 · v${selected.version}`);
    } catch (error) {
      setUpdateReview(null);
      setUpdateError(errorMessage(error));
    } finally {
      setUpdateBusy(false);
    }
  }

  async function discoverOfficialUpdate() {
    if (!isNativeApp() || updateBusy) return;
    setUpdateBusy(true);
    setUpdateError("");
    setUpdateInstallPermissionRequired(false);
    setUpdateReview(null);
    try {
      const discovered = await NativeUpdate.discoverOfficial();
      setUpdateDiscovery(discovered);
      showToast(discovered.available
        ? `공식 정식판 v${discovered.latestVersion}을 찾았습니다. 다운로드 전 내용을 확인해 주세요.`
        : `현재 v${discovered.currentVersion}은 공식 Latest보다 같거나 새롭습니다.`);
    } catch (error) {
      setUpdateDiscovery(null);
      setUpdateError(errorMessage(error));
    } finally {
      setUpdateBusy(false);
    }
  }

  async function downloadOfficialUpdate() {
    if (!isNativeApp() || !updateDiscovery?.available || !updateDiscovery.token || updateBusy) return;
    if (!updateDiscovery.expiresAt || Date.now() >= updateDiscovery.expiresAt) {
      setUpdateDiscovery(null);
      setUpdateError("10분 조회 시간이 만료되었습니다. 공식 정식판을 다시 조회해 주세요.");
      void NativeUpdate.discard();
      return;
    }
    setUpdateBusy(true);
    setUpdateError("");
    setUpdateInstallPermissionRequired(false);
    try {
      const verified = await NativeUpdate.downloadOfficial({ token: updateDiscovery.token });
      setUpdateDiscovery(null);
      setUpdateReview(verified);
      showToast(`공식 ZIP의 서명과 APK를 확인했습니다 · v${verified.version}`);
    } catch (error) {
      setUpdateDiscovery(null);
      setUpdateReview(null);
      setUpdateError(errorMessage(error));
    } finally {
      setUpdateBusy(false);
    }
  }

  async function discardSignedUpdateBundle() {
    if (!isNativeApp() || updateBusy) return;
    setUpdateBusy(true);
    try {
      await NativeUpdate.discard();
      setUpdateDiscovery(null);
      setUpdateReview(null);
      setUpdateError("");
      setUpdateInstallPermissionRequired(false);
    } catch (error) {
      setUpdateError(errorMessage(error));
    } finally {
      setUpdateBusy(false);
    }
  }

  async function installSignedUpdate() {
    if (!isNativeApp() || !updateReview || updateBusy) return;
    if (Date.now() >= updateReview.expiresAt) {
      setUpdateError("10분 검토 시간이 만료되었습니다. 업데이트 ZIP을 다시 선택해 주세요.");
      setUpdateReview(null);
      void NativeUpdate.discard();
      return;
    }
    setUpdateBusy(true);
    setUpdateError("");
    setUpdateInstallPermissionRequired(false);
    try {
      const result = await NativeUpdate.installVerified({ token: updateReview.token });
      if (result.settingsRequired) {
        setUpdateInstallPermissionRequired(true);
        setUpdateError("Android 설정에서 ‘이 출처 허용’을 켠 뒤 돌아와 설치를 다시 눌러 주세요.");
      } else if (result.launched) {
        showToast("Android 설치 확인창을 열었습니다. 버전과 앱 이름을 다시 확인해 주세요.");
      }
    } catch (error) {
      setUpdateError(errorMessage(error));
    } finally {
      setUpdateBusy(false);
    }
  }

  async function consumeNativeNotificationAction() {
    try {
      const action = await NativeNotifications.consumePendingAction();
      if (!action.pending || !action.deviceId || !action.operationId) return;
      const target = listDeviceTargets().find((item) => item.id === action.deviceId);
      if (!target) {
        showToast("알림의 Linux PC 등록을 찾을 수 없습니다.");
        return;
      }
      pendingNotificationActionRef.current = action;
      if (action.deviceId !== deviceRef.current) {
        selectDevice(action.deviceId);
        return;
      }
      const attempt = connectionAttemptRef.current;
      const selectedDevice = deviceRef.current;
      if (initializingAttemptRef.current === attempt) return;
      const data = await api<{ operations: Operation[] }>("/api/runs");
      if (attempt !== connectionAttemptRef.current || selectedDevice !== deviceRef.current) return;
      setOperationSnapshots(data.operations);
      resolvePendingNotificationAction(data.operations);
    } catch (error) {
      showToast(errorMessage(error));
    }
  }

  function resolvePendingNotificationAction(operations: readonly Operation[]) {
    const action = pendingNotificationActionRef.current;
    if (!action?.pending || action.deviceId !== deviceRef.current || !action.operationId) return;
    pendingNotificationActionRef.current = null;
    const target = operations.find((operation) => operation.id === action.operationId);
    if (!target) {
      setShowOperationsDashboard(true);
      showToast("알림의 작업이 현재 Companion 보존 범위에 없습니다.");
      return;
    }
    openOperationFromDashboardRef.current(target);
  }

  handleEventRef.current = handleEvent;

  async function addMedia(files: FileList | null) {
    if (!files?.length) return;
    const selected = [...files].slice(0, Math.max(
      0,
      MAX_COMPOSER_ATTACHMENTS - mediaComposerRef.current.attachments.length,
    ));
    if (selected.length < files.length) {
      showToast(`첨부 파일은 한 번에 최대 ${MAX_COMPOSER_ATTACHMENTS}개까지 보낼 수 있습니다.`);
    }
    if (selected.length === 0) {
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }
    const pending = selected.map((file) => {
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
      dispatchMediaComposer({ type: "add_placeholder", attachment: placeholder });
      return { file, localId, previewUrl };
    });
    dispatchMediaComposer({ type: "begin_upload_batch" });
    try {
      for (const { file, localId, previewUrl } of pending) {
        if (!mediaComposerRef.current.attachments.some((item) => item.id === localId)) continue;
        try {
          const uploaded = await uploadMedia<MediaItem>(file, (progress) => {
            dispatchMediaComposer({ type: "upload_progress", id: localId, progress });
          });
          if (!mediaComposerRef.current.attachments.some((item) => item.id === localId)) {
            await api(`/api/media/${encodeURIComponent(uploaded.id)}`, { method: "DELETE" }).catch(() => undefined);
            if (previewUrl) URL.revokeObjectURL(previewUrl);
            continue;
          }
          dispatchMediaComposer({ type: "upload_complete", placeholderId: localId, media: uploaded, previewUrl });
          if (uploaded.kind === "video") void analyzeMedia(uploaded.id);
        } catch (error) {
          dispatchMediaComposer({ type: "remove", id: localId });
          if (previewUrl) URL.revokeObjectURL(previewUrl);
          showToast(errorMessage(error));
        }
      }
    } finally {
      dispatchMediaComposer({ type: "finish_upload_batch" });
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
    dispatchMediaComposer({ type: "server_update", media });
  }

  async function removeAttachment(id: string) {
    const uploaded = attachments.find((item) => item.id === id && item.status !== "uploading");
    if (uploaded) await api(`/api/media/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => undefined);
    const removed = attachments.find((item) => item.id === id);
    if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
    dispatchMediaComposer({ type: "remove", id });
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

    if (composerRunMode === "steer") {
      await submitSteer(text);
      return;
    }

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
      routing: selectedRouting(provider, routingPrimary, routingBackup),
      attachments: [...attachments],
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
    };
    setPrompt("");
    dispatchMediaComposer({ type: "clear" });
    if (connection !== "online" || pendingRunPolicyReviewRef.current
        || activeRunRef.current.operation !== null
        || activeRunRef.current.requestId !== null) {
      const nextQueue = [...promptQueueRef.current, queued];
      updatePromptQueue(nextQueue);
      showToast(connection === "online"
        ? activeRunRef.current.operation?.status === "unknown"
          ? `이전 작업 상태를 확인할 때까지 요청을 대기열 ${nextQueue.length}번째에 보관합니다.`
          : `요청을 대기열 ${nextQueue.length}번째에 추가했습니다.`
        : `오프라인 대기열에 저장했습니다. ${deviceLabel(deviceRef.current)} 연결 후 자동 실행됩니다.`);
      return;
    }
    await executePrompt(queued);
  }

  async function submitSteer(text: string) {
    const current = activeRunRef.current.operation;
    const selectedDevice = deviceRef.current;
    const scope = activeRunScope(activeRunRef.current);
    const canSteer = connection === "online" && current?.status === "running"
      && current.providerId === "codex"
      && activeProvider(providers, "codex")?.capabilities.steering === true;
    if (!canSteer || !current) {
      setComposerRunMode("queue");
      showToast("현재 작업에는 방향 수정을 적용할 수 없습니다. 입력은 그대로 두었습니다.");
      return;
    }
    if (steering) return;
    const fingerprint = JSON.stringify([
      selectedDevice,
      current.id,
      text,
      attachments.map((item) => item.id),
    ]);
    if (steerRequestRef.current?.fingerprint !== fingerprint) {
      steerRequestRef.current = { fingerprint, requestId: newId("steer") };
    }
    const requestId = steerRequestRef.current.requestId;
    setSteering(true);
    try {
      const data = await api<{ operation: Operation }>(`/api/runs/${encodeURIComponent(current.id)}/steer`, {
        method: "POST",
        body: {
          requestId,
          prompt: text,
          attachments: attachments.map((item) => item.id),
        },
      });
      if (deviceRef.current !== selectedDevice || !activeRunScopeMatches(activeRunRef.current, scope)) return;
      const stillOwnsOperation = activeRunOwnsOperation(activeRunRef.current, scope, current.id);
      for (const item of attachments) if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      setPrompt("");
      dispatchMediaComposer({ type: "clear" });
      setComposerRunMode("queue");
      steerRequestRef.current = null;
      if (stillOwnsOperation) handleOperationEvent("steered", data.operation, scope);
      showToast("현재 Codex 작업에 방향 수정을 전달했습니다.");
    } catch (error) {
      if (deviceRef.current !== selectedDevice) return;
      if (error instanceof ApiError && error.status === 409) setComposerRunMode("queue");
      showToast(errorMessage(error));
    } finally {
      setSteering(false);
    }
  }

  async function executePrompt(queued: QueuedPrompt, continuedThreadId = "") {
    const selectedDevice = deviceRef.current;
    if ((queued.provider === "openai" || queued.provider === "openrouter")
        && !queued.policyConfirmation) {
      const holdForPolicyReview = (review: PendingRunPolicyReview) => {
        pendingRunPolicyReviewRef.current = review;
        setPendingRunPolicyReview(review);
        updatePromptQueue([
          queued,
          ...promptQueueRef.current.filter((item) => item.id !== queued.id),
        ]);
        queueDispatchingRef.current = false;
      };
      try {
        const data = await api<{ preflight: RunPolicyPreflight }>("/api/run-policy/preflight", {
          method: "POST",
          body: {
            provider: queued.provider,
            accountId: queued.accountId,
            model: queued.model || undefined,
            routing: queued.routing,
            attachments: queued.attachments.map((item) => item.id),
          },
        });
        if (deviceRef.current !== selectedDevice) return;
        setLastRunPolicyPreflight(data.preflight.snapshot);
        if (data.preflight.snapshot.confirmationRequired) {
          const review: PendingRunPolicyReview = data.preflight.confirmationToken
            ? { queued, continuedThreadId, preflight: data.preflight }
            : { queued, continuedThreadId, error: "Companion이 비용 확인 토큰을 발급하지 않았습니다." };
          holdForPolicyReview(review);
          return;
        }
      } catch (error) {
        if (deviceRef.current !== selectedDevice) return;
        const review: PendingRunPolicyReview = {
          queued,
          continuedThreadId,
          error: errorMessage(error),
        };
        holdForPolicyReview(review);
        return;
      }
    }
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
    markConversationJournalLive();
    const runScope = beginActiveRun(selectedDevice, {
      requestId: queued.id,
      liveMessageId: assistantId,
      activity: {
        running: true,
        text: queued.provider === "codex" ? "Codex가 요청을 시작하고 있습니다…" : "AI가 요청을 시작하고 있습니다…",
        detail: "",
      },
    });

    try {
      const data = await api<{ operation: Operation }>("/api/runs", {
        method: "POST",
        body: {
          requestId: queued.id,
          prompt: queued.text,
          cwd: queued.cwd,
          threadId: queued.provider === "codex" ? queued.threadId || continuedThreadId || undefined : undefined,
          conversationId: queued.provider !== "codex" ? queued.threadId || continuedThreadId || undefined : undefined,
          networkAccess: queued.networkAccess,
          model: queued.model || undefined,
          effort: queued.effort || undefined,
          provider: queued.provider,
          accountId: queued.accountId,
          routing: queued.routing,
          policyConfirmation: queued.policyConfirmation,
          attachments: queued.attachments.map((item) => item.id),
        },
      });
      if (!activeRunScopeMatches(activeRunRef.current, runScope)
          || activeRunRef.current.requestId !== queued.id
          || deviceRef.current !== selectedDevice) return;
      queueDispatchingRef.current = false;
      for (const item of queued.attachments) if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      handleOperationEvent(operationAction(data.operation), data.operation, runScope, queued.id);
      if (activeRunScopeMatches(activeRunRef.current, runScope)
          && activeRunRef.current.requestId === queued.id) {
        finishLiveMessage(
          "Companion 응답이 현재 프로젝트 또는 AI 제공자와 일치하지 않아 연결하지 않았습니다.",
          true,
          {},
          runScope,
          { requestId: queued.id },
        );
        startNextQueuedPrompt(continuedThreadId || threadRef.current);
      }
    } catch (error) {
      if (!activeRunScopeMatches(activeRunRef.current, runScope)
          || activeRunRef.current.requestId !== queued.id
          || deviceRef.current !== selectedDevice) return;
      queueDispatchingRef.current = false;
      const message = errorMessage(error);
      if (message.includes("연결할 수 없습니다")) {
        dispatchConnection({
          type: "reconnecting",
          attempt: connectionAttemptRef.current,
          device: deviceRef.current,
        });
        updatePromptQueue([{ ...queued, displayed: true }, ...promptQueueRef.current]);
        finishLiveMessage(
          "단말 연결이 끊겨 요청을 오프라인 대기열로 되돌렸습니다.",
          true,
          {},
          runScope,
          { requestId: queued.id },
        );
        return;
      }
      finishLiveMessage(
        `실행하지 못했습니다: ${message}`,
        true,
        {},
        runScope,
        { requestId: queued.id },
      );
      startNextQueuedPrompt(continuedThreadId || threadRef.current);
    }
  }

  function approveRunPolicyReview() {
    const review = pendingRunPolicyReviewRef.current;
    const token = review?.preflight?.confirmationToken;
    if (!review || !token) return;
    pendingRunPolicyReviewRef.current = null;
    setPendingRunPolicyReview(null);
    updatePromptQueue(promptQueueRef.current.filter((item) => item.id !== review.queued.id));
    if (review.preflight?.confirmationExpiresAt
        && Date.parse(review.preflight.confirmationExpiresAt) <= Date.now()) {
      void executePrompt({ ...review.queued, policyConfirmation: undefined }, review.continuedThreadId);
      return;
    }
    void executePrompt({ ...review.queued, policyConfirmation: token }, review.continuedThreadId);
  }

  function retryRunPolicyReview() {
    const review = pendingRunPolicyReviewRef.current;
    if (!review) return;
    pendingRunPolicyReviewRef.current = null;
    setPendingRunPolicyReview(null);
    updatePromptQueue(promptQueueRef.current.filter((item) => item.id !== review.queued.id));
    void executePrompt({ ...review.queued, policyConfirmation: undefined }, review.continuedThreadId);
  }

  function restoreRunPolicyReview() {
    const review = pendingRunPolicyReviewRef.current;
    if (!review) return;
    pendingRunPolicyReviewRef.current = null;
    setPendingRunPolicyReview(null);
    updatePromptQueue(promptQueueRef.current.filter((item) => item.id !== review.queued.id));
    setProvider(review.queued.provider);
    providerRef.current = review.queued.provider;
    localStorage.setItem(storageKey("provider", deviceRef.current), review.queued.provider);
    setAccountId(review.queued.accountId);
    if (review.queued.accountId) localStorage.setItem(storageKey("account", deviceRef.current), review.queued.accountId);
    setModel(review.queued.model);
    setEffort(review.queued.effort);
    if (review.queued.model) localStorage.setItem(storageKey("model", deviceRef.current), review.queued.model);
    else localStorage.removeItem(storageKey("model", deviceRef.current));
    if (review.queued.effort) localStorage.setItem(storageKey("effort", deviceRef.current), review.queued.effort);
    else localStorage.removeItem(storageKey("effort", deviceRef.current));
    setNetworkAccess(review.queued.networkAccess);
    setRoutingPrimary(review.queued.routing?.upstreams[0] ?? "");
    setRoutingBackup(review.queued.routing?.upstreams[1] ?? "");
    setWorkspace(review.queued.cwd);
    workspaceRef.current = review.queued.cwd;
    setThreadId(review.queued.threadId);
    threadRef.current = review.queued.threadId;
    persistConversationSelection(
      deviceRef.current,
      review.queued.provider,
      review.queued.cwd,
      review.queued.threadId,
    );
    setPrompt(review.queued.text);
    dispatchMediaComposer({ type: "clear" });
    for (const attachment of review.queued.attachments) {
      dispatchMediaComposer({ type: "add_placeholder", attachment });
    }
    void api<ModelResponse>(`/api/models?provider=${encodeURIComponent(review.queued.provider)}`)
      .then((data) => {
        if (providerRef.current === review.queued.provider) setModels(data.models);
      })
      .catch(() => undefined);
    beginConversationJournalScope();
    queueDispatchingRef.current = false;
  }

  function startNextQueuedPrompt(continuedThreadId: string) {
    if (queueDispatchingRef.current || pendingRunPolicyReviewRef.current
        || activeRunRef.current.operation || activeRunRef.current.requestId) return;
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
      persistConversationSelection(
        deviceRef.current,
        next.provider,
        next.cwd,
        effectiveThreadId,
      );
      messagesRef.current = [];
      setMessages([]);
      beginConversationJournalScope();
    }
    void executePrompt(next, continuedThreadId);
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
    dispatchJournal({ type: "queue_changed", device: deviceRef.current });
    if (queueJournalReady(journalStateRef.current, deviceRef.current)) {
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
    const current = activeRunRef.current.operation;
    if (!current) return;
    if (!operationBelongsToSession(current, workspaceRef.current, threadRef.current)) {
      showToast("현재 프로젝트의 작업이 아니어서 중단하지 않았습니다.");
      return;
    }
    const scope = activeRunScope(activeRunRef.current);
    try {
      await api(`/api/runs/${encodeURIComponent(current.id)}/interrupt`, { method: "POST", body: {} });
      setRunning("중단을 요청했습니다…", "", scope, { operationId: current.id });
    } catch (error) {
      showToast(errorMessage(error));
    }
  }

  async function acknowledgeUnknownOperation() {
    const current = activeRunRef.current.operation;
    if (current?.status !== "unknown") return;
    const scope = activeRunScope(activeRunRef.current);
    const hadQueuedPrompts = promptQueueRef.current.length > 0;
    try {
      const data = await api<{ operation: Operation }>(`/api/runs/${encodeURIComponent(current.id)}/acknowledge`, {
        method: "POST",
        body: {},
      });
      if (!activeRunOwnsOperation(activeRunRef.current, scope, current.id)) return;
      setOperationSnapshots((snapshots) => upsertOperation(snapshots, data.operation));
      handleOperationEvent("acknowledged", data.operation, scope);
      showToast(hadQueuedPrompts
        ? "상태 확인을 마쳤습니다. 보관한 대기열을 다시 시작합니다."
        : "상태 확인을 마쳤습니다. 새 작업을 시작할 수 있습니다.");
    } catch (error) {
      showToast(errorMessage(error));
    }
  }

  async function releaseSession() {
    if (handoffBusy) return;
    if (activeRunRef.current.requestId) {
      showToast("작업 시작 응답을 확인한 뒤 세션을 반납해 주세요.");
      return;
    }
    if (promptQueueRef.current.length > 0) {
      showToast("이 기기에만 저장된 대기열이 있습니다. 모두 실행하거나 취소한 뒤 세션을 반납하세요.");
      return;
    }
    const candidateOperation = activeRunRef.current.operation;
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
    resetActiveRun();
    setThreadId("");
    threadRef.current = "";
    localStorage.removeItem(storageKey("thread", deviceRef.current));
    setMessages([]);
    messagesRef.current = [];
    beginConversationJournalScope();
    setShowHandoffDialog(false);
  }

  async function resumeHandoff() {
    const pending = handoff;
    if (!pending || handoffBusy) return;
    if (promptQueueRef.current.length > 0) {
      showToast("현재 기기의 대기열을 먼저 실행하거나 취소한 뒤 인계받으세요.");
      return;
    }
    const selectedDevice = deviceRef.current;
    setHandoffBusy(true);
    try {
      if (!workspaces.some((item) => item.path === pending.workspace)) {
        throw new Error("인계된 프로젝트가 현재 PC의 허용 목록에 없습니다.");
      }
      setWorkspace(pending.workspace);
      workspaceRef.current = pending.workspace;
      localStorage.setItem(storageKey("workspace", deviceRef.current), pending.workspace);
      const runScope = resetActiveRun(selectedDevice);
      await loadThreads(pending.workspace, false, pending.threadId, undefined, runScope);
      const data = await api<{ thread: ThreadDetail }>(`/api/threads/${encodeURIComponent(pending.threadId)}`);
      if (deviceRef.current !== selectedDevice || !activeRunScopeMatches(activeRunRef.current, runScope)) return;
      setThreadId(pending.threadId);
      threadRef.current = pending.threadId;
      localStorage.setItem(storageKey("thread", deviceRef.current), pending.threadId);
      const restored = historyMessages(data.thread);
      messagesRef.current = restored;
      setMessages(restored);
      beginConversationJournalScope();
      if (pending.operationId) {
        const active = await api<{ operation: Operation }>(`/api/runs/${encodeURIComponent(pending.operationId)}`)
          .catch(() => null);
        if (deviceRef.current !== selectedDevice || !activeRunScopeMatches(activeRunRef.current, runScope)) return;
        if (active?.operation.status === "running") handleOperationEvent("started", active.operation, runScope);
        else if (active?.operation.status === "unknown") handleOperationEvent("recovered", active.operation, runScope);
        else if (active?.operation.status === "failed") handleOperationEvent("failed", active.operation, runScope);
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
    setRoutingPrimary("");
    setRoutingBackup("");
    setMessages([]);
    messagesRef.current = [];
    resetActiveRun(nextDevice);
    promptQueueRef.current = [];
    setPromptQueue([]);
    beginQueueJournalScope(nextDevice);
    queueDispatchingRef.current = false;
    beginConversationJournalScope();
    setHandoff(null);
    setShowHandoffDialog(false);
    setHandoffSupported(false);
    setOperationSnapshots([]);
    setApprovalInbox([]);
    setShowOperationsDashboard(false);
    setDecidingApprovalId(null);
    setJournalPolicy(null);
    setJournalPolicyLimits(null);
    setUpdatingJournalPolicy(false);
    setRunPolicy(null);
    setRunPolicyLimits(null);
    setUpdatingRunPolicy(false);
    setLastRunPolicyPreflight(null);
    pendingRunPolicyReviewRef.current = null;
    setPendingRunPolicyReview(null);
    setWorkspaceRecovery(null);
    setRetryingWorkspaceRecovery(false);
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
    restoreRoutingSelection(providerRef.current, info);
    if (effort && !info?.efforts.some((item) => item.id === effort)) selectEffort("");
  }

  function restoreRoutingSelection(nextProvider: ProviderId, info: ModelOption | undefined) {
    if (nextProvider !== "openrouter" || !info?.routingOptions?.length) {
      setRoutingPrimary("");
      setRoutingBackup("");
      return;
    }
    const allowed = new Set(info.routingOptions.map((option) => option.id));
    const storedPrimary = localStorage.getItem(routingStorageKey(deviceRef.current, info.id, "primary")) ?? "";
    const primary = allowed.has(storedPrimary) ? storedPrimary : "";
    const storedBackup = localStorage.getItem(routingStorageKey(deviceRef.current, info.id, "backup")) ?? "";
    const backup = primary && storedBackup !== primary && allowed.has(storedBackup) ? storedBackup : "";
    setRoutingPrimary(primary);
    setRoutingBackup(backup);
  }

  function selectRoutingPrimary(nextPrimary: string) {
    const info = activeModel(models, model);
    if (!info?.routingOptions?.some((option) => option.id === nextPrimary)) nextPrimary = "";
    setRoutingPrimary(nextPrimary);
    if (info) persistRoutingSlot(deviceRef.current, info.id, "primary", nextPrimary);
    if (!nextPrimary || nextPrimary === routingBackup) {
      setRoutingBackup("");
      if (info) persistRoutingSlot(deviceRef.current, info.id, "backup", "");
    }
  }

  function selectRoutingBackup(nextBackup: string) {
    const info = activeModel(models, model);
    if (!routingPrimary || nextBackup === routingPrimary
        || !info?.routingOptions?.some((option) => option.id === nextBackup)) nextBackup = "";
    setRoutingBackup(nextBackup);
    if (info) persistRoutingSlot(deviceRef.current, info.id, "backup", nextBackup);
  }

  async function selectProvider(nextProvider: ProviderId) {
    if (activeRunRef.current.operation || activeRunRef.current.requestId) {
      showToast("현재 작업 상태를 확인한 뒤 AI 제공자를 바꿔 주세요.");
      return;
    }
    const info = providers.find((item) => item.id === nextProvider);
    if (!info?.available) {
      showToast(info?.detail ?? "이 AI 연결은 현재 사용할 수 없습니다.");
      return;
    }
    const selectedDevice = deviceRef.current;
    setProvider(nextProvider);
    providerRef.current = nextProvider;
    const selectionScope = resetActiveRun(selectedDevice);
    localStorage.setItem(storageKey("provider", deviceRef.current), nextProvider);
    const nextAccount = info.accounts.find((item) => item.connected) ?? info.accounts[0];
    setAccountId(nextAccount?.id ?? "");
    if (nextAccount) localStorage.setItem(storageKey("account", deviceRef.current), nextAccount.id);
    const modelData = await api<ModelResponse>(`/api/models?provider=${encodeURIComponent(nextProvider)}`);
    if (deviceRef.current !== selectedDevice || providerRef.current !== nextProvider
        || !activeRunScopeMatches(activeRunRef.current, selectionScope)) return;
    setModels(modelData.models);
    const nextModel = nextProvider === "codex" ? "" : defaultModel(modelData.models)?.id ?? "";
    setModel(nextModel);
    if (nextModel) localStorage.setItem(storageKey("model", deviceRef.current), nextModel);
    else localStorage.removeItem(storageKey("model", deviceRef.current));
    setEffort("");
    restoreRoutingSelection(nextProvider, defaultModel(modelData.models));
    setThreadId("");
    threadRef.current = "";
    setMessages([]);
    messagesRef.current = [];
    beginConversationJournalScope();
    setHandoff(null);
    if (nextProvider === "codex") {
      await loadThreads(
        workspaceRef.current,
        true,
        localStorage.getItem(storageKey("thread", deviceRef.current)) ?? "",
        undefined,
        selectionScope,
      );
      await loadProjectHandoff(workspaceRef.current, undefined, selectionScope);
    } else {
      const availableConversations = providerConversationThreads(
        operationSnapshots,
        nextProvider,
        workspaceRef.current,
      );
      const storedConversation = localStorage.getItem(
        providerConversationKey(deviceRef.current, nextProvider, workspaceRef.current),
      ) ?? "";
      const selectedConversation = availableConversations.some((item) => item.id === storedConversation)
        ? storedConversation
        : "";
      setThreads(availableConversations);
      setThreadId(selectedConversation);
      threadRef.current = selectedConversation;
      if (selectedConversation) {
        const restored = providerConversationMessages(
          operationSnapshots,
          nextProvider,
          workspaceRef.current,
          selectedConversation,
        );
        messagesRef.current = restored;
        setMessages(restored);
      }
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
    const attempt = connectionAttemptRef.current;
    const selectedDevice = deviceRef.current;
    try {
      const data = await api<{ diagnostics: SystemDiagnostics }>("/api/diagnostics");
      if (attempt !== connectionAttemptRef.current || selectedDevice !== deviceRef.current) return;
      setDiagnostics(data.diagnostics);
    } catch (error) {
      if (attempt === connectionAttemptRef.current && selectedDevice === deviceRef.current) {
        showToast(errorMessage(error));
      }
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
    if (activeRunRef.current.operation || activeRunRef.current.requestId) {
      showToast("현재 작업 상태를 확인한 뒤 프로젝트를 바꿔 주세요.");
      return;
    }
    const selectedDevice = deviceRef.current;
    setWorkspace(path);
    workspaceRef.current = path;
    localStorage.setItem(storageKey("workspace", deviceRef.current), path);
    setThreadId("");
    threadRef.current = "";
    localStorage.removeItem(storageKey("thread", deviceRef.current));
    setMessages([]);
    messagesRef.current = [];
    const selectionScope = resetActiveRun(selectedDevice);
    beginConversationJournalScope();
    if (providerRef.current === "codex") {
      await loadThreads(path, false, undefined, undefined, selectionScope);
      await loadProjectHandoff(path, undefined, selectionScope);
    } else {
      const availableConversations = providerConversationThreads(operationSnapshots, providerRef.current, path);
      const storedConversation = localStorage.getItem(
        providerConversationKey(deviceRef.current, providerRef.current, path),
      ) ?? "";
      const selectedConversation = availableConversations.some((item) => item.id === storedConversation)
        ? storedConversation
        : "";
      setThreads(availableConversations);
      setThreadId(selectedConversation);
      threadRef.current = selectedConversation;
      if (selectedConversation) {
        const restored = providerConversationMessages(
          operationSnapshots,
          providerRef.current,
          path,
          selectedConversation,
        );
        messagesRef.current = restored;
        setMessages(restored);
      }
      setHandoff(null);
    }
  }

  async function selectThread(id: string) {
    if (activeRunRef.current.operation || activeRunRef.current.requestId) {
      showToast("현재 작업 상태를 확인한 뒤 대화를 바꿔 주세요.");
      return;
    }
    const selectedDevice = deviceRef.current;
    setThreadId(id);
    threadRef.current = id;
    persistConversationSelection(deviceRef.current, providerRef.current, workspaceRef.current, id);
    setMessages([]);
    messagesRef.current = [];
    const selectionScope = resetActiveRun(selectedDevice);
    beginConversationJournalScope();
    if (!id) return;
    if (providerRef.current !== "codex") {
      const restored = providerConversationMessages(
        operationSnapshots,
        providerRef.current,
        workspaceRef.current,
        id,
      );
      messagesRef.current = restored;
      setMessages(restored);
      return;
    }
    try {
      const data = await api<{ thread: ThreadDetail }>(`/api/threads/${encodeURIComponent(id)}`);
      if (deviceRef.current !== selectedDevice || threadRef.current !== id
          || !activeRunScopeMatches(activeRunRef.current, selectionScope)) return;
      const restored = historyMessages(data.thread);
      messagesRef.current = restored;
      setMessages(restored);
    } catch (error) {
      showToast(errorMessage(error));
    }
  }

  async function startDictation(continuous: boolean) {
    if (!speechSupported || dictating || handsFreeRef.current) return;
    dictationBaseRef.current = prompt.trim();
    nativeFinalRef.current = "";
    handsFreeRef.current = continuous;
    dispatchVoiceInput({ type: "begin", continuous });
    textareaRef.current?.blur();

    if (isNativeApp()) {
      try {
        await NativeSpeech.start({
          language: speechLanguageRef.current,
          continuous,
        });
      } catch (error) {
        handsFreeRef.current = false;
        dispatchVoiceInput({ type: "fatal_error" });
        showToast(`음성 인식 오류: ${errorMessage(error)}`);
      }
      return;
    }

    const recognition = recognitionRef.current;
    if (!recognition) {
      handsFreeRef.current = false;
      dispatchVoiceInput({ type: "fatal_error" });
      return;
    }
    try {
      recognition.lang = speechLanguageRef.current;
      recognition.continuous = continuous;
      recognition.start();
    } catch (error) {
      handsFreeRef.current = false;
      dispatchVoiceInput({ type: "fatal_error" });
      showToast(errorMessage(error));
    }
  }

  async function stopDictation() {
    handsFreeRef.current = false;
    dispatchVoiceInput({ type: "stop" });
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
      dispatchPocketLinkBootstrap({ type: "clear_qr" });
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
    dispatchPocketLinkBootstrap({ type: "clear_qr" });
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
    if (!isNativeApp() || pocketLinkBootstrap.phase !== "idle") return;
    dispatchPocketLinkBootstrap({ type: "start_qr" });
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
      dispatchPocketLinkBootstrap({ type: "review_qr", bootstrap });
      showToast("PocketLink QR을 읽었습니다. PC 정보와 pin을 확인한 뒤 등록하세요.");
    } catch (error) {
      showToast(errorMessage(error));
    } finally {
      dispatchPocketLinkBootstrap({ type: "finish_qr" });
    }
  }

  async function discoverPocketLinks() {
    if (!isNativeApp() || pocketLinkBootstrap.phase !== "idle") return;
    dispatchPocketLinkBootstrap({ type: "start_discovery" });
    try {
      const result = await NativeTunnel.discoverPocketLinks();
      const candidates = parsePocketLinkDiscoveryResult(result);
      setNewDeviceTransport("pocketlink");
      dispatchPocketLinkBootstrap({ type: "review_discovery", candidates });
      showToast(candidates.length > 0
        ? `${candidates.length}개의 PocketLink 주소를 찾았습니다. PC 화면의 pin은 별도로 확인해야 합니다.`
        : "광고가 켜진 PocketLink Companion을 같은 LAN에서 찾지 못했습니다.");
    } catch (error) {
      showToast(errorMessage(error));
    } finally {
      dispatchPocketLinkBootstrap({ type: "finish_discovery" });
    }
  }

  async function discoverPocketLinkPeers() {
    if (!isNativeApp() || pocketLinkBootstrap.phase !== "idle") return;
    dispatchPocketLinkBootstrap({ type: "start_p2p" });
    try {
      const result = await NativeTunnel.discoverPocketLinkPeers();
      const candidates = parsePocketLinkP2pResult(result);
      setNewDeviceTransport("pocketlink");
      dispatchPocketLinkBootstrap({ type: "review_p2p", candidates });
      showToast(candidates.length > 0
        ? `${candidates.length}개의 Wi-Fi Direct 기기를 찾았습니다. Companion pin은 별도로 확인해야 합니다.`
        : "Wi-Fi Direct에서 Linux Companion을 찾지 못했습니다.");
    } catch (error) {
      showToast(errorMessage(error));
    } finally {
      dispatchPocketLinkBootstrap({ type: "finish_p2p" });
    }
  }

  function reviewPocketLinkDiscovery(candidate: PocketLinkDiscoveryCandidate) {
    const now = Date.now();
    if (now >= candidate.expiresAt) {
      showToast("LAN 검색 결과가 만료되었습니다. 다시 검색해 주세요.");
      return;
    }
    setNewDeviceTransport("pocketlink");
    setNewDeviceName(candidate.name);
    setNewPocketLinkHost(candidate.host);
    setNewPocketLinkPort(String(candidate.port));
    setNewPocketLinkPin("");
    setNewPocketLinkBackupPin("");
    dispatchPocketLinkBootstrap({ type: "select_discovery", candidate, now });
    showToast("LAN 주소만 선택했습니다. Companion 화면의 SPKI pin을 직접 대조·입력하세요.");
  }

  function reviewPocketLinkP2p(candidate: PocketLinkP2pCandidate) {
    const now = Date.now();
    if (!isCurrentPocketLinkP2pCandidate(candidate, now)) {
      showToast("Wi-Fi Direct 검색 결과가 만료되었습니다. 다시 검색해 주세요.");
      return;
    }
    setNewDeviceTransport("pocketlink");
    if (!newDeviceName.trim()) setNewDeviceName(candidate.name);
    dispatchPocketLinkBootstrap({ type: "select_p2p", candidate, now });
    showToast("Wi-Fi Direct 기기만 선택했습니다. Companion 화면의 SPKI pin을 별도로 대조하세요.");
  }

  async function createLinuxDevice() {
    let target: DeviceTarget | null = null;
    let configuredPocketLinkPort: number | null = null;
    try {
      const localPort = Number(newDevicePort);
      if (selectedPocketLinkDiscovery && !matchesPocketLinkDiscovery(
        selectedPocketLinkDiscovery,
        newDeviceName,
        newPocketLinkHost,
        Number(newPocketLinkPort),
      )) {
        throw new Error("LAN 검색 결과가 만료되었거나 변경되었습니다. 다시 검색하거나 주소를 직접 입력해 주세요.");
      }
      if ((newPocketLinkRoute === "p2p" || selectedPocketLinkP2p)
          && !isCurrentPocketLinkP2pCandidate(selectedPocketLinkP2p)) {
        throw new Error("Wi-Fi Direct 검색 결과가 만료되었습니다. 다시 검색해 주세요.");
      }
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
          route: newPocketLinkRoute,
          p2pCandidateId: newPocketLinkRoute === "p2p" || newPocketLinkRoute === "auto"
            ? selectedPocketLinkP2p?.id
            : undefined,
          relayHost: newPocketLinkRoute === "relay" || newPocketLinkRoute === "auto" ? newPocketRelayHost : undefined,
          relayPort: newPocketLinkRoute === "relay" || newPocketLinkRoute === "auto" ? Number(newPocketRelayPort) : undefined,
          relayServerName: newPocketLinkRoute === "relay" || newPocketLinkRoute === "auto" ? newPocketRelayServerName : undefined,
          relayServerPublicKeyPin: newPocketLinkRoute === "relay" || newPocketLinkRoute === "auto" ? newPocketRelayPin : undefined,
          relaySlot: newPocketLinkRoute === "relay" || newPocketLinkRoute === "auto" ? newPocketRelaySlot : undefined,
          relaySecret: newPocketLinkRoute === "relay" || newPocketLinkRoute === "auto" ? newPocketRelaySecret : undefined,
        });
        configuredPocketLinkPort = localPort;
      }
      dispatchPocketLinkBootstrap({
        type: "register",
        targetId: target.id,
        pocketLink: newDeviceTransport === "pocketlink",
        host: newPocketLinkHost,
        port: Number(newPocketLinkPort),
        serverPublicKeyPin: newPocketLinkPin,
      });
      setDeviceTargets(listDeviceTargets());
      setNewDeviceName("");
      setNewDevicePort(String(Number(newDevicePort) + 1));
      setNewPocketLinkHost("");
      setNewPocketLinkPin("");
      setNewPocketLinkBackupPin("");
      setNewPocketLinkRoute("direct");
      setNewPocketRelayHost("");
      setNewPocketRelayPort("9443");
      setNewPocketRelayServerName("");
      setNewPocketRelayPin("");
      setNewPocketRelaySlot("");
      setNewPocketRelaySecret("");
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

  async function retrySafeWorkspaceRecovery(): Promise<boolean> {
    if (retryingWorkspaceRecovery) return false;
    const requestedDevice = deviceRef.current;
    setRetryingWorkspaceRecovery(true);
    try {
      const data = await api<{ status: WorkspaceChangeRecoveryStatus }>(
        "/api/workspace-changes/recovery/retry",
        { method: "POST", body: { confirm: "retry-safe-workspace-recovery" } },
      );
      if (deviceRef.current !== requestedDevice) return false;
      setWorkspaceRecovery(data.status);
      if (data.status.blocked) {
        showToast("아직 안전하게 복구할 수 없습니다. PC에서 표시된 파일을 확인해 주세요.");
        return false;
      }
      showToast("Workspace 변경 복구를 마쳤습니다. 변경 도구를 다시 사용할 수 있습니다.");
      return true;
    } catch (error) {
      if (deviceRef.current === requestedDevice) showToast(errorMessage(error));
      return false;
    } finally {
      if (deviceRef.current === requestedDevice) setRetryingWorkspaceRecovery(false);
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

  async function updateCompanionJournalPolicy(policy: JournalPolicy) {
    if (updatingJournalPolicy) return false;
    const requestedDevice = deviceRef.current;
    setUpdatingJournalPolicy(true);
    try {
      const data = await api<{ policy: JournalPolicy; limits: JournalPolicyLimits }>("/api/journal/policy", {
        method: "PUT",
        body: {
          retentionMs: policy.retentionMs,
          maxOperations: policy.maxOperations,
          maxEvents: policy.maxEvents,
          confirm: "apply-retention-policy",
        },
      });
      if (deviceRef.current !== requestedDevice) return false;
      setJournalPolicy(data.policy);
      setJournalPolicyLimits(data.limits);
      await refreshOperationalSnapshot(true);
      showToast("Companion 보존 정책을 저장하고 오래된 기록을 정리했습니다.");
      return true;
    } catch (error) {
      if (deviceRef.current === requestedDevice) showToast(errorMessage(error));
      return false;
    } finally {
      if (deviceRef.current === requestedDevice) setUpdatingJournalPolicy(false);
    }
  }

  async function updateCompanionRunPolicy(policy: RunPolicyConfig) {
    if (updatingRunPolicy) return false;
    const requestedDevice = deviceRef.current;
    setUpdatingRunPolicy(true);
    try {
      const data = await api<{ policy: RunPolicyConfig; limits: RunPolicyConfigLimits }>("/api/run-policy", {
        method: "PUT",
        body: { ...policy, confirm: "apply-run-policy" },
      });
      if (deviceRef.current !== requestedDevice) return false;
      setRunPolicy(data.policy);
      setRunPolicyLimits(data.limits);
      setLastRunPolicyPreflight(null);
      showToast(data.policy.emergencyStop
        ? "API 실행 긴급 중단을 켰습니다. Codex 실행은 계속 사용할 수 있습니다."
        : "API 비용·token 정책을 저장했습니다.");
      return true;
    } catch (error) {
      if (deviceRef.current === requestedDevice) showToast(errorMessage(error));
      return false;
    } finally {
      if (deviceRef.current === requestedDevice) setUpdatingRunPolicy(false);
    }
  }

  async function updateOperationMetadata(current: Operation, patch: OperationMetadataPatch) {
    if (updatingOperationId) return false;
    setUpdatingOperationId(current.id);
    try {
      const data = await api<{ operation: Operation }>(
        `/api/runs/${encodeURIComponent(current.id)}/metadata`,
        { method: "PATCH", body: patch },
      );
      handleOperationEvent("metadata_updated", data.operation);
      showToast(patch.archived === true
        ? "작업을 보관했습니다."
        : patch.archived === false
          ? "보관한 작업을 복원했습니다."
          : patch.pinned === true
            ? "작업을 위에 고정했습니다."
            : patch.pinned === false
              ? "작업 고정을 해제했습니다."
              : "작업 이름을 저장했습니다.");
      return true;
    } catch (error) {
      await refreshOperationalSnapshot(true);
      showToast(errorMessage(error));
      return false;
    } finally {
      setUpdatingOperationId(null);
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
      const current = activeRunRef.current.operation;
      if (current?.cwd === targetWorkspace && current.status !== "running"
        && (current.status !== "unknown" || current.acknowledgedAt)) {
        dispatchActiveRun({
          type: "finish",
          ...activeRunScope(activeRunRef.current),
          operationId: current.id,
        });
        clearOperationPoll();
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
    const conversationId = nextOperation.threadId ?? nextOperation.conversationId ?? "";
    const providerThreads = nextProvider === "codex"
      ? []
      : providerConversationThreads(
          upsertOperation(operationSnapshots, nextOperation),
          nextProvider,
          nextOperation.cwd,
        );
    const nextThread = nextProvider === "codex" || providerThreads.some((item) => item.id === conversationId)
      ? conversationId
      : "";
    const assistantId = newId("operation-assistant");

    setProvider(nextProvider);
    providerRef.current = nextProvider;
    localStorage.setItem(storageKey("provider", deviceRef.current), nextProvider);
    setAccountId(nextOperation.accountId ?? "");
    if (nextOperation.accountId) {
      localStorage.setItem(storageKey("account", deviceRef.current), nextOperation.accountId);
    }
    setModel(nextOperation.model ?? "");
    setEffort(nextOperation.effort ?? "");
    setRoutingPrimary(nextOperation.routing?.upstreams[0] ?? "");
    setRoutingBackup(nextOperation.routing?.upstreams[1] ?? "");
    setNetworkAccess(nextOperation.networkAccess === true);
    setWorkspace(nextOperation.cwd);
    workspaceRef.current = nextOperation.cwd;
    localStorage.setItem(storageKey("workspace", deviceRef.current), nextOperation.cwd);
    setThreadId(nextThread);
    threadRef.current = nextThread;
    const runScope = beginActiveRun(deviceRef.current, nextOperation.status === "running"
      || (nextOperation.status === "unknown" && !nextOperation.acknowledgedAt)
      ? { liveMessageId: assistantId }
      : {});
    persistConversationSelection(deviceRef.current, nextProvider, nextOperation.cwd, nextThread);
    setThreads(nextProvider === "codex"
      ? (current) => current.filter((item) => item.cwd === nextOperation.cwd)
      : providerThreads);
    setHandoff(null);
    beginConversationJournalScope();

    const terminalText = nextOperation.status === "failed"
      ? `작업 실패: ${nextOperation.error || "알 수 없는 오류"}`
      : nextOperation.status === "unknown"
        ? nextOperation.error || "Companion 재시작 전 작업의 최종 상태를 확인할 수 없습니다."
        : nextOperation.result?.finalResponse || statusMessage(nextOperation.status);
    const restored: ChatMessage[] = nextProvider !== "codex" && conversationId
      ? [
          ...providerConversationMessages(
            upsertOperation(operationSnapshots, nextOperation),
            nextProvider,
            nextOperation.cwd,
            conversationId,
          ),
          ...(nextOperation.status === "running" ? [{
            id: assistantId,
            role: "assistant" as const,
            text: "",
            pending: true,
          }] : []),
        ]
      : [
          { id: newId("operation-user"), role: "user", text: nextOperation.prompt },
          ...(nextOperation.steers ?? []).map((steer, index) => ({
            id: `steer-${nextOperation.id}-${steer.acceptedAt}-${index}`,
            role: "user" as const,
            text: `↪ 지금 방향 수정\n${steer.prompt}${steer.attachmentCount > 0 ? `\n\n📎 첨부 ${steer.attachmentCount}개` : ""}`,
          })),
          {
            id: assistantId,
            role: "assistant",
            text: nextOperation.status === "running" ? "" : terminalText,
            pending: nextOperation.status === "running",
            error: nextOperation.status === "failed" || nextOperation.status === "unknown",
            details: nextOperation.status === "running"
              ? undefined
              : buildResultDetails(nextOperation.result ?? {}, "") || undefined,
          },
        ];
    messagesRef.current = restored;
    setMessages(restored);
    markConversationJournalLive();

    if (nextOperation.status === "running") {
      handleOperationEvent("started", nextOperation, runScope);
    } else if (nextOperation.status === "unknown" && !nextOperation.acknowledgedAt) {
      handleOperationEvent("recovered", nextOperation, runScope);
    }
    setShowOperationsDashboard(false);
    if (nextProvider === "codex") void loadProjectHandoff(nextOperation.cwd, undefined, runScope);
    void api<ModelResponse>(`/api/models?provider=${encodeURIComponent(nextProvider)}`)
      .then((data) => {
        if (providerRef.current === nextProvider && activeRunScopeMatches(activeRunRef.current, runScope)) {
          setModels(data.models);
        }
      })
      .catch(() => undefined);
  }

  openOperationFromDashboardRef.current = openOperationFromDashboard;

  const pendingApprovalCount = activeApprovals(approvalInbox).length;
  const steeringAvailable = connection === "online" && operation?.status === "running"
    && (operation.providerId ?? "codex") === "codex"
    && activeProvider(providers, "codex")?.capabilities.steering === true;
  const steerSelected = steeringAvailable && composerRunMode === "steer";
  const selectedModelOption = activeModel(models, model);
  const selectedPrimaryRoute = selectedModelOption?.routingOptions?.find((item) => item.id === routingPrimary);
  const selectedBackupRoute = selectedModelOption?.routingOptions?.find((item) => item.id === routingBackup);
  const selectedModelVerification = provider === "openrouter"
    ? combinedRouteVerification([selectedPrimaryRoute, selectedBackupRoute].filter(
        (item): item is ProviderRoutingOption => item !== undefined,
      ))
    : selectedModelOption?.verification;
  const selectedRunPolicyPreflight = lastRunPolicyPreflight
    && lastRunPolicyPreflight.providerId === provider
    && lastRunPolicyPreflight.model === (model || undefined)
    && JSON.stringify(lastRunPolicyPreflight.routing) === JSON.stringify(selectedRouting(provider, routingPrimary, routingBackup))
    ? lastRunPolicyPreflight
    : null;
  const selectedPolicyPricingKnown = provider === "openrouter" && (selectedPrimaryRoute || selectedBackupRoute)
    ? [selectedPrimaryRoute, selectedBackupRoute].filter(Boolean).every((route) => (
        route?.pricing?.inputPerMillionUsd !== undefined && route.pricing.outputPerMillionUsd !== undefined
      ))
    : selectedModelOption?.pricing?.inputPerMillionUsd !== undefined
      && selectedModelOption.pricing.outputPerMillionUsd !== undefined;
  const updateInstallBlockedReason = prompt.trim() || attachments.length > 0
    ? "전송하지 않은 입력·첨부를 먼저 보내거나 지워 주세요."
    : mediaBusy
      ? "첨부 처리가 끝난 뒤 설치할 수 있습니다."
      : rotatingIdentityTarget !== null
        ? "단말 key 교체를 마친 뒤 설치할 수 있습니다."
        : "";

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
            {(workspaceRecovery?.blocked || pendingApprovalCount > 0) && (
              <b aria-label={workspaceRecovery?.blocked
                ? `Workspace 변경 복구 필요${pendingApprovalCount > 0 ? ` · 승인 필요 ${pendingApprovalCount}건` : ""}`
                : `승인 필요 ${pendingApprovalCount}건`}
              >{workspaceRecovery?.blocked ? "!" : Math.min(99, pendingApprovalCount)}</b>
            )}
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
          workspaceRecovery={workspaceRecovery}
          retryingWorkspaceRecovery={retryingWorkspaceRecovery}
          decidingApprovalId={decidingApprovalId}
          updatingOperationId={updatingOperationId}
          journalPolicy={journalPolicy}
          journalPolicyLimits={journalPolicyLimits}
          updatingJournalPolicy={updatingJournalPolicy}
          runPolicy={runPolicy}
          runPolicyLimits={runPolicyLimits}
          updatingRunPolicy={updatingRunPolicy}
          exportingWorkspace={exportingWorkspace}
          deletingWorkspace={deletingWorkspace}
          onClose={() => setShowOperationsDashboard(false)}
          onRefresh={() => void refreshOperationalSnapshot(false)}
          onRetryWorkspaceRecovery={retrySafeWorkspaceRecovery}
          onOpenOperation={openOperationFromDashboard}
          onUpdateOperation={updateOperationMetadata}
          onUpdateJournalPolicy={updateCompanionJournalPolicy}
          onUpdateRunPolicy={updateCompanionRunPolicy}
          onDecision={(approval, decision) => void decideApproval(approval, decision)}
          onExportWorkspace={exportCompanionJournal}
          onDeleteWorkspaceHistory={deleteCompanionJournal}
        />
      )}

      {pendingRunPolicyReview && (
        <section className="run-policy-review" role="dialog" aria-modal="true" aria-labelledby="run-policy-review-title">
          <div className="run-policy-review-card">
            <header>
              <div>
                <strong id="run-policy-review-title">
                  {pendingRunPolicyReview.error ? "API 실행이 정책으로 멈췄습니다" : "월간 API 비용 확인"}
                </strong>
                <small>아직 Provider 요청을 보내지 않았습니다.</small>
              </div>
            </header>
            {pendingRunPolicyReview.error ? (
              <p className="run-policy-review-error" role="alert">{pendingRunPolicyReview.error}</p>
            ) : pendingRunPolicyReview.preflight && (
              <>
                <div className="run-policy-review-facts">
                  <span><strong>Provider</strong>{pendingRunPolicyReview.preflight.snapshot.providerId}</span>
                  <span><strong>모델</strong>{pendingRunPolicyReview.preflight.snapshot.model}</span>
                  <span><strong>Privacy</strong>{runPrivacyLabel(pendingRunPolicyReview.preflight.snapshot.privacyProfile)}</span>
                  <span><strong>Token 상한</strong>{pendingRunPolicyReview.preflight.snapshot.limits?.maxTotalTokens.toLocaleString()} total · {pendingRunPolicyReview.preflight.snapshot.limits?.maxOutputTokens.toLocaleString()} output</span>
                  <span><strong>Run 비용 hard cap</strong>{formatPolicyUsd(pendingRunPolicyReview.preflight.snapshot.limits?.maxRunCostMicrosUsd)}</span>
                  <span><strong>이번 달 집계</strong>{formatPolicyUsd(pendingRunPolicyReview.preflight.snapshot.usageWindow.monthCostMicrosUsd)}</span>
                  <span><strong>가격</strong>{pendingRunPolicyReview.preflight.snapshot.pricing.status === "known"
                    ? `최악 상한 ${formatPolicyUsd(pendingRunPolicyReview.preflight.snapshot.pricing.maximumRunCostMicrosUsd)}`
                    : "가격 확인 필요 · 추측 안 함"}</span>
                </div>
                {pendingRunPolicyReview.preflight.snapshot.warnings.length > 0 && (
                  <ul>{pendingRunPolicyReview.preflight.snapshot.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
                )}
                <p>승인은 이 모델·route·정책·현재 집계에만 묶인 1회용 토큰이며 10분 안에 한 번만 사용할 수 있습니다.</p>
              </>
            )}
            <div className="run-policy-review-actions">
              <button type="button" onClick={restoreRunPolicyReview}>취소·입력으로 복원</button>
              {pendingRunPolicyReview.error ? (
                <button type="button" className="retry" onClick={retryRunPolicyReview}>정책 다시 확인</button>
              ) : (
                <button type="button" className="approve" onClick={approveRunPolicyReview}>검토하고 이 1회 실행</button>
              )}
            </div>
          </div>
        </section>
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
            disabled={operation !== null || activeRun.requestId !== null || controlsCollapsed}
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
            disabled={operation !== null || activeRun.requestId !== null || controlsCollapsed}
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
            <select value={workspace} disabled={operation !== null || activeRun.requestId !== null || controlsCollapsed} aria-label="프로젝트 선택" onChange={(event) => void selectWorkspace(event.target.value)}>
              {workspaces.length === 0 && <option value="">{tr("noProject")}</option>}
              {workspaces.map((item) => <option key={item.path} value={item.path}>{item.name}</option>)}
            </select>
            <button
              className="icon-button"
              type="button"
              disabled={operation !== null || activeRun.requestId !== null || controlsCollapsed}
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
            <select value={threadId} disabled={operation !== null || activeRun.requestId !== null || controlsCollapsed} aria-label="AI 대화 선택" onChange={(event) => void selectThread(event.target.value)}>
              <option value="">{tr("newConversation")}</option>
              {threads.map((thread) => (
                <option key={thread.id} value={thread.id}>{short(thread.name || thread.preview || tr("unnamed"), 42)}</option>
              ))}
            </select>
            <button
              className="icon-button"
              type="button"
              disabled={operation !== null || activeRun.requestId !== null || controlsCollapsed}
              aria-label="대화 새로고침"
              onClick={() => {
                if (providerRef.current === "codex") {
                  void loadThreads(
                    workspaceRef.current,
                    true,
                    undefined,
                    undefined,
                    activeRunScope(activeRunRef.current),
                  );
                }
                else setThreads(providerConversationThreads(
                  operationSnapshots,
                  providerRef.current,
                  workspaceRef.current,
                ));
              }}
            >↻</button>
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
              {isNativeApp() && (
                <label className="notification-preference">
                  <span>백그라운드 작업 알림</span>
                  <small>켜면 Android 연결 상태 알림이 유지되며 완료·승인·오류만 표시합니다.</small>
                  <button
                    type="button"
                    aria-pressed={notificationsEnabled}
                    onClick={() => void toggleNativeNotifications()}
                  >{notificationsEnabled ? "켜짐 · 끄기" : "꺼짐 · 권한 확인 후 켜기"}</button>
                </label>
              )}
            </section>

            {isNativeApp() && (
              <section className="update-manager" aria-label="Android 앱 업데이트">
                <div className="update-manager-head">
                  <div>
                    <strong>Android 앱 업데이트</strong>
                    <small>공식 GitHub 정식판을 직접 조회하거나, 받은 signed ZIP 묶음을 선택합니다.</small>
                  </div>
                  <div className="update-manager-actions">
                    <button type="button" disabled={updateBusy} onClick={() => void discoverOfficialUpdate()}>
                      {updateBusy ? "처리 중…" : "공식판 조회"}
                    </button>
                    <button type="button" disabled={updateBusy} onClick={() => void selectSignedUpdateBundle()}>
                      {updateReview ? "다른 ZIP" : "ZIP 선택"}
                    </button>
                  </div>
                </div>
                {!updateReview && !updateDiscovery && !updateError && (
                  <p>자동·백그라운드 조회는 하지 않습니다. 다운로드 뒤에도 현재 signer, manifest 서명, APK·SBOM 해시와 상위 versionCode를 다시 확인합니다.</p>
                )}
                {updateDiscovery && (
                  <div className="update-discovery">
                    <strong>
                      {updateDiscovery.available
                        ? `공식 정식판 v${updateDiscovery.latestVersion} 발견`
                        : "설치할 새 공식 정식판 없음"}
                    </strong>
                    <dl>
                      <div><dt>Version</dt><dd>v{updateDiscovery.currentVersion} → v{updateDiscovery.latestVersion}</dd></div>
                      <div><dt>게시</dt><dd>{updateDiscovery.publishedAt}</dd></div>
                      {updateDiscovery.available && updateDiscovery.assetName && updateDiscovery.assetBytes && (
                        <div><dt>ZIP</dt><dd>{updateDiscovery.assetName} · {formatBytes(updateDiscovery.assetBytes)}</dd></div>
                      )}
                      {updateDiscovery.available && updateDiscovery.assetSha256 && (
                        <div><dt>전송 digest</dt><dd>{updateDiscovery.assetSha256.slice(0, 16)}…</dd></div>
                      )}
                    </dl>
                    {updateDiscovery.available ? (
                      <>
                        <p>다음 터치에서 app-private cache로만 내려받습니다. Release digest를 확인한 뒤 signed manifest 검증기로 넘기며, 아직 설치하지 않습니다.</p>
                        <div className="update-review-actions">
                          <button type="button" disabled={updateBusy} onClick={() => void discardSignedUpdateBundle()}>취소</button>
                          <button type="button" className="install" disabled={updateBusy} onClick={() => void downloadOfficialUpdate()}>
                            다운로드·서명 검증
                          </button>
                        </div>
                      </>
                    ) : (
                      <p>Latest는 정식 Release만 대상으로 하며 draft와 prerelease는 조회 대상이 아닙니다.</p>
                    )}
                  </div>
                )}
                {updateReview && (
                  <div className="update-review">
                    <strong>v{updateReview.currentVersion} → v{updateReview.version}</strong>
                    <dl>
                      <div><dt>versionCode</dt><dd>{updateReview.currentVersionCode} → {updateReview.versionCode}</dd></div>
                      <div><dt>APK</dt><dd>{formatBytes(updateReview.apkBytes)} · {updateReview.apkSha256.slice(0, 12)}…</dd></div>
                      <div><dt>Signer</dt><dd>{updateReview.certificateSha256.slice(0, 12)}… · 현재 앱과 일치</dd></div>
                      <div><dt>Build</dt><dd>{updateReview.channel} · {updateReview.commit.slice(0, 12)}</dd></div>
                    </dl>
                    <p>
                      검증 결과는 10분간 이 앱의 비공개 cache에만 유지됩니다. 설치하면 앱이 닫힐 수 있지만
                      Linux Companion의 실행 중 작업은 중단하지 않습니다. Android 시스템 확인 없이 자동 설치하지 않습니다.
                    </p>
                    {updateInstallBlockedReason && <small className="update-blocked">{updateInstallBlockedReason}</small>}
                    <div className="update-review-actions">
                      <button type="button" disabled={updateBusy} onClick={() => void discardSignedUpdateBundle()}>취소·파일 폐기</button>
                      <button
                        type="button"
                        className="install"
                        disabled={updateBusy || Boolean(updateInstallBlockedReason)}
                        onClick={() => void installSignedUpdate()}
                      >{updateInstallPermissionRequired ? "권한 확인 후 설치 다시 열기" : "검증된 APK 설치 확인"}</button>
                    </div>
                  </div>
                )}
                {updateError && <p className="update-error" role="alert">{updateError}</p>}
              </section>
            )}

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
                  {isNativeApp() && newDeviceTransport === "pocketlink" && (
                    <select
                      value={newPocketLinkRoute}
                      aria-label="PocketLink 연결 경로"
                      onChange={(event) => {
                        const route = event.target.value as PocketLinkRoute;
                        setNewPocketLinkRoute(route);
                        if (route === "relay") {
                          dispatchPocketLinkBootstrap({ type: "invalidate_discovery" });
                          dispatchPocketLinkBootstrap({ type: "invalidate_p2p" });
                        } else if (route === "p2p") {
                          dispatchPocketLinkBootstrap({ type: "invalidate_discovery" });
                        } else if (route === "direct") {
                          dispatchPocketLinkBootstrap({ type: "invalidate_p2p" });
                        }
                      }}
                    >
                      <option value="direct">직접 LAN · Companion으로 바로 연결</option>
                      <option value="p2p">Wi-Fi Direct · Linux PC에 직접 연결</option>
                      <option value="auto">자동 · LAN, P2P, 릴레이 순서</option>
                      <option value="relay">아웃바운드 릴레이 · 이중 TLS</option>
                    </select>
                  )}
                  {isNativeApp() && newDeviceTransport === "pocketlink" && (
                    <div className="pocket-link-bootstrap-actions">
                      <button type="button" className="pocket-link-qr-scan" disabled={scanningPocketLinkQr || discoveringPocketLinks || discoveringPocketLinkPeers} onClick={() => void scanPocketLinkQr()}>
                        {scanningPocketLinkQr ? "QR 카메라 여는 중…" : "PocketLink QR 스캔"}
                      </button>
                      {(newPocketLinkRoute === "direct" || newPocketLinkRoute === "auto") && (
                        <button type="button" className="pocket-link-lan-discovery" disabled={scanningPocketLinkQr || discoveringPocketLinks || discoveringPocketLinkPeers} onClick={() => void discoverPocketLinks()}>
                          {discoveringPocketLinks ? "LAN 검색 중 · 8초…" : "같은 LAN에서 찾기"}
                        </button>
                      )}
                      {(newPocketLinkRoute === "p2p" || newPocketLinkRoute === "auto") && (
                        <button type="button" className="pocket-link-p2p-discovery" disabled={scanningPocketLinkQr || discoveringPocketLinks || discoveringPocketLinkPeers} onClick={() => void discoverPocketLinkPeers()}>
                          {discoveringPocketLinkPeers ? "P2P 검색 중 · 12초…" : "Wi-Fi Direct에서 찾기"}
                        </button>
                      )}
                    </div>
                  )}
                  <div className="device-create-row">
                    <input value={newDeviceName} maxLength={60} placeholder="예: 작업실 PC" aria-label="Linux PC 이름" onChange={(event) => { setNewDeviceName(event.target.value); dispatchPocketLinkBootstrap({ type: "invalidate_discovery" }); }} />
                    <input value={newDevicePort} inputMode="numeric" maxLength={5} placeholder="8790" aria-label="로컬 터널 포트" onChange={(event) => setNewDevicePort(event.target.value.replace(/\D/g, ""))} />
                    {newDeviceTransport === "termux" && <button type="button" onClick={() => void createLinuxDevice()}>등록</button>}
                  </div>
                  {newDeviceTransport === "pocketlink" && (
                    <div className="pocket-link-fields">
                      {(newPocketLinkRoute === "direct" || newPocketLinkRoute === "auto") && pocketLinkDiscoveryCandidates.length > 0 && !selectedPocketLinkDiscovery && (
                        <div className="pocket-link-discovery-list" aria-label="발견한 PocketLink Companion">
                          <strong>발견한 주소 · 아직 신뢰되지 않음</strong>
                          <small>PC를 고른 뒤에도 Companion 터미널의 SPKI pin을 직접 입력해야 합니다.</small>
                          {pocketLinkDiscoveryCandidates.map((candidate) => (
                            <button
                              type="button"
                              key={`${candidate.name}-${candidate.host}-${candidate.port}`}
                              onClick={() => reviewPocketLinkDiscovery(candidate)}
                            >
                              <span>{candidate.name}</span>
                              <small>{candidate.host}:{candidate.port}</small>
                            </button>
                          ))}
                        </div>
                      )}
                      {(newPocketLinkRoute === "direct" || newPocketLinkRoute === "auto") && selectedPocketLinkDiscovery && (
                        <div className="pocket-link-discovery-review">
                          <strong>LAN 주소만 선택됨 · pin은 미확인</strong>
                          <small>{selectedPocketLinkDiscovery.host}:{selectedPocketLinkDiscovery.port} · Companion 화면과 SPKI pin을 별도 대조하세요.</small>
                        </div>
                      )}
                      {(newPocketLinkRoute === "p2p" || newPocketLinkRoute === "auto") && pocketLinkP2pCandidates.length > 0 && !selectedPocketLinkP2p && (
                        <div className="pocket-link-discovery-list" aria-label="발견한 Wi-Fi Direct 기기">
                          <strong>발견한 P2P 기기 · 아직 신뢰되지 않음</strong>
                          <small>기기 검색은 인증 수단이 아닙니다. Linux Companion의 이름을 고른 뒤 SPKI pin을 별도로 확인하세요.</small>
                          {pocketLinkP2pCandidates.map((candidate) => (
                            <button type="button" key={candidate.id} onClick={() => reviewPocketLinkP2p(candidate)}>
                              <span>{candidate.name}</span>
                              <small>Wi-Fi Direct 후보 · 주소 비공개</small>
                            </button>
                          ))}
                        </div>
                      )}
                      {(newPocketLinkRoute === "p2p" || newPocketLinkRoute === "auto") && selectedPocketLinkP2p && (
                        <div className="pocket-link-discovery-review">
                          <strong>Wi-Fi Direct 기기만 선택됨 · pin은 미확인</strong>
                          <small>{selectedPocketLinkP2p.name} · Android는 client, Linux는 group owner여야 합니다.</small>
                        </div>
                      )}
                      {pendingPocketLinkBootstrap && (
                        <div className="pocket-link-qr-review">
                          <strong>QR에서 읽음 · 반드시 PC 화면과 대조</strong>
                          <small>장치 {pendingPocketLinkBootstrap.deviceId.slice(0, 8)} · {new Date(pendingPocketLinkBootstrap.expiresAt).toLocaleTimeString()} 만료</small>
                        </div>
                      )}
                      <input value={newPocketLinkHost} maxLength={253} autoCapitalize="none" spellCheck={false} placeholder="Companion TLS 이름 또는 주소" aria-label="PocketLink Companion TLS 이름 또는 주소" onChange={(event) => { setNewPocketLinkHost(event.target.value); dispatchPocketLinkBootstrap({ type: "invalidate_discovery" }); }} />
                      <input value={newPocketLinkPort} inputMode="numeric" maxLength={5} placeholder="8789" aria-label="PocketLink TLS 포트" onChange={(event) => { setNewPocketLinkPort(event.target.value.replace(/\D/g, "")); dispatchPocketLinkBootstrap({ type: "invalidate_discovery" }); }} />
                      <input className="pin" value={newPocketLinkPin} maxLength={51} autoCapitalize="none" spellCheck={false} placeholder="sha256/… 기본 SPKI pin" aria-label="PocketLink 기본 SPKI pin" onChange={(event) => setNewPocketLinkPin(event.target.value.trim())} />
                      <input className="pin" value={newPocketLinkBackupPin} maxLength={51} autoCapitalize="none" spellCheck={false} placeholder="sha256/… 교체용 pin · 선택" aria-label="PocketLink 교체용 SPKI pin" onChange={(event) => setNewPocketLinkBackupPin(event.target.value.trim())} />
                      {(newPocketLinkRoute === "relay" || newPocketLinkRoute === "auto") && (
                        <div className="pocket-link-relay-fields">
                          <strong>바깥 릴레이 TLS · Companion mTLS와 별도 확인</strong>
                          <small>{newPocketLinkRoute === "auto"
                            ? "LAN TCP 후 P2P 연결이 도달 불가일 때만 릴레이를 사용합니다. TLS·pin·mTLS 실패는 우회하지 않으며 SSH로 전환하지 않습니다."
                            : "릴레이 운영자는 접속 metadata를 볼 수 있습니다. 공인 CA hostname과 SPKI pin을 모두 검증하며 직접 LAN이나 SSH로 자동 전환하지 않습니다."}</small>
                          <input value={newPocketRelayHost} maxLength={253} autoCapitalize="none" spellCheck={false} placeholder="릴레이 접속 호스트" aria-label="PocketLink 릴레이 접속 호스트" onChange={(event) => setNewPocketRelayHost(event.target.value.trim())} />
                          <input value={newPocketRelayPort} inputMode="numeric" maxLength={5} placeholder="9443" aria-label="PocketLink 릴레이 포트" onChange={(event) => setNewPocketRelayPort(event.target.value.replace(/\D/g, ""))} />
                          <input className="wide" value={newPocketRelayServerName} maxLength={253} autoCapitalize="none" spellCheck={false} placeholder="인증서 hostname · 예: relay.example.com" aria-label="PocketLink 릴레이 인증서 hostname" onChange={(event) => setNewPocketRelayServerName(event.target.value.trim())} />
                          <input className="wide pin" value={newPocketRelayPin} maxLength={51} autoCapitalize="none" spellCheck={false} placeholder="sha256/… 릴레이 SPKI pin" aria-label="PocketLink 릴레이 SPKI pin" onChange={(event) => setNewPocketRelayPin(event.target.value.trim())} />
                          <input className="wide secret" value={newPocketRelaySlot} maxLength={86} autoCapitalize="none" spellCheck={false} placeholder="opaque relay slot" aria-label="PocketLink 릴레이 slot" onChange={(event) => setNewPocketRelaySlot(event.target.value.trim())} />
                          <input className="wide secret" type="password" value={newPocketRelaySecret} maxLength={128} autoCapitalize="none" spellCheck={false} autoComplete="off" placeholder="256-bit relay secret" aria-label="PocketLink 릴레이 secret" onChange={(event) => setNewPocketRelaySecret(event.target.value.trim())} />
                        </div>
                      )}
                      <button type="button" onClick={() => void createLinuxDevice()}>
                        {newPocketLinkRoute === "relay"
                          ? "두 TLS pin 확인 후 릴레이 등록"
                          : newPocketLinkRoute === "auto"
                            ? "LAN·P2P·릴레이 확인 후 자동 연결 등록"
                            : newPocketLinkRoute === "p2p"
                              ? "P2P 기기·pin 확인 후 등록"
                              : "pin 확인 후 직접 연결 등록"}
                      </button>
                    </div>
                  )}
                  <small>{newDeviceTransport === "pocketlink"
                    ? newPocketLinkRoute === "direct"
                      ? "QR을 스캔하거나 같은 LAN에서 주소만 찾을 수 있습니다. LAN 광고는 인증 수단이 아니므로 PC 화면의 SPKI pin을 별도로 대조합니다. 설정은 Keystore로 보호되고 SSH로 자동 우회하지 않습니다."
                      : newPocketLinkRoute === "p2p"
                        ? "Wi-Fi Direct 검색은 사용자 동작으로만 시작합니다. Linux가 group owner인 연결만 허용하며, 실제 신뢰는 동일한 Companion mTLS와 고정 SPKI pin으로 검증합니다."
                      : newPocketLinkRoute === "auto"
                        ? "Companion mTLS는 LAN·P2P·릴레이에서 동일하게 검증합니다. 전송 연결 자체가 실패할 때만 다음 경로로 이동하며 LAN은 30초, P2P는 60초 cooldown을 사용하고 인증 오류는 fallback 조건이 아닙니다."
                        : "Companion 정보는 내부 mTLS에, 릴레이 정보·slot·secret은 외부 TLS에 사용합니다. 둘은 Android Keystore 암호화 설정에만 저장되고 화면 상태·로그로 다시 내보내지 않습니다."
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
          {steeringAvailable && (
            <div className="run-input-mode" role="group" aria-label="실행 중 요청 방식">
              <button
                type="button"
                aria-pressed={!steerSelected}
                disabled={steering}
                onClick={() => setComposerRunMode("queue")}
              >
                <strong>다음에 실행</strong>
                <span>현재 작업 뒤 대기열</span>
              </button>
              <button
                type="button"
                className="steer"
                aria-pressed={steerSelected}
                disabled={steering}
                onClick={() => setComposerRunMode("steer")}
              >
                <strong>지금 방향 수정</strong>
                <span>현재 Codex turn에 전달</span>
              </button>
              <small>{steerSelected
                ? "이 입력은 새 작업이 아니라 현재 응답의 방향을 바꿉니다. Provider·모델·프로젝트는 그대로입니다."
                : "기본값입니다. 현재 작업이 끝난 뒤 별도 요청으로 실행합니다."}</small>
            </div>
          )}
          {models.length > 0 && (
            <div className="model-bar" aria-label="AI 모델 설정">
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
                  aria-label="AI 모델"
                  onChange={(event) => selectModel(event.target.value)}
                >
                  {provider === "codex" && <option value="">{tr("automatic")} · {defaultModel(models)?.displayName ?? "Codex"}</option>}
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
          {(provider === "openrouter" || provider === "openai") && selectedModelOption && (
            <div className="model-insight" aria-label={`${provider === "openrouter" ? "OpenRouter" : "OpenAI"} 모델 검증 정보`}>
              <span>{provider === "openrouter"
                ? selectedModelOption.capabilities?.tools ? "함수 도구 metadata" : "chat-only metadata"
                : selectedModelOption.capabilities?.tools ? "검증된 프로젝트 도구" : "chat-only"}</span>
              <span>{selectedModelOption.capabilities?.imageInput ? "이미지 입력" : "텍스트 입력"}</span>
              {provider === "openrouter" && catalogPricingLabel(selectedModelOption.pricing) && (
                <span>모델 최저 {catalogPricingLabel(selectedModelOption.pricing)}</span>
              )}
              {selectedModelOption.expiresAt && <span>만료 예정 {selectedModelOption.expiresAt.slice(0, 10)}</span>}
              <span className={modelVerificationClass(selectedModelVerification)}>{modelVerificationLabel(selectedModelVerification, provider)}</span>
              <small>{selectedModelOption.description} · catalog metadata와 보호된 eval 등급은 별도로 적용됩니다.</small>
            </div>
          )}
          {(provider === "openrouter" || provider === "openai") && runPolicy && (
            <div className={`run-policy-status${runPolicy.emergencyStop ? " stopped" : ""}`} aria-label="API 실행 정책 상태">
              <strong>{runPolicy.emergencyStop ? "API 실행 긴급 중단" : "Companion 사전검사 사용"}</strong>
              <span>{provider === "openai" ? "store:false" : "strict ZDR"}</span>
              <span>합계 {runPolicy.maxTotalTokens.toLocaleString()} tokens</span>
              <span>run hard cap {formatPolicyUsd(runPolicy.maxRunCostMicrosUsd)}</span>
              <span>월 soft limit {formatPolicyUsd(runPolicy.monthlyCostSoftLimitMicrosUsd)}</span>
              {selectedRunPolicyPreflight ? (
                <>
                  <small>{selectedRunPolicyPreflight.pricing.status === "known"
                    ? `최근 사전확인 · 최대 ${formatPolicyUsd(selectedRunPolicyPreflight.pricing.maximumRunCostMicrosUsd)}`
                    : "최근 사전확인 · 가격 확인 필요 · 비용을 추측하지 않음"}</small>
                  {selectedRunPolicyPreflight.warnings.map((warning) => <small className="warning" key={warning}>{warning}</small>)}
                </>
              ) : (
                <small>{selectedPolicyPricingKnown
                  ? "catalog 가격 있음 · 전송 시 실제 첨부·route·사용량으로 상한을 검사합니다."
                  : "가격 확인 필요 · 비용을 추측하지 않고 전송 직전 Companion에서 다시 검사합니다."}</small>
              )}
            </div>
          )}
          {provider === "openrouter" && (selectedModelOption?.routingOptions?.length ?? 0) > 0 && (
            <div className="routing-bar" aria-label="OpenRouter strict ZDR upstream 설정">
              <label>
                <span>UPSTREAM</span>
                <select
                  value={routingPrimary}
                  disabled={operation !== null || activeRun.requestId !== null}
                  aria-label="OpenRouter 1차 upstream"
                  onChange={(event) => selectRoutingPrimary(event.target.value)}
                >
                  <option value="">자동 · ZDR · fallback 없음</option>
                  {(selectedModelOption?.routingOptions ?? []).map((item) => (
                    <option key={item.id} value={item.id}>{routingOptionLabel(item)}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>승인한 백업</span>
                <select
                  value={routingBackup}
                  disabled={!routingPrimary || operation !== null || activeRun.requestId !== null}
                  aria-label="OpenRouter 승인한 fallback upstream"
                  onChange={(event) => selectRoutingBackup(event.target.value)}
                >
                  <option value="">없음 · 1차 고정</option>
                  {(selectedModelOption?.routingOptions ?? [])
                    .filter((item) => item.id !== routingPrimary)
                    .map((item) => <option key={item.id} value={item.id}>{routingOptionLabel(item)}</option>)}
                </select>
              </label>
              {(selectedPrimaryRoute || selectedBackupRoute) && (
                <div className="routing-facts">
                  {selectedPrimaryRoute && <span>1차 · {routingRouteFacts(selectedPrimaryRoute)}</span>}
                  {selectedBackupRoute && <span>백업 · {routingRouteFacts(selectedBackupRoute)}</span>}
                </div>
              )}
              <small>ZDR·데이터 비수집을 강제하며, 백업을 골라도 승인한 두 upstream 밖으로는 우회하지 않습니다.</small>
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
                  <button
                    type="button"
                    disabled={steering}
                    aria-label={`${item.name} 첨부 제거`}
                    onClick={() => void removeAttachment(item.id)}
                  >×</button>
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
                disabled={steering}
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
              disabled={steering || mediaBusy || attachments.length >= MAX_COMPOSER_ATTACHMENTS}
              aria-label="이미지 또는 영상 첨부"
              onClick={() => fileInputRef.current?.click()}
            >📎 <span>{tr("attachment")}</span></button>
            <label className="toggle">
              <input type="checkbox" checked={tts} onChange={(event) => setTts(event.target.checked)} />
              <span aria-hidden="true" />
              {tr("readAnswer")}
            </label>
            <label className="toggle network-toggle" title="패키지 설치 등 꼭 필요한 경우에만 켜세요">
              <input
                type="checkbox"
                checked={networkAccess}
                disabled={steerSelected}
                onChange={(event) => setNetworkAccess(event.target.checked)}
              />
              <span aria-hidden="true" />
              {tr("network")}
            </label>
            <button
              className="send-button"
              type="button"
              disabled={steering || dictating || mediaBusy || (!prompt.trim() && attachments.length === 0) || attachments.some((item) => item.kind === "video" && item.status !== "ready")}
              aria-label={steerSelected ? "지금 방향 수정 전송" : activity.running ? "요청을 대기열에 추가" : "요청 전송"}
              onClick={() => void submitPrompt()}
            >
              {steering ? "전달 중…" : steerSelected ? "방향 수정" : activity.running ? tr("queue") : tr("send")}
              <span aria-hidden="true">{steerSelected ? "↪" : activity.running ? "+" : "↑"}</span>
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

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
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

function providerConversationKey(device: DeviceId, provider: ProviderId, workspace: string): string {
  return `codex-pocket-conversation-${device}-${provider}-${workspace}`;
}

function persistConversationSelection(
  device: DeviceId,
  provider: ProviderId,
  workspace: string,
  conversationId: string,
): void {
  const key = provider === "codex"
    ? storageKey("thread", device)
    : providerConversationKey(device, provider, workspace);
  if (conversationId) localStorage.setItem(key, conversationId);
  else localStorage.removeItem(key);
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

function routingStorageKey(device: DeviceId, model: string, slot: "primary" | "backup"): string {
  return `codex-pocket-openrouter-routing-${slot}-${device}-${encodeURIComponent(model)}`;
}

function persistRoutingSlot(device: DeviceId, model: string, slot: "primary" | "backup", value: string): void {
  const key = routingStorageKey(device, model, slot);
  if (value) localStorage.setItem(key, value);
  else localStorage.removeItem(key);
}

function selectedRouting(
  provider: ProviderId,
  primary: string,
  backup: string,
): ProviderRoutingSelection | undefined {
  if (provider !== "openrouter" || !primary) return undefined;
  return {
    upstreams: backup ? [primary, backup] : [primary],
    allowFallbacks: Boolean(backup),
  };
}

function catalogPricingLabel(pricing: ProviderCatalogPricing | undefined): string {
  if (!pricing) return "";
  return [
    pricing.inputPerMillionUsd === undefined ? null : `입력 $${catalogNumber(pricing.inputPerMillionUsd)}/M`,
    pricing.outputPerMillionUsd === undefined ? null : `출력 $${catalogNumber(pricing.outputPerMillionUsd)}/M`,
  ].filter(Boolean).join(" · ");
}

function formatPolicyUsd(micros: number | undefined): string {
  if (micros === undefined) return "가격 확인 필요";
  return `$${(micros / 1_000_000).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;
}

function runPrivacyLabel(profile: RunPolicySnapshot["privacyProfile"]): string {
  if (profile === "openai-store-false") return "OpenAI store:false";
  if (profile === "openrouter-strict-zdr") return "OpenRouter strict ZDR";
  if (profile === "codex-managed") return "Codex 관리 연결";
  return "Provider 정의 확인 필요";
}

function routingOptionLabel(option: ProviderRoutingOption): string {
  const pricing = catalogPricingLabel(option.pricing);
  return `${option.displayName} · ${option.id}${pricing ? ` · ${pricing}` : ""}`;
}

function routingRouteFacts(option: ProviderRoutingOption): string {
  return [
    option.displayName,
    catalogPricingLabel(option.pricing) || null,
    option.latencyP50Ms === undefined ? null : `p50 ${catalogNumber(option.latencyP50Ms)}ms`,
    option.throughputP50 === undefined ? null : `p50 ${catalogNumber(option.throughputP50)} tok/s`,
    option.uptime30m === undefined ? null : `30분 uptime ${catalogNumber(option.uptime30m)}%`,
    option.quantization || null,
    option.supportsTools === false ? "tool 미지원" : null,
    option.verification ? modelVerificationLabel(option.verification, "openrouter") : null,
  ].filter(Boolean).join(" · ");
}

function combinedRouteVerification(
  routes: readonly ProviderRoutingOption[],
): ProviderModelVerification | undefined {
  if (routes.length === 0) return undefined;
  const verifications = routes.map((route) => route.verification).filter(
    (item): item is ProviderModelVerification => item !== undefined,
  );
  if (verifications.length !== routes.length) {
    return { scope: "upstream", conversation: "not_tested", projectRead: "not_tested", coding: "not_tested" };
  }
  return {
    scope: "upstream",
    conversation: combinedGrade(verifications.map((item) => item.conversation)),
    projectRead: combinedGrade(verifications.map((item) => item.projectRead)),
    coding: combinedGrade(verifications.map((item) => item.coding)),
    checkedAt: verifications.every((item) => item.checkedAt)
      ? new Date(Math.min(...verifications.map((item) => Date.parse(item.checkedAt!)))).toISOString()
      : undefined,
    expiresAt: verifications.every((item) => item.expiresAt)
      ? new Date(Math.min(...verifications.map((item) => Date.parse(item.expiresAt!)))).toISOString()
      : undefined,
  };
}

function combinedGrade(grades: readonly ProviderModelGrade[]): ProviderModelGrade {
  if (grades.every((grade) => grade === "pass")) return "pass";
  for (const grade of ["invalid", "expired", "fail", "not_tested"] as const) {
    if (grades.includes(grade)) return grade;
  }
  return "not_tested";
}

function modelVerificationLabel(
  verification: ProviderModelVerification | undefined,
  provider: ProviderId,
): string {
  if (!verification) return provider === "openrouter" ? "upstream 미선택 · 프로젝트 도구 차단" : "eval 없음 · chat-only";
  if (verification.coding === "pass" && verification.projectRead === "pass") return "코딩 eval 통과 · 터치 승인 필요";
  if (verification.projectRead === "pass") return "읽기 eval 통과 · 변경 차단";
  if (verification.coding === "invalid" || verification.projectRead === "invalid") return "eval report 오류 · 도구 차단";
  if (verification.coding === "expired" || verification.projectRead === "expired") return "eval 만료 · 도구 차단";
  if (verification.coding === "fail" || verification.projectRead === "fail") return "eval 미통과 · 도구 차단";
  return "project eval 미실행 · chat-only";
}

function modelVerificationClass(verification: ProviderModelVerification | undefined): string {
  if (verification?.coding === "pass" || verification?.projectRead === "pass") return "verified";
  return "restricted";
}

function catalogNumber(value: number): string {
  return value.toLocaleString("en-US", {
    maximumFractionDigits: value !== 0 && Math.abs(value) < 0.01 ? 6 : 2,
  });
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
