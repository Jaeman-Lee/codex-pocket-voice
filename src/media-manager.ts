import { createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const IMAGE_TYPES = new Map([
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"],
  ["image/gif", ".gif"],
]);
const VIDEO_TYPES = new Map([
  ["video/mp4", ".mp4"],
  ["video/webm", ".webm"],
  ["video/quicktime", ".mov"],
  ["video/x-matroska", ".mkv"],
]);
const DEFAULT_MAX_BYTES = 200 * 1024 * 1024;
const MAX_MEDIA_AGE_MS = 24 * 60 * 60_000;

export type MediaKind = "image" | "video";
export type MediaStatus = "uploaded" | "queued" | "analyzing" | "ready" | "failed";

export interface VideoTimelineItem {
  timestamp: number;
  observation: string;
  screenText?: string;
}

export interface VideoAnalysis {
  summary: string;
  timeline: VideoTimelineItem[];
  issues: string[];
  model: string;
  durationSeconds: number;
}

export interface MediaRecord {
  id: string;
  name: string;
  kind: MediaKind;
  mimeType: string;
  size: number;
  status: MediaStatus;
  createdAt: string;
  path: string;
  frames: string[];
  analysis?: VideoAnalysis;
  error?: string;
}

export interface PublicMediaRecord extends Omit<MediaRecord, "path" | "frames"> {
  frameCount: number;
}

export interface MediaManagerOptions {
  rootDir?: string;
  maxBytes?: number;
  ollamaUrl?: string;
  model?: string;
  onUpdate?: (media: PublicMediaRecord) => void;
}

export class MediaError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

export class MediaManager {
  readonly rootDir: string;
  readonly maxBytes: number;
  readonly ollamaUrl: string;
  readonly model: string;
  private readonly records = new Map<string, MediaRecord>();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly options: MediaManagerOptions = {}) {
    this.rootDir = options.rootDir ?? process.env.CODEX_POCKET_MEDIA_DIR
      ?? join(homedir(), ".local", "state", "codex-pocket-voice", "media");
    this.maxBytes = options.maxBytes ?? environmentInteger("CODEX_MEDIA_MAX_BYTES", DEFAULT_MAX_BYTES);
    this.ollamaUrl = (options.ollamaUrl ?? process.env.CODEX_VIDEO_OLLAMA_URL
      ?? "http://127.0.0.1:11435").replace(/\/$/, "");
    this.model = options.model ?? process.env.CODEX_VIDEO_MODEL ?? "qwen3-vl:4b";
  }

  async initialize(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    const cutoff = Date.now() - MAX_MEDIA_AGE_MS;
    for (const entry of await readdir(this.rootDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(this.rootDir, entry.name);
      const info = await stat(path).catch(() => null);
      if (info && info.mtimeMs < cutoff) await rm(path, { recursive: true, force: true });
    }
  }

  async saveUpload(
    chunks: AsyncIterable<Uint8Array>,
    suppliedName: string,
    contentType: string,
  ): Promise<PublicMediaRecord> {
    const mimeType = contentType.split(";", 1)[0]!.trim().toLowerCase();
    const imageExtension = IMAGE_TYPES.get(mimeType);
    const videoExtension = VIDEO_TYPES.get(mimeType);
    const kind: MediaKind | undefined = imageExtension ? "image" : videoExtension ? "video" : undefined;
    const extension = imageExtension ?? videoExtension;
    if (!kind || !extension) throw new MediaError(415, "JPEG, PNG, WebP, GIF, MP4, WebM, MOV, MKV만 첨부할 수 있습니다.");

    const id = randomUUID();
    const directory = join(this.rootDir, id);
    const path = join(directory, `original${extension}`);
    await mkdir(directory, { recursive: false, mode: 0o700 });
    let size = 0;
    try {
      await new Promise<void>(async (resolve, reject) => {
        const output = createWriteStream(path, { mode: 0o600, flags: "wx" });
        output.once("error", reject);
        output.once("finish", resolve);
        try {
          for await (const chunk of chunks) {
            size += chunk.byteLength;
            if (size > this.maxBytes) throw new MediaError(413, `첨부 파일은 ${Math.floor(this.maxBytes / 1024 / 1024)}MB 이하여야 합니다.`);
            if (!output.write(chunk)) await new Promise<void>((resume) => output.once("drain", resume));
          }
          output.end();
        } catch (error) {
          output.destroy();
          reject(error);
        }
      });
      if (size === 0) throw new MediaError(400, "빈 파일은 첨부할 수 없습니다.");
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }

    const record: MediaRecord = {
      id,
      name: safeDisplayName(suppliedName, `attachment${extension}`),
      kind,
      mimeType,
      size,
      status: "uploaded",
      createdAt: new Date().toISOString(),
      path,
      frames: [],
    };
    this.records.set(id, record);
    this.notify(record);
    return publicMedia(record);
  }

  get(id: string): PublicMediaRecord {
    return publicMedia(this.required(id));
  }

  getFrame(id: string, index: number): string {
    const record = this.required(id);
    const frame = record.frames[index];
    if (!frame) throw new MediaError(404, "대표 프레임을 찾을 수 없습니다.");
    return frame;
  }

  queueAnalysis(id: string): PublicMediaRecord {
    const record = this.required(id);
    if (record.kind !== "video") throw new MediaError(400, "영상 파일만 분석할 수 있습니다.");
    if (record.status === "queued" || record.status === "analyzing") return publicMedia(record);
    if (record.status === "ready") return publicMedia(record);
    record.status = "queued";
    record.error = undefined;
    this.notify(record);
    this.queue = this.queue.then(() => this.analyze(record)).catch(() => undefined);
    return publicMedia(record);
  }

  resolveForTurn(ids: string[]): { promptContext: string; imagePaths: string[] } {
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length > 4) throw new MediaError(400, "첨부 파일은 한 번에 최대 4개까지 보낼 수 있습니다.");
    const records = uniqueIds.map((id) => this.required(id));
    for (const record of records) {
      if (record.kind === "video" && record.status !== "ready") {
        throw new MediaError(409, `${record.name} 영상 분석이 아직 끝나지 않았습니다.`);
      }
    }
    const sections: string[] = [];
    const imagePaths: string[] = [];
    for (const record of records) {
      if (record.kind === "image") {
        imagePaths.push(record.path);
        sections.push(`- 이미지: ${record.name}`);
      } else if (record.analysis) {
        imagePaths.push(...record.frames);
        sections.push(formatVideoContext(record));
      }
    }
    return {
      promptContext: sections.length
        ? `\n\n[첨부 매체 사전 분석]\n${sections.join("\n")}\n위 분석은 로컬 ${this.model}의 보조 결과이므로 대표 프레임을 함께 확인하세요.`
        : "",
      imagePaths,
    };
  }

  private required(id: string): MediaRecord {
    const record = this.records.get(id);
    if (!record) throw new MediaError(404, "첨부 파일을 찾을 수 없습니다. 다시 첨부해 주세요.");
    return record;
  }

  private async analyze(record: MediaRecord): Promise<void> {
    record.status = "analyzing";
    this.notify(record);
    try {
      const probe = await probeVideo(record.path);
      if (!Number.isFinite(probe.durationSeconds) || probe.durationSeconds <= 0) {
        throw new Error("영상 길이를 확인할 수 없습니다.");
      }
      if (probe.durationSeconds > 30 * 60) throw new Error("현재는 30분 이하 영상만 분석할 수 있습니다.");
      const frameDir = join(this.rootDir, record.id, "frames");
      await mkdir(frameDir, { recursive: true, mode: 0o700 });
      const timestamps = representativeTimestamps(probe.durationSeconds);
      record.frames = [];
      for (let index = 0; index < timestamps.length; index += 1) {
        const output = join(frameDir, `frame-${String(index + 1).padStart(2, "0")}.jpg`);
        await runCommand("ffmpeg", [
          "-nostdin", "-hide_banner", "-loglevel", "error", "-ss", String(timestamps[index]),
          "-i", record.path, "-frames:v", "1", "-vf", "scale=512:-2", "-q:v", "3", "-y", output,
        ], 120_000);
        record.frames.push(output);
      }
      const images = await Promise.all(record.frames.map(async (path) => (await readFile(path)).toString("base64")));
      const response = await fetch(`${this.ollamaUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          messages: [{
            role: "user",
            content: videoPrompt(timestamps),
            images,
          }],
          stream: false,
          format: {
            type: "object",
            required: ["summary", "timeline", "issues"],
            properties: {
              summary: { type: "string" },
              timeline: {
                type: "array",
                items: {
                  type: "object",
                  required: ["timestamp", "observation", "screenText"],
                  properties: {
                    timestamp: { type: "number" },
                    observation: { type: "string" },
                    screenText: { type: "string" },
                  },
                },
              },
              issues: { type: "array", items: { type: "string" } },
            },
          },
          keep_alive: "10m",
          options: { temperature: 0, num_ctx: 8192 },
        }),
        signal: AbortSignal.timeout(5 * 60_000),
      });
      if (!response.ok) throw new Error(`로컬 영상 모델 응답 오류 (HTTP ${response.status})`);
      const body = await response.json() as { message?: { content?: string }; error?: string };
      if (body.error) throw new Error(body.error);
      const parsed = parseAnalysis(body.message?.content ?? "", timestamps);
      record.analysis = {
        ...parsed,
        model: this.model,
        durationSeconds: probe.durationSeconds,
      };
      record.status = "ready";
      this.notify(record);
    } catch (error) {
      record.status = "failed";
      record.error = error instanceof Error ? error.message : String(error);
      this.notify(record);
    }
  }

  private notify(record: MediaRecord): void {
    this.options.onUpdate?.(publicMedia(record));
  }
}

function publicMedia(record: MediaRecord): PublicMediaRecord {
  const { path: _path, frames, ...rest } = record;
  return { ...rest, frameCount: frames.length };
}

function safeDisplayName(value: string, fallback: string): string {
  const cleaned = basename(value || fallback).replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return (cleaned || fallback).slice(0, 180);
}

function environmentInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

async function probeVideo(path: string): Promise<{ durationSeconds: number }> {
  const output = await runCommand("ffprobe", [
    "-v", "error", "-show_entries", "format=duration", "-of", "json", path,
  ], 30_000);
  const parsed = JSON.parse(output) as { format?: { duration?: string } };
  return { durationSeconds: Number(parsed.format?.duration) };
}

function representativeTimestamps(duration: number): number[] {
  const edge = Math.min(0.5, duration * 0.05);
  return [edge, duration * 0.34, duration * 0.67, Math.max(edge, duration - edge)]
    .map((value) => Math.max(0, Math.min(duration - 0.01, value)));
}

function videoPrompt(timestamps: number[]): string {
  const labels = timestamps.map((value, index) => `${index + 1}번=${value.toFixed(1)}초`).join(", ");
  return `다음 이미지는 영상에서 시간순으로 뽑은 대표 프레임입니다 (${labels}). 화면 글자를 정확히 읽고 변화, 사용자 동작, 오류를 분석하세요. 반드시 다음 JSON 형태로만 한국어로 답하세요: {"summary":"전체 요약","timeline":[{"timestamp":0.0,"observation":"장면 설명","screenText":"읽힌 글자"}],"issues":["발견한 문제"]}. 문제가 없으면 issues는 빈 배열로 쓰세요.`;
}

function parseAnalysis(content: string, timestamps: number[]): Omit<VideoAnalysis, "model" | "durationSeconds"> {
  let value: unknown;
  try {
    value = JSON.parse(extractJsonObject(content));
  } catch {
    const summary = content.replace(/```(?:json)?/gi, "").trim();
    if (!summary) throw new Error("로컬 영상 모델이 빈 응답을 반환했습니다.");
    return {
      summary: summary.slice(0, 4_000),
      timeline: timestamps.map((timestamp) => ({ timestamp, observation: "대표 장면" })),
      issues: ["모델 응답의 구조를 복구하지 못해 원문 요약을 전달했습니다."],
    };
  }
  const record = isRecord(value) ? value : {};
  const summary = typeof record.summary === "string" && record.summary.trim()
    ? record.summary.trim()
    : "대표 프레임 분석 완료";
  const timeline = Array.isArray(record.timeline)
    ? record.timeline.filter(isRecord).slice(0, 8).map((item, index) => ({
        timestamp: finiteNumber(item.timestamp) ?? timestamps[Math.min(index, timestamps.length - 1)] ?? 0,
        observation: typeof item.observation === "string" ? item.observation : "장면 확인",
        ...(typeof item.screenText === "string" && item.screenText ? { screenText: item.screenText } : {}),
      }))
    : [];
  const issues = Array.isArray(record.issues)
    ? record.issues.filter((item): item is string => typeof item === "string").slice(0, 12)
    : [];
  return { summary, timeline, issues };
}

function extractJsonObject(content: string): string {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("JSON object not found");
  return trimmed.slice(start, end + 1);
}

function formatVideoContext(record: MediaRecord): string {
  const analysis = record.analysis!;
  const timeline = analysis.timeline.map((item) => {
    const text = item.screenText ? ` / 화면 글자: ${item.screenText}` : "";
    return `  - ${item.timestamp.toFixed(1)}초: ${item.observation}${text}`;
  });
  const issues = analysis.issues.length ? analysis.issues.map((item) => `  - ${item}`) : ["  - 감지된 문제 없음"];
  return [
    `- 영상: ${record.name} (${analysis.durationSeconds.toFixed(1)}초, ${analysis.model})`,
    `  요약: ${analysis.summary}`,
    "  타임라인:",
    ...timeline,
    "  문제:",
    ...issues,
  ].join("\n");
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function runCommand(command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} 실행 시간이 초과되었습니다.`));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} 실패${stderr.trim() ? `: ${stderr.trim().slice(-800)}` : ""}`));
    });
  });
}
