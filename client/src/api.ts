import { isNativeApp } from "./native";

interface ApiOptions {
  method?: string;
  body?: unknown;
}

const API_BASE = isNativeApp() ? "http://127.0.0.1:8788" : "";

export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
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
    throw new Error("PC에 연결할 수 없습니다. PC 전원과 Tailscale 연결을 확인하세요.");
  }
  const data = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}
