import assert from "node:assert/strict";
import test from "node:test";

test("per-device API requests never switch the active Companion or discard another device token", async (t) => {
  const storage = new MemoryStorage();
  const activeToken = `A${"a".repeat(42)}`;
  const fleetToken = `B${"b".repeat(42)}`;
  storage.setItem("codex-pocket-device", "pc");
  storage.setItem("codex-pocket-secure:device-registry", JSON.stringify([
    { id: "pc", name: "Primary", kind: "linux", baseUrl: "", builtIn: true },
    { id: "linux-fleet", name: "Fleet", kind: "linux", baseUrl: "http://127.0.0.1:8790" },
  ]));
  storage.setItem("codex-pocket-secure:gateway-token:pc", activeToken);
  storage.setItem("codex-pocket-secure:gateway-token:linux-fleet", fleetToken);
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });

  const requests: Array<{ url: string; authorization?: string }> = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    requests.push({ url, authorization: headers.get("Authorization") ?? undefined });
    if (url.endsWith("/api/unauthorized")) {
      return new Response(JSON.stringify({ error: "pairing required" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ operations: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
    Reflect.deleteProperty(globalThis, "localStorage");
  });

  const {
    activeDeviceTarget,
    api,
    apiForDevice,
    initializeApiAuth,
    PairingRequiredError,
  } = await import("../client/src/api.js");
  await initializeApiAuth();
  assert.equal(activeDeviceTarget().id, "pc");

  await assert.rejects(
    apiForDevice("linux-fleet", "/api/unauthorized"),
    PairingRequiredError,
  );
  await api<{ operations: [] }>("/api/runs");
  await apiForDevice<{ operations: [] }>("linux-fleet", "/api/runs");
  await assert.rejects(
    apiForDevice("linux-unknown", "/api/runs"),
    /등록되지 않은 Linux PC/,
  );

  assert.deepEqual(requests, [
    { url: "http://127.0.0.1:8790/api/unauthorized", authorization: `Bearer ${fleetToken}` },
    { url: "/api/runs", authorization: `Bearer ${activeToken}` },
    { url: "http://127.0.0.1:8790/api/runs", authorization: undefined },
  ]);
  assert.equal(activeDeviceTarget().id, "pc");
  assert.equal(storage.getItem("codex-pocket-secure:gateway-token:pc"), activeToken);
  assert.equal(storage.getItem("codex-pocket-secure:gateway-token:linux-fleet"), null);
  assert.equal(requests.length, 3);
});

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, String(value)); }
}
