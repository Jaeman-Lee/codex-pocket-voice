import assert from "node:assert/strict";
import test from "node:test";
import {
  applySpeechGlossary,
  appendSpeechGlossaryEntry,
  createSpeechGlossaryEntry,
  MAX_SPEECH_GLOSSARY_ENTRIES,
  parseSpeechGlossaryEntries,
  speechGlossaryHints,
  type SpeechGlossaryEntry,
} from "../client/src/speech-glossary.js";

const entry = (id: string, spoken: string, replacement: string): SpeechGlossaryEntry => ({ id, spoken, replacement });

test("project glossary corrects complete speech phrases with longest match first", () => {
  const entries = [
    entry("short", "오픈", "OPEN"),
    entry("router", "오픈 라우터", "OpenRouter"),
    entry("codex", "코덱스 포켓", "Codex Pocket"),
  ];
  assert.equal(
    applySpeechGlossary("오픈 라우터 연동과 코덱스 포켓 화면", entries),
    "OpenRouter 연동과 Codex Pocket 화면",
  );
});

test("project glossary is boundary-aware, case-insensitive, and does not chain replacements", () => {
  const entries = [
    entry("alias", "router alias", "OpenRouter"),
    entry("spoken", "오픈 라우터", "router alias"),
    entry("api", "에이피아이", "API"),
  ];
  assert.equal(applySpeechGlossary("오픈 라우터 에이피아이", entries), "router alias API");
  assert.equal(applySpeechGlossary("앞에이피아이뒤", entries), "앞에이피아이뒤");
  assert.equal(applySpeechGlossary("ROUTER ALIAS", entries), "OpenRouter");
});

test("project glossary normalizes bounded entries and rejects duplicates or extra fields", () => {
  const created = createSpeechGlossaryEntry("  오픈   라우터  ", " OpenRouter ", "term-1");
  assert.deepEqual(created, entry("term-1", "오픈 라우터", "OpenRouter"));
  assert.throws(() => appendSpeechGlossaryEntry([created], entry("term-2", "오픈 라우터", "다른 값")), /이미/);
  assert.equal(parseSpeechGlossaryEntries([{ ...created, leaked: "value" }]), null);
  assert.equal(parseSpeechGlossaryEntries([created, { ...created, id: "term-2" }]), null);

  let entries: SpeechGlossaryEntry[] = [];
  for (let index = 0; index < MAX_SPEECH_GLOSSARY_ENTRIES; index += 1) {
    entries = appendSpeechGlossaryEntry(entries, entry(`term-${index}`, `말 ${index}`, `term_${index}`));
  }
  assert.throws(() => appendSpeechGlossaryEntry(entries, entry("overflow", "초과", "overflow")), /최대/);
});

test("native recognition hints expose only unique reviewed replacements", () => {
  assert.deepEqual(speechGlossaryHints([
    entry("one", "오픈 라우터", "OpenRouter"),
    entry("two", "오픈라우터", "OpenRouter"),
    entry("three", "코덱스", "Codex"),
  ]), ["OpenRouter", "Codex"]);
});
