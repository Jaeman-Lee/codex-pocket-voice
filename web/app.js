const $ = (selector) => document.querySelector(selector);

const elements = {
  connectionText: $("#connectionText"),
  connectionDot: $("#connectionDot"),
  workspace: $("#workspaceSelect"),
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
  liveBubble: null,
  liveText: "",
  latestDiff: "",
  installPrompt: null,
  recognition: null,
  dictationBase: "",
  dictationFinal: "",
};

elements.tts.checked = localStorage.getItem("codex-pocket-tts") === "true";
elements.tts.addEventListener("change", () => localStorage.setItem("codex-pocket-tts", String(elements.tts.checked)));
elements.send.addEventListener("click", submitPrompt);
elements.stop.addEventListener("click", stopOperation);
elements.refresh.addEventListener("click", () => loadThreads(true));
elements.thread.addEventListener("change", loadSelectedThread);
elements.workspace.addEventListener("change", () => loadThreads(false));
elements.prompt.addEventListener("input", autoSizePrompt);
elements.voice.addEventListener("click", toggleDictation);
elements.prompt.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    void submitPrompt();
  }
});

for (const button of document.querySelectorAll("[data-prompt]")) {
  button.addEventListener("click", () => {
    elements.prompt.value = button.dataset.prompt ?? "";
    autoSizePrompt();
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
  try {
    const [health, workspaceData] = await Promise.all([api("/api/health"), api("/api/workspaces")]);
    elements.connectionText.textContent = `${health.userAgent} · 안전 연결`;
    setConnection("online");
    elements.workspace.replaceChildren(
      ...workspaceData.workspaces.map((workspace) => option(workspace.path, workspace.name)),
    );
    await loadThreads(false);
  } catch (error) {
    setConnection("error");
    elements.connectionText.textContent = "PC 연결 실패";
    showToast(error.message);
  }
}

async function loadThreads(preserveSelection) {
  const selected = preserveSelection ? elements.thread.value : "";
  elements.refresh.disabled = true;
  try {
    const data = await api("/api/threads?limit=30");
    const workspace = elements.workspace.value;
    const prefix = workspace.endsWith("/") ? workspace : `${workspace}/`;
    const threads = data.threads.filter(
      (thread) => !workspace || thread.cwd === workspace || thread.cwd.startsWith(prefix),
    );
    elements.thread.replaceChildren(option("", "새 대화"));
    for (const thread of threads) {
      const title = thread.name || thread.preview || "제목 없는 대화";
      elements.thread.append(option(thread.id, short(title, 42)));
    }
    if (selected && threads.some((thread) => thread.id === selected)) elements.thread.value = selected;
  } catch (error) {
    showToast(error.message);
  } finally {
    elements.refresh.disabled = false;
  }
}

async function loadSelectedThread() {
  const threadId = elements.thread.value;
  clearTranscript();
  if (!threadId) return;
  elements.transcript.setAttribute("aria-busy", "true");
  try {
    const data = await api(`/api/threads/${encodeURIComponent(threadId)}`);
    for (const turn of data.thread.turns) {
      for (const item of turn.items) renderHistoryItem(item);
    }
    scrollToBottom();
  } catch (error) {
    showToast(error.message);
  } finally {
    elements.transcript.removeAttribute("aria-busy");
  }
}

async function submitPrompt() {
  const prompt = elements.prompt.value.trim();
  if (!prompt || state.operation?.status === "running") return;
  const workspace = elements.workspace.value;
  if (!workspace) {
    showToast("프로젝트를 먼저 선택하세요.");
    return;
  }

  removeEmptyState();
  addMessage("user", prompt);
  state.liveText = "";
  state.latestDiff = "";
  state.liveBubble = addMessage("assistant", "", { pending: true });
  setRunning(true, "Codex가 요청을 시작하고 있습니다…");
  elements.prompt.value = "";
  autoSizePrompt();

  try {
    const data = await api("/api/runs", {
      method: "POST",
      body: {
        prompt,
        cwd: workspace,
        threadId: elements.thread.value || undefined,
        networkAccess: elements.network.checked,
      },
    });
    state.operation = data.operation;
    setRunning(true, "Codex가 프로젝트를 살펴보고 있습니다…");
  } catch (error) {
    finishLiveMessage(`실행하지 못했습니다: ${error.message}`, true);
    setRunning(false);
  }
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
  stream.onopen = () => setConnection("online");
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
    if (event.action === "started" && !state.operation) state.operation = operation;
    if (!state.operation || operation.id !== state.operation.id) return;
    state.operation = operation;
    if (event.action === "completed") {
      const result = operation.result ?? {};
      finishLiveMessage(result.finalResponse || statusMessage(operation.status), false, result);
      setRunning(false);
      if (result.threadId) selectThread(result.threadId);
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
  for (const child of [...elements.transcript.children]) {
    if (child !== elements.empty) child.remove();
  }
  elements.empty.classList.remove("hidden");
}

function removeEmptyState() { elements.empty.classList.add("hidden"); }

function setRunning(running, text = "", detail = "") {
  elements.send.disabled = running;
  elements.thread.disabled = running;
  elements.workspace.disabled = running;
  elements.activity.classList.toggle("hidden", !running);
  if (text) elements.activityText.textContent = text;
  elements.activityDetail.textContent = detail || "";
}

function setConnection(status) {
  elements.connectionDot.className = `status-dot ${status}`;
  if (status === "online" && elements.connectionText.textContent.includes("복구")) {
    elements.connectionText.textContent = "PC와 안전하게 연결됨";
  }
}

function selectThread(threadId) {
  if ([...elements.thread.options].some((item) => item.value === threadId)) elements.thread.value = threadId;
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
  const init = { method: options.method ?? "GET", headers: { Accept: "application/json" } };
  if (options.body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }
  const response = await fetch(path, init);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
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

function scrollToBottom() {
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
