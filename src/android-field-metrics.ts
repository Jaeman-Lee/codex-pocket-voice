import { execFile } from "node:child_process";
import { lstat, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import type { FunctionalCandidateIdentity } from "./functional-field-acceptance.js";

const MAX_ADB_OUTPUT_BYTES = 1024 * 1024;
const MAX_REPORT_BYTES = 64 * 1024;
const ADB_TIMEOUT_MS = 30_000;
const PACKAGE_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/;
const SERIAL_PATTERN = /^[!-~]{1,128}$/;

export const ANDROID_FIELD_LIMITS = {
  minimumDurationSeconds: 60,
  maximumDurationSeconds: 4 * 60 * 60,
  minimumIntervalSeconds: 5,
  maximumIntervalSeconds: 60,
} as const;

export const ANDROID_RELEASE_THRESHOLDS = {
  minimumDurationSeconds: 60 * 60,
  minimumProcessPresencePercent: 95,
  minimumMetricCoveragePercent: 95,
  maximumCpuP95Percent: 5,
  maximumPssMib: 192,
  maximumBatteryPercentPerHour: 4,
  maximumBackgroundWakePercent: 10,
} as const;

export const ANDROID_FIELD_TRANSPORTS = [
  "direct_lan",
  "p2p",
  "outbound_relay",
] as const;

export type AndroidFieldMode = "observation" | "release_gate";
export type AndroidFieldTransport = typeof ANDROID_FIELD_TRANSPORTS[number];

export interface AndroidFieldConfig {
  candidate: FunctionalCandidateIdentity;
  transport: AndroidFieldTransport;
  durationSeconds: number;
  intervalSeconds: number;
  mode: AndroidFieldMode;
  serial?: string;
}

export interface AdbExecutor {
  execute(args: readonly string[]): Promise<string>;
}

export interface AndroidFieldDependencies {
  executor: AdbExecutor;
  monotonicMs?: () => number;
  wallClockMs?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

interface PackageIdentity {
  userId: number;
  versionName: string;
  versionCode: number;
}

interface InstalledCandidateState {
  packageIdentity: PackageIdentity;
  apkPath: string;
}

export interface MemorySample {
  pssKib: number;
  rssKib: number | null;
}

export interface BatterySnapshot {
  levelPercent: number;
  discharging: boolean;
}

export interface WakeSnapshot {
  partialDurationMs: number;
  backgroundPartialDurationMs: number;
}

interface NumericSummary {
  mean: number;
  p95: number;
  max: number;
}

interface GateCheck {
  metric: string;
  outcome: "pass" | "fail";
  observed: number | string | null;
  requirement: number | string;
}

export interface AndroidFieldReport {
  schemaVersion: 3;
  kind: "android_field_acceptance";
  evidenceKind: "adb_aggregate_measurement";
  candidate: FunctionalCandidateIdentity;
  transport: AndroidFieldTransport;
  testWindow: {
    startedAt: string;
    completedAt: string;
  };
  app: {
    packageName: string;
    versionName: string;
    versionCode: number;
    apkSha256: string;
    digestVerifiedAtStartAndEnd: true;
  };
  measurement: {
    requestedDurationSeconds: number;
    actualDurationSeconds: number;
    intervalSeconds: number;
    scheduledSamples: number;
    processPresencePercent: number;
    cpuCoveragePercent: number;
    memoryCoveragePercent: number;
  };
  cpuPercent: NumericSummary | null;
  memoryMib: {
    pss: NumericSummary | null;
    rss: NumericSummary | null;
  };
  battery: {
    state: "discharging" | "not_discharging" | "unavailable";
    levelDropPercent: number | null;
    percentPerHour: number | null;
  };
  backgroundWake: {
    state: "available" | "counter_reset" | "unavailable";
    durationMs: number | null;
    percentOfMeasurement: number | null;
  };
  gate: {
    mode: AndroidFieldMode;
    outcome: "passed" | "failed" | "observation_only";
    passed: boolean | null;
    thresholds: typeof ANDROID_RELEASE_THRESHOLDS | null;
    checks: GateCheck[];
  };
  privacy: {
    containsDeviceIdentifiers: false;
    containsRawAdbOutput: false;
    containsNetworkValues: false;
  };
}

export class AndroidFieldError extends Error {}

export class NodeAdbExecutor implements AdbExecutor {
  async execute(args: readonly string[]): Promise<string> {
    if (!args.length || args.some((argument) => typeof argument !== "string"
      || argument.length === 0 || argument.length > 512
      || /[\u0000-\u001f\u007f]/.test(argument))) {
      throw new AndroidFieldError("ADB query arguments are invalid");
    }
    return new Promise<string>((resolve, reject) => {
      execFile("adb", [...args], {
        encoding: "utf8",
        maxBuffer: MAX_ADB_OUTPUT_BYTES,
        timeout: ADB_TIMEOUT_MS,
        windowsHide: true,
      }, (error, stdout) => {
        if (error || typeof stdout !== "string"
          || Buffer.byteLength(stdout, "utf8") > MAX_ADB_OUTPUT_BYTES) {
          reject(new AndroidFieldError("ADB query failed"));
          return;
        }
        resolve(stdout);
      });
    });
  }
}

export async function measureAndroidFieldAcceptance(
  config: AndroidFieldConfig,
  dependencies: AndroidFieldDependencies,
): Promise<AndroidFieldReport> {
  const checkedConfig: AndroidFieldConfig = {
    ...config,
    candidate: { ...config.candidate },
  };
  validateConfig(checkedConfig);
  const monotonicMs = dependencies.monotonicMs ?? (() => performance.now());
  const wallClockMs = dependencies.wallClockMs ?? (() => Date.now());
  const sleep = dependencies.sleep ?? ((milliseconds) => new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  }));
  const devices = await safeAdb(dependencies.executor, ["devices"]);
  const serial = selectAdbDevice(devices, checkedConfig.serial);
  const shell = (...args: string[]) => safeAdb(
    dependencies.executor,
    ["-s", serial, "shell", ...args],
  );
  const packageName = checkedConfig.candidate.applicationId;
  const installedCandidate = await inspectInstalledCandidate(shell, checkedConfig.candidate);
  const packageIdentity = installedCandidate.packageIdentity;

  const startedWallClockMs = wallClockMs();
  if (!Number.isFinite(startedWallClockMs)) throw new AndroidFieldError("Measurement clock is invalid");
  const startedAt = monotonicMs();
  const [startingBattery, startingWake] = await Promise.all([
    optionalQuery(() => shell("dumpsys", "battery"), parseBatterySnapshot),
    optionalQuery(
      () => shell("dumpsys", "batterystats", "-c", "--charged", packageName),
      (output) => parseWakeSnapshot(output, packageIdentity.userId, packageName),
    ),
  ]);
  const scheduledSamples = checkedConfig.durationSeconds / checkedConfig.intervalSeconds + 1;
  const samples: Array<{
    processPresent: boolean | null;
    cpuPercent: number | null;
    memory: MemorySample | null;
  }> = [];

  for (let index = 0; index < scheduledSamples; index += 1) {
    if (index > 0) {
      const target = startedAt + index * checkedConfig.intervalSeconds * 1_000;
      let remaining = target - monotonicMs();
      while (remaining > 0) {
        await sleep(remaining);
        remaining = target - monotonicMs();
      }
    }
    const [cpuOutput, memoryOutput] = await Promise.all([
      optionalRawQuery(() => shell("dumpsys", "cpuinfo")),
      optionalRawQuery(() => shell("dumpsys", "meminfo", packageName)),
    ]);
    let memory: MemorySample | null = null;
    let processPresent: boolean | null = null;
    if (memoryOutput !== null) {
      try {
        memory = parseMemoryInfo(memoryOutput);
        processPresent = memory !== null;
      } catch {
        processPresent = null;
      }
    }
    let cpuPercent: number | null = null;
    if (cpuOutput !== null) {
      try {
        cpuPercent = parseCpuInfo(cpuOutput, packageName);
      } catch {
        cpuPercent = null;
      }
    }
    samples.push({ processPresent, cpuPercent, memory });
  }

  const [endingWake, endingBattery] = await Promise.all([
    optionalQuery(
      () => shell("dumpsys", "batterystats", "-c", "--charged", packageName),
      (output) => parseWakeSnapshot(output, packageIdentity.userId, packageName),
    ),
    optionalQuery(() => shell("dumpsys", "battery"), parseBatterySnapshot),
  ]);
  const endingCandidate = await inspectInstalledCandidate(shell, checkedConfig.candidate);
  if (endingCandidate.apkPath !== installedCandidate.apkPath
      || endingCandidate.packageIdentity.userId !== packageIdentity.userId) {
    throw new AndroidFieldError("Installed app changed during the field measurement");
  }
  const actualDurationSeconds = Math.max(0.001, (monotonicMs() - startedAt) / 1_000);
  const processPresencePercent = percentage(
    samples.filter((sample) => sample.processPresent === true).length,
    scheduledSamples,
  );
  const cpuValues = samples.flatMap((sample) => sample.cpuPercent === null ? [] : [sample.cpuPercent]);
  const pssValues = samples.flatMap((sample) => sample.memory === null ? [] : [sample.memory.pssKib / 1_024]);
  const rssValues = samples.flatMap((sample) => sample.memory?.rssKib == null ? [] : [sample.memory.rssKib / 1_024]);
  const battery = batteryResult(startingBattery, endingBattery, actualDurationSeconds);
  const backgroundWake = wakeResult(startingWake, endingWake, actualDurationSeconds);
  const completedWallClockMs = wallClockMs();
  if (!Number.isFinite(completedWallClockMs) || completedWallClockMs < startedWallClockMs) {
    throw new AndroidFieldError("Measurement clock is invalid");
  }
  const report: AndroidFieldReport = {
    schemaVersion: 3,
    kind: "android_field_acceptance",
    evidenceKind: "adb_aggregate_measurement",
    candidate: checkedConfig.candidate,
    transport: checkedConfig.transport,
    testWindow: {
      startedAt: wallTimestamp(startedWallClockMs),
      completedAt: wallTimestamp(completedWallClockMs),
    },
    app: {
      packageName,
      versionName: packageIdentity.versionName,
      versionCode: packageIdentity.versionCode,
      apkSha256: checkedConfig.candidate.apkSha256,
      digestVerifiedAtStartAndEnd: true,
    },
    measurement: {
      requestedDurationSeconds: checkedConfig.durationSeconds,
      actualDurationSeconds: rounded(actualDurationSeconds),
      intervalSeconds: checkedConfig.intervalSeconds,
      scheduledSamples,
      processPresencePercent,
      cpuCoveragePercent: percentage(cpuValues.length, scheduledSamples),
      memoryCoveragePercent: percentage(pssValues.length, scheduledSamples),
    },
    cpuPercent: numericSummary(cpuValues),
    memoryMib: {
      pss: numericSummary(pssValues),
      rss: numericSummary(rssValues),
    },
    battery,
    backgroundWake,
    gate: {
      mode: config.mode,
      outcome: "observation_only",
      passed: null,
      thresholds: null,
      checks: [],
    },
    privacy: {
      containsDeviceIdentifiers: false,
      containsRawAdbOutput: false,
      containsNetworkValues: false,
    },
  };
  report.gate = evaluateAndroidReleaseGate(report, checkedConfig.mode);
  return report;
}

export function selectAdbDevice(output: string, requestedSerial?: string): string {
  boundedText(output, "ADB device list");
  if (requestedSerial !== undefined && !SERIAL_PATTERN.test(requestedSerial)) {
    throw new AndroidFieldError("Requested ADB device is invalid");
  }
  const devices = output.split(/\r?\n/).slice(1).flatMap((line) => {
    const match = /^([^\s]+)\s+(device|offline|unauthorized)(?:\s|$)/.exec(line.trim());
    return match ? [{ serial: match[1]!, state: match[2]! }] : [];
  });
  if (requestedSerial !== undefined) {
    const selected = devices.find((device) => device.serial === requestedSerial);
    if (!selected || selected.state !== "device") {
      throw new AndroidFieldError("Requested ADB device is not ready");
    }
    return selected.serial;
  }
  const ready = devices.filter((device) => device.state === "device");
  if (ready.length !== 1) {
    throw new AndroidFieldError("Exactly one ready ADB device is required");
  }
  return ready[0]!.serial;
}

export function parsePackageIdentity(output: string): PackageIdentity {
  boundedText(output, "package diagnostics");
  const userId = exactIntegerMatch(output, /^\s*userId=(\d+)\b/m);
  const versionCode = exactIntegerMatch(output, /^\s*versionCode=(\d+)\b/m);
  const versionNameMatch = /^\s*versionName=([^\s]+)\s*$/m.exec(output);
  if (userId === null || versionCode === null || !versionNameMatch
    || versionNameMatch[1]!.length > 64
    || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(versionNameMatch[1]!)) {
    throw new AndroidFieldError("Installed app identity could not be verified");
  }
  return { userId, versionCode, versionName: versionNameMatch[1]! };
}

export function parseInstalledApkPath(output: string): string {
  boundedText(output, "installed package path");
  const lines = output.trim().split(/\r?\n/);
  if (lines.length !== 1) throw new AndroidFieldError("Installed APK path could not be verified");
  const match = /^package:(\/data\/app\/(?:[A-Za-z0-9._~+=,@%-]{1,255}\/){1,8}base\.apk)$/.exec(lines[0]!);
  if (!match) throw new AndroidFieldError("Installed APK path could not be verified");
  const path = match[1]!;
  if (path.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new AndroidFieldError("Installed APK path could not be verified");
  }
  return path;
}

export function parseInstalledApkDigest(output: string, expectedPath: string): string {
  boundedText(output, "installed APK digest");
  if (!expectedPath.startsWith("/data/app/") || expectedPath.length > 4_096
      || /[\u0000-\u001f\u007f]/.test(expectedPath)) {
    throw new AndroidFieldError("Installed APK digest could not be verified");
  }
  const match = /^([a-fA-F0-9]{64})[ \t]+([^\r\n]+)\r?\n?$/.exec(output);
  if (!match || match[2] !== expectedPath) {
    throw new AndroidFieldError("Installed APK digest could not be verified");
  }
  return match[1]!.toLowerCase();
}

export function parseCpuInfo(output: string, packageName: string): number {
  boundedText(output, "CPU diagnostics");
  validatePackageName(packageName);
  if (!/^\s*(?:\d+(?:\.\d+)?%\s+TOTAL:|TOTAL:\s+\d+(?:\.\d+)?%)/m.test(output)) {
    throw new AndroidFieldError("CPU diagnostics format is unsupported");
  }
  let total = 0;
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*[+-]?(\d+(?:\.\d+)?)%\s+\d+\/([^\s]+):\s/.exec(line);
    if (!match) continue;
    const processName = match[2]!;
    if (processName !== packageName && !processName.startsWith(`${packageName}:`)) continue;
    const value = Number(match[1]);
    if (!Number.isFinite(value) || value < 0 || value > 10_000) {
      throw new AndroidFieldError("CPU diagnostics value is invalid");
    }
    total += value;
  }
  return rounded(total);
}

export function parseMemoryInfo(output: string): MemorySample | null {
  boundedText(output, "memory diagnostics");
  if (/No process found for:/i.test(output)) return null;
  const pssLabel = /\bTOTAL PSS:\s*([\d,]+)\b/.exec(output);
  const rssLabel = /\bTOTAL RSS:\s*([\d,]+)\b/.exec(output);
  if (pssLabel) {
    return {
      pssKib: diagnosticInteger(pssLabel[1]!),
      rssKib: rssLabel ? diagnosticInteger(rssLabel[1]!) : null,
    };
  }
  const totalLine = /^\s*TOTAL\s+([\d,]+)(?:\s+[\d,]+){2,}/m.exec(output);
  if (!totalLine) throw new AndroidFieldError("Memory diagnostics format is unsupported");
  return { pssKib: diagnosticInteger(totalLine[1]!), rssKib: null };
}

export function parseBatterySnapshot(output: string): BatterySnapshot {
  boundedText(output, "battery diagnostics");
  const level = exactIntegerMatch(output, /^\s*level:\s*(\d+)\s*$/m);
  const scale = exactIntegerMatch(output, /^\s*scale:\s*(\d+)\s*$/m);
  const status = exactIntegerMatch(output, /^\s*status:\s*(\d+)\s*$/m);
  const powerValues = [...output.matchAll(/^\s*(?:AC|USB|Wireless|Dock) powered:\s*(true|false)\s*$/gm)]
    .map((match) => match[1]);
  if (level === null || scale === null || status === null || scale <= 0 || level > scale
    || powerValues.length < 3) {
    throw new AndroidFieldError("Battery diagnostics format is unsupported");
  }
  return {
    levelPercent: rounded(level / scale * 100),
    discharging: status === 3 && powerValues.every((value) => value === "false"),
  };
}

export function parseWakeSnapshot(
  output: string,
  expectedAppId: number,
  expectedPackageName: string,
): WakeSnapshot {
  boundedText(output, "battery usage diagnostics");
  if (!Number.isSafeInteger(expectedAppId) || expectedAppId < 0) {
    throw new AndroidFieldError("App UID is invalid");
  }
  validatePackageName(expectedPackageName);
  let checkinVersion: number | null = null;
  let packageMappingFound = false;
  let result: WakeSnapshot | null = null;
  for (const line of output.split(/\r?\n/)) {
    const fields = line.trim().split(",");
    if (fields.length >= 5 && fields[2] === "i" && fields[3] === "vers") {
      checkinVersion = csvInteger(fields[4]);
      continue;
    }
    if (fields.length === 6 && fields[1] === "0" && fields[2] === "i"
      && fields[3] === "uid" && fields[4] === String(expectedAppId)
      && fields[5] === expectedPackageName) {
      packageMappingFound = true;
      continue;
    }
    const rowUid = fields.length === 6 && /^\d+$/.test(fields[1] ?? "")
      ? csvInteger(fields[1])
      : null;
    if (rowUid !== null && rowUid % 100_000 === expectedAppId
      && fields[2] === "l" && fields[3] === "awl") {
      if (result) throw new AndroidFieldError("Wake diagnostics are ambiguous");
      result = {
        partialDurationMs: csvInteger(fields[4]),
        backgroundPartialDurationMs: csvInteger(fields[5]),
      };
    }
  }
  if (checkinVersion === null || checkinVersion < 21 || !packageMappingFound) {
    throw new AndroidFieldError("Wake diagnostics format is unsupported");
  }
  return result ?? { partialDurationMs: 0, backgroundPartialDurationMs: 0 };
}

export function evaluateAndroidReleaseGate(
  report: AndroidFieldReport,
  mode: AndroidFieldMode,
): AndroidFieldReport["gate"] {
  if (mode === "observation") {
    return {
      mode,
      outcome: "observation_only",
      passed: null,
      thresholds: null,
      checks: [],
    };
  }
  const thresholds = ANDROID_RELEASE_THRESHOLDS;
  const checks: GateCheck[] = [
    minimumCheck("duration_seconds", report.measurement.actualDurationSeconds, thresholds.minimumDurationSeconds),
    minimumCheck("process_presence_percent", report.measurement.processPresencePercent, thresholds.minimumProcessPresencePercent),
    minimumCheck("cpu_coverage_percent", report.measurement.cpuCoveragePercent, thresholds.minimumMetricCoveragePercent),
    maximumCheck("cpu_p95_percent", report.cpuPercent?.p95 ?? null, thresholds.maximumCpuP95Percent),
    minimumCheck("memory_coverage_percent", report.measurement.memoryCoveragePercent, thresholds.minimumMetricCoveragePercent),
    maximumCheck("pss_max_mib", report.memoryMib.pss?.max ?? null, thresholds.maximumPssMib),
    equalityCheck("battery_state", report.battery.state, "discharging"),
    maximumCheck("battery_percent_per_hour", report.battery.percentPerHour, thresholds.maximumBatteryPercentPerHour),
    equalityCheck("background_wake_state", report.backgroundWake.state, "available"),
    maximumCheck(
      "background_wake_percent",
      report.backgroundWake.percentOfMeasurement,
      thresholds.maximumBackgroundWakePercent,
    ),
  ];
  const passed = checks.every((check) => check.outcome === "pass");
  return {
    mode,
    outcome: passed ? "passed" : "failed",
    passed,
    thresholds,
    checks,
  };
}

export async function requireUnusedAndroidFieldReport(path: string): Promise<void> {
  if (!path || path.length > 4_096 || /[\u0000-\u001f\u007f]/.test(path)) {
    throw new AndroidFieldError("Report path is invalid");
  }
  try {
    await lstat(path);
    throw new AndroidFieldError("Report path already exists");
  } catch (error) {
    if (error instanceof AndroidFieldError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new AndroidFieldError("Report path could not be checked");
    }
  }
}

export async function writeAndroidFieldReport(path: string, report: AndroidFieldReport): Promise<void> {
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_REPORT_BYTES) {
    throw new AndroidFieldError("Field report exceeded its size limit");
  }
  try {
    await writeFile(path, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch {
    throw new AndroidFieldError("Field report could not be written");
  }
}

function validateConfig(config: AndroidFieldConfig): void {
  validateCandidate(config.candidate);
  if (!(ANDROID_FIELD_TRANSPORTS as readonly string[]).includes(config.transport)) {
    throw new AndroidFieldError("Measurement transport is invalid");
  }
  if (!Number.isSafeInteger(config.durationSeconds)
    || config.durationSeconds < ANDROID_FIELD_LIMITS.minimumDurationSeconds
    || config.durationSeconds > ANDROID_FIELD_LIMITS.maximumDurationSeconds) {
    throw new AndroidFieldError("Measurement duration is invalid");
  }
  if (!Number.isSafeInteger(config.intervalSeconds)
    || config.intervalSeconds < ANDROID_FIELD_LIMITS.minimumIntervalSeconds
    || config.intervalSeconds > ANDROID_FIELD_LIMITS.maximumIntervalSeconds
    || config.durationSeconds % config.intervalSeconds !== 0) {
    throw new AndroidFieldError("Measurement interval is invalid");
  }
  if (config.mode !== "observation" && config.mode !== "release_gate") {
    throw new AndroidFieldError("Measurement mode is invalid");
  }
  if (config.mode === "release_gate"
    && config.durationSeconds < ANDROID_RELEASE_THRESHOLDS.minimumDurationSeconds) {
    throw new AndroidFieldError("Release-gate measurement must run for at least 60 minutes");
  }
  if (config.serial !== undefined && !SERIAL_PATTERN.test(config.serial)) {
    throw new AndroidFieldError("Requested ADB device is invalid");
  }
}

function validateCandidate(candidate: FunctionalCandidateIdentity): void {
  validatePackageName(candidate.applicationId);
  if (!/^\d+\.\d+\.\d+$/.test(candidate.version)
      || !Number.isSafeInteger(candidate.versionCode) || candidate.versionCode <= 0
      || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(candidate.channel)
      || !/^[a-f0-9]{40}$/.test(candidate.commit)
      || !/^[a-f0-9]{64}$/.test(candidate.manifestSha256)
      || !/^[a-f0-9]{64}$/.test(candidate.apkSha256)
      || !/^[a-f0-9]{64}$/.test(candidate.signingCertificateSha256)) {
    throw new AndroidFieldError("Signed candidate identity is invalid");
  }
  const [major, minor, patch] = candidate.version.split(".").map(Number);
  if (minor! > 99 || patch! > 99
      || candidate.versionCode !== major! * 10_000 + minor! * 100 + patch!) {
    throw new AndroidFieldError("Signed candidate version code is invalid");
  }
}

function validatePackageName(packageName: string): void {
  if (!PACKAGE_PATTERN.test(packageName) || packageName.length > 200) {
    throw new AndroidFieldError("Android package name is invalid");
  }
}

async function inspectInstalledCandidate(
  shell: (...args: string[]) => Promise<string>,
  candidate: FunctionalCandidateIdentity,
): Promise<InstalledCandidateState> {
  const [packageOutput, pathOutput] = await Promise.all([
    shell("dumpsys", "package", candidate.applicationId),
    shell("pm", "path", candidate.applicationId),
  ]);
  const packageIdentity = parsePackageIdentity(packageOutput);
  if (packageIdentity.versionName !== candidate.version
      || packageIdentity.versionCode !== candidate.versionCode) {
    throw new AndroidFieldError("Installed app version does not match the signed candidate");
  }
  const apkPath = parseInstalledApkPath(pathOutput);
  const digest = parseInstalledApkDigest(
    await shell("toybox", "sha256sum", apkPath),
    apkPath,
  );
  if (digest !== candidate.apkSha256) {
    throw new AndroidFieldError("Installed APK does not match the signed candidate");
  }
  return { packageIdentity, apkPath };
}

function wallTimestamp(value: number): string {
  try {
    return new Date(value).toISOString();
  } catch {
    throw new AndroidFieldError("Measurement clock is invalid");
  }
}

async function safeAdb(executor: AdbExecutor, args: readonly string[]): Promise<string> {
  try {
    const output = await executor.execute(args);
    boundedText(output, "ADB output");
    return output;
  } catch {
    throw new AndroidFieldError("ADB query failed");
  }
}

async function optionalRawQuery(query: () => Promise<string>): Promise<string | null> {
  try {
    return await query();
  } catch {
    return null;
  }
}

async function optionalQuery<T>(
  query: () => Promise<string>,
  parse: (output: string) => T,
): Promise<T | null> {
  const output = await optionalRawQuery(query);
  if (output === null) return null;
  try {
    return parse(output);
  } catch {
    return null;
  }
}

function batteryResult(
  starting: BatterySnapshot | null,
  ending: BatterySnapshot | null,
  durationSeconds: number,
): AndroidFieldReport["battery"] {
  if (!starting || !ending) {
    return { state: "unavailable", levelDropPercent: null, percentPerHour: null };
  }
  if (!starting.discharging || !ending.discharging) {
    return { state: "not_discharging", levelDropPercent: null, percentPerHour: null };
  }
  const drop = Math.max(0, starting.levelPercent - ending.levelPercent);
  return {
    state: "discharging",
    levelDropPercent: rounded(drop),
    percentPerHour: rounded(drop / durationSeconds * 3_600),
  };
}

function wakeResult(
  starting: WakeSnapshot | null,
  ending: WakeSnapshot | null,
  durationSeconds: number,
): AndroidFieldReport["backgroundWake"] {
  if (!starting || !ending) {
    return { state: "unavailable", durationMs: null, percentOfMeasurement: null };
  }
  if (ending.partialDurationMs < starting.partialDurationMs
    || ending.backgroundPartialDurationMs < starting.backgroundPartialDurationMs) {
    return { state: "counter_reset", durationMs: null, percentOfMeasurement: null };
  }
  const durationMs = ending.backgroundPartialDurationMs - starting.backgroundPartialDurationMs;
  return {
    state: "available",
    durationMs,
    percentOfMeasurement: rounded(durationMs / (durationSeconds * 1_000) * 100),
  };
}

function numericSummary(values: number[]): NumericSummary | null {
  if (!values.length || values.some((value) => !Number.isFinite(value) || value < 0)) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const p95Index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
  return {
    mean: rounded(sorted.reduce((total, value) => total + value, 0) / sorted.length),
    p95: rounded(sorted[p95Index]!),
    max: rounded(sorted[sorted.length - 1]!),
  };
}

function minimumCheck(metric: string, observed: number | null, requirement: number): GateCheck {
  return {
    metric,
    outcome: observed !== null && observed >= requirement ? "pass" : "fail",
    observed,
    requirement,
  };
}

function maximumCheck(metric: string, observed: number | null, requirement: number): GateCheck {
  return {
    metric,
    outcome: observed !== null && observed <= requirement ? "pass" : "fail",
    observed,
    requirement,
  };
}

function equalityCheck(metric: string, observed: string, requirement: string): GateCheck {
  return {
    metric,
    outcome: observed === requirement ? "pass" : "fail",
    observed,
    requirement,
  };
}

function exactIntegerMatch(output: string, pattern: RegExp): number | null {
  const match = pattern.exec(output);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function diagnosticInteger(raw: string): number {
  const value = Number(raw.replaceAll(",", ""));
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AndroidFieldError("Diagnostic integer is invalid");
  }
  return value;
}

function csvInteger(raw: string | undefined): number {
  if (raw === undefined || !/^\d+$/.test(raw)) {
    throw new AndroidFieldError("Battery usage integer is invalid");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new AndroidFieldError("Battery usage integer is invalid");
  return value;
}

function percentage(numerator: number, denominator: number): number {
  return rounded(denominator === 0 ? 0 : numerator / denominator * 100);
}

function rounded(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function boundedText(value: string, label: string): void {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_ADB_OUTPUT_BYTES) {
    throw new AndroidFieldError(`${label} exceeded its size limit`);
  }
}
