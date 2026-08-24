#!/usr/bin/env -S node --import tsx

import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import {
  FunctionalFieldError,
  createFunctionalFieldObservationTemplate,
  evaluateFunctionalFieldAcceptance,
  parseFunctionalCandidateManifest,
  requireFunctionalCandidateSource,
  requireUnusedFunctionalFieldFile,
  writeFunctionalFieldFile,
} from "../src/functional-field-acceptance.js";
import { APP_VERSION } from "../src/version.js";

const execFileAsync = promisify(execFile);
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_OBSERVATION_BYTES = 64 * 1024;

type CliOptions =
  | { manifestPath: string; createObservationsPath: string }
  | { manifestPath: string; observationsPath: string; reportPath: string };

function parseArguments(args: string[]): CliOptions | "help" {
  const values = new Map<string, string>();
  const allowed = new Set(["--manifest", "--create-observations", "--observations", "--report"]);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--help" || argument === "-h") return "help";
    if (!allowed.has(argument)) throw new FunctionalFieldError("Unknown CLI option");
    if (values.has(argument)) throw new FunctionalFieldError("Duplicate CLI option");
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new FunctionalFieldError("CLI option value is missing");
    values.set(argument, value);
    index += 1;
  }
  const manifestPath = values.get("--manifest");
  if (!manifestPath) throw new FunctionalFieldError("Update manifest path is required");
  const createObservationsPath = values.get("--create-observations");
  const observationsPath = values.get("--observations");
  const reportPath = values.get("--report");
  if (createObservationsPath && !observationsPath && !reportPath) {
    return { manifestPath, createObservationsPath };
  }
  if (!createObservationsPath && observationsPath && reportPath) {
    return { manifestPath, observationsPath, reportPath };
  }
  throw new FunctionalFieldError("Choose either template creation or observation verification");
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  if (options === "help") {
    process.stdout.write([
      "Usage:",
      "  npm run android:functional-acceptance -- --manifest /private/update-manifest.json --create-observations /private/observations.json",
      "  npm run android:functional-acceptance -- --manifest /private/update-manifest.json --observations /private/observations.json --report /private/functional-report.json",
      "",
      "The signed update bundle must be verified separately before this command.",
      "This command never installs, starts, stops, pairs, revokes, or changes a device or network.",
      "It creates or validates owner-only structured operator observations for the exact clean source commit.",
      "",
    ].join("\n"));
    return;
  }
  const manifestText = await readBoundedFile(options.manifestPath, MAX_MANIFEST_BYTES, false);
  const candidate = parseFunctionalCandidateManifest(manifestText);
  const expectedSource = await cleanSourceIdentity();
  requireFunctionalCandidateSource(candidate, expectedSource);
  if ("createObservationsPath" in options) {
    await requireUnusedFunctionalFieldFile(options.createObservationsPath);
    await writeFunctionalFieldFile(
      options.createObservationsPath,
      createFunctionalFieldObservationTemplate(candidate),
    );
    process.stdout.write("Created an inert owner-only functional observation template; no field gate has passed.\n");
    return;
  }
  await requireUnusedFunctionalFieldFile(options.reportPath);
  const observationText = await readBoundedFile(options.observationsPath, MAX_OBSERVATION_BYTES, true);
  const report = evaluateFunctionalFieldAcceptance(manifestText, observationText, expectedSource);
  await writeFunctionalFieldFile(options.reportPath, report);
  if (report.gate.passed) {
    process.stdout.write("Functional field release gate passed; structured aggregate report written.\n");
  } else {
    process.stderr.write("Functional field release gate failed; inspect the structured aggregate report.\n");
    process.exitCode = 1;
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
    throw new FunctionalFieldError("Checked-out Git identity could not be verified");
  }
  if (!/^[a-f0-9]{40}$/.test(commit) || dirty.length !== 0) {
    throw new FunctionalFieldError("Functional field evidence requires the exact clean candidate commit");
  }
  return { version: APP_VERSION, versionCode: versionCode(APP_VERSION), commit };
}

async function readBoundedFile(path: string, maximum: number, privateFile: boolean): Promise<string> {
  const resolved = resolve(path);
  let info;
  try {
    info = await lstat(resolved);
  } catch {
    throw new FunctionalFieldError(privateFile ? "Functional observations could not be read" : "Update manifest could not be read");
  }
  const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
  if (!info.isFile() || info.nlink !== 1 || info.size <= 0 || info.size > maximum
      || !Number.isSafeInteger(info.size)
      || (privateFile && ((info.mode & 0o077) !== 0 || (currentUid !== null && info.uid !== currentUid)))) {
    throw new FunctionalFieldError(privateFile ? "Functional observations are not a private regular file" : "Update manifest file is invalid");
  }
  try {
    return await readFile(resolved, "utf8");
  } catch {
    throw new FunctionalFieldError(privateFile ? "Functional observations could not be read" : "Update manifest could not be read");
  }
}

function versionCode(version: string): number {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new FunctionalFieldError("Source version is invalid");
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part) || part < 0 || part > 99)) {
    throw new FunctionalFieldError("Source version is invalid");
  }
  return parts[0]! * 10_000 + parts[1]! * 100 + parts[2]!;
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (entry === import.meta.url) {
  void main().catch((error) => {
    const message = error instanceof FunctionalFieldError ? error.message : "Unexpected functional field failure";
    process.stderr.write(`Functional field acceptance failed: ${message}\n`);
    process.exitCode = 1;
  });
}
