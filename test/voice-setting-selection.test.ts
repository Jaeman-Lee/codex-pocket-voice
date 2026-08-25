import assert from "node:assert/strict";
import test from "node:test";
import {
  initialVoiceSettingState,
  MAX_VOICE_SETTING_CANDIDATES,
  MAX_VOICE_SETTING_TRANSCRIPT_LENGTH,
  parseVoiceSettingCommand,
  reduceVoiceSetting,
  voiceSettingCatalog,
  voiceSettingOwnerMatches,
  type VoiceSettingCatalog,
  type VoiceSettingOwner,
} from "../client/src/voice-setting-selection.js";
import type { ModelOption, ProviderOption, Workspace } from "../client/src/types.js";

const workspace = (path: string, name: string): Workspace => ({ path, name });
const model = (id: string, displayName: string): ModelOption => ({
  id,
  displayName,
  description: "",
  isDefault: false,
  defaultEffort: "",
  efforts: [],
});
const provider = (id: string, name: string, available = true): ProviderOption => ({
  id,
  name,
  available,
  status: available ? "connected" : "login_required",
  detail: "",
  accounts: [],
  loginCommand: "",
  installed: true,
  canLogin: false,
  canTest: false,
  capabilities: { run: true, resume: false, models: true, attachments: false },
  installGuide: { summary: "", command: "", docsUrl: "" },
});

const catalog = voiceSettingCatalog(
  [workspace("/work/stock-explorer", "주식 탐색기")],
  [provider("codex", "OpenAI Codex"), provider("openrouter", "OpenRouter"), provider("offline", "Offline", false)],
  [model("gpt-5.6-codex", "GPT 5.6 Codex")],
);

test("voice setting commands require one strict selector command and exact reviewed aliases", () => {
  assert.deepEqual(parseVoiceSettingCommand("프로젝트 주식 탐색기 선택", catalog), {
    status: "match",
    proposal: { kind: "workspace", targetId: "/work/stock-explorer", targetLabel: "주식 탐색기", transcript: "프로젝트 주식 탐색기 선택" },
  });
  assert.equal(parseVoiceSettingCommand("AI 연결 오픈 라우터 변경해 줘", catalog).status, "match");
  assert.equal(parseVoiceSettingCommand("model GPT-5.6 Codex switch", catalog).status, "match");
  assert.equal(parseVoiceSettingCommand("오픈 라우터로 바꿔", catalog).status, "error");
  assert.equal(parseVoiceSettingCommand("프로젝트 주식 선택 모델 GPT 5.6 Codex 선택", catalog).status, "error");
  assert.equal(parseVoiceSettingCommand("AI 연결 Offline 선택", catalog).status, "error");
});

test("voice setting commands never guess unknown or ambiguous names", () => {
  const ambiguous: VoiceSettingCatalog = {
    workspace: [
      { id: "/one/app", label: "app", aliases: ["app"] },
      { id: "/two/app", label: "app", aliases: ["app"] },
    ],
    provider: [],
    model: [],
  };
  const duplicate = parseVoiceSettingCommand("프로젝트 app 선택", ambiguous);
  assert.equal(duplicate.status, "error");
  if (duplicate.status === "error") assert.match(duplicate.message, /여러 개/);
  assert.equal(parseVoiceSettingCommand("프로젝트 ap 선택", ambiguous).status, "error");
  assert.equal(parseVoiceSettingCommand(`모델 ${"가".repeat(MAX_VOICE_SETTING_TRANSCRIPT_LENGTH + 1)} 선택`, catalog).status, "error");

  const oversized: VoiceSettingCatalog = {
    workspace: Array.from({ length: MAX_VOICE_SETTING_CANDIDATES + 1 }, (_, index) => ({
      id: String(index), label: String(index), aliases: [String(index)],
    })),
    provider: [],
    model: [],
  };
  assert.equal(parseVoiceSettingCommand("프로젝트 0 선택", oversized).status, "error");
});

test("voice setting review is inert until apply begins and stale owners do not match", () => {
  const owner: VoiceSettingOwner = { device: "pc", workspace: "/one", provider: "codex", model: "" };
  const listening = reduceVoiceSetting(initialVoiceSettingState, { type: "start", owner });
  const result = parseVoiceSettingCommand("AI 연결 오픈 라우터 선택", catalog);
  const review = reduceVoiceSetting(listening, { type: "review", result });
  assert.equal(review.phase, "review");
  assert.equal(review.applying, false);
  assert.equal(review.proposal?.targetId, "openrouter");
  assert.equal(reduceVoiceSetting(review, { type: "apply_begin" }).applying, true);
  assert.equal(voiceSettingOwnerMatches(owner, owner), true);
  assert.equal(voiceSettingOwnerMatches(owner, { ...owner, workspace: "/two" }), false);
  assert.deepEqual(reduceVoiceSetting(review, { type: "reset" }), initialVoiceSettingState);
});
