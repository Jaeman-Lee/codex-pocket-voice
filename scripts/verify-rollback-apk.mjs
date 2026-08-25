#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";

const MAX_APK_BYTES = 1024 * 1024 * 1024;
const SOURCE_VERSION = "1.8.1";
const SOURCE_VERSION_CODE = 10_801;

const options = parseArguments(process.argv.slice(2));
const apkPath = resolve(required(options, "apk"));
const expectedApplicationId = required(options, "expected-application-id");
if (!/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/.test(expectedApplicationId)) {
  fail("Expected application ID is invalid");
}
const expectedCertificate = normalizeFingerprint(required(options, "expected-certificate-sha256"));
const aapt = required(options, "aapt");
const apkSigner = required(options, "apksigner");

const handle = await open(apkPath, constants.O_RDONLY | constants.O_NOFOLLOW)
  .catch(() => fail("Rollback APK is not a regular non-symlink file"));
try {
  const initial = await handle.stat().catch(() => fail("Rollback APK metadata is invalid"));
  if (!initial.isFile() || initial.nlink !== 1 || initial.size <= 0
      || !Number.isSafeInteger(initial.size) || initial.size > MAX_APK_BYTES) {
    fail("Rollback APK size or link count is invalid");
  }
  const bytes = await readWithLimit(handle, MAX_APK_BYTES);
  const descriptorPath = "/proc/self/fd/3";
  const packageIdentity = inspectPackage(handle, descriptorPath, aapt);
  if (packageIdentity.applicationId !== expectedApplicationId
      || packageIdentity.version !== SOURCE_VERSION
      || packageIdentity.versionCode !== SOURCE_VERSION_CODE) {
    fail("Rollback APK package identity is invalid");
  }
  inspectSigner(handle, descriptorPath, apkSigner, expectedCertificate);
  const final = await handle.stat().catch(() => fail("Rollback APK metadata is invalid"));
  if (bytes.length !== initial.size || final.size !== initial.size
      || final.mtimeMs !== initial.mtimeMs || final.ctimeMs !== initial.ctimeMs) {
    fail("Rollback APK changed while it was read");
  }
  const receipt = {
    schemaVersion: 1,
    kind: "verified_rollback_apk",
    applicationId: packageIdentity.applicationId,
    version: packageIdentity.version,
    versionCode: packageIdentity.versionCode,
    apkSha256: createHash("sha256").update(bytes).digest("hex"),
    apkBytes: bytes.length,
    signingCertificateSha256: expectedCertificate,
  };
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
} finally {
  await handle.close().catch(() => undefined);
}

function inspectPackage(handle, descriptorPath, command) {
  const result = spawnSync(command, ["dump", "badging", descriptorPath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe", handle.fd],
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) fail("Rollback APK package inspection failed");
  const matches = [...result.stdout.matchAll(
    /^package:\s+name='([^']+)'\s+versionCode='(\d+)'\s+versionName='([^']+)'(?:\s.*)?$/gm,
  )];
  if (matches.length !== 1) fail("Rollback APK package metadata is invalid");
  const versionCode = Number(matches[0][2]);
  if (!Number.isSafeInteger(versionCode) || versionCode <= 0) {
    fail("Rollback APK version code is invalid");
  }
  return {
    applicationId: matches[0][1],
    versionCode,
    version: matches[0][3],
  };
}

function inspectSigner(handle, descriptorPath, command, expected) {
  const result = spawnSync(command, ["verify", "--print-certs", descriptorPath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe", handle.fd],
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) fail("Rollback APK signature verification failed");
  const matches = [...result.stdout.matchAll(/Signer #\d+ certificate SHA-256 digest:\s*([a-fA-F0-9:]+)/g)]
    .map((match) => normalizeFingerprint(match[1]));
  if (matches.length !== 1 || matches[0] !== expected) {
    fail("Rollback APK signing certificate is invalid");
  }
}

async function readWithLimit(handle, maximum) {
  const chunks = [];
  let total = 0;
  while (true) {
    const remaining = maximum + 1 - total;
    if (remaining <= 0) fail("Rollback APK exceeds its size limit");
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, null)
      .catch(() => fail("Rollback APK could not be read"));
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > maximum) fail("Rollback APK exceeds its size limit");
    chunks.push(chunk.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks, total);
}

function normalizeFingerprint(value) {
  const normalized = String(value).replaceAll(":", "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) fail("Certificate SHA-256 fingerprint is invalid");
  return normalized;
}

function parseArguments(values) {
  const allowed = new Set([
    "apk", "aapt", "apksigner", "expected-application-id", "expected-certificate-sha256",
  ]);
  const parsed = new Map();
  for (let index = 0; index < values.length; index += 1) {
    const token = values[index];
    if (!token?.startsWith("--")) fail(`Unexpected argument: ${token ?? ""}`);
    const name = token.slice(2);
    if (!allowed.has(name)) fail(`Unsupported argument: --${name}`);
    if (parsed.has(name)) fail(`Duplicate argument: --${name}`);
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

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
