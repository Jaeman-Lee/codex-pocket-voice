#!/usr/bin/env node

import { createHash, verify as verifySignature, X509Certificate } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const options = parseArguments(process.argv.slice(2));
const manifestPath = resolve(required(options, "manifest"));
const artifactDirectory = resolve(options.get("artifact-dir") ?? dirname(manifestPath));
const manifestBytes = await boundedFile(manifestPath, 65_536, "Update manifest");
const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
let manifest;
try {
  manifest = JSON.parse(manifestBytes.toString("utf8"));
} catch {
  fail("Update manifest is not valid JSON");
}
validateManifest(manifest);
const canonical = `${JSON.stringify(manifest, null, 2)}\n`;
if (!manifestBytes.equals(Buffer.from(canonical))) fail("Update manifest is not canonical JSON");
if (resolve(artifactDirectory, basename(manifestPath)) !== manifestPath) {
  fail("Update manifest must be directly inside the artifact directory");
}

for (const artifact of manifest.artifacts) {
  const path = containedArtifactPath(artifactDirectory, artifact.file);
  const maximum = artifact.kind === "apk" ? 1024 * 1024 * 1024 : 64 * 1024 * 1024;
  const bytes = await boundedFile(path, maximum, `${artifact.kind} artifact`);
  if (bytes.length !== artifact.bytes) fail(`${artifact.kind} artifact byte count does not match`);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== artifact.sha256) fail(`${artifact.kind} artifact SHA-256 does not match`);
}

const apk = manifest.artifacts.find((artifact) => artifact.kind === "apk");
if (manifest.signed) {
  const signaturePath = resolve(required(options, "signature"));
  const certificatePath = resolve(required(options, "certificate"));
  const expectedCertificate = normalizeFingerprint(required(options, "expected-certificate-sha256"));
  const certificateBytes = await boundedFile(certificatePath, 16_384, "Signing certificate");
  const certificate = new X509Certificate(certificateBytes);
  const fingerprint = normalizeFingerprint(certificate.fingerprint256);
  if (fingerprint !== manifest.signingCertificateSha256 || fingerprint !== expectedCertificate) {
    fail("Update manifest signing certificate does not match the pinned certificate");
  }
  const now = Date.now();
  if (Date.parse(certificate.validFrom) > now || Date.parse(certificate.validTo) < now) {
    fail("Update manifest signing certificate is not currently valid");
  }
  const encodedSignature = (await boundedFile(signaturePath, 16_384, "Update manifest signature"))
    .toString("ascii").trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encodedSignature)) fail("Update manifest signature is malformed");
  const signature = Buffer.from(encodedSignature, "base64");
  const keyType = certificate.publicKey.asymmetricKeyType;
  if (keyType !== "rsa" && keyType !== "ec") fail("Update manifest signing key algorithm is unsupported");
  if (!verifySignature("sha256", manifestBytes, certificate.publicKey, signature)) {
    fail("Update manifest signature is invalid");
  }
  verifyApkCertificate(
    containedArtifactPath(artifactDirectory, apk.file),
    fingerprint,
    options.get("apksigner") ?? "apksigner",
  );
} else if (!options.has("allow-unsigned")) {
  fail("Unsigned update manifest is not allowed");
}

if (options.has("current-version-code")) {
  const currentVersionCode = positiveInteger(options.get("current-version-code"), "--current-version-code");
  if (manifest.versionCode < currentVersionCode) fail("Update manifest would downgrade the installed version");
  if (manifest.versionCode === currentVersionCode && !options.has("allow-same-version")) {
    fail("Update manifest does not advance the installed version");
  }
}

if (options.has("json")) {
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    kind: "verified_update_manifest",
    manifestSha256,
  })}\n`);
} else {
  process.stdout.write(`Verified update manifest for ${manifest.applicationId} v${manifest.version} (${manifest.versionCode})\n`);
}

function validateManifest(value) {
  if (!record(value)) fail("Update manifest root is invalid");
  const signedKeys = [
    "schemaVersion", "applicationId", "version", "versionCode", "channel", "commit", "createdAt", "signed",
    ...(value.signed === true ? ["signingCertificateSha256"] : []), "artifacts",
  ];
  exactKeys(value, signedKeys, "Update manifest");
  if (value.schemaVersion !== 1) fail("Update manifest schema is unsupported");
  if (typeof value.applicationId !== "string"
    || !/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/.test(value.applicationId)) fail("Application ID is invalid");
  if (typeof value.version !== "string" || !/^\d+\.\d+\.\d+$/.test(value.version)) fail("Version is invalid");
  const [major, minor, patch] = value.version.split(".").map(Number);
  if (minor > 99 || patch > 99 || !Number.isSafeInteger(value.versionCode)
    || value.versionCode !== major * 10_000 + minor * 100 + patch) fail("Version code is invalid");
  if (typeof value.channel !== "string" || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(value.channel)) fail("Channel is invalid");
  if (typeof value.commit !== "string" || !/^[a-f0-9]{40}$/.test(value.commit)) fail("Commit is invalid");
  if (typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))
    || new Date(value.createdAt).toISOString() !== value.createdAt) fail("Creation time is invalid");
  if (typeof value.signed !== "boolean") fail("Signed state is invalid");
  if (value.signed && (typeof value.signingCertificateSha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(value.signingCertificateSha256))) fail("Signing certificate digest is invalid");
  if (!Array.isArray(value.artifacts) || value.artifacts.length !== 2) fail("Artifact list is invalid");
  const kinds = new Set();
  for (const artifact of value.artifacts) {
    if (!record(artifact)) fail("Artifact record is invalid");
    exactKeys(artifact, ["kind", "file", "sha256", "bytes"], "Artifact");
    if (artifact.kind !== "apk" && artifact.kind !== "sbom") fail("Artifact kind is invalid");
    if (kinds.has(artifact.kind)) fail("Artifact kind is duplicated");
    kinds.add(artifact.kind);
    assertSimpleFilename(artifact.file, "Artifact filename");
    if (typeof artifact.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(artifact.sha256)) fail("Artifact digest is invalid");
    if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0) fail("Artifact byte count is invalid");
  }
  if (!kinds.has("apk") || !kinds.has("sbom")) fail("APK and SBOM artifacts are required");
  const apkArtifact = value.artifacts.find((artifact) => artifact.kind === "apk");
  if (!apkArtifact.file.includes(`v${value.version}`) || !apkArtifact.file.endsWith(".apk")) {
    fail("APK filename does not match the update version");
  }
}

function verifyApkCertificate(apkPath, expected, command) {
  const result = spawnSync(command, ["verify", "--print-certs", apkPath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  });
  if (result.error || result.status !== 0) fail("APK signature verification failed");
  const matches = [...result.stdout.matchAll(/Signer #\d+ certificate SHA-256 digest:\s*([a-fA-F0-9:]+)/g)]
    .map((match) => normalizeFingerprint(match[1]));
  if (matches.length !== 1 || matches[0] !== expected) fail("APK signing certificate does not match the update manifest");
}

async function boundedFile(path, maximum, name) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    .catch(() => fail(`${name} is not a regular non-symlink file`));
  try {
    const initial = await handle.stat().catch(() => fail(`${name} metadata is invalid`));
    if (!initial.isFile() || initial.nlink !== 1 || initial.size <= 0
        || !Number.isSafeInteger(initial.size) || initial.size > maximum) {
      fail(`${name} size or link count is invalid`);
    }
    const bytes = await readWithLimit(handle, maximum, name);
    const final = await handle.stat().catch(() => fail(`${name} metadata is invalid`));
    if (bytes.length !== initial.size || final.size !== initial.size
        || final.mtimeMs !== initial.mtimeMs || final.ctimeMs !== initial.ctimeMs) {
      fail(`${name} changed while it was read`);
    }
    return bytes;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function readWithLimit(handle, maximum, name) {
  const chunks = [];
  let total = 0;
  while (true) {
    const remaining = maximum + 1 - total;
    if (remaining <= 0) fail(`${name} exceeds its size limit`);
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, null)
      .catch(() => fail(`${name} could not be read`));
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > maximum) fail(`${name} exceeds its size limit`);
    chunks.push(chunk.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks, total);
}

function containedArtifactPath(directory, file) {
  assertSimpleFilename(file, "Artifact filename");
  const path = resolve(directory, file);
  if (dirname(path) !== directory) fail("Artifact path escapes its directory");
  return path;
}

function normalizeFingerprint(value) {
  const normalized = String(value).replaceAll(":", "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) fail("Certificate SHA-256 fingerprint is invalid");
  return normalized;
}

function exactKeys(value, expected, name) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${name} fields are invalid`);
  }
}

function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertSimpleFilename(value, name) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value)
    || value === "." || value === "..") fail(`${name} is invalid`);
}

function parseArguments(values) {
  const flags = new Set(["allow-unsigned", "allow-same-version", "json"]);
  const allowed = new Set([
    "manifest", "signature", "certificate", "expected-certificate-sha256", "artifact-dir", "apksigner",
    "current-version-code", ...flags,
  ]);
  const parsed = new Map();
  for (let index = 0; index < values.length; index += 1) {
    const token = values[index];
    if (!token?.startsWith("--")) fail(`Unexpected argument: ${token ?? ""}`);
    const name = token.slice(2);
    if (!allowed.has(name)) fail(`Unsupported argument: --${name}`);
    if (parsed.has(name)) fail(`Duplicate argument: --${name}`);
    if (flags.has(name)) {
      parsed.set(name, "true");
      continue;
    }
    const value = values[index + 1];
    if (!value || value.startsWith("--")) fail(`Missing value for --${name}`);
    parsed.set(name, value);
    index += 1;
  }
  return parsed;
}

function required(values, name) {
  const value = values.get(name);
  if (!value) fail(`--${name} is required`);
  return value;
}

function positiveInteger(value, name) {
  if (!/^\d+$/.test(value ?? "")) fail(`${name} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) fail(`${name} must be a positive integer`);
  return parsed;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
