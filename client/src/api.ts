import { isNativeApp } from "./native";
import type { DeviceId } from "./types";

interface ApiOptions {
  method?: string;
  body?: unknown;
}

interface UploadResponse<T> {
  media?: T;
  error?: string;
}

let activeDevice: DeviceId = localStorage.getItem("codex-pocket-device") === "phone" ? "phone" : "pc";

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

export async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  const init: RequestInit = { method: options.method ?? "GET", headers };
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }

  let response: Response;
  try {
    response = await fetch(apiUrl(path), init);
  } catch {
    throw new Error(activeDevice === "phone"
      ? "스마트폰 Codex 서버에 연결할 수 없습니다. Termux가 실행 중인지 확인하세요."
      : "PC에 연결할 수 없습니다. PC 전원과 Tailscale 연결을 확인하세요.");
  }
  const data = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

export function uploadMedia<T>(file: File, onProgress: (percentage: number) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", apiUrl(`/api/media?name=${encodeURIComponent(file.name)}`));
    request.responseType = "json";
    request.setRequestHeader("Accept", "application/json");
    request.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    };
    request.onerror = () => reject(new Error(
      `첨부 파일을 ${activeDevice === "phone" ? "스마트폰 Codex" : "PC"}로 보내지 못했습니다. 연결을 확인하세요.`,
    ));
    request.onload = () => {
      const response = (request.response ?? {}) as UploadResponse<T>;
      if (request.status < 200 || request.status >= 300 || !response.media) {
        reject(new Error(response.error || `첨부 실패 (HTTP ${request.status})`));
        return;
      }
      onProgress(100);
      resolve(response.media);
    };
    request.send(file);
  });
}
