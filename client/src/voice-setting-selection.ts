import type { ModelOption, ProviderId, ProviderOption, Workspace } from "./types";

export const MAX_VOICE_SETTING_TRANSCRIPT_LENGTH = 240;
export const MAX_VOICE_SETTING_CANDIDATES = 128;
export const MAX_VOICE_SETTING_HINTS = 32;

export type VoiceSettingKind = "workspace" | "provider" | "model";

export interface VoiceSettingCandidate {
  id: string;
  label: string;
  aliases: string[];
}

export interface VoiceSettingCatalog {
  workspace: VoiceSettingCandidate[];
  provider: VoiceSettingCandidate[];
  model: VoiceSettingCandidate[];
}

export interface VoiceSettingProposal {
  kind: VoiceSettingKind;
  targetId: string;
  targetLabel: string;
  transcript: string;
}

export type VoiceSettingParseResult =
  | { status: "match"; proposal: VoiceSettingProposal }
  | { status: "error"; transcript: string; message: string };

export interface VoiceSettingOwner {
  device: string;
  workspace: string;
  provider: ProviderId;
  model: string;
}

export interface VoiceSettingState {
  phase: "idle" | "listening" | "review";
  transcript: string;
  error: string;
  proposal: VoiceSettingProposal | null;
  owner: VoiceSettingOwner | null;
  applying: boolean;
}

export type VoiceSettingAction =
  | { type: "start"; owner: VoiceSettingOwner }
  | { type: "transcript"; transcript: string }
  | { type: "review"; result: VoiceSettingParseResult }
  | { type: "invalidate"; message: string }
  | { type: "apply_begin" }
  | { type: "apply_failed"; message: string }
  | { type: "reset" };

export const initialVoiceSettingState: VoiceSettingState = {
  phase: "idle",
  transcript: "",
  error: "",
  proposal: null,
  owner: null,
  applying: false,
};

export function reduceVoiceSetting(
  state: VoiceSettingState,
  action: VoiceSettingAction,
): VoiceSettingState {
  switch (action.type) {
    case "start":
      if (state.applying) return state;
      return { phase: "listening", transcript: "", error: "", proposal: null, owner: action.owner, applying: false };
    case "transcript":
      return state.phase === "listening" ? { ...state, transcript: boundedTranscript(action.transcript) } : state;
    case "review":
      if (state.phase !== "listening") return state;
      return action.result.status === "match"
        ? { ...state, phase: "review", transcript: action.result.proposal.transcript, error: "", proposal: action.result.proposal }
        : { ...state, phase: "review", transcript: action.result.transcript, error: action.result.message, proposal: null };
    case "invalidate":
      return state.phase === "idle"
        ? state
        : { ...state, phase: "review", error: action.message, proposal: null, applying: false };
    case "apply_begin":
      return state.phase === "review" && state.proposal && !state.applying
        ? { ...state, applying: true, error: "" }
        : state;
    case "apply_failed":
      return state.phase === "review" ? { ...state, applying: false, error: action.message } : state;
    case "reset":
      return initialVoiceSettingState;
  }
}

export function voiceSettingCatalog(
  workspaces: readonly Workspace[],
  providers: readonly ProviderOption[],
  models: readonly ModelOption[],
): VoiceSettingCatalog {
  return {
    workspace: workspaces.slice(0, MAX_VOICE_SETTING_CANDIDATES).map((item) => ({
      id: item.path,
      label: item.name,
      aliases: uniqueAliases([item.name, basename(item.path)]),
    })),
    provider: providers
      .filter((item) => item.available)
      .slice(0, MAX_VOICE_SETTING_CANDIDATES)
      .map((item) => ({
        id: item.id,
        label: item.name,
        aliases: uniqueAliases([item.id, item.name, ...knownProviderAliases(item.id)]),
      })),
    model: models.slice(0, MAX_VOICE_SETTING_CANDIDATES).map((item) => ({
      id: item.id,
      label: item.displayName,
      aliases: uniqueAliases([item.id, item.displayName]),
    })),
  };
}

export function voiceSettingHints(catalog: VoiceSettingCatalog): string[] {
  return uniqueAliases([
    ...catalog.workspace.map((item) => item.label),
    ...catalog.provider.map((item) => item.label),
    ...catalog.model.map((item) => item.label),
  ]).slice(0, MAX_VOICE_SETTING_HINTS);
}

export function parseVoiceSettingCommand(
  input: string,
  catalog: VoiceSettingCatalog,
): VoiceSettingParseResult {
  const transcript = boundedTranscript(input);
  if (!transcript) return parseError(transcript, "명령을 듣지 못했습니다. 예시 형식으로 다시 말해 주세요.");
  if (input.length > MAX_VOICE_SETTING_TRANSCRIPT_LENGTH) {
    return parseError(transcript, "설정 명령이 너무 깁니다. 한 가지 설정만 짧게 말해 주세요.");
  }

  const command = commandParts(transcript);
  if (!command) {
    return parseError(transcript, "‘프로젝트 이름 선택’, ‘AI 연결 이름 선택’, ‘모델 이름 선택’ 형식으로 말해 주세요.");
  }
  const candidates = catalog[command.kind];
  if (candidates.length > MAX_VOICE_SETTING_CANDIDATES) {
    return parseError(transcript, "선택 목록이 너무 커서 음성 설정을 사용할 수 없습니다. 화면에서 선택해 주세요.");
  }
  const targetKey = spokenKey(command.target);
  const matches = candidates.filter((candidate) => candidate.aliases.some((alias) => spokenKey(alias) === targetKey));
  if (matches.length === 0) {
    return parseError(transcript, `${kindLabel(command.kind)} 이름이 현재 선택 목록과 정확히 일치하지 않습니다.`);
  }
  const distinct = [...new Map(matches.map((candidate) => [candidate.id, candidate])).values()];
  if (distinct.length !== 1) {
    return parseError(transcript, `같은 이름의 ${kindLabel(command.kind)}이 여러 개입니다. 화면에서 직접 선택해 주세요.`);
  }
  const target = distinct[0]!;
  return {
    status: "match",
    proposal: {
      kind: command.kind,
      targetId: target.id,
      targetLabel: target.label,
      transcript,
    },
  };
}

export function voiceSettingOwnerMatches(
  owner: VoiceSettingOwner,
  current: VoiceSettingOwner,
): boolean {
  return owner.device === current.device
    && owner.workspace === current.workspace
    && owner.provider === current.provider
    && owner.model === current.model;
}

function commandParts(transcript: string): { kind: VoiceSettingKind; target: string } | null {
  const korean = transcript.match(
    /^(프로젝트|작업\s*공간|워크\s*스페이스|AI\s*연결|에이\s*아이\s*연결|제공자|프로바이더|모델)\s+(.+?)\s+(선택|변경|전환)(?:\s*(?:해\s*줘|해\s*주세요|해주세요|해줘|할게|할래))?[.!?。！？]?$/iu,
  );
  if (korean) return { kind: commandKind(korean[1]!), target: korean[2]!.trim() };
  const english = transcript.match(/^(project|workspace|provider|connection|model)\s+(.+?)\s+(select|change|switch)[.!?]?$/iu);
  if (english) return { kind: commandKind(english[1]!), target: english[2]!.trim() };
  return null;
}

function commandKind(prefix: string): VoiceSettingKind {
  const key = spokenKey(prefix);
  if (["프로젝트", "작업공간", "워크스페이스", "project", "workspace"].includes(key)) return "workspace";
  if (["모델", "model"].includes(key)) return "model";
  return "provider";
}

function kindLabel(kind: VoiceSettingKind): string {
  if (kind === "workspace") return "프로젝트";
  if (kind === "provider") return "AI 연결";
  return "모델";
}

function parseError(transcript: string, message: string): VoiceSettingParseResult {
  return { status: "error", transcript, message };
}

function boundedTranscript(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_VOICE_SETTING_TRANSCRIPT_LENGTH);
}

function spokenKey(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, "");
}

function uniqueAliases(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of values) {
    const value = raw.replace(/\s+/g, " ").trim();
    const key = spokenKey(value);
    if (!value || !key || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function basename(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? path;
}

function knownProviderAliases(provider: ProviderId): string[] {
  switch (provider) {
    case "codex":
      return ["코덱스", "오픈AI 코덱스", "오픈에이아이 코덱스", "OpenAI Codex"];
    case "openai":
      return ["오픈AI", "오픈에이아이", "오픈AI API", "오픈에이아이 API", "OpenAI API"];
    case "openrouter":
      return ["오픈라우터", "오픈 라우터", "Open Router"];
    case "claude":
      return ["클로드", "클로드 코드", "Claude Code"];
    default:
      return [];
  }
}
