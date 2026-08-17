import { isNativeApp } from "./native";
import { secureGet, secureRemove, secureSet } from "./secure-storage";
import type { CodexEvent, DeviceId, DeviceInfo, DeviceTarget } from "./types";

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
  minimumClientProtocol: number;
  appVersion: string;
}

const CLIENT_PROTOCOL_VERSION = 2;

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

let activeDevice: DeviceId = "pc";
let deviceTargets: DeviceTarget[] = [];
const tokens = new Map<DeviceId, string>();

export async function initializeApiAuth(): Promise<void> {
  deviceTargets = await loadDeviceTargets();
  const stored = localStorage.getItem("codex-pocket-device");
  activeDevice = deviceTargets.some((target) => target.id === stored) ? stored! : deviceTargets[0]!.id;
  for (const target of deviceTargets) {
    const token = await secureGet(tokenKey(target.id)).catch(() => null);
    if (token) tokens.set(target.id, token);
  }
}

export function listDeviceTargets(): DeviceTarget[] {
  return deviceTargets.map((target) => ({ ...target }));
}

export function activeDeviceTarget(): DeviceTarget {
  return deviceTargets.find((target) => target.id === activeDevice) ?? deviceTargets[0]!;
}

export function deviceTargetLabel(id: DeviceId): string {
  return deviceTargets.find((target) => target.id === id)?.name ?? "실행 단말";
}

export async function addLinuxDevice(name: string, localPort: number): Promise<DeviceTarget> {
  if (!name.trim() || name.trim().length > 60) throw new Error("Linux PC 이름을 입력해 주세요.");
  if (!Number.isInteger(localPort) || localPort < 1024 || localPort > 65_535) {
    throw new Error("로컬 터널 포트는 1024~65535 사이여야 합니다.");
  }
  const baseUrl = `http://127.0.0.1:${localPort}`;
  if (deviceTargets.some((target) => target.baseUrl === baseUrl)) throw new Error("이미 등록된 로컬 포트입니다.");
  const target: DeviceTarget = {
    id: `linux-${crypto.randomUUID()}`,
    name: name.trim(),
    kind: "linux",
    baseUrl,
  };
  deviceTargets = [...deviceTargets, target];
  await saveDeviceTargets();
  return { ...target };
}

export async function removeDeviceTarget(id: DeviceId): Promise<void> {
  const target = deviceTargets.find((item) => item.id === id);
  if (!target || target.builtIn) throw new Error("기본 실행 단말은 삭제할 수 없습니다.");
  deviceTargets = deviceTargets.filter((item) => item.id !== id);
  tokens.delete(id);
  await Promise.all([saveDeviceTargets(), secureRemove(tokenKey(id))]);
  if (activeDevice === id) activeDevice = deviceTargets[0]!.id;
}

export function setApiDevice(device: DeviceId): void {
  activeDevice = device;
}

function apiBase(): string {
  return activeDeviceTarget().baseUrl;
}

export function apiUrl(path: string): string {
  return `${apiBase()}${path}`;
}

export async function pairingStatus(): Promise<PairingStatus> {
  const status = await publicApi<PairingStatus>("/api/pairing/status");
  assertCompatibleProtocol(status.protocolVersion, status.minimumClientProtocol);
  return status;
}

export async function pairActiveDevice(code: string, label: string): Promise<DeviceInfo> {
  const result = await publicApi<{ token: string; device: DeviceInfo }>("/api/pairing/claim", {
    method: "POST",
    body: { code, label },
  });
  tokens.set(activeDevice, result.token);
  await secureSet(tokenKey(activeDevice), result.token);
  deviceTargets = deviceTargets.map((target) => target.id === activeDevice
    ? { ...target, name: result.device.name, kind: result.device.kind, remoteDeviceId: result.device.id }
    : target);
  await saveDeviceTargets();
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
      "첨부 파일을 Linux PC로 보내지 못했습니다. PC 연결을 확인하세요.",
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

function assertCompatibleProtocol(serverProtocol: number, minimumClientProtocol: number): void {
  if (minimumClientProtocol > CLIENT_PROTOCOL_VERSION || serverProtocol < CLIENT_PROTOCOL_VERSION) {
    throw new Error(`앱과 Companion 프로토콜이 호환되지 않습니다. 앱 ${CLIENT_PROTOCOL_VERSION}, 서버 ${serverProtocol}`);
  }
}

async function fetchJson<T>(path: string, init: RequestInit, authenticated: boolean): Promise<T> {
  let response: Response;
  try {
    response = await fetch(apiUrl(path), init);
  } catch {
    throw new Error("Linux PC Companion에 연결할 수 없습니다. PC와 연결 상태를 확인하세요.");
  }
  if (!response.ok) await throwResponseError(response, authenticated);
  return response.json() as Promise<T>;
}

async function loadDeviceTargets(): Promise<DeviceTarget[]> {
  const defaults = defaultDeviceTargets();
  const serialized = await secureGet("device-registry").catch(() => null);
  if (!serialized) return defaults;
  try {
    const parsed = JSON.parse(serialized) as unknown;
    if (!Array.isArray(parsed)) return defaults;
    const saved = parsed.filter(isDeviceTarget).filter((target) => target.kind === "linux");
    const mergedDefaults = defaults.map((target) => {
      const override = saved.find((item) => item.id === target.id);
      return override ? { ...target, name: override.name, remoteDeviceId: override.remoteDeviceId } : target;
    });
    const custom = saved.filter((target) => !defaults.some((item) => item.id === target.id || item.baseUrl === target.baseUrl));
    return [...mergedDefaults, ...custom.map((target) => ({ ...target, builtIn: false }))];
  } catch {
    return defaults;
  }
}

async function saveDeviceTargets(): Promise<void> {
  await secureSet("device-registry", JSON.stringify(deviceTargets));
}

function defaultDeviceTargets(): DeviceTarget[] {
  if (!isNativeApp()) return [{ id: "pc", name: "이 Linux PC", kind: "linux", baseUrl: "", builtIn: true }];
  return [{ id: "pc", name: "내 Linux PC", kind: "linux", baseUrl: "http://127.0.0.1:8788", builtIn: true }];
}

function isDeviceTarget(value: unknown): value is DeviceTarget {
  if (!value || typeof value !== "object") return false;
  const target = value as Record<string, unknown>;
  return typeof target.id === "string" && typeof target.name === "string"
    && (target.kind === "linux" || target.kind === "android")
    && typeof target.baseUrl === "string" && isSafeLoopbackBase(target.baseUrl)
    && (target.remoteDeviceId === undefined || typeof target.remoteDeviceId === "string");
}

function isSafeLoopbackBase(value: string): boolean {
  if (value === "") return true;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:")
      && (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]")
      && url.pathname === "/" && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
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
