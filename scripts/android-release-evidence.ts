#!/usr/bin/env -S node --import tsx

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AndroidFieldTransport } from "../src/android-field-metrics.js";
import { readBoundedRegularFile } from "../src/bounded-file.js";
import {
  FunctionalFieldError,
  requireFunctionalCandidateSource,
} from "../src/functional-field-acceptance.js";
import {
  ReleaseEvidenceError,
  evaluateReleaseEvidence,
  requireUnusedReleaseEvidenceFile,
  writeReleaseEvidenceFile,
} from "../src/release-evidence.js";
import { readCleanSourceIdentity } from "../src/source-identity.js";

const execFileAsync = promisify(execFile);
const MAX_INPUT_BYTES = 64 * 1024;

interface CliOptions {
  manifestPath: string;
  signaturePath: string;
  certificatePath: string;
  expectedCertificateSha256: string;
  artifactDirectory: string;
  apkSignerPath: string;
  observationsPath: string;
  androidReportPaths: Record<AndroidFieldTransport, string>;
  reportPath: string;
}

function parseArguments(args: string[]): CliOptions | "help" {
  const values = new Map<string, string>();
  const allowed = new Set([
    "--manifest",
    "--signature",
    "--certificate",
    "--expected-certificate-sha256",
    "--artifact-dir",
    "--apksigner",
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
    "--signature",
    "--certificate",
    "--expected-certificate-sha256",
    "--artifact-dir",
    "--apksigner",
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
    signaturePath: values.get("--signature")!,
    certificatePath: values.get("--certificate")!,
    expectedCertificateSha256: values.get("--expected-certificate-sha256")!,
    artifactDirectory: values.get("--artifact-dir")!,
    apkSignerPath: values.get("--apksigner")!,
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
      "    --signature /private/update-manifest.sig \\",
      "    --certificate /trusted/update-manifest-cert.pem \\",
      "    --expected-certificate-sha256 PINNED_FINGERPRINT \\",
      "    --artifact-dir /private/update-bundle \\",
      "    --apksigner /trusted/android-sdk/build-tools/36.0.0/apksigner \\",
      "    --observations /private/functional-observations.json \\",
      "    --direct-lan-report /private/direct-lan.json \\",
      "    --p2p-report /private/p2p.json \\",
      "    --relay-report /private/outbound-relay.json \\",
      "    --report /private/release-evidence.json",
      "",
      "The pinned fingerprint must come from a previously trusted install or another independent trust path.",
      "This command verifies the detached manifest signature, APK signer, APK/SBOM hashes, and exact source before evaluating field evidence.",
      "All private inputs must be owner-only regular files for the same exact clean candidate commit.",
      "This command performs no ADB, device, network, Provider, installation, or Companion action.",
      "",
    ].join("\n"));
    return;
  }
  await requireUnusedReleaseEvidenceFile(options.reportPath);
  const verifiedManifestSha256 = await verifySignedCandidateBundle(options);
  const [manifestText, observationsText, directText, p2pText, relayText, source] = await Promise.all([
    readBoundedFile(options.manifestPath, false, "Update manifest"),
    readBoundedFile(options.observationsPath, true, "Functional observations"),
    readBoundedFile(options.androidReportPaths.direct_lan, true, "Direct LAN report"),
    readBoundedFile(options.androidReportPaths.p2p, true, "P2P report"),
    readBoundedFile(options.androidReportPaths.outbound_relay, true, "Outbound relay report"),
    cleanSourceIdentity(),
  ]);
  if (createHash("sha256").update(manifestText, "utf8").digest("hex") !== verifiedManifestSha256) {
    throw new ReleaseEvidenceError("Update manifest changed after cryptographic verification");
  }
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
  requireFunctionalCandidateSource(report.candidate, await cleanSourceIdentity());
  await writeReleaseEvidenceFile(options.reportPath, report);
  if (report.gate.passed) {
    process.stdout.write("Exact-candidate release evidence gate passed; private aggregate report written.\n");
  } else {
    process.stderr.write("Release evidence gate failed; inspect the private aggregate report.\n");
    process.exitCode = 1;
  }
}

async function verifySignedCandidateBundle(options: CliOptions): Promise<string> {
  const verifier = fileURLToPath(new URL("./verify-update-manifest.mjs", import.meta.url));
  try {
    const result = await execFileAsync(process.execPath, [
      verifier,
      "--manifest", options.manifestPath,
      "--signature", options.signaturePath,
      "--certificate", options.certificatePath,
      "--expected-certificate-sha256", options.expectedCertificateSha256,
      "--artifact-dir", options.artifactDirectory,
      "--apksigner", options.apkSignerPath,
      "--json",
    ], {
      encoding: "utf8",
      timeout: 90_000,
      maxBuffer: 64 * 1024,
    });
    return parseVerifierReceipt(result.stdout);
  } catch {
    throw new ReleaseEvidenceError("Signed update bundle verification failed before release evidence evaluation");
  }
}

function parseVerifierReceipt(text: string): string {
  if (Buffer.byteLength(text, "utf8") > 4_096) throw new Error("Unexpected verifier output");
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new Error("Unexpected verifier output");
  }
  if (text !== `${JSON.stringify(value)}\n` || typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Unexpected verifier output");
  }
  const receipt = value as Record<string, unknown>;
  const keys = Object.keys(receipt).sort();
  const expected = ["kind", "manifestSha256", "schemaVersion"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])
      || receipt.schemaVersion !== 1 || receipt.kind !== "verified_update_manifest"
      || typeof receipt.manifestSha256 !== "string" || !/^[a-f0-9]{64}$/.test(receipt.manifestSha256)) {
    throw new Error("Unexpected verifier output");
  }
  return receipt.manifestSha256;
}

async function readBoundedFile(path: string, privateFile: boolean, label: string): Promise<string> {
  try {
    return (await readBoundedRegularFile(resolve(path), {
      maximumBytes: MAX_INPUT_BYTES,
      requirePrivate: privateFile,
    })).toString("utf8");
  } catch {
    throw new ReleaseEvidenceError(`${label} is not an acceptable ${privateFile ? "private " : ""}regular file`);
  }
}

async function cleanSourceIdentity(): Promise<{ version: string; versionCode: number; commit: string }> {
  try {
    return await readCleanSourceIdentity();
  } catch {
    throw new ReleaseEvidenceError("Checked-out Git identity could not be verified");
  }
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
