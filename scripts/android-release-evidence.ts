#!/usr/bin/env -S node --import tsx

import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import type { AndroidFieldTransport } from "../src/android-field-metrics.js";
import { FunctionalFieldError } from "../src/functional-field-acceptance.js";
import {
  ReleaseEvidenceError,
  evaluateReleaseEvidence,
  requireUnusedReleaseEvidenceFile,
  writeReleaseEvidenceFile,
} from "../src/release-evidence.js";
import { APP_VERSION } from "../src/version.js";

const execFileAsync = promisify(execFile);
const MAX_INPUT_BYTES = 64 * 1024;

interface CliOptions {
  manifestPath: string;
  observationsPath: string;
  androidReportPaths: Record<AndroidFieldTransport, string>;
  reportPath: string;
}

function parseArguments(args: string[]): CliOptions | "help" {
  const values = new Map<string, string>();
  const allowed = new Set([
    "--manifest",
    "--observations",
    "--direct-lan-report",
    "--p2p-report",
    "--relay-report",
    "--report",
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--help" || argument === "-h") return "help";
    if (!allowed.has(argument)) throw new ReleaseEvidenceError("Unknown CLI option");
    if (values.has(argument)) throw new ReleaseEvidenceError("Duplicate CLI option");
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new ReleaseEvidenceError("CLI option value is missing");
    values.set(argument, value);
    index += 1;
  }
  const required = [
    "--manifest",
    "--observations",
    "--direct-lan-report",
    "--p2p-report",
    "--relay-report",
    "--report",
  ] as const;
  for (const name of required) {
    if (!values.has(name)) throw new ReleaseEvidenceError(`Required CLI option is missing: ${name}`);
  }
  return {
    manifestPath: values.get("--manifest")!,
    observationsPath: values.get("--observations")!,
    androidReportPaths: {
      direct_lan: values.get("--direct-lan-report")!,
      p2p: values.get("--p2p-report")!,
      outbound_relay: values.get("--relay-report")!,
    },
    reportPath: values.get("--report")!,
  };
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  if (options === "help") {
    process.stdout.write([
      "Usage:",
      "  npm run android:release-evidence -- \\",
      "    --manifest /private/update-manifest.json \\",
      "    --observations /private/functional-observations.json \\",
      "    --direct-lan-report /private/direct-lan.json \\",
      "    --p2p-report /private/p2p.json \\",
      "    --relay-report /private/outbound-relay.json \\",
      "    --report /private/release-evidence.json",
      "",
      "The signed update bundle must be verified separately before this command.",
      "All private inputs must be owner-only regular files for the same exact clean candidate commit.",
      "This command performs no ADB, device, network, Provider, installation, or Companion action.",
      "",
    ].join("\n"));
    return;
  }
  await requireUnusedReleaseEvidenceFile(options.reportPath);
  const [manifestText, observationsText, directText, p2pText, relayText, source] = await Promise.all([
    readBoundedFile(options.manifestPath, false, "Update manifest"),
    readBoundedFile(options.observationsPath, true, "Functional observations"),
    readBoundedFile(options.androidReportPaths.direct_lan, true, "Direct LAN report"),
    readBoundedFile(options.androidReportPaths.p2p, true, "P2P report"),
    readBoundedFile(options.androidReportPaths.outbound_relay, true, "Outbound relay report"),
    cleanSourceIdentity(),
  ]);
  const report = evaluateReleaseEvidence(
    manifestText,
    observationsText,
    {
      direct_lan: directText,
      p2p: p2pText,
      outbound_relay: relayText,
    },
    source,
  );
  await writeReleaseEvidenceFile(options.reportPath, report);
  if (report.gate.passed) {
    process.stdout.write("Exact-candidate release evidence gate passed; private aggregate report written.\n");
  } else {
    process.stderr.write("Release evidence gate failed; inspect the private aggregate report.\n");
    process.exitCode = 1;
  }
}

async function readBoundedFile(path: string, privateFile: boolean, label: string): Promise<string> {
  const resolved = resolve(path);
  let info;
  try {
    info = await lstat(resolved);
  } catch {
    throw new ReleaseEvidenceError(`${label} could not be read`);
  }
  const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
  if (!info.isFile() || info.nlink !== 1 || info.size <= 0 || info.size > MAX_INPUT_BYTES
      || !Number.isSafeInteger(info.size)
      || (privateFile && ((info.mode & 0o077) !== 0 || (currentUid !== null && info.uid !== currentUid)))) {
    throw new ReleaseEvidenceError(`${label} is not an acceptable ${privateFile ? "private " : ""}regular file`);
  }
  try {
    return await readFile(resolved, "utf8");
  } catch {
    throw new ReleaseEvidenceError(`${label} could not be read`);
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
    throw new ReleaseEvidenceError("Checked-out Git identity could not be verified");
  }
  if (!/^[a-f0-9]{40}$/.test(commit) || dirty.length !== 0) {
    throw new ReleaseEvidenceError("Release evidence requires the exact clean candidate commit");
  }
  return { version: APP_VERSION, versionCode: versionCode(APP_VERSION), commit };
}

function versionCode(version: string): number {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new ReleaseEvidenceError("Source version is invalid");
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part) || part < 0 || part > 99)) {
    throw new ReleaseEvidenceError("Source version is invalid");
  }
  return parts[0]! * 10_000 + parts[1]! * 100 + parts[2]!;
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (entry === import.meta.url) {
  void main().catch((error) => {
    const message = error instanceof ReleaseEvidenceError || error instanceof FunctionalFieldError
      ? error.message
      : "Unexpected release evidence failure";
    process.stderr.write(`Release evidence failed: ${message}\n`);
    process.exitCode = 1;
  });
}
