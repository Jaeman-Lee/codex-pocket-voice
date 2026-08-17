import { isNativeApp } from "./native";
import { secureGet, secureRemove, secureSet } from "./secure-storage";
import type { CodexEvent, DeviceId, DeviceInfo } from "./types";

interface ApiOptions {
  method?: string;
  body?: unknown;
}

interface UploadResponse<T> {
  media?: T;
  error?: string;
  code?: string;
}

export interface PairingStatus {
  device: DeviceInfo;
  pairedClientCount: number;
  pairingExpiresAt: string;
  protocolVersion: number;
}

interface ApiErrorBody {
  error?: string;
  code?: string;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
  }
}

export class PairingRequiredError extends ApiError {}

let activeDevice: DeviceId = localStorage.getItem("codex-pocket-device") === "phone" ? "phone" : "pc";
const tokens = new Map<DeviceId, string>();

export async function initializeApiAuth(): Promise<void> {
  for (const device of ["pc", "phone"] as const) {
    const token = await secureGet(tokenKey(device)).catch(() => null);
    if (token) tokens.set(device, token);
  }
}

export function setApiDevice(device: DeviceId): void {
  activeDevice = device;
}

function apiBase(): string {
  if (!isNativeApp()) return "";
  return activeDevice === "phone" ? "http://127.0.0.1:8789" : "http://127.0.0.1:8788";
}

export function apiUrl(path: string): string {
  return `${apiBase()}${path}`;
}

export async function pairingStatus(): Promise<PairingStatus> {
  return publicApi<PairingStatus>("/api/pairing/status");
}

export async function pairActiveDevice(code: string, label: string): Promise<DeviceInfo> {
  const result = await publicApi<{ token: string; device: DeviceInfo }>("/api/pairing/claim", {
    method: "POST",
    body: { code, label },
  });
  tokens.set(activeDevice, result.token);
  await secureSet(tokenKey(activeDevice), result.token);
  return result.device;
}

export async function forgetActiveDevice(): Promise<void> {
  try {
    await api("/api/pairing/revoke", { method: "POST", body: {} });
  } finally {
    tokens.delete(activeDevice);
    await secureRemove(tokenKey(activeDevice));
  }
}

export async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const headers = authorizedHeaders(options.body !== undefined);
  const init: RequestInit = { method: options.method ?? "GET", headers };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);
  return fetchJson<T>(path, init, true);
}

export async function apiBlob(path: string): Promise<Blob> {
  const response = await fetch(apiUrl(path), { headers: authorizedHeaders(false) });
  if (!response.ok) await throwResponseError(response, true);
  return response.blob();
}

export async function subscribeEvents(
  onOpen: () => void,
  onEvent: (event: CodexEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch(apiUrl("/api/events"), {
    headers: authorizedHeaders(false),
    signal,
  });
  if (!response.ok) await throwResponseError(response, true);
  if (!response.body) throw new Error("이 브라우저는 실시간 응답 스트림을 지원하지 않습니다.");
  onOpen();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  while (!signal.aborted) {
    const { value, done } = await reader.read();
    pending += decoder.decode(value, { stream: !done });
    let boundary = pending.indexOf("\n\n");
    while (boundary >= 0) {
      const frame = pending.slice(0, boundary);
      pending = pending.slice(boundary + 2);
      const data = frame.split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data) {
        try {
          onEvent(JSON.parse(data) as CodexEvent);
        } catch {
          // Ignore malformed or forward-compatible event frames.
        }
      }
      boundary = pending.indexOf("\n\n");
    }
    if (done) break;
  }
}

export function uploadMedia<T>(file: File, onProgress: (percentage: number) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", apiUrl(`/api/media?name=${encodeURIComponent(file.name)}`));
    request.responseType = "json";
    request.setRequestHeader("Accept", "application/json");
    request.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    const token = tokens.get(activeDevice);
    if (token) request.setRequestHeader("Authorization", `Bearer ${token}`);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    };
    request.onerror = () => reject(new Error(
      `첨부 파일을 ${activeDevice === "phone" ? "스마트폰 Codex" : "PC"}로 보내지 못했습니다. 연결을 확인하세요.`,
    ));
    request.onload = () => {
      const response = (request.response ?? {}) as UploadResponse<T>;
      if (request.status < 200 || request.status >= 300 || !response.media) {
        if (request.status === 401) {
          void discardInvalidToken();
          reject(new PairingRequiredError(response.error ?? "페어링이 필요합니다.", request.status, response.code));
          return;
        }
        reject(new ApiError(response.error || `첨부 실패 (HTTP ${request.status})`, request.status, response.code));
        return;
      }
      onProgress(100);
      resolve(response.media);
    };
    request.send(file);
  });
}

async function publicApi<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  const init: RequestInit = { method: options.method ?? "GET", headers };
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }
  return fetchJson<T>(path, init, false);
}

async function fetchJson<T>(path: string, init: RequestInit, authenticated: boolean): Promise<T> {
  let response: Response;
  try {
    response = await fetch(apiUrl(path), init);
  } catch {
    throw new Error(activeDevice === "phone"
      ? "스마트폰 Codex 서버에 연결할 수 없습니다. 스마트폰 런타임 상태를 확인하세요."
      : "Linux PC Companion에 연결할 수 없습니다. PC와 연결 상태를 확인하세요.");
  }
  if (!response.ok) await throwResponseError(response, authenticated);
  return response.json() as Promise<T>;
}

async function throwResponseError(response: Response, authenticated: boolean): Promise<never> {
  const data = await response.json().catch(() => ({})) as ApiErrorBody;
  if (response.status === 401 && authenticated) {
    await discardInvalidToken();
    throw new PairingRequiredError(data.error ?? "페어링이 필요합니다.", response.status, data.code);
  }
  throw new ApiError(data.error || `HTTP ${response.status}`, response.status, data.code);
}

function authorizedHeaders(json: boolean): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json" };
  const token = tokens.get(activeDevice);
  if (token) headers.Authorization = `Bearer ${token}`;
  if (json) headers["Content-Type"] = "application/json";
  return headers;
}

async function discardInvalidToken(): Promise<void> {
  tokens.delete(activeDevice);
  await secureRemove(tokenKey(activeDevice)).catch(() => undefined);
}

function tokenKey(device: DeviceId): string {
  return `gateway-token:${device}`;
}
