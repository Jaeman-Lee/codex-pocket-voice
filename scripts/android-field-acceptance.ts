#!/usr/bin/env -S node --import tsx

import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import {
  ANDROID_FIELD_TRANSPORTS,
  AndroidFieldError,
  NodeAdbExecutor,
  measureAndroidFieldAcceptance,
  requireUnusedAndroidFieldReport,
  writeAndroidFieldReport,
  type AndroidFieldTransport,
} from "../src/android-field-metrics.js";
import {
  FunctionalFieldError,
  parseFunctionalCandidateManifest,
  requireFunctionalCandidateSource,
} from "../src/functional-field-acceptance.js";
import { readBoundedRegularFile } from "../src/bounded-file.js";
import { APP_VERSION } from "../src/version.js";

const execFileAsync = promisify(execFile);
const MAX_MANIFEST_BYTES = 64 * 1024;

interface CliOptions {
  manifestPath: string;
  transport: AndroidFieldTransport;
  durationMinutes: number;
  intervalSeconds: number;
  reportPath: string;
  releaseGate: boolean;
  serial?: string;
}

function parseArguments(args: string[]): CliOptions | "help" {
  const values = new Map<string, string>();
  let releaseGate = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--help" || argument === "-h") return "help";
    if (argument === "--release-gate") {
      if (releaseGate) throw new AndroidFieldError("Duplicate CLI option");
      releaseGate = true;
      continue;
    }
    if (!["--manifest", "--transport", "--duration-minutes", "--interval-seconds", "--report", "--serial"].includes(argument)) {
      throw new AndroidFieldError("Unknown CLI option");
    }
    if (values.has(argument)) throw new AndroidFieldError("Duplicate CLI option");
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new AndroidFieldError("CLI option value is missing");
    values.set(argument, value);
    index += 1;
  }
  const durationMinutes = integerOption(values.get("--duration-minutes"), "duration");
  const intervalSeconds = integerOption(values.get("--interval-seconds") ?? "15", "interval");
  const reportPath = values.get("--report");
  const manifestPath = values.get("--manifest");
  const transport = parseTransport(values.get("--transport"));
  if (!reportPath) throw new AndroidFieldError("Report path is required");
  if (!manifestPath) throw new AndroidFieldError("Update manifest path is required");
  return {
    manifestPath,
    transport,
    durationMinutes,
    intervalSeconds,
    reportPath,
    releaseGate,
    ...(values.has("--serial") ? { serial: values.get("--serial")! } : {}),
  };
}

function parseTransport(raw: string | undefined): AndroidFieldTransport {
  const normalized = raw?.replaceAll("-", "_");
  if (!normalized || !(ANDROID_FIELD_TRANSPORTS as readonly string[]).includes(normalized)) {
    throw new AndroidFieldError("transport must be direct-lan, p2p, or outbound-relay");
  }
  return normalized as AndroidFieldTransport;
}

function integerOption(raw: string | undefined, label: string): number {
  if (!raw || !/^\d+$/.test(raw)) throw new AndroidFieldError(`${label} is invalid`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new AndroidFieldError(`${label} is invalid`);
  return value;
}

function versionCode(version: string): number {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new AndroidFieldError("Source version is invalid");
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part) || part < 0 || part > 99)) {
    throw new AndroidFieldError("Source version is invalid");
  }
  return parts[0]! * 10_000 + parts[1]! * 100 + parts[2]!;
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  if (options === "help") {
    process.stdout.write([
      "Usage:",
      "  npm run android:field-acceptance -- --manifest /private/update-manifest.json --transport direct-lan --duration-minutes 60 --release-gate --report /private/path/report.json",
      "",
      "The signed update bundle must be verified separately before this command.",
      "The installed base APK digest is checked before and after measurement against the exact clean signed candidate.",
      "The report is bound to that manifest, installed APK digest, exact clean source commit, and one transport.",
      "",
      "Options:",
      "  --manifest PATH       Canonical signed update manifest for the installed candidate",
      "  --transport NAME      Required: direct-lan, p2p, or outbound-relay",
      "  --duration-minutes N  Required; 1-240 minutes",
      "  --interval-seconds N  Sample every 5-60 seconds (default: 15)",
      "  --release-gate        Enforce the documented 60-minute release thresholds",
      "  --report PATH         Create a new owner-only aggregate JSON report",
      "  --serial SERIAL       Select one ready ADB device without recording its identifier",
      "",
    ].join("\n"));
    return;
  }
  const manifestText = await readManifest(options.manifestPath);
  const candidate = parseFunctionalCandidateManifest(manifestText);
  requireFunctionalCandidateSource(candidate, await cleanSourceIdentity());
  await requireUnusedAndroidFieldReport(options.reportPath);
  const report = await measureAndroidFieldAcceptance({
    candidate,
    transport: options.transport,
    durationSeconds: options.durationMinutes * 60,
    intervalSeconds: options.intervalSeconds,
    mode: options.releaseGate ? "release_gate" : "observation",
    ...(options.serial ? { serial: options.serial } : {}),
  }, { executor: new NodeAdbExecutor() });
  await writeAndroidFieldReport(options.reportPath, report);
  if (report.gate.outcome === "failed") {
    process.stderr.write("Android field release gate failed; inspect the aggregate report.\n");
    process.exitCode = 1;
  } else if (report.gate.outcome === "passed") {
    process.stdout.write("Android field release gate passed; aggregate report written.\n");
  } else {
    process.stdout.write("Android field observation completed; aggregate report written without a release verdict.\n");
  }
}

async function cleanSourceIdentity(): Promise<{ version: string; versionCode: number; commit: string }> {
  let commit: string;
  let dirty: string;
  try {
    const [commitResult, statusResult] = await Promise.all([
      execFileAsync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 64 * 1024,
      }),
      execFileAsync("git", ["status", "--porcelain=v1", "--untracked-files=normal"], {
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 64 * 1024,
      }),
    ]);
    commit = commitResult.stdout.trim();
    dirty = statusResult.stdout;
  } catch {
    throw new AndroidFieldError("Checked-out Git identity could not be verified");
  }
  if (!/^[a-f0-9]{40}$/.test(commit) || dirty.length !== 0) {
    throw new AndroidFieldError("Android field evidence requires the exact clean candidate commit");
  }
  return { version: APP_VERSION, versionCode: versionCode(APP_VERSION), commit };
}

async function readManifest(path: string): Promise<string> {
  try {
    return (await readBoundedRegularFile(resolve(path), {
      maximumBytes: MAX_MANIFEST_BYTES,
      requirePrivate: false,
    })).toString("utf8");
  } catch {
    throw new AndroidFieldError("Update manifest file is invalid");
  }
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (entry === import.meta.url) {
  void main().catch((error) => {
    const message = error instanceof AndroidFieldError || error instanceof FunctionalFieldError
      ? error.message
      : "Unexpected Android field failure";
    process.stderr.write(`Android field acceptance failed: ${message}\n`);
    process.exitCode = 1;
  });
}
