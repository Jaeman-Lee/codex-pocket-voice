import assert from "node:assert/strict";
import test from "node:test";

test("per-device API and revocation isolate credentials and preserve retryable failures", async (t) => {
  const storage = new MemoryStorage();
  const activeToken = `A${"a".repeat(42)}`;
  const fleetToken = `B${"b".repeat(42)}`;
  const revokeToken = `C${"c".repeat(42)}`;
  const offlineToken = `D${"d".repeat(42)}`;
  const invalidToken = `E${"e".repeat(42)}`;
  const tlsMismatchToken = `F${"f".repeat(42)}`;
  const malformedToken = `G${"g".repeat(42)}`;
  storage.setItem("codex-pocket-device", "pc");
  storage.setItem("codex-pocket-secure:device-registry", JSON.stringify([
    { id: "pc", name: "Primary", kind: "linux", baseUrl: "", builtIn: true },
    { id: "linux-fleet", name: "Fleet", kind: "linux", baseUrl: "http://127.0.0.1:8790" },
    { id: "linux-revoke", name: "Revoke", kind: "linux", baseUrl: "http://127.0.0.1:8791", remoteDeviceId: "remote-revoke" },
    { id: "linux-offline", name: "Offline", kind: "linux", baseUrl: "http://127.0.0.1:8792", remoteDeviceId: "remote-offline" },
    { id: "linux-invalid", name: "Invalid", kind: "linux", baseUrl: "http://127.0.0.1:8793", remoteDeviceId: "remote-invalid" },
    { id: "linux-tls", name: "TLS", kind: "linux", baseUrl: "http://127.0.0.1:8794", remoteDeviceId: "remote-tls", transport: "pocketlink" },
    { id: "linux-malformed", name: "Malformed", kind: "linux", baseUrl: "http://127.0.0.1:8795", remoteDeviceId: "remote-malformed" },
    { id: "linux-local", name: "Local only", kind: "linux", baseUrl: "http://127.0.0.1:8796" },
    { id: "linux-missing-token", name: "Missing token", kind: "linux", baseUrl: "http://127.0.0.1:8797", remoteDeviceId: "remote-missing" },
  ]));
  storage.setItem("codex-pocket-secure:gateway-token:pc", activeToken);
  storage.setItem("codex-pocket-secure:gateway-token:linux-fleet", fleetToken);
  storage.setItem("codex-pocket-secure:gateway-token:linux-revoke", revokeToken);
  storage.setItem("codex-pocket-secure:gateway-token:linux-offline", offlineToken);
  storage.setItem("codex-pocket-secure:gateway-token:linux-invalid", invalidToken);
  storage.setItem("codex-pocket-secure:gateway-token:linux-tls", tlsMismatchToken);
  storage.setItem("codex-pocket-secure:gateway-token:linux-malformed", malformedToken);
  storage.setItem("codex-pocket-secure:event-cursor:linux-revoke", "12");
  storage.setItem("codex-pocket-secure:event-cursor:linux-invalid", "13");
  storage.setItem("codex-pocket-secure:pocketlink-identity-rotation:linux-revoke", JSON.stringify({
    rotationToken: "r".repeat(43),
    expiresAt: "2026-08-24T12:00:00.000Z",
  }));
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });

  const requests: Array<{ url: string; authorization?: string; method?: string; body?: BodyInit | null }> = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    requests.push({
      url,
      authorization: headers.get("Authorization") ?? undefined,
      method: init?.method,
      body: init?.body,
    });
    if (url.endsWith("/api/unauthorized")) {
      return new Response(JSON.stringify({ error: "pairing required" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url === "http://127.0.0.1:8791/api/pairing/revoke") {
      return jsonResponse({ revoked: true });
    }
    if (url === "http://127.0.0.1:8792/api/pairing/revoke") {
      throw new TypeError("network unavailable");
    }
    if (url === "http://127.0.0.1:8793/api/pairing/revoke") {
      return jsonResponse({ error: "already revoked", code: "INVALID_TOKEN" }, 401);
    }
    if (url === "http://127.0.0.1:8794/api/pairing/revoke") {
      return jsonResponse({ error: "wrong device key", code: "TLS_DEVICE_MISMATCH" }, 401);
    }
    if (url === "http://127.0.0.1:8795/api/pairing/revoke") {
      return jsonResponse({ revoked: true, unexpected: true });
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
    listDeviceTargets,
    PairingRequiredError,
    revokeDeviceTarget,
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
  assert.equal(await revokeDeviceTarget("linux-revoke"), "revoked");
  assert.equal(await revokeDeviceTarget("linux-revoke"), "not_paired");
  await assert.rejects(revokeDeviceTarget("linux-offline"), /Companion에 연결할 수 없습니다/);
  assert.equal(await revokeDeviceTarget("linux-invalid"), "already_revoked");
  await assert.rejects(
    revokeDeviceTarget("linux-tls"),
    (error: unknown) => error instanceof PairingRequiredError && error.code === "TLS_DEVICE_MISMATCH",
  );
  await assert.rejects(revokeDeviceTarget("linux-malformed"), /권한 해제 응답을 확인할 수 없습니다/);
  assert.equal(await revokeDeviceTarget("linux-local"), "not_paired");
  await assert.rejects(revokeDeviceTarget("linux-missing-token"), /권한 해제를 확인할 인증 정보가 없습니다/);

  assert.deepEqual(requests, [
    { url: "http://127.0.0.1:8790/api/unauthorized", authorization: `Bearer ${fleetToken}`, method: "GET", body: undefined },
    { url: "/api/runs", authorization: `Bearer ${activeToken}`, method: "GET", body: undefined },
    { url: "http://127.0.0.1:8790/api/runs", authorization: undefined, method: "GET", body: undefined },
    { url: "http://127.0.0.1:8791/api/pairing/revoke", authorization: `Bearer ${revokeToken}`, method: "POST", body: "{}" },
    { url: "http://127.0.0.1:8792/api/pairing/revoke", authorization: `Bearer ${offlineToken}`, method: "POST", body: "{}" },
    { url: "http://127.0.0.1:8793/api/pairing/revoke", authorization: `Bearer ${invalidToken}`, method: "POST", body: "{}" },
    { url: "http://127.0.0.1:8794/api/pairing/revoke", authorization: `Bearer ${tlsMismatchToken}`, method: "POST", body: "{}" },
    { url: "http://127.0.0.1:8795/api/pairing/revoke", authorization: `Bearer ${malformedToken}`, method: "POST", body: "{}" },
  ]);
  assert.equal(activeDeviceTarget().id, "pc");
  assert.equal(storage.getItem("codex-pocket-secure:gateway-token:pc"), activeToken);
  assert.equal(storage.getItem("codex-pocket-secure:gateway-token:linux-fleet"), null);
  assert.equal(storage.getItem("codex-pocket-secure:gateway-token:linux-revoke"), null);
  assert.equal(storage.getItem("codex-pocket-secure:event-cursor:linux-revoke"), null);
  assert.equal(storage.getItem("codex-pocket-secure:pocketlink-identity-rotation:linux-revoke"), null);
  assert.equal(storage.getItem("codex-pocket-secure:gateway-token:linux-invalid"), null);
  assert.equal(storage.getItem("codex-pocket-secure:event-cursor:linux-invalid"), null);
  assert.equal(storage.getItem("codex-pocket-secure:gateway-token:linux-offline"), offlineToken);
  assert.equal(storage.getItem("codex-pocket-secure:gateway-token:linux-tls"), tlsMismatchToken);
  assert.equal(storage.getItem("codex-pocket-secure:gateway-token:linux-malformed"), malformedToken);
  const targets = listDeviceTargets();
  assert.equal(targets.find((target) => target.id === "linux-revoke")?.remoteDeviceId, undefined);
  assert.equal(targets.find((target) => target.id === "linux-invalid")?.remoteDeviceId, undefined);
  assert.equal(targets.find((target) => target.id === "linux-offline")?.remoteDeviceId, "remote-offline");
  assert.equal(targets.find((target) => target.id === "linux-tls")?.remoteDeviceId, "remote-tls");
  assert.equal(targets.find((target) => target.id === "linux-malformed")?.remoteDeviceId, "remote-malformed");
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, String(value)); }
}
