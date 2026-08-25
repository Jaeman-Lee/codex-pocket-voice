import assert from "node:assert/strict";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadPocketLinkTlsConfig } from "../src/pocket-link.js";
import { createTestCertificate } from "./helpers/tls-certificate.js";

test("PocketLink loads only a private matching TLS identity and reports its SPKI pin", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-pocket-link-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await chmod(directory, 0o700);
  const { certificateFile, privateKeyFile } = await createTestCertificate(directory, "127.0.0.1");
  const environment = {
    CODEX_POCKET_LINK_HOST: "127.0.0.1",
    CODEX_POCKET_LINK_PORT: "8789",
    CODEX_POCKET_LINK_ADVERTISE_HOST: "127.0.0.1",
    CODEX_POCKET_LINK_CERT_FILE: certificateFile,
    CODEX_POCKET_LINK_KEY_FILE: privateKeyFile,
  };
  const config = await loadPocketLinkTlsConfig(environment);
  assert.equal(config?.host, "127.0.0.1");
  assert.equal(config?.port, 8789);
  assert.match(config?.publicKeyPin ?? "", /^sha256\/[A-Za-z0-9+/]{43}=$/);
  assert.ok((config?.certificate.length ?? 0) > 0);
  assert.ok((config?.privateKey.length ?? 0) > 0);

  await chmod(privateKeyFile, 0o644);
  await assert.rejects(loadPocketLinkTlsConfig(environment), /permissions must be 0600/);
});

test("PocketLink rejects partial configuration and a certificate for another host", async (t) => {
  await assert.rejects(
    loadPocketLinkTlsConfig({ CODEX_POCKET_LINK_HOST: "127.0.0.1" }),
    /CERT_FILE is required/,
  );
  const directory = await mkdtemp(join(tmpdir(), "codex-pocket-link-host-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await chmod(directory, 0o700);
  const files = await createTestCertificate(directory, "localhost");
  await assert.rejects(loadPocketLinkTlsConfig({
    CODEX_POCKET_LINK_HOST: "127.0.0.1",
    CODEX_POCKET_LINK_ADVERTISE_HOST: "127.0.0.1",
    CODEX_POCKET_LINK_CERT_FILE: files.certificateFile,
    CODEX_POCKET_LINK_KEY_FILE: files.privateKeyFile,
  }), /does not cover/);
});
