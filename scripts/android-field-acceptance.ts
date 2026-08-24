#!/usr/bin/env -S node --import tsx

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  AndroidFieldError,
  NodeAdbExecutor,
  measureAndroidFieldAcceptance,
  requireUnusedAndroidFieldReport,
  writeAndroidFieldReport,
} from "../src/android-field-metrics.js";
import { APP_VERSION } from "../src/version.js";

const DEFAULT_PACKAGE_NAME = "io.github.jaemanlee.codexpocketvoice.stable";

interface CliOptions {
  packageName: string;
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
    if (!["--package", "--duration-minutes", "--interval-seconds", "--report", "--serial"].includes(argument)) {
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
  if (!reportPath) throw new AndroidFieldError("Report path is required");
  return {
    packageName: values.get("--package") ?? DEFAULT_PACKAGE_NAME,
    durationMinutes,
    intervalSeconds,
    reportPath,
    releaseGate,
    ...(values.has("--serial") ? { serial: values.get("--serial")! } : {}),
  };
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
      "  npm run android:field-acceptance -- --duration-minutes 60 --release-gate --report /private/path/report.json",
      "",
      "Options:",
      "  --duration-minutes N  Required; 1-240 minutes",
      "  --interval-seconds N  Sample every 5-60 seconds (default: 15)",
      "  --release-gate        Enforce the documented 60-minute release thresholds",
      "  --report PATH         Create a new owner-only aggregate JSON report",
      "  --serial SERIAL       Select one ready ADB device without recording its identifier",
      "  --package NAME        Override the stable application ID for a fork build",
      "",
    ].join("\n"));
    return;
  }
  await requireUnusedAndroidFieldReport(options.reportPath);
  const report = await measureAndroidFieldAcceptance({
    packageName: options.packageName,
    expectedVersionName: APP_VERSION,
    expectedVersionCode: versionCode(APP_VERSION),
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

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (entry === import.meta.url) {
  void main().catch((error) => {
    const message = error instanceof AndroidFieldError ? error.message : "Unexpected Android field failure";
    process.stderr.write(`Android field acceptance failed: ${message}\n`);
    process.exitCode = 1;
  });
}
