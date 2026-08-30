export type UiLanguage = "ko" | "en";

const messages = {
  ko: {
    target: "실행 단말", provider: "AI 연결", project: "프로젝트", conversation: "대화",
    noProject: "프로젝트 없음", newConversation: "새 대화", unnamed: "제목 없는 대화",
    emptyTitle: "말하고, 확인하고, 실행하세요.", emptyBody: "음성 버튼으로 말한 뒤 전송하면 선택한 단말의 AI가 프로젝트에서 작업합니다.",
    statusPrompt: "현재 상태 확인", testPrompt: "테스트 실행·수정", account: "계정", model: "모델", performance: "성능",
    automatic: "자동", default: "기본", attachment: "첨부", readAnswer: "답변 읽기", network: "네트워크",
    send: "보내기", queue: "대기열", safeNote: "허용된 폴더만 수정 · 대화와 대기열은 암호화 로컬 저장",
    speechPlaceholder: "말하거나 직접 입력하세요", listening: "듣는 중", continuous: "연속 중", speech: "음성",
    speechHelp: "짧게 누르기 · 길게 눌러 연속", speechActive: "계속 듣는 중 · 마이크를 누르면 종료",
    uiLanguage: "화면 언어", speechLanguage: "음성 인식 언어", diagnostics: "Linux 진단",
    connected: "사용 가능", missing: "없음", required: "필수", optional: "선택",
  },
  en: {
    target: "Run on", provider: "AI provider", project: "Project", conversation: "Conversation",
    noProject: "No projects", newConversation: "New conversation", unnamed: "Untitled conversation",
    emptyTitle: "Speak, review, and run.", emptyBody: "Dictate or type a request and the selected device will work in the chosen project.",
    statusPrompt: "Check project status", testPrompt: "Run and fix tests", account: "Account", model: "Model", performance: "Reasoning",
    automatic: "Automatic", default: "Default", attachment: "Attach", readAnswer: "Read answer", network: "Network",
    send: "Send", queue: "Queue", safeNote: "Only allowed folders can change · local history and queues are encrypted",
    speechPlaceholder: "Speak or type a request", listening: "Listening", continuous: "Continuous", speech: "Voice",
    speechHelp: "Tap to dictate · hold for continuous", speechActive: "Listening continuously · tap the mic to stop",
    uiLanguage: "Display language", speechLanguage: "Speech language", diagnostics: "Linux diagnostics",
    connected: "Available", missing: "Missing", required: "Required", optional: "Optional",
  },
} as const;

export type MessageKey = keyof typeof messages.ko;

export function translate(language: UiLanguage, key: MessageKey): string {
  return messages[language][key];
}

export function initialUiLanguage(): UiLanguage {
  const stored = localStorage.getItem("codex-pocket-ui-language");
  if (stored === "ko" || stored === "en") return stored;
  return navigator.language.toLowerCase().startsWith("ko") ? "ko" : "en";
}

export function initialSpeechLanguage(): string {
  return localStorage.getItem("codex-pocket-speech-language") || navigator.language || "en-US";
}
