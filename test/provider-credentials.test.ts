import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { EnvironmentOpenAICredentialSource } from "../src/providers/openai-credentials.js";
import { OpenAIProviderAdapter } from "../src/providers/openai-provider.js";
import { EnvironmentOpenRouterCredentialSource } from "../src/providers/openrouter-credentials.js";
import { OpenRouterProviderAdapter } from "../src/providers/openrouter-provider.js";

const execFileAsync = promisify(execFile);

test("Provider adapters prefer private systemd credentials without exposing their runtime path", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-pocket-systemd-credentials-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const openaiFile = join(directory, "openai-api-key");
  const openrouterFile = join(directory, "openrouter-api-key");
  await writeFile(openaiFile, "fixture-systemd-openai\n", { mode: 0o400 });
  await writeFile(openrouterFile, "fixture-systemd-openrouter\n", { mode: 0o600 });
  const openaiCredentials = new EnvironmentOpenAICredentialSource({
    CREDENTIALS_DIRECTORY: directory,
    OPENAI_API_KEY: "fixture-stale-environment-openai",
  });
  const openrouterCredentials = new EnvironmentOpenRouterCredentialSource({
    CREDENTIALS_DIRECTORY: directory,
    OPENROUTER_API_KEY: "fixture-stale-environment-openrouter",
  });

  assert.deepEqual(await openaiCredentials.load(), {
    apiKey: "fixture-systemd-openai",
    source: "systemd_credential",
  });
  assert.deepEqual(await openrouterCredentials.load(), {
    apiKey: "fixture-systemd-openrouter",
    source: "systemd_credential",
  });

  const openai = await new OpenAIProviderAdapter({
    credentials: openaiCredentials,
    modelAllowlist: ["gpt-fixture"],
  }).describe();
  const openrouter = await new OpenRouterProviderAdapter({
    credentials: openrouterCredentials,
    modelAllowlist: ["vendor/fixture"],
  }).describe();
  assert.match(openai.detail, /systemd/);
  assert.match(openrouter.detail, /systemd/);
  assert.doesNotMatch(JSON.stringify([openai, openrouter]), new RegExp(directory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(JSON.stringify([openai, openrouter]), /fixture-systemd-(?:openai|openrouter)/);
});

test("missing systemd credentials preserve the legacy environment and protected-file fallbacks", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-pocket-credential-fallback-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const protectedFile = join(directory, "openrouter-key");
  await writeFile(protectedFile, "fixture-protected-openrouter\n", { mode: 0o600 });

  assert.deepEqual(await new EnvironmentOpenAICredentialSource({
    CREDENTIALS_DIRECTORY: directory,
    OPENAI_API_KEY: "fixture-environment-openai",
  }).load(), { apiKey: "fixture-environment-openai", source: "environment" });
  assert.deepEqual(await new EnvironmentOpenRouterCredentialSource({
    CREDENTIALS_DIRECTORY: directory,
    CODEX_POCKET_OPENROUTER_API_KEY_FILE: protectedFile,
  }).load(), { apiKey: "fixture-protected-openrouter", source: "protected_file" });
});

test("Provider credentials fail closed on symlinks, broad permissions, and invalid systemd directories", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-pocket-credential-invalid-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = join(directory, "target");
  await writeFile(target, "fixture-target-key\n", { mode: 0o600 });
  await symlink(target, join(directory, "openai-api-key"));
  await assert.rejects(new EnvironmentOpenAICredentialSource({
    CREDENTIALS_DIRECTORY: directory,
    OPENAI_API_KEY: "fixture-must-not-fallback",
  }).load(), /symlink/);

  const broadFile = join(directory, "broad-openrouter-key");
  await writeFile(broadFile, "fixture-broad-key\n", { mode: 0o644 });
  await assert.rejects(new EnvironmentOpenRouterCredentialSource({
    CODEX_POCKET_OPENROUTER_API_KEY_FILE: broadFile,
  }).load(), /0600 또는 0400/);
  await assert.rejects(new EnvironmentOpenAICredentialSource({
    CREDENTIALS_DIRECTORY: "relative/credentials",
  }).load(), /systemd credential 디렉터리/);
});

test("credential manager encrypts, rotates, and recoverably removes without restarting the service", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-pocket-credential-manager-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixtureBin = join(root, "bin");
  const configHome = join(root, "config");
  const secretFile = join(root, "fixture-secret");
  await mkdir(fixtureBin, { recursive: true, mode: 0o700 });
  await writeExecutable(join(fixtureBin, "systemd"), "#!/bin/sh\nprintf '%s\\n' 'systemd 256 (fixture)'\n");
  await writeExecutable(join(fixtureBin, "systemd-ask-password"), `#!/bin/sh\ncat "${secretFile}"\n`);
  await writeExecutable(join(fixtureBin, "systemd-creds"), `#!/bin/sh
set -eu
case "$1" in
  encrypt)
    IFS= read -r secret || true
    output=
    for argument in "$@"; do output=$argument; done
    case "$secret" in
      fixture-provider-key-one) ciphertext=fixture-ciphertext-one ;;
      fixture-provider-key-two) ciphertext=fixture-ciphertext-two ;;
      *) exit 9 ;;
    esac
    printf '%s\\n' "$ciphertext" > "$output"
    ;;
  decrypt) ;;
  *) exit 8 ;;
esac
`);
  const environment = {
    ...process.env,
    HOME: root,
    XDG_CONFIG_HOME: configHome,
    PATH: `${fixtureBin}:${process.env.PATH ?? ""}`,
  };
  const script = resolve("scripts/manage-provider-credential.sh");
  await writeFile(secretFile, "fixture-provider-key-one\n", { mode: 0o600 });
  const first = await execFileAsync(script, ["set", "openai"], { env: environment });
  const credentialFile = join(configHome, "codex-pocket-voice", "credentials.encrypted", "openai-api-key.cred");
  assert.equal(await readFile(credentialFile, "utf8"), "fixture-ciphertext-one\n");
  assert.equal((await stat(credentialFile)).mode & 0o777, 0o600);
  assert.doesNotMatch(`${first.stdout}${first.stderr}`, /fixture-provider-key|systemctl|restart.*service/i);

  await writeFile(secretFile, "fixture-provider-key-two\n", { mode: 0o600 });
  const second = await execFileAsync(script, ["set", "openai"], { env: environment });
  assert.equal(await readFile(credentialFile, "utf8"), "fixture-ciphertext-two\n");
  const archiveDirectory = join(configHome, "codex-pocket-voice", "credentials.encrypted", "archive");
  const firstArchives = await readdir(archiveDirectory);
  assert.equal(firstArchives.length, 1);
  assert.equal(await readFile(join(archiveDirectory, firstArchives[0]!), "utf8"), "fixture-ciphertext-one\n");
  assert.doesNotMatch(`${second.stdout}${second.stderr}`, /fixture-provider-key|systemctl/i);

  const removed = await execFileAsync(script, ["remove", "openai"], { env: environment });
  await assert.rejects(readFile(credentialFile, "utf8"), /ENOENT/);
  assert.equal((await readdir(archiveDirectory)).length, 2);
  assert.doesNotMatch(`${removed.stdout}${removed.stderr}`, /fixture-provider-key|systemctl/i);
});

test("Linux installer binds encrypted credentials on systemd 256 and rejects them on legacy systemd", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-pocket-installer-credential-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixtureBin = join(root, "bin");
  await mkdir(fixtureBin, { recursive: true, mode: 0o700 });
  const noOp = "#!/bin/sh\nexit 0\n";
  for (const command of ["git", "tmux", "ssh", "npm", "systemd-creds"]) {
    await writeExecutable(join(fixtureBin, command), noOp);
  }
  const systemctlLog = join(root, "systemctl.log");
  await writeExecutable(join(fixtureBin, "systemctl"), "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$FIXTURE_SYSTEMCTL_LOG\"\n");
  await writeExecutable(join(fixtureBin, "systemd"), "#!/bin/sh\nprintf '%s\\n' 'systemd 256 (fixture)'\n");
  const codexBin = join(fixtureBin, "codex-fixture");
  await writeExecutable(codexBin, noOp);
  const configHome = join(root, "supported-config");
  const credentialDirectory = join(configHome, "codex-pocket-voice", "credentials.encrypted");
  await mkdir(credentialDirectory, { recursive: true, mode: 0o700 });
  const encrypted = "fixture-encrypted-credential-not-a-key";
  await writeFile(join(credentialDirectory, "openai-api-key.cred"), encrypted, { mode: 0o600 });
  const environment = {
    ...process.env,
    HOME: root,
    XDG_CONFIG_HOME: configHome,
    CODEX_PROJECTS_HOME: join(root, "workspace"),
    CODEX_BIN: codexBin,
    FIXTURE_SYSTEMCTL_LOG: systemctlLog,
    PATH: `${fixtureBin}:${process.env.PATH ?? ""}`,
  };
  const result = await execFileAsync(resolve("scripts/install-linux-companion.sh"), [], { env: environment });
  const service = await readFile(join(configHome, "systemd", "user", "codex-pocket-companion.service"), "utf8");
  assert.match(service, new RegExp(`LoadCredentialEncrypted=openai-api-key:${escapeRegex(join(credentialDirectory, "openai-api-key.cred"))}`));
  assert.doesNotMatch(service, new RegExp(encrypted));
  assert.match(await readFile(systemctlLog, "utf8"), /daemon-reload[\s\S]*enable --now codex-pocket-companion\.service/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}${service}`, /API_KEY=|fixture-provider-key/);

  await writeExecutable(join(fixtureBin, "systemd"), "#!/bin/sh\nprintf '%s\\n' 'systemd 245 (fixture)'\n");
  const legacyConfig = join(root, "legacy-config");
  const legacyCredentialDirectory = join(legacyConfig, "codex-pocket-voice", "credentials.encrypted");
  await mkdir(legacyCredentialDirectory, { recursive: true, mode: 0o700 });
  await writeFile(join(legacyCredentialDirectory, "openrouter-api-key.cred"), encrypted, { mode: 0o600 });
  await assert.rejects(execFileAsync(resolve("scripts/install-linux-companion.sh"), [], {
    env: { ...environment, XDG_CONFIG_HOME: legacyConfig },
  }), /systemd 256 or newer; found 245/);
});

async function writeExecutable(path: string, content: string): Promise<void> {
  await writeFile(path, content, { mode: 0o700 });
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
