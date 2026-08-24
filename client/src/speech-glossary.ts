export const MAX_SPEECH_GLOSSARY_ENTRIES = 32;
export const MAX_SPEECH_GLOSSARY_SPOKEN_LENGTH = 80;
export const MAX_SPEECH_GLOSSARY_REPLACEMENT_LENGTH = 120;

export interface SpeechGlossaryEntry {
  id: string;
  spoken: string;
  replacement: string;
}

const ENTRY_ID = /^[a-zA-Z0-9-]{1,64}$/;
const WORD_CHARACTER = "\\p{L}\\p{N}_";

export function createSpeechGlossaryEntry(
  spokenInput: string,
  replacementInput: string,
  id: string = crypto.randomUUID(),
): SpeechGlossaryEntry {
  const spoken = normalizeGlossaryText(spokenInput);
  const replacement = normalizeGlossaryText(replacementInput);
  if (!ENTRY_ID.test(id)) throw new Error("용어 사전 항목 ID가 올바르지 않습니다.");
  if (!spoken || spoken.length > MAX_SPEECH_GLOSSARY_SPOKEN_LENGTH) {
    throw new Error(`인식되는 말은 1~${MAX_SPEECH_GLOSSARY_SPOKEN_LENGTH}자로 입력해 주세요.`);
  }
  if (!replacement || replacement.length > MAX_SPEECH_GLOSSARY_REPLACEMENT_LENGTH) {
    throw new Error(`바꿀 표기는 1~${MAX_SPEECH_GLOSSARY_REPLACEMENT_LENGTH}자로 입력해 주세요.`);
  }
  return { id, spoken, replacement };
}

export function appendSpeechGlossaryEntry(
  entries: readonly SpeechGlossaryEntry[],
  entry: SpeechGlossaryEntry,
): SpeechGlossaryEntry[] {
  if (entries.length >= MAX_SPEECH_GLOSSARY_ENTRIES) {
    throw new Error(`프로젝트 용어는 최대 ${MAX_SPEECH_GLOSSARY_ENTRIES}개까지 저장할 수 있습니다.`);
  }
  const duplicate = entries.some((item) => glossaryKey(item.spoken) === glossaryKey(entry.spoken));
  if (duplicate) throw new Error("같은 인식 표현이 이미 등록되어 있습니다.");
  return [...entries, entry];
}

export function parseSpeechGlossaryEntries(value: unknown): SpeechGlossaryEntry[] | null {
  if (!Array.isArray(value) || value.length > MAX_SPEECH_GLOSSARY_ENTRIES) return null;
  const entries: SpeechGlossaryEntry[] = [];
  const spoken = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const record = item as Record<string, unknown>;
    if (Object.keys(record).some((key) => key !== "id" && key !== "spoken" && key !== "replacement")) return null;
    if (typeof record.id !== "string" || typeof record.spoken !== "string" || typeof record.replacement !== "string") {
      return null;
    }
    let entry: SpeechGlossaryEntry;
    try {
      entry = createSpeechGlossaryEntry(record.spoken, record.replacement, record.id);
    } catch {
      return null;
    }
    if (entry.spoken !== record.spoken || entry.replacement !== record.replacement) return null;
    const key = glossaryKey(entry.spoken);
    if (spoken.has(key)) return null;
    spoken.add(key);
    entries.push(entry);
  }
  return entries;
}

export function applySpeechGlossary(
  transcript: string,
  entries: readonly SpeechGlossaryEntry[],
): string {
  if (!transcript || entries.length === 0) return transcript;
  const replacements = new Map(entries.map((entry) => [glossaryKey(entry.spoken), entry.replacement]));
  const alternatives = [...entries]
    .sort((left, right) => right.spoken.length - left.spoken.length)
    .map((entry) => escapeRegExp(entry.spoken));
  const expression = new RegExp(
    `(^|[^${WORD_CHARACTER}])(${alternatives.join("|")})(?=$|[^${WORD_CHARACTER}])`,
    "giu",
  );
  return transcript.replace(expression, (_match, prefix: string, spoken: string) => (
    `${prefix}${replacements.get(glossaryKey(spoken)) ?? spoken}`
  ));
}

export function speechGlossaryHints(entries: readonly SpeechGlossaryEntry[]): string[] {
  return [...new Set(entries.map((entry) => entry.replacement))].slice(0, MAX_SPEECH_GLOSSARY_ENTRIES);
}

function normalizeGlossaryText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
}

function glossaryKey(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
