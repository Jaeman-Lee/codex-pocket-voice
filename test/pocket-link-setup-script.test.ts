import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { loadPocketLinkTlsConfig } from "../src/pocket-link.js";

const execFileAsync = promisify(execFile);

test("PocketLink setup creates a non-overwriting private identity with the reported pin", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-pocket-link-setup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "identity");
  const script = resolve("scripts/setup-pocket-link-tls.sh");
  const first = await execFileAsync(script, ["127.0.0.1", directory]);
  const reportedPin = first.stdout.match(/PocketLink SPKI pin: (sha256\/[A-Za-z0-9+/]{43}=)/)?.[1];
  assert.ok(reportedPin);
  const config = await loadPocketLinkTlsConfig({
    CODEX_POCKET_LINK_HOST: "127.0.0.1",
    CODEX_POCKET_LINK_ADVERTISE_HOST: "127.0.0.1",
    CODEX_POCKET_LINK_CERT_FILE: join(directory, "pocket-link-cert.pem"),
    CODEX_POCKET_LINK_KEY_FILE: join(directory, "pocket-link-key.pem"),
  });
  assert.equal(config?.publicKeyPin, reportedPin);

  await assert.rejects(execFileAsync(script, ["127.0.0.1", directory]), (error: unknown) => {
    const stderr = String((error as { stderr?: unknown }).stderr ?? "");
    return /already exists/.test(stderr);
  });
});
