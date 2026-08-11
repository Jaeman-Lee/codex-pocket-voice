import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, apiUrl } from "./api";
import { isNativeApp, NativeSpeech, NativeTunnel } from "./native";
import { mergeSpeechSegments } from "./speech-utils";
import type {
  ChatMessage,
  CodexEvent,
  ConnectionStatus,
  HistoryItem,
  Operation,
  RunResult,
  ThreadDetail,
  ThreadSummary,
  Workspace,
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
  const [dictating, setDictating] = useState(false);
  const [speechSupported, setSpeechSupported] = useState(true);
  const [toast, setToast] = useState("");
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);

  const transcriptRef = useRef<HTMLElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const operationRef = useRef<Operation | null>(null);
  const workspaceRef = useRef("");
  const threadRef = useRef("");
  const ttsRef = useRef(tts);
  const liveMessageIdRef = useRef<string | null>(null);
  const liveTextRef = useRef("");
  const latestDiffRef = useRef("");
  const pollTimerRef = useRef<number | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const dictationBaseRef = useRef("");
  const initializedRef = useRef(false);
  const initializingRef = useRef(false);
  const handleEventRef = useRef<(event: CodexEvent) => void>(() => undefined);
  const initializeRef = useRef<() => Promise<void>>(async () => undefined);

  useEffect(() => { workspaceRef.current = workspace; }, [workspace]);
  useEffect(() => { threadRef.current = threadId; }, [threadId]);
  useEffect(() => { ttsRef.current = tts; localStorage.setItem("codex-pocket-tts", String(tts)); }, [tts]);
  useEffect(() => { operationRef.current = operation; }, [operation]);

  const showToast = useCallback((text: string) => {
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
    setToast(text);
    toastTimerRef.current = window.setTimeout(() => setToast(""), 4_000);
  }, []);

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
      const [health, workspaceData] = await Promise.all([
        api<{ userAgent: string }>("/api/health"),
        api<{ workspaces: Workspace[] }>("/api/workspaces"),
      ]);
      setConnectionText(`${health.userAgent} · 안전 연결`);
      setConnection("online");
      setWorkspaces(workspaceData.workspaces);

      const stored = localStorage.getItem("codex-pocket-workspace") ?? "";
      const selected = workspaceData.workspaces.some((item) => item.path === workspaceRef.current)
        ? workspaceRef.current
        : workspaceData.workspaces.some((item) => item.path === stored)
          ? stored
          : (workspaceData.workspaces[0]?.path ?? "");
      setWorkspace(selected);
      workspaceRef.current = selected;
      await loadThreads(selected, true, localStorage.getItem("codex-pocket-thread") ?? "");
      initializedRef.current = true;
    } catch (error) {
      setConnection("error");
      setConnectionText("PC 연결 실패");
      showToast(errorMessage(error));
    } finally {
      initializingRef.current = false;
    }
  }, [loadThreads, showToast]);

  initializeRef.current = initialize;

  useEffect(() => {
    void (async () => {
      if (isNativeApp()) {
        try {
          await NativeTunnel.start();
          setConnectionText("PC 연결을 준비하는 중…");
        } catch (error) {
          showToast(errorMessage(error));
        }
      }
      await initialize();
    })();
    const stream = new EventSource(apiUrl("/api/events"));
    stream.onopen = () => {
      setConnection("online");
      setConnectionText((current) => current.includes("복구") || current.includes("실패") ? "PC와 안전하게 연결됨" : current);
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
  }, [initialize]);

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
    recognition.onend = () => setDictating(false);
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
        localStorage.setItem("codex-pocket-thread", result.threadId);
      }
      if (ttsRef.current && result.finalResponse) speak(result.finalResponse);
      void loadThreads(workspaceRef.current, true, result.threadId);
    } else if (action === "failed") {
      finishLiveMessage(`작업 실패: ${nextOperation.error || "알 수 없는 오류"}`, true);
      stopRunning();
    }
  }

  function handleEvent(event: CodexEvent) {
    if (event.type === "connected") return;
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

  async function submitPrompt() {
    const text = prompt.trim();
    if (!text || operationRef.current?.status === "running") return;
    if (!workspaceRef.current) {
      showToast("프로젝트를 먼저 선택하세요.");
      return;
    }
    if (dictating) recognitionRef.current?.stop();

    const userId = newId("user");
    const assistantId = newId("assistant");
    setMessages((current) => [
      ...current,
      { id: userId, role: "user", text },
      { id: assistantId, role: "assistant", text: "", pending: true },
    ]);
    liveMessageIdRef.current = assistantId;
    liveTextRef.current = "";
    latestDiffRef.current = "";
    setPrompt("");
    setRunning("Codex가 요청을 시작하고 있습니다…");

    try {
      const data = await api<{ operation: Operation }>("/api/runs", {
        method: "POST",
        body: {
          prompt: text,
          cwd: workspaceRef.current,
          threadId: threadRef.current || undefined,
          networkAccess,
        },
      });
      operationRef.current = data.operation;
      setOperation(data.operation);
      scheduleOperationPoll(data.operation.id);
      setRunning("Codex가 프로젝트를 살펴보고 있습니다…");
    } catch (error) {
      finishLiveMessage(`실행하지 못했습니다: ${errorMessage(error)}`, true);
      stopRunning();
    }
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

  async function selectWorkspace(path: string) {
    setWorkspace(path);
    workspaceRef.current = path;
    localStorage.setItem("codex-pocket-workspace", path);
    setThreadId("");
    threadRef.current = "";
    localStorage.removeItem("codex-pocket-thread");
    setMessages([]);
    await loadThreads(path, false);
  }

  async function selectThread(id: string) {
    setThreadId(id);
    threadRef.current = id;
    if (id) localStorage.setItem("codex-pocket-thread", id);
    else localStorage.removeItem("codex-pocket-thread");
    setMessages([]);
    if (!id) return;
    try {
      const data = await api<{ thread: ThreadDetail }>(`/api/threads/${encodeURIComponent(id)}`);
      setMessages(historyMessages(data.thread));
    } catch (error) {
      showToast(errorMessage(error));
    }
  }

  async function toggleDictation() {
    if (isNativeApp()) {
      if (dictating) return;
      setDictating(true);
      try {
        const result = await NativeSpeech.listen({
          language: "ko-KR",
          prompt: "Codex에게 보낼 내용을 한국어로 말씀해 주세요",
        });
        if (!result.cancelled && result.transcript.trim()) {
          setPrompt((current) => joinDictation(current, result.transcript));
        }
      } catch (error) {
        showToast(`음성 인식 오류: ${errorMessage(error)}`);
      } finally {
        setDictating(false);
      }
      return;
    }

    const recognition = recognitionRef.current;
    if (!recognition) return;
    if (dictating) {
      recognition.stop();
      return;
    }
    dictationBaseRef.current = prompt.trim();
    try {
      recognition.lang = "ko-KR";
      recognition.start();
    } catch (error) {
      showToast(errorMessage(error));
    }
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
          {installPrompt && (
            <button className="icon-button" type="button" aria-label="홈 화면에 설치" onClick={() => {
              void installPrompt.prompt();
              setInstallPrompt(null);
            }}>＋</button>
          )}
          <span className={`status-dot ${connection}`} aria-hidden="true" />
        </div>
      </header>

      <section className="selectors" aria-label="작업 대상">
        <label>
          <span>프로젝트</span>
          <select value={workspace} disabled={activity.running} aria-label="프로젝트 선택" onChange={(event) => void selectWorkspace(event.target.value)}>
            {workspaces.map((item) => <option key={item.path} value={item.path}>{item.name}</option>)}
          </select>
        </label>
        <label>
          <span>대화</span>
          <div className="select-row">
            <select value={threadId} disabled={activity.running} aria-label="Codex 대화 선택" onChange={(event) => void selectThread(event.target.value)}>
              <option value="">새 대화</option>
              {threads.map((thread) => (
                <option key={thread.id} value={thread.id}>{short(thread.name || thread.preview || "제목 없는 대화", 42)}</option>
              ))}
            </select>
            <button className="icon-button" type="button" aria-label="대화 새로고침" onClick={() => void loadThreads(workspaceRef.current, true)}>↻</button>
          </div>
        </label>
      </section>

      <main ref={transcriptRef} className="transcript" aria-live="polite">
        {messages.length === 0 ? (
          <section className="empty-state">
            <div className="empty-orbit" aria-hidden="true"><span /></div>
            <h2>말하고, 확인하고, 실행하세요.</h2>
            <p>한국어 음성 버튼으로 말한 뒤 전송하면 PC의 Codex가 선택한 프로젝트에서 작업합니다.</p>
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
        <div className="composer">
          <div className="composer-input-row">
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
            <button
              className={`voice-button${dictating ? " listening" : ""}`}
              type="button"
              disabled={!speechSupported}
              aria-label={dictating ? "음성 입력 중지" : "한국어 음성 입력 시작"}
              aria-pressed={dictating}
              title={speechSupported ? undefined : "이 브라우저는 앱 내 음성 인식을 지원하지 않습니다."}
              onClick={() => void toggleDictation()}
            >
              <span aria-hidden="true">🎙</span><small>{dictating ? "듣는 중" : "한국어"}</small>
            </button>
          </div>
          <div className="composer-bar">
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
            <button className="send-button" type="button" disabled={activity.running || !prompt.trim()} aria-label="요청 전송" onClick={() => void submitPrompt()}>
              보내기 <span aria-hidden="true">↑</span>
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
