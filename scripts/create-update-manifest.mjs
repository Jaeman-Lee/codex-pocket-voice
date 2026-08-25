#!/usr/bin/env node

import { createHash, X509Certificate } from "node:crypto";
import { basename, dirname, resolve } from "node:path";
import { readFile, stat, writeFile } from "node:fs/promises";

const options = parseArguments(process.argv.slice(2));
const version = required(options, "version");
if (!/^\d+\.\d+\.\d+$/.test(version)) fail("--version must be a stable SemVer");
const versionCode = positiveInteger(required(options, "version-code"), "--version-code");
const [major, minor, patch] = version.split(".").map(Number);
if (minor > 99 || patch > 99 || versionCode !== major * 10_000 + minor * 100 + patch) {
  fail("--version-code does not match the Android SemVer mapping");
}
const applicationId = required(options, "application-id");
if (!/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/.test(applicationId)) fail("--application-id is invalid");
const channel = required(options, "channel");
if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(channel)) fail("--channel is invalid");
const commit = required(options, "commit").toLowerCase();
if (!/^[a-f0-9]{40}$/.test(commit)) fail("--commit must be a full Git SHA");
const createdAt = options.get("created-at") ?? new Date().toISOString();
if (!Number.isFinite(Date.parse(createdAt)) || new Date(createdAt).toISOString() !== createdAt) {
  fail("--created-at must be a canonical ISO timestamp");
}
const apkPath = resolve(required(options, "apk"));
const sbomPath = resolve(required(options, "sbom"));
const outputPath = resolve(required(options, "output"));
assertSimpleFilename(basename(apkPath), "APK filename");
assertSimpleFilename(basename(sbomPath), "SBOM filename");
if (!basename(apkPath).includes(`v${version}`)) fail("APK filename does not contain the manifest version");
if (dirname(outputPath) !== dirname(apkPath) || dirname(outputPath) !== dirname(sbomPath)) {
  fail("Manifest, APK, and SBOM must share one artifact directory");
}
const unsigned = options.has("unsigned");
const certificatePath = options.get("certificate");
if (unsigned === Boolean(certificatePath)) fail("Provide exactly one of --unsigned or --certificate");

const apk = await artifact(apkPath, "apk");
const sbom = await artifact(sbomPath, "sbom");
const manifest = {
  schemaVersion: 1,
  applicationId,
  version,
  versionCode,
  channel,
  commit,
  createdAt,
  signed: !unsigned,
  ...(certificatePath ? { signingCertificateSha256: await certificateFingerprint(resolve(certificatePath)) } : {}),
  artifacts: [apk, sbom],
};
await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o644 });

async function artifact(path, kind) {
  const info = await stat(path);
  const maximum = kind === "apk" ? 1024 * 1024 * 1024 : 64 * 1024 * 1024;
  if (!info.isFile() || info.size <= 0 || info.size > maximum || !Number.isSafeInteger(info.size)) {
    fail(`${kind} artifact is invalid`);
  }
  const bytes = await readFile(path);
  return {
    kind,
    file: basename(path),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: info.size,
  };
}

async function certificateFingerprint(path) {
  const pem = await readFile(path, "utf8");
  const certificate = new X509Certificate(pem);
  return certificate.fingerprint256.replaceAll(":", "").toLowerCase();
}

function parseArguments(values) {
  const parsed = new Map();
  for (let index = 0; index < values.length; index += 1) {
    const token = values[index];
    if (!token?.startsWith("--")) fail(`Unexpected argument: ${token ?? ""}`);
    const name = token.slice(2);
    if (parsed.has(name)) fail(`Duplicate argument: --${name}`);
    if (name === "unsigned") {
      parsed.set(name, "true");
      continue;
    }
    const value = values[index + 1];
    if (!value || value.startsWith("--")) fail(`Missing value for --${name}`);
    parsed.set(name, value);
    index += 1;
  }
  const allowed = new Set([
    "apk", "sbom", "output", "version", "version-code", "application-id", "channel", "commit",
    "created-at", "certificate", "unsigned",
  ]);
  for (const name of parsed.keys()) if (!allowed.has(name)) fail(`Unsupported argument: --${name}`);
  return parsed;
}

function required(values, name) {
  const value = values.get(name);
  if (!value) fail(`--${name} is required`);
  return value;
}

function positiveInteger(value, name) {
  if (!/^\d+$/.test(value)) fail(`${name} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) fail(`${name} must be a positive integer`);
  return parsed;
}

function assertSimpleFilename(value, name) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value) || value === "." || value === "..") {
    fail(`${name} is invalid`);
  }
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
