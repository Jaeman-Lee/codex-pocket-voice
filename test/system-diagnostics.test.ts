import assert from "node:assert/strict";
import test from "node:test";
import {
  createDiagnosticSupportBundle,
  sanitizeDiagnosticVersion,
  type SystemDiagnostics,
} from "../src/system-diagnostics.js";

test("diagnostic tool versions retain only recognized version tokens", () => {
  const secret = "sk-diagnostic-fixture-secret";
  assert.equal(sanitizeDiagnosticVersion("codex", `codex-cli 0.149.0 ${secret} /home/private`), "0.149.0");
  assert.equal(sanitizeDiagnosticVersion("git", "git version 2.43.0"), "2.43.0");
  assert.equal(sanitizeDiagnosticVersion("tmux", "tmux 3.4"), "3.4");
  assert.equal(sanitizeDiagnosticVersion("ssh", "OpenSSH_9.6p1 Ubuntu-3ubuntu13, OpenSSL 3.0.13"), "9.6p1");
  assert.equal(sanitizeDiagnosticVersion("ffmpeg", "ffmpeg version 6.1.1-3ubuntu5 Copyright"), "6.1.1-3ubuntu5");
  assert.equal(sanitizeDiagnosticVersion("ollama", "ollama version is 0.11.4"), "0.11.4");
  assert.equal(sanitizeDiagnosticVersion("codex", `Authorization: Bearer ${secret}`), undefined);
  assert.equal(sanitizeDiagnosticVersion("unknown", "unknown 1.2.3"), undefined);
});

test("support bundle is an allowlist-only aggregate without workspace or request fields", () => {
  const diagnostics: SystemDiagnostics = {
    ok: true,
    platform: "linux",
    architecture: "x64",
    nodeVersion: "v22.20.0",
    tools: [{ id: "codex", label: "Codex CLI", required: true, available: true, version: "0.149.0" }],
    workspaceCount: 3,
    creationLocationCount: 1,
    checkedAt: "2026-08-24T13:30:00.000Z",
  };
  const bundle = createDiagnosticSupportBundle(diagnostics, {
    appVersion: "2.0.0",
    minimumProtocol: 2,
    maximumProtocol: 3,
    capabilities: { runs: true, approvals: true, mediaPersistence: false },
  });

  assert.equal(bundle.schemaVersion, 1);
  assert.deepEqual(bundle.companion.protocol.capabilities, {
    approvals: true,
    mediaPersistence: false,
    runs: true,
  });
  assert.equal(bundle.system.workspaceCount, 3);
  assert.equal(bundle.privacy.mode, "allowlist-only");
  const serialized = JSON.stringify(bundle);
  assert.doesNotMatch(serialized, /\/home\/private-project|192\.168\.50\.20|sk-private-support-key|private prompt text/i);
  assert.deepEqual(Object.keys(bundle).sort(), ["companion", "generatedAt", "privacy", "schemaVersion", "system"]);
  assert.deepEqual(Object.keys(bundle.system).sort(), [
    "architecture",
    "checkedAt",
    "creationLocationCount",
    "nodeVersion",
    "ok",
    "platform",
    "tools",
    "workspaceCount",
  ]);
});
