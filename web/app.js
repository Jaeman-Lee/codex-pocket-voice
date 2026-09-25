const $ = (selector) => document.querySelector(selector);

const elements = {
  connectionText: $("#connectionText"),
  connectionDot: $("#connectionDot"),
  workspace: $("#workspaceSelect"),
  search: $("#workspaceSearch"),
  reconnect: $("#reconnectButton"),
  connectionHelp: $("#connectionHelp"),
  newThread: $("#newThreadButton"),
  thread: $("#threadSelect"),
  refresh: $("#refreshButton"),
  transcript: $("#transcript"),
  empty: $("#emptyState"),
  prompt: $("#promptInput"),
  voice: $("#voiceButton"),
  send: $("#sendButton"),
  stop: $("#stopButton"),
  tts: $("#ttsToggle"),
  network: $("#networkToggle"),
  activity: $("#activityPanel"),
  activityText: $("#activityText"),
  activityDetail: $("#activityDetail"),
  toast: $("#toast"),
  install: $("#installButton"),
};

const state = {
  operation: null,
  submitting: false,
  connected: false,
  workspaceList: [],
  workspacePath: "",
  threadsRequest: 0,
  historyRequest: 0,
  syncing: false,
  initialized: false,
  followOutput: true,
  liveBubble: null,
  liveText: "",
  latestDiff: "",
  installPrompt: null,
  recognition: null,
  dictationBase: "",
  dictationFinal: "",
};

function stored(storage, key, fallback = "") {
  try { return storage.getItem(key) ?? fallback; } catch { return fallback; }
}
function remember(storage, key, value) {
  try { if (value === null) storage.removeItem(key); else storage.setItem(key, value); } catch {}
}
function draftKey() { return `pocket-draft:${state.workspacePath}`; }
function saveDraft() { if (state.workspacePath) remember(sessionStorage, draftKey(), elements.prompt.value); }
function saveSelection() {
  remember(localStorage, "pocket-workspace", state.workspacePath);
  remember(localStorage, `pocket-thread:${state.workspacePath}`, elements.thread.value);
}
function restoreDraft() {
  elements.prompt.value = stored(sessionStorage, draftKey());
  autoSizePrompt();
}
function renderWorkspaces() {
  const query = elements.search.value.trim().toLowerCase();
  const matches = state.workspaceList.filter(w => w.path === state.workspacePath || w.name.toLowerCase().includes(query));
  elements.workspace.replaceChildren(...matches.map(w => option(w.path, w.name)));
  elements.workspace.value = state.workspacePath;
}
async function changeWorkspace() {
  saveDraft();
  state.workspacePath = elements.workspace.value;
  state.historyRequest += 1;
  clearTranscript();
  restoreDraft();
  await loadThreads(false, stored(localStorage, `pocket-thread:${state.workspacePath}`));
  saveSelection();
  await loadSelectedThread();
}
elements.tts.checked = stored(localStorage, "codex-pocket-tts") === "true";
elements.tts.addEventListener("change", () => remember(localStorage, "codex-pocket-tts", String(elements.tts.checked)));
elements.send.addEventListener("click", submitPrompt);
elements.stop.addEventListener("click", stopOperation);
elements.refresh.addEventListener("click", () => loadThreads(true));
elements.thread.addEventListener("change", () => { saveSelection(); void loadSelectedThread(); });
elements.workspace.addEventListener("change", changeWorkspace);
elements.search.addEventListener("input", renderWorkspaces);
elements.newThread.addEventListener("click", () => {
  elements.thread.value = ""; saveSelection(); void loadSelectedThread(); elements.prompt.focus();
});
elements.reconnect.addEventListener("click", () => void initialize());
elements.prompt.addEventListener("input", () => { autoSizePrompt(); saveDraft(); });
elements.transcript.addEventListener("scroll", () => {
  const box = elements.transcript;
  state.followOutput = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
});
elements.voice.addEventListener("click", toggleDictation);
elements.prompt.addEventListener("keydown", (event) => {
  if (!event.isComposing && event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault(); void submitPrompt();
  }
});
window.addEventListener("pagehide", saveDraft);
window.addEventListener("online", () => void initialize());
window.addEventListener("offline", () => setConnection("pending"));
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void syncOperation();
});
setInterval(() => { if (state.operation) void syncOperation(); }, 5000);

for (const button of document.querySelectorAll("[data-prompt]")) {
  button.addEventListener("click", () => {
    elements.prompt.value = button.dataset.prompt ?? "";
    autoSizePrompt();
    saveDraft();
    elements.prompt.focus();
  });
}

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  state.installPrompt = event;
  elements.install.classList.remove("hidden");
});
elements.install.addEventListener("click", async () => {
  if (!state.installPrompt) return;
  await state.installPrompt.prompt();
  state.installPrompt = null;
  elements.install.classList.add("hidden");
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}

connectEvents();
initializeDictation();
void initialize();

function initializeDictation() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    elements.voice.disabled = true;
    elements.voice.title = "이 브라우저는 앱 내 음성 인식을 지원하지 않습니다.";
    $("#voiceHelp").classList.remove("hidden");
    return;
  }

  const recognition = new Recognition();
  recognition.lang = "ko-KR";
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;
  recognition.onstart = () => setDictating(true);
  recognition.onresult = (event) => {
    let interim = "";
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const transcript = event.results[index][0]?.transcript ?? "";
      if (event.results[index].isFinal) state.dictationFinal += transcript;
      else interim += transcript;
    }
    elements.prompt.value = joinDictation(state.dictationBase, state.dictationFinal, interim);
    autoSizePrompt();
    saveDraft();
  };
  recognition.onerror = (event) => {
    if (event.error === "not-allowed" || event.error === "service-not-allowed") {
      showToast("마이크 권한을 허용해 주세요.");
    } else if (event.error !== "no-speech" && event.error !== "aborted") {
      showToast(`음성 인식 오류: ${event.error}`);
    }
  };
  recognition.onend = () => setDictating(false);
  state.recognition = recognition;
}

function toggleDictation() {
  const recognition = state.recognition;
  if (!recognition) return;
  if (elements.voice.getAttribute("aria-pressed") === "true") {
    recognition.stop();
    return;
  }
  state.dictationBase = elements.prompt.value.trim();
  state.dictationFinal = "";
  try {
    recognition.lang = "ko-KR";
    recognition.start();
  } catch (error) {
    showToast(error.message);
  }
}

function setDictating(active) {
  elements.voice.setAttribute("aria-pressed", String(active));
  elements.voice.classList.toggle("listening", active);
  elements.voice.querySelector("small").textContent = active ? "듣는 중" : "한국어";
  elements.voice.setAttribute("aria-label", active ? "음성 입력 중지" : "한국어 음성 입력 시작");
}

function joinDictation(...parts) {
  return parts.map((part) => part.trim()).filter(Boolean).join(" ");
}

async function initialize() {
  elements.reconnect.disabled = true;
  try {
    const [, workspaceData] = await Promise.all([api("/api/health"), api("/api/workspaces")]);
    setConnection("online");
    state.workspaceList = workspaceData.workspaces;
    if (!state.initialized) {
      let active;
      try { active = JSON.parse(stored(sessionStorage, "pocket-active", "null")); } catch {}
      const preferred = active?.cwd || stored(localStorage, "pocket-workspace");
      state.workspacePath = state.workspaceList.find(w => w.path === preferred)?.path || state.workspaceList[0]?.path || "";
      renderWorkspaces();
      restoreDraft();
      await loadThreads(false, active?.threadId || stored(localStorage, `pocket-thread:${state.workspacePath}`));
      await loadSelectedThread();
      if (active?.id && active.cwd === state.workspacePath) {
        state.operation = active;
        setRunning(true, "진행 중인 작업을 확인하고 있습니다…");
      }
      state.initialized = true;
    }
    await syncOperation();
  } catch (error) {
    setConnection("error");
    showToast(error.message);
  } finally { elements.reconnect.disabled = false; }
}

async function loadThreads(preserveSelection, requested = "") {
  const selected = requested || (preserveSelection ? elements.thread.value : "");
  const workspace = state.workspacePath;
  const request = ++state.threadsRequest;
  elements.refresh.disabled = true;
  try {
    const data = await api(`/api/threads?limit=50&cwd=${encodeURIComponent(workspace)}`);
    if (request !== state.threadsRequest || workspace !== state.workspacePath) return;
    const prefix = `${workspace}/`;
    const threads = data.threads.filter(t => t.cwd === workspace || t.cwd.startsWith(prefix));
    elements.thread.replaceChildren(option("", "새 대화"));
    for (const thread of threads) {
      elements.thread.append(option(thread.id, short(thread.name || thread.preview || "제목 없는 대화", 42)));
    }
    if (selected) {
      if (!threads.some(t => t.id === selected)) elements.thread.append(option(selected, "이전 대화 이어가기"));
      elements.thread.value = selected;
    }
  } catch (error) { showToast(error.message); }
  finally { if (request === state.threadsRequest) elements.refresh.disabled = state.submitting || !!state.operation; }
}

async function loadSelectedThread() {
  const threadId = elements.thread.value;
  const request = ++state.historyRequest;
  clearTranscript();
  if (!threadId) return;
  elements.transcript.setAttribute("aria-busy", "true");
  try {
    const data = await api(`/api/threads/${encodeURIComponent(threadId)}`);
    if (request !== state.historyRequest) return;
    for (const turn of data.thread.turns) for (const item of turn.items) renderHistoryItem(item);
    scrollToBottom(true);
  } catch (error) {
    if (request === state.historyRequest) showToast(error.message);
  } finally { if (request === state.historyRequest) elements.transcript.removeAttribute("aria-busy"); }
}

async function submitPrompt() {
  const prompt = elements.prompt.value.trim();
  if (!prompt || state.submitting || state.operation || !state.connected) return;
  const workspace = state.workspacePath;
  if (!workspace) { showToast("프로젝트를 먼저 선택하세요."); return; }
  if (elements.voice.getAttribute("aria-pressed") === "true") state.recognition?.stop();
  saveDraft();
  state.submitting = true;
  state.followOutput = true;
  removeEmptyState();
  addMessage("user", prompt);
  state.liveText = ""; state.latestDiff = "";
  state.liveBubble = addMessage("assistant", "", { pending: true });
  setRunning(true, "요청을 보내고 있습니다…");
  try {
    const data = await api("/api/runs", { method: "POST", body: {
      prompt, cwd: workspace, threadId: elements.thread.value || undefined, networkAccess: elements.network.checked,
    }});
    state.operation = data.operation;
    remember(sessionStorage, "pocket-active", JSON.stringify({id: data.operation.id, cwd: workspace, threadId: data.operation.threadId}));
    selectThread(data.operation.threadId); saveSelection();
    if (elements.prompt.value.trim() === prompt) { elements.prompt.value = ""; saveDraft(); autoSizePrompt(); }
    setRunning(true, "Codex가 작업 중입니다…");
  } catch (error) {
    finishLiveMessage(`전송 결과를 확인하지 못했습니다. 입력은 보관했습니다. 대화 기록을 확인한 뒤 다시 보내세요.\n${error.message}`, true);
    setRunning(false);
  } finally {
    state.submitting = false;
    setRunning(!!state.operation);
  }
  await syncOperation();
}

async function syncOperation() {
  if (state.syncing || !state.operation || state.submitting) return;
  state.syncing = true;
  const id = state.operation.id;
  try {
    const { operation } = await api(`/api/runs/${encodeURIComponent(id)}`);
    if (state.operation?.id !== id) return;
    setConnection("online");
    if (operation.status === "running") { state.operation = operation; setRunning(true, "Codex가 작업 중입니다…"); }
    else handleEvent({type: "operation", action: operation.status === "failed" ? "failed" : "completed", operation});
  } catch (error) {
    if (state.operation?.id !== id) return;
    if (error.status === 404) {
      finishLiveMessage("PC 서버가 재시작되어 실행 상태를 확인할 수 없습니다. 대화 기록을 확인해 주세요.", true);
      setRunning(false);
    } else setConnection("pending");
  } finally { state.syncing = false; }
}

async function stopOperation() {
  if (!state.operation) return;
  elements.stop.disabled = true;
  try {
    await api(`/api/runs/${encodeURIComponent(state.operation.id)}/interrupt`, {
      method: "POST",
      body: {},
    });
    setRunning(true, "중단을 요청했습니다…");
  } catch (error) {
    showToast(error.message);
  } finally {
    elements.stop.disabled = false;
  }
}

function connectEvents() {
  const stream = new EventSource("/api/events");
  stream.onopen = () => { if (state.initialized) void initialize(); };
  stream.onerror = () => {
    setConnection("pending");
    elements.connectionText.textContent = "연결을 복구하는 중…";
  };
  stream.onmessage = (message) => {
    let event;
    try { event = JSON.parse(message.data); } catch { return; }
    handleEvent(event);
  };
}

function handleEvent(event) {
  if (event.type === "connected") return;
  if (event.type === "operation") {
    const operation = event.operation;
    // Only track this tab's acknowledged request, never another client's operation.
    if (!state.operation || operation.id !== state.operation.id) return;
    state.operation = operation;
    if (event.action === "completed") {
      const result = operation.result ?? {};
      finishLiveMessage(result.finalResponse || statusMessage(operation.status), false, result);
      setRunning(false);
      selectThread(result.threadId || operation.threadId);
      saveSelection();
      if (elements.tts.checked && result.finalResponse) speak(result.finalResponse);
      void loadThreads(true);
    } else if (event.action === "failed") {
      finishLiveMessage(`작업 실패: ${operation.error || "알 수 없는 오류"}`, true);
      setRunning(false);
    }
    return;
  }
  if (event.type !== "codex" || !state.operation) return;
  const params = event.params ?? {};
  if (params.turnId && params.turnId !== state.operation.turnId) return;
  switch (event.method) {
    case "item/agentMessage/delta":
      state.liveText += params.delta ?? "";
      updateLiveText(state.liveText);
      setRunning(true, "Codex가 답변을 작성하고 있습니다…");
      break;
    case "item/started":
      if (params.item?.type === "commandExecution") {
        setRunning(true, "명령을 실행하고 있습니다…", params.item.command);
      } else if (params.item?.type === "fileChange") {
        setRunning(true, "파일 변경을 적용하고 있습니다…", (params.item.paths ?? []).join("\n"));
      }
      break;
    case "item/completed":
      if (params.item?.type === "commandExecution") {
        setRunning(true, `명령 완료 · ${params.item.status ?? "처리됨"}`, params.item.command);
      }
      break;
    case "turn/diff/updated":
      state.latestDiff = params.diff ?? "";
      setRunning(true, "변경 내용을 검토하고 있습니다…");
      break;
  }
}

function renderHistoryItem(item) {
  if (item.type === "userMessage" && item.text) addMessage("user", item.text);
  if (item.type === "agentMessage" && item.text) addMessage("assistant", item.text);
  if (item.type === "commandExecution") addActivityMessage(`$ ${item.command}\n${item.output || ""}`);
  if (item.type === "fileChange") {
    const text = item.changes.map((change) => `${change.kind}: ${change.path}`).join("\n");
    addActivityMessage(text);
  }
}

function addMessage(role, text, options = {}) {
  removeEmptyState();
  const article = document.createElement("article");
  article.className = `message ${role}${options.pending ? " pending" : ""}`;
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  const label = document.createElement("div");
  label.className = "message-label";
  label.textContent = role === "user" ? "나" : "Codex";
  const paragraph = document.createElement("p");
  paragraph.className = "message-text";
  paragraph.textContent = text;
  bubble.append(label, paragraph);
  const copy = document.createElement("button");
  copy.type = "button"; copy.className = "copy-button"; copy.textContent = "복사";
  copy.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(paragraph.textContent); showToast("복사했습니다."); }
    catch { showToast("복사 권한이 없습니다. 답변을 길게 눌러 복사해 주세요."); }
  });
  bubble.append(copy);
  article.append(bubble);
  elements.transcript.append(article);
  scrollToBottom();
  return article;
}

function addActivityMessage(text) {
  if (!text.trim()) return;
  const article = addMessage("assistant", "작업 기록");
  const details = document.createElement("details");
  details.className = "details";
  const summary = document.createElement("summary");
  summary.textContent = "명령·파일 변경 보기";
  const pre = document.createElement("pre");
  pre.textContent = text;
  details.append(summary, pre);
  article.querySelector(".bubble").append(details);
}

function updateLiveText(text) {
  if (!state.liveBubble) state.liveBubble = addMessage("assistant", "", { pending: true });
  state.liveBubble.querySelector(".message-text").textContent = text;
  scrollToBottom();
}

function finishLiveMessage(text, isError, result = {}) {
  if (!state.liveBubble) state.liveBubble = addMessage("assistant", text);
  state.liveBubble.classList.remove("pending");
  if (isError) state.liveBubble.classList.add("error");
  state.liveBubble.querySelector(".message-text").textContent = text;
  const detailText = buildResultDetails(result);
  if (detailText) {
    const details = document.createElement("details");
    details.className = "details";
    const summary = document.createElement("summary");
    summary.textContent = "변경 파일과 명령 보기";
    const pre = document.createElement("pre");
    pre.textContent = detailText;
    details.append(summary, pre);
    state.liveBubble.querySelector(".bubble").append(details);
  }
  state.liveBubble = null;
  state.liveText = "";
  state.operation = null;
  remember(sessionStorage, "pocket-active", null);
  scrollToBottom();
}

function buildResultDetails(result) {
  const lines = [];
  for (const command of result.commands ?? []) {
    lines.push(`$ ${command.command}\n  ${command.status}${command.exitCode == null ? "" : ` · exit ${command.exitCode}`}`);
  }
  for (const fileChange of result.fileChanges ?? []) {
    for (const change of fileChange.changes ?? []) lines.push(`${change.kind}: ${change.path}`);
  }
  if (state.latestDiff) lines.push(`\n--- diff ---\n${state.latestDiff}`);
  return lines.join("\n");
}

function clearTranscript() {
  state.followOutput = true;
  for (const child of [...elements.transcript.children]) {
    if (child !== elements.empty) child.remove();
  }
  elements.empty.classList.remove("hidden");
}

function removeEmptyState() { elements.empty.classList.add("hidden"); }

function setRunning(running, text = "", detail = "") {
  elements.send.disabled = running || !state.connected;
  elements.refresh.disabled = running;
  elements.newThread.disabled = running;
  elements.search.disabled = running;
  elements.stop.disabled = running && !state.operation;
  elements.thread.disabled = running;
  elements.workspace.disabled = running;
  elements.activity.classList.toggle("hidden", !running);
  if (text) elements.activityText.textContent = text;
  elements.activityDetail.textContent = detail || "";
}

function setConnection(status) {
  state.connected = status === "online";
  elements.connectionDot.className = `status-dot ${status}`;
  elements.connectionText.textContent = state.connected ? "PC 연결됨" : status === "pending" ? "연결 복구 중 · 입력은 보관됩니다" : "PC 연결 안 됨";
  elements.connectionHelp.classList.toggle("hidden", state.connected);
  elements.send.disabled = !state.connected || state.submitting || !!state.operation;
}

function selectThread(threadId) {
  if (!threadId) return;
  if (![...elements.thread.options].some(item => item.value === threadId)) elements.thread.append(option(threadId, "현재 대화"));
  elements.thread.value = threadId;
}

function speak(text) {
  if (!("speechSynthesis" in window)) return;
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text.slice(0, 4000));
  utterance.lang = "ko-KR";
  utterance.rate = 1.03;
  const korean = speechSynthesis.getVoices().find((voice) => voice.lang.toLowerCase().startsWith("ko"));
  if (korean) utterance.voice = korean;
  speechSynthesis.speak(utterance);
}

async function api(path, options = {}) {
  const init = { method: options.method ?? "GET", headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15000) };
  if (options.body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }
  const response = await fetch(path, init);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(data.error || `HTTP ${response.status}`); error.status = response.status; throw error; }
  return data;
}

function option(value, label) {
  const item = document.createElement("option");
  item.value = value;
  item.textContent = label;
  return item;
}

function autoSizePrompt() {
  elements.prompt.style.height = "auto";
  elements.prompt.style.height = `${Math.min(elements.prompt.scrollHeight, 160)}px`;
}

function scrollToBottom(force = false) {
  if (!force && !state.followOutput) return;
  requestAnimationFrame(() => elements.transcript.scrollTo({ top: elements.transcript.scrollHeight, behavior: "smooth" }));
}

let toastTimer;
function showToast(text) {
  clearTimeout(toastTimer);
  elements.toast.textContent = text;
  elements.toast.classList.remove("hidden");
  toastTimer = setTimeout(() => elements.toast.classList.add("hidden"), 4000);
}

function short(text, length) { return text.length <= length ? text : `${text.slice(0, length - 1)}…`; }
function statusMessage(status) {
  if (status === "interrupted") return "작업이 중단되었습니다.";
  if (status === "failed") return "작업이 실패했습니다.";
  return "작업이 완료되었습니다.";
}
