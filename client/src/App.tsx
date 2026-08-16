import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { api, apiUrl, setApiDevice, uploadMedia } from "./api";
import {
  isNativeApp,
  NativeSpeech,
  NativeTunnel,
  type NativeSpeechError,
  type NativeSpeechResult,
  type NativeSpeechState,
} from "./native";
import { mergeSpeechSegments } from "./speech-utils";
import type {
  ChatMessage,
  CodexEvent,
  ConnectionStatus,
  DeviceId,
  HistoryItem,
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
  RunResult,
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

interface QueuedPrompt {
  id: string;
  text: string;
  cwd: string;
  threadId: string;
  networkAccess: boolean;
  model: string;
  effort: string;
  provider: ProviderId;
  accountId: string;
  attachments: PendingAttachment[];
}

let localId = 0;
const newId = (prefix: string) => `${prefix}-${Date.now()}-${localId++}`;

export function App() {
  const [device, setDevice] = useState<DeviceId>(
    () => localStorage.getItem("codex-pocket-device") === "phone" && isNativeApp() ? "phone" : "pc",
  );
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
  const [promptQueue, setPromptQueue] = useState<QueuedPrompt[]>([]);
  const [showConnectionCenter, setShowConnectionCenter] = useState(false);
  const [testingProvider, setTestingProvider] = useState<ProviderId | null>(null);
  const [connectionTest, setConnectionTest] = useState<Partial<Record<ProviderId, ProviderConnectionTest>>>({});
  const [loginSession, setLoginSession] = useState<ProviderLoginSession | null>(null);
  const [providerAliases, setProviderAliases] = useState<Partial<Record<ProviderId, string>>>({});

  const transcriptRef = useRef<HTMLElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const operationRef = useRef<Operation | null>(null);
  const promptQueueRef = useRef<QueuedPrompt[]>([]);
  const workspaceRef = useRef("");
  const deviceRef = useRef<DeviceId>(device);
  const threadRef = useRef("");
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
  const longPressTimerRef = useRef<number | null>(null);
  const longPressTriggeredRef = useRef(false);
  const voiceWasActiveRef = useRef(false);
  const initializedRef = useRef(false);
  const initializingRef = useRef(false);
  const handleEventRef = useRef<(event: CodexEvent) => void>(() => undefined);
  const initializeRef = useRef<() => Promise<void>>(async () => undefined);

  useEffect(() => { workspaceRef.current = workspace; }, [workspace]);
  useEffect(() => {
    deviceRef.current = device;
    setApiDevice(device);
    localStorage.setItem("codex-pocket-device", device);
  }, [device]);
  useEffect(() => { threadRef.current = threadId; }, [threadId]);
  useEffect(() => { ttsRef.current = tts; localStorage.setItem("codex-pocket-tts", String(tts)); }, [tts]);
  useEffect(() => { operationRef.current = operation; }, [operation]);
  useEffect(() => { handsFreeRef.current = handsFree; }, [handsFree]);
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

  const showToast = useCallback((text: string) => {
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
    setToast(text);
    toastTimerRef.current = window.setTimeout(() => setToast(""), 4_000);
  }, []);

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

  const initialize = useCallback(async () => {
    if (initializingRef.current) return;
    initializingRef.current = true;
    try {
      const [health, workspaceData, providerData, modelData] = await Promise.all([
        api<{ userAgent: string; device: { name: string } }>("/api/health"),
        api<WorkspaceResponse>("/api/workspaces"),
        api<ProviderResponse>("/api/providers"),
        api<ModelResponse>("/api/models?provider=codex"),
      ]);
      setConnectionText(`${health.device.name} · ${health.userAgent}`);
      setConnection("online");
      setWorkspaces(workspaceData.workspaces);
      setCreationLocations(workspaceData.creationLocations);
      setModels(modelData.models);
      setProviders(providerData.providers);
      const storedProvider = localStorage.getItem(storageKey("provider", deviceRef.current));
      const selectedProvider = providerData.providers.find((item) => item.id === storedProvider && item.available)
        ?? providerData.providers.find((item) => item.id === "codex")
        ?? providerData.providers.find((item) => item.available);
      setProvider(selectedProvider?.id ?? "codex");
      const storedAccount = localStorage.getItem(storageKey("account", deviceRef.current));
      const selectedAccount = selectedProvider?.accounts.find((item) => item.id === storedAccount)
        ?? selectedProvider?.accounts.find((item) => item.connected)
        ?? selectedProvider?.accounts[0];
      setAccountId(selectedAccount?.id ?? "cli-default");
      const storedModel = localStorage.getItem(storageKey("model", deviceRef.current)) ?? "";
      const selectedModel = modelData.models.some((item) => item.id === storedModel) ? storedModel : "";
      setModel(selectedModel);
      const selectedModelInfo = modelData.models.find((item) => item.id === selectedModel)
        ?? modelData.models.find((item) => item.isDefault)
        ?? modelData.models[0];
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
      await loadThreads(selected, true, localStorage.getItem(storageKey("thread", deviceRef.current)) ?? "");
      initializedRef.current = true;
    } catch (error) {
      setConnection("error");
      setConnectionText(`${deviceLabel(deviceRef.current)} 연결 실패`);
      showToast(errorMessage(error));
    } finally {
      initializingRef.current = false;
    }
  }, [loadThreads, showToast]);

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
          const tunnel = await NativeTunnel.start();
          if (tunnel.manual && tunnel.message) showToast(tunnel.message);
        } catch (error) {
          showToast(errorMessage(error));
        }
      }
      await initialize();
    })();
    const stream = new EventSource(apiUrl("/api/events"));
    stream.onopen = () => {
      setConnection("online");
      setConnectionText((current) => current.includes("복구") || current.includes("실패")
        ? `${deviceLabel(device)}와 안전하게 연결됨`
        : current);
      if (!initializedRef.current) void initializeRef.current();
    };
    stream.onerror = () => {
      setConnection("pending");
      setConnectionText("연결을 복구하는 중…");
    };
    stream.onmessage = (message) => {
      try {
        handleEventRef.current(JSON.parse(message.data) as CodexEvent);
      } catch {
        // Ignore malformed or forward-compatible event frames.
      }
    };
    return () => stream.close();
  }, [device, initialize, showToast]);

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
    recognition.lang = "ko-KR";
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
    setMessages((current) => current.map((message) => message.id === id ? { ...message, ...update } : message));
  }

  function ensureLiveMessage(): string {
    if (liveMessageIdRef.current) return liveMessageIdRef.current;
    const id = newId("assistant");
    liveMessageIdRef.current = id;
    setMessages((current) => [...current, { id, role: "assistant", text: "", pending: true }]);
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
    utterance.lang = "ko-KR";
    utterance.rate = 1.03;
    const korean = speechSynthesis.getVoices().find((voice) => voice.lang.toLowerCase().startsWith("ko"));
    if (korean) utterance.voice = korean;
    speechSynthesis.speak(utterance);
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
      handleOperationEvent(data.operation.status === "failed" ? "failed" : "completed", data.operation);
    } catch {
      scheduleOperationPoll(operationId);
    }
  }

  function handleOperationEvent(action: string, nextOperation: Operation) {
    if (action === "started" && !operationRef.current) {
      operationRef.current = nextOperation;
      setOperation(nextOperation);
      ensureLiveMessage();
      setRunning("Codex가 프로젝트를 살펴보고 있습니다…");
      scheduleOperationPoll(nextOperation.id);
    }
    if (!operationRef.current || nextOperation.id !== operationRef.current.id) return;
    operationRef.current = nextOperation;
    setOperation(nextOperation);

    if (action === "completed") {
      const result = nextOperation.result ?? {};
      finishLiveMessage(result.finalResponse || statusMessage(nextOperation.status), false, result);
      stopRunning();
      if (result.threadId) {
        setThreadId(result.threadId);
        threadRef.current = result.threadId;
        localStorage.setItem(storageKey("thread", deviceRef.current), result.threadId);
      }
      if (ttsRef.current && result.finalResponse) speak(result.finalResponse);
      void loadThreads(workspaceRef.current, true, result.threadId);
      startNextQueuedPrompt(result.threadId ?? threadRef.current);
    } else if (action === "failed") {
      finishLiveMessage(`작업 실패: ${nextOperation.error || "알 수 없는 오류"}`, true);
      stopRunning();
      startNextQueuedPrompt(threadRef.current);
    }
  }

  function handleEvent(event: CodexEvent) {
    if (event.type === "connected") return;
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
    const current = operationRef.current;
    if (event.type !== "codex" || !current) return;
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

  function removeAttachment(id: string) {
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
    };
    setPrompt("");
    setAttachments([]);
    if (operationRef.current?.status === "running") {
      const nextQueue = [...promptQueueRef.current, queued];
      promptQueueRef.current = nextQueue;
      setPromptQueue(nextQueue);
      showToast(`요청을 대기열 ${nextQueue.length}번째에 추가했습니다.`);
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
    setMessages((current) => [
      ...current,
      { id: userId, role: "user", text: `${queued.text}${attachmentLabel}` },
      { id: assistantId, role: "assistant", text: "", pending: true },
    ]);
    liveMessageIdRef.current = assistantId;
    liveTextRef.current = "";
    latestDiffRef.current = "";
    setRunning("Codex가 요청을 시작하고 있습니다…");

    try {
      const data = await api<{ operation: Operation }>("/api/runs", {
        method: "POST",
        body: {
          prompt: queued.text,
          cwd: queued.cwd,
          threadId: queued.threadId || continuedThreadId || undefined,
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
      for (const item of queued.attachments) if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      scheduleOperationPoll(data.operation.id);
      setRunning("Codex가 프로젝트를 살펴보고 있습니다…");
    } catch (error) {
      finishLiveMessage(`실행하지 못했습니다: ${errorMessage(error)}`, true);
      stopRunning();
      startNextQueuedPrompt(continuedThreadId || threadRef.current);
    }
  }

  function startNextQueuedPrompt(continuedThreadId: string) {
    const [next, ...remaining] = promptQueueRef.current;
    if (!next) return;
    promptQueueRef.current = remaining;
    setPromptQueue(remaining);
    window.setTimeout(() => void executePrompt(next, continuedThreadId), 0);
  }

  function removeQueuedPrompt(id: string) {
    const removed = promptQueueRef.current.find((item) => item.id === id);
    for (const attachment of removed?.attachments ?? []) {
      if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
    }
    const remaining = promptQueueRef.current.filter((item) => item.id !== id);
    promptQueueRef.current = remaining;
    setPromptQueue(remaining);
  }

  async function stopOperation() {
    const current = operationRef.current;
    if (!current) return;
    try {
      await api(`/api/runs/${encodeURIComponent(current.id)}/interrupt`, { method: "POST", body: {} });
      setRunning("중단을 요청했습니다…");
    } catch (error) {
      showToast(errorMessage(error));
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
    setAccountId("cli-default");
    setModel("");
    setEffort("");
    setMessages([]);
    promptQueueRef.current = [];
    setPromptQueue([]);
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
    const info = providers.find((item) => item.id === nextProvider);
    if (!info?.available) {
      showToast(info?.detail ?? "이 AI 연결은 현재 사용할 수 없습니다.");
      return;
    }
    setProvider(nextProvider);
    localStorage.setItem(storageKey("provider", deviceRef.current), nextProvider);
    const nextAccount = info.accounts.find((item) => item.connected) ?? info.accounts[0];
    setAccountId(nextAccount?.id ?? "");
    if (nextAccount) localStorage.setItem(storageKey("account", deviceRef.current), nextAccount.id);
    const modelData = await api<ModelResponse>(`/api/models?provider=${encodeURIComponent(nextProvider)}`);
    setModels(modelData.models);
    setModel("");
    setEffort("");
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
    if (!name || creatingProject) return;
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
      showToast(errorMessage(error));
    } finally {
      setCreatingProject(false);
    }
  }

  async function selectWorkspace(path: string) {
    setWorkspace(path);
    workspaceRef.current = path;
    localStorage.setItem(storageKey("workspace", deviceRef.current), path);
    setThreadId("");
    threadRef.current = "";
    localStorage.removeItem(storageKey("thread", deviceRef.current));
    setMessages([]);
    await loadThreads(path, false);
  }

  async function selectThread(id: string) {
    setThreadId(id);
    threadRef.current = id;
    if (id) localStorage.setItem(storageKey("thread", deviceRef.current), id);
    else localStorage.removeItem(storageKey("thread", deviceRef.current));
    setMessages([]);
    if (!id) return;
    try {
      const data = await api<{ thread: ThreadDetail }>(`/api/threads/${encodeURIComponent(id)}`);
      setMessages(historyMessages(data.thread));
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
          language: "ko-KR",
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
      recognition.lang = "ko-KR";
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
            className="icon-button"
            type="button"
            aria-label="AI 연결 센터 열기"
            title="AI 연결 센터"
            onClick={() => {
              setShowConnectionCenter(true);
              void refreshProviders();
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

      <section className={`selectors${controlsCollapsed ? " collapsed" : ""}`} aria-label="작업 대상" aria-hidden={controlsCollapsed}>
        <label>
          <span>실행 단말</span>
          <select
            value={device}
            disabled={activity.running || controlsCollapsed}
            aria-label="Codex 실행 단말 선택"
            onChange={(event) => selectDevice(event.target.value as DeviceId)}
          >
            <option value="pc">내 PC</option>
            {isNativeApp() && <option value="phone">이 스마트폰</option>}
          </select>
        </label>
        <label>
          <span>AI 연결</span>
          <select
            value={provider}
            disabled={activity.running || controlsCollapsed}
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
          <span>프로젝트</span>
          <div className="select-row">
            <select value={workspace} disabled={activity.running || controlsCollapsed} aria-label="프로젝트 선택" onChange={(event) => void selectWorkspace(event.target.value)}>
              {workspaces.length === 0 && <option value="">프로젝트 없음</option>}
              {workspaces.map((item) => <option key={item.path} value={item.path}>{item.name}</option>)}
            </select>
            <button
              className="icon-button"
              type="button"
              disabled={activity.running || controlsCollapsed || creationLocations.length === 0}
              aria-label={`${deviceLabel(device)}에 새 프로젝트 만들기`}
              onClick={() => setShowProjectCreator(true)}
            >＋</button>
          </div>
        </label>
        <label>
          <span>대화</span>
          <div className="select-row">
            <select value={threadId} disabled={activity.running || controlsCollapsed} aria-label="Codex 대화 선택" onChange={(event) => void selectThread(event.target.value)}>
              <option value="">새 대화</option>
              {threads.map((thread) => (
                <option key={thread.id} value={thread.id}>{short(thread.name || thread.preview || "제목 없는 대화", 42)}</option>
              ))}
            </select>
            <button className="icon-button" type="button" disabled={controlsCollapsed} aria-label="대화 새로고침" onClick={() => void loadThreads(workspaceRef.current, true)}>↻</button>
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
              <button type="button" aria-label="닫기" onClick={() => setShowConnectionCenter(false)}>×</button>
            </div>

            <label className="connection-device">
              <span>확인할 단말</span>
              <select value={device} disabled={activity.running} onChange={(event) => selectDevice(event.target.value as DeviceId)}>
                <option value="pc">내 PC</option>
                {isNativeApp() && <option value="phone">이 스마트폰</option>}
              </select>
            </label>

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
                <option value="pc">내 PC</option>
                {isNativeApp() && <option value="phone">이 스마트폰</option>}
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
                onChange={(event) => setNewProjectName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void createProject();
                }}
              />
            </label>
            <button className="create-project-button" type="button" disabled={creatingProject || !newProjectName.trim() || creationLocations.length === 0} onClick={() => void createProject()}>
              {creatingProject ? "만드는 중…" : `${deviceLabel(device)}에 만들기`}
            </button>
          </div>
        </section>
      )}

      <main ref={transcriptRef} className="transcript" aria-live="polite">
        {messages.length === 0 ? (
          <section className="empty-state">
            <div className="empty-orbit" aria-hidden="true"><span /></div>
            <h2>말하고, 확인하고, 실행하세요.</h2>
            <p>한국어 음성 버튼으로 말한 뒤 전송하면 {deviceLabel(device)}의 Codex가 선택한 프로젝트에서 작업합니다.</p>
            <div className="suggestions">
              <button type="button" onClick={() => setPrompt("이 프로젝트의 현재 상태를 확인하고 다음 할 일을 알려주세요.")}>현재 상태 확인</button>
              <button type="button" onClick={() => setPrompt("테스트를 실행하고 실패 원인을 고쳐주세요.")}>테스트 실행·수정</button>
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

      <footer className="composer-wrap">
        {promptQueue.length > 0 && (
          <div className="prompt-queue" aria-label="예약 요청">
            <div className="prompt-queue-head">
              <strong>대기열 {promptQueue.length}</strong>
              <span>현재 작업이 끝나면 순서대로 실행</span>
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
                <span>계정</span>
                <select value={accountId} aria-label="AI 계정 프로필" onChange={(event) => selectAccount(event.target.value)}>
                  {(activeProvider(providers, provider)?.accounts ?? []).map((item) => (
                    <option key={item.id} value={item.id}>{item.label}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>모델</span>
                <select
                  value={model}
                  aria-label="Codex 모델"
                  onChange={(event) => selectModel(event.target.value)}
                >
                  <option value="">자동 · {defaultModel(models)?.displayName ?? "Codex 기본값"}</option>
                  {models.map((item) => (
                    <option key={item.id} value={item.id}>{item.displayName}{item.isDefault ? " · 기본" : ""}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>성능</span>
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
                    <img src={apiUrl(`/api/media/${encodeURIComponent(item.id)}/frames/0`)} alt="영상 첫 대표 프레임" />
                  )}
                  <div>
                    <strong>{item.kind === "video" ? "🎬" : "🖼️"} {short(item.name, 28)}</strong>
                    <span>{mediaStatusText(item, device)}</span>
                    {item.analysis?.summary && <small>{short(item.analysis.summary, 72)}</small>}
                  </div>
                  <button type="button" aria-label={`${item.name} 첨부 제거`} onClick={() => removeAttachment(item.id)}>×</button>
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
                lang="ko-KR"
                inputMode="text"
                rows={2}
                maxLength={100_000}
                value={prompt}
                placeholder="한국어로 말하거나 직접 입력하세요"
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
              <span aria-hidden="true">🎙</span><small>{handsFree ? "연속 중" : dictating ? "듣는 중" : "한국어"}</small>
            </button>
          </div>
          <p className={`voice-help${handsFree ? " active" : ""}`}>
            {handsFree ? "계속 듣는 중 · 마이크를 누르면 종료" : "짧게 누르기 · 길게 눌러 연속"}
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
            >📎 <span>첨부</span></button>
            <label className="toggle">
              <input type="checkbox" checked={tts} onChange={(event) => setTts(event.target.checked)} />
              <span aria-hidden="true" />
              답변 읽기
            </label>
            <label className="toggle network-toggle" title="패키지 설치 등 꼭 필요한 경우에만 켜세요">
              <input type="checkbox" checked={networkAccess} onChange={(event) => setNetworkAccess(event.target.checked)} />
              <span aria-hidden="true" />
              네트워크
            </label>
            <button
              className="send-button"
              type="button"
              disabled={dictating || mediaBusy || (!prompt.trim() && attachments.length === 0) || attachments.some((item) => item.kind === "video" && item.status !== "ready")}
              aria-label={activity.running ? "요청을 대기열에 추가" : "요청 전송"}
              onClick={() => void submitPrompt()}
            >
              {activity.running ? "대기열" : "보내기"} <span aria-hidden="true">{activity.running ? "+" : "↑"}</span>
            </button>
          </div>
        </div>
        <p className="safety-note">허용된 폴더만 수정 · 추가 권한은 자동 거절</p>
      </footer>

      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}

function Message({ message }: { message: ChatMessage }) {
  return (
    <article className={`message ${message.role}${message.pending ? " pending" : ""}${message.error ? " error" : ""}`}>
      <div className="bubble">
        <div className="message-label">{message.role === "user" ? "나" : "Codex"}</div>
        <p className="message-text">{message.text}</p>
        {message.details && (
          <details className="details">
            <summary>변경 파일과 명령 보기</summary>
            <pre>{message.details}</pre>
          </details>
        )}
      </div>
    </article>
  );
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

function statusMessage(status: Operation["status"]): string {
  if (status === "interrupted") return "작업이 중단되었습니다.";
  if (status === "failed") return "작업이 실패했습니다.";
  return "작업이 완료되었습니다.";
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

function providerAliasKey(device: DeviceId, provider: ProviderId): string {
  return `codex-pocket-provider-alias-${device}-${provider}`;
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
  return device === "phone" ? "이 스마트폰" : "내 PC";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
