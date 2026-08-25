import assert from "node:assert/strict";
import { createHash, sign, X509Certificate } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const createManifest = fileURLToPath(new URL("../scripts/create-update-manifest.mjs", import.meta.url));
const verifyManifest = fileURLToPath(new URL("../scripts/verify-update-manifest.mjs", import.meta.url));
const androidWorkflow = fileURLToPath(new URL("../.github/workflows/android-debug.yml", import.meta.url));
const applicationId = "io.github.jaemanlee.codexpocketvoice.stable";
const commit = "a".repeat(40);
const createdAt = "2026-08-24T00:00:00.000Z";

test("update manifests bind the APK, signing identity, and monotonic version", { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-pocket-update-manifest-"));
  try {
    const signedDirectory = join(root, "signed");
    const apk = join(signedDirectory, "Codex-Pocket-Voice-v2.0.0-stable.apk");
    const sbom = join(signedDirectory, "codex-pocket-sbom.json");
    const manifest = join(signedDirectory, "update-manifest.json");
    const certificate = join(root, "certificate.pem");
    const privateKey = join(root, "private-key.pem");
    await mkdir(signedDirectory);
    await writeFile(apk, "signed APK fixture\n", { mode: 0o600 });
    await writeFile(sbom, "{\"bomFormat\":\"CycloneDX\"}\n", { mode: 0o600 });
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
      "-subj", "/CN=Codex Pocket Voice test signing key",
      "-keyout", privateKey,
      "-out", certificate,
    ], { stdio: "ignore" });

    run(createManifest, [
      "--apk", apk,
      "--sbom", sbom,
      "--output", manifest,
      "--version", "2.0.0",
      "--version-code", "20000",
      "--application-id", applicationId,
      "--channel", "ci",
      "--commit", commit,
      "--created-at", createdAt,
      "--certificate", certificate,
    ]);

    const manifestBytes = await readFile(manifest);
    const signaturePath = join(signedDirectory, "update-manifest.sig");
    const signature = sign("sha256", manifestBytes, await readFile(privateKey, "utf8"));
    await writeFile(signaturePath, `${signature.toString("base64")}\n`, { mode: 0o600 });
    const certificatePem = await readFile(certificate, "utf8");
    const fingerprint = new X509Certificate(certificatePem).fingerprint256.replaceAll(":", "").toLowerCase();
    const fakeApkSigner = join(root, "fake-apksigner.mjs");
    await writeFile(
      fakeApkSigner,
      `#!/usr/bin/env node\nprocess.stdout.write("Signer #1 certificate SHA-256 digest: ${fingerprint}\\n");\n`,
      { mode: 0o700 },
    );
    await chmod(fakeApkSigner, 0o700);

    const signedArguments = [
      "--manifest", manifest,
      "--signature", signaturePath,
      "--certificate", certificate,
      "--expected-certificate-sha256", fingerprint,
      "--artifact-dir", signedDirectory,
      "--apksigner", fakeApkSigner,
      "--current-version-code", "19999",
    ];
    const valid = run(verifyManifest, signedArguments);
    assert.match(valid.stdout, /Verified update manifest .* v2\.0\.0 \(20000\)/);
    const receipt = JSON.parse(run(verifyManifest, [...signedArguments, "--json"]).stdout) as Record<string, unknown>;
    assert.deepEqual(receipt, {
      schemaVersion: 1,
      kind: "verified_update_manifest",
      manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
    });

    const linkedManifest = join(signedDirectory, "linked-update-manifest.json");
    await symlink(manifest, linkedManifest);
    const symlinked = run(verifyManifest, [
      ...replaceArgument(signedArguments, "--manifest", linkedManifest),
    ], false);
    assert.notEqual(symlinked.status, 0);
    assert.match(symlinked.stderr, /regular non-symlink file/);

    const hardlinkedApk = join(root, "hardlinked.apk");
    await link(apk, hardlinkedApk);
    const hardlinked = run(verifyManifest, signedArguments, false);
    assert.notEqual(hardlinked.status, 0);
    assert.match(hardlinked.stderr, /link count is invalid/);
    await unlink(hardlinkedApk);

    const untrusted = run(verifyManifest, [
      ...replaceArgument(signedArguments, "--expected-certificate-sha256", "b".repeat(64)),
    ], false);
    assert.notEqual(untrusted.status, 0);
    assert.match(untrusted.stderr, /does not match the pinned certificate/);

    await writeFile(apk, "tampered APK fixture\n", { mode: 0o600 });
    const tampered = run(verifyManifest, signedArguments, false);
    assert.notEqual(tampered.status, 0);
    assert.match(tampered.stderr, /APK artifact (?:byte count|SHA-256) does not match/i);
    await writeFile(apk, "signed APK fixture\n", { mode: 0o600 });

    const downgrade = run(verifyManifest, [
      ...replaceArgument(signedArguments, "--current-version-code", "20001"),
    ], false);
    assert.notEqual(downgrade.status, 0);
    assert.match(downgrade.stderr, /would downgrade/);

    const wrongApkSigner = join(root, "wrong-apksigner.mjs");
    await writeFile(
      wrongApkSigner,
      `#!/usr/bin/env node\nprocess.stdout.write("Signer #1 certificate SHA-256 digest: ${"c".repeat(64)}\\n");\n`,
      { mode: 0o700 },
    );
    await chmod(wrongApkSigner, 0o700);
    const wrongApkIdentity = run(verifyManifest, [
      ...replaceArgument(signedArguments, "--apksigner", wrongApkSigner),
    ], false);
    assert.notEqual(wrongApkIdentity.status, 0);
    assert.match(wrongApkIdentity.stderr, /APK signing certificate does not match/);

    const replacementApk = join(root, "replacement.apk");
    const swappingApkSigner = join(root, "swapping-apksigner.mjs");
    await writeFile(replacementApk, "replacement APK fixture\n", { mode: 0o600 });
    await writeFile(
      swappingApkSigner,
      [
        "#!/usr/bin/env node",
        "import { readFileSync, renameSync } from 'node:fs';",
        `renameSync(${JSON.stringify(replacementApk)}, ${JSON.stringify(apk)});`,
        "const bytes = readFileSync(process.argv.at(-1), 'utf8');",
        `const digest = bytes.includes('replacement') ? ${JSON.stringify(fingerprint)} : ${JSON.stringify("c".repeat(64))};`,
        "process.stdout.write(`Signer #1 certificate SHA-256 digest: ${digest}\\n`);",
        "",
      ].join("\n"),
      { mode: 0o700 },
    );
    await chmod(swappingApkSigner, 0o700);
    const swappedDuringSignerCheck = run(verifyManifest, [
      ...replaceArgument(signedArguments, "--apksigner", swappingApkSigner),
    ], false);
    assert.notEqual(swappedDuringSignerCheck.status, 0);
    assert.match(swappedDuringSignerCheck.stderr, /APK signing certificate does not match/);
    await writeFile(apk, "signed APK fixture\n", { mode: 0o600 });

    const unsignedDirectory = join(root, "unsigned");
    await mkdir(unsignedDirectory);
    const unsignedApk = join(unsignedDirectory, "Codex-Pocket-Voice-v2.0.0-unsigned.apk");
    const unsignedSbom = join(unsignedDirectory, "codex-pocket-sbom.json");
    const unsignedManifest = join(unsignedDirectory, "update-manifest.json");
    await writeFile(unsignedApk, "unsigned APK fixture\n", { mode: 0o600 });
    await writeFile(unsignedSbom, "{\"bomFormat\":\"CycloneDX\"}\n", { mode: 0o600 });
    run(createManifest, [
      "--apk", unsignedApk,
      "--sbom", unsignedSbom,
      "--output", unsignedManifest,
      "--version", "2.0.0",
      "--version-code", "20000",
      "--application-id", applicationId,
      "--channel", "ci-unsigned",
      "--commit", commit,
      "--created-at", createdAt,
      "--unsigned",
    ]);
    const refusedUnsigned = run(verifyManifest, [
      "--manifest", unsignedManifest,
      "--artifact-dir", unsignedDirectory,
    ], false);
    assert.notEqual(refusedUnsigned.status, 0);
    assert.match(refusedUnsigned.stderr, /Unsigned update manifest is not allowed/);
    const acceptedUnsigned = run(verifyManifest, [
      "--manifest", unsignedManifest,
      "--artifact-dir", unsignedDirectory,
      "--allow-unsigned",
      "--current-version-code", "20000",
      "--allow-same-version",
    ]);
    assert.match(acceptedUnsigned.stdout, /Verified update manifest/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Android candidate workflow builds and manifests the exact pull-request head", async () => {
  const workflow = await readFile(androidWorkflow, "utf8");
  const exactHeadExpression = "${{ github.event.pull_request.head.sha || github.sha }}";
  assert.match(workflow, new RegExp(`ref: \\$\\{\\{ github\\.event\\.pull_request\\.head\\.sha \\|\\| github\\.sha \\}\\}`));
  assert.match(workflow, /source_commit=\$\(git rev-parse HEAD\)/);
  assert.match(workflow, /test "\$source_commit" = "\$expected_commit"/);
  assert.equal(workflow.match(/--commit "\$\{\{ steps\.app\.outputs\.source_commit \}\}"/g)?.length, 2);
  assert.doesNotMatch(workflow, /--commit "\$GITHUB_SHA"/);
  assert.ok(workflow.includes(`expected_commit="${exactHeadExpression}"`));
});

function run(script: string, arguments_: string[], expectSuccess = true) {
  const result = spawnSync(process.execPath, [script, ...arguments_], {
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.ifError(result.error);
  if (expectSuccess) assert.equal(result.status, 0, result.stderr);
  return result;
}

function replaceArgument(values: string[], name: string, replacement: string): string[] {
  const result = [...values];
  const index = result.indexOf(name);
  assert.notEqual(index, -1);
  result[index + 1] = replacement;
  return result;
}
