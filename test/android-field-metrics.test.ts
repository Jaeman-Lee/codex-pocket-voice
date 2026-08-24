import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ANDROID_RELEASE_THRESHOLDS,
  AndroidFieldError,
  evaluateAndroidReleaseGate,
  measureAndroidFieldAcceptance,
  parseBatterySnapshot,
  parseCpuInfo,
  parseInstalledApkDigest,
  parseInstalledApkPath,
  parseMemoryInfo,
  parsePackageIdentity,
  parseWakeSnapshot,
  requireUnusedAndroidFieldReport,
  selectAdbDevice,
  writeAndroidFieldReport,
  type AdbExecutor,
  type AndroidFieldReport,
} from "../src/android-field-metrics.js";
import type { FunctionalCandidateIdentity } from "../src/functional-field-acceptance.js";

const packageName = "io.github.jaemanlee.codexpocketvoice.stable";
const privateSerial = "device-secret-serial";
const candidate: FunctionalCandidateIdentity = {
  applicationId: packageName,
  version: "2.0.0",
  versionCode: 20_000,
  channel: "stable",
  commit: "a".repeat(40),
  manifestSha256: "b".repeat(64),
  apkSha256: "c".repeat(64),
  signingCertificateSha256: "d".repeat(64),
};

test("Android field parsers accept bounded API 30 diagnostics and exact app processes", () => {
  assert.deepEqual(parsePackageIdentity(`
    userId=10123
    codePath=/data/app/private-install-path
    versionCode=20000 minSdk=24 targetSdk=36
    versionName=2.0.0
  `), { userId: 10123, versionCode: 20000, versionName: "2.0.0" });
  assert.equal(parseCpuInfo(`
    Load: 1.0 / 2.0 / 3.0
     +1.25% 111/${packageName}: 1% user + 0.25% kernel
     -0.75% 112/${packageName}:pocket_link: 0.5% user + 0.25% kernel
      88% 113/${packageName}.lookalike: 40% user + 48% kernel
      15% TOTAL: 12% user + 3% kernel
  `, packageName), 2);
  assert.equal(parseCpuInfo("CPU usage from 10ms to 0ms ago:\nTOTAL: 0% user + 0% kernel\n", packageName), 0);
  assert.deepEqual(parseMemoryInfo(`
    ** MEMINFO in pid 111 [${packageName}] **
    App Summary
      TOTAL PSS: 102,400            TOTAL RSS: 204,800       TOTAL SWAP PSS: 0
  `), { pssKib: 102_400, rssKib: 204_800 });
  assert.deepEqual(parseMemoryInfo(`
                         Pss  Private  Private
                       Total    Dirty    Clean
                       ------   ------   ------
             TOTAL     98304    65536     4096
  `), { pssKib: 98_304, rssKib: null });
  assert.equal(parseMemoryInfo(`No process found for: ${packageName}`), null);
  const installedPath = "/data/app/~~private-token==/io.github.jaemanlee.codexpocketvoice.stable-private==/base.apk";
  assert.equal(parseInstalledApkPath(`package:${installedPath}\n`), installedPath);
  assert.equal(
    parseInstalledApkDigest(`${candidate.apkSha256}  ${installedPath}\n`, installedPath),
    candidate.apkSha256,
  );
  assert.throws(
    () => parseInstalledApkPath(`package:${installedPath}\npackage:/data/app/private/split.apk\n`),
    /path could not be verified/,
  );
  assert.throws(
    () => parseInstalledApkDigest(`${candidate.apkSha256}  /data/app/other/base.apk\n`, installedPath),
    /digest could not be verified/,
  );
});

test("battery and aggregate wake parsers reject unsupported or ambiguous evidence", () => {
  assert.deepEqual(parseBatterySnapshot(`
    AC powered: false
    USB powered: false
    Wireless powered: false
    status: 3
    level: 79
    scale: 100
  `), { levelPercent: 79, discharging: true });
  assert.deepEqual(parseWakeSnapshot(`
9,0,i,vers,31,999,REL,REL
9,0,i,uid,10123,${packageName}
9,10123,l,awl,1200,300
9,20123,l,awl,999999,999999
  `, 10123, packageName), { partialDurationMs: 1_200, backgroundPartialDurationMs: 300 });
  assert.deepEqual(parseWakeSnapshot(
    `9,0,i,vers,31,999,REL,REL\n9,0,i,uid,10123,${packageName}\n`,
    10123,
    packageName,
  ), {
    partialDurationMs: 0,
    backgroundPartialDurationMs: 0,
  });
  assert.throws(
    () => parseWakeSnapshot(`9,0,i,vers,20,999,REL,REL\n9,0,i,uid,10123,${packageName}\n`, 10123, packageName),
    /unsupported/,
  );
  assert.throws(
    () => parseWakeSnapshot(
      `9,0,i,vers,31,x,x\n9,0,i,uid,10123,${packageName}\n9,10123,l,awl,1,1\n9,10123,l,awl,2,2\n`,
      10123,
      packageName,
    ),
    /ambiguous/,
  );
  assert.throws(
    () => parseWakeSnapshot("9,0,i,vers,31,x,x\n", 10123, packageName),
    /unsupported/,
  );
  assert.throws(() => parseCpuInfo("private raw output", packageName), /unsupported/);
  assert.throws(() => parseMemoryInfo("private raw output"), /unsupported/);
  assert.throws(() => parseMemoryInfo("x".repeat(1024 * 1024 + 1)), /size limit/);
});

test("device selection requires one ready device and never places its identifier in an error", () => {
  assert.equal(selectAdbDevice(`List of devices attached\n${privateSerial}\tdevice product:private\n`), privateSerial);
  assert.throws(
    () => selectAdbDevice(`List of devices attached\n${privateSerial}\toffline\n`, privateSerial),
    (error: unknown) => error instanceof AndroidFieldError
      && error.message === "Requested ADB device is not ready"
      && !error.message.includes(privateSerial),
  );
  assert.throws(
    () => selectAdbDevice("List of devices attached\na\tdevice\nb\tdevice\n"),
    /Exactly one ready ADB device/,
  );
});

test("field measurement uses only read-only dumpsys queries and emits aggregate privacy-safe evidence", async () => {
  const executor = new FixtureAdbExecutor();
  let monotonic = 0;
  const report = await measureAndroidFieldAcceptance({
    candidate,
    transport: "direct_lan",
    durationSeconds: 60,
    intervalSeconds: 20,
    mode: "observation",
  }, {
    executor,
    monotonicMs: () => monotonic,
    wallClockMs: () => Date.parse("2026-08-25T00:00:00.000Z") + monotonic,
    sleep: async (milliseconds) => { monotonic += milliseconds; },
  });

  assert.equal(report.schemaVersion, 3);
  assert.equal(report.evidenceKind, "adb_aggregate_measurement");
  assert.deepEqual(report.candidate, candidate);
  assert.equal(report.transport, "direct_lan");
  assert.deepEqual(report.testWindow, {
    startedAt: "2026-08-25T00:00:00.000Z",
    completedAt: "2026-08-25T00:01:00.000Z",
  });
  assert.equal(report.measurement.actualDurationSeconds, 60);
  assert.equal(report.measurement.scheduledSamples, 4);
  assert.equal(report.measurement.processPresencePercent, 100);
  assert.equal(report.measurement.cpuCoveragePercent, 100);
  assert.equal(report.cpuPercent?.mean, 2);
  assert.equal(report.cpuPercent?.p95, 2);
  assert.equal(report.memoryMib.pss?.max, 100);
  assert.equal(report.memoryMib.rss?.max, 200);
  assert.deepEqual(report.battery, {
    state: "discharging",
    levelDropPercent: 1,
    percentPerHour: 60,
  });
  assert.deepEqual(report.backgroundWake, {
    state: "available",
    durationMs: 60,
    percentOfMeasurement: 0.1,
  });
  assert.equal(report.gate.outcome, "observation_only");
  assert.deepEqual(report.app, {
    packageName,
    versionName: "2.0.0",
    versionCode: 20_000,
    apkSha256: candidate.apkSha256,
    digestVerifiedAtStartAndEnd: true,
  });

  const serialized = JSON.stringify(report);
  for (const secret of [privateSerial, "private-install-path", "private-wifi", "10123"]) {
    assert.doesNotMatch(serialized, new RegExp(secret));
  }
  assert.deepEqual(report.privacy, {
    containsDeviceIdentifiers: false,
    containsRawAdbOutput: false,
    containsNetworkValues: false,
  });
  const shellCalls = executor.calls.filter((args) => args.includes("shell"));
  assert.ok(shellCalls.length > 0);
  for (const args of shellCalls) {
    const command = args.slice(args.indexOf("shell") + 1);
    assert.ok(
      command[0] === "dumpsys"
      || (command[0] === "pm" && command[1] === "path" && command[2] === packageName)
      || (command[0] === "toybox" && command[1] === "sha256sum"),
    );
    assert.ok(!args.includes("--reset"));
    assert.ok(!args.includes("--checkin"));
  }
  assert.equal(shellCalls.filter((args) => args.includes("pm") && args.includes("path")).length, 2);
  assert.equal(shellCalls.filter((args) => args.includes("sha256sum")).length, 2);
  const wakeCalls = shellCalls.filter((args) => args.includes("batterystats"));
  assert.equal(wakeCalls.length, 2);
  assert.ok(wakeCalls.every((args) => args.includes("-c") && args.includes("--charged")));
});

test("release verdict enforces every documented low-load threshold and fails unavailable evidence", () => {
  const passing = passingReport();
  const passed = evaluateAndroidReleaseGate(passing, "release_gate");
  assert.equal(passed.passed, true);
  assert.equal(passed.checks.length, 10);
  assert.deepEqual(passed.thresholds, ANDROID_RELEASE_THRESHOLDS);

  const failing = structuredClone(passing);
  failing.measurement.cpuCoveragePercent = 90;
  failing.cpuPercent = null;
  failing.battery.state = "not_discharging";
  failing.battery.percentPerHour = null;
  failing.backgroundWake.state = "counter_reset";
  failing.backgroundWake.percentOfMeasurement = null;
  const failed = evaluateAndroidReleaseGate(failing, "release_gate");
  assert.equal(failed.passed, false);
  assert.deepEqual(
    failed.checks.filter((check) => check.outcome === "fail").map((check) => check.metric),
    [
      "cpu_coverage_percent",
      "cpu_p95_percent",
      "battery_state",
      "battery_percent_per_hour",
      "background_wake_state",
      "background_wake_percent",
    ],
  );
});

test("field measurement rejects an unbound candidate or unknown transport before ADB", async () => {
  const executor: AdbExecutor = {
    async execute() {
      throw new Error("ADB must not run for invalid field identity");
    },
  };
  await assert.rejects(
    measureAndroidFieldAcceptance({
      candidate: { ...candidate, apkSha256: "invalid" },
      transport: "direct_lan",
      durationSeconds: 60,
      intervalSeconds: 20,
      mode: "observation",
    }, { executor }),
    /candidate identity is invalid/,
  );
  await assert.rejects(
    measureAndroidFieldAcceptance({
      candidate,
      transport: "ssh" as never,
      durationSeconds: 60,
      intervalSeconds: 20,
      mode: "observation",
    }, { executor }),
    /transport is invalid/,
  );
});

test("field measurement rejects an installed APK digest mismatch before sampling and after an in-place change", async () => {
  let slept = false;
  await assert.rejects(
    measureAndroidFieldAcceptance({
      candidate,
      transport: "direct_lan",
      durationSeconds: 60,
      intervalSeconds: 20,
      mode: "observation",
    }, {
      executor: new FixtureAdbExecutor(["e".repeat(64)]),
      monotonicMs: () => 0,
      wallClockMs: () => Date.parse("2026-08-25T00:00:00.000Z"),
      sleep: async () => { slept = true; },
    }),
    /Installed APK does not match the signed candidate/,
  );
  assert.equal(slept, false);

  let monotonic = 0;
  await assert.rejects(
    measureAndroidFieldAcceptance({
      candidate,
      transport: "p2p",
      durationSeconds: 60,
      intervalSeconds: 20,
      mode: "observation",
    }, {
      executor: new FixtureAdbExecutor([candidate.apkSha256, "f".repeat(64)]),
      monotonicMs: () => monotonic,
      wallClockMs: () => Date.parse("2026-08-25T00:00:00.000Z") + monotonic,
      sleep: async (milliseconds) => { monotonic += milliseconds; },
    }),
    /Installed APK does not match the signed candidate/,
  );
});

test("field report is owner-only, create-once, bounded, and contains no raw fixture values", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-pocket-android-field-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "report.json");
  await requireUnusedAndroidFieldReport(path);
  await writeAndroidFieldReport(path, passingReport());
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const text = await readFile(path, "utf8");
  assert.equal(JSON.parse(text).kind, "android_field_acceptance");
  assert.doesNotMatch(text, new RegExp(privateSerial));
  await assert.rejects(requireUnusedAndroidFieldReport(path), /already exists/);
  await assert.rejects(writeAndroidFieldReport(path, passingReport()), /could not be written/);
});

test("ADB failures are redacted before they cross the measurement boundary", async () => {
  const executor: AdbExecutor = {
    async execute() {
      throw new Error(`offline ${privateSerial} private-wifi`);
    },
  };
  await assert.rejects(
    measureAndroidFieldAcceptance({
      candidate,
      transport: "p2p",
      durationSeconds: 60,
      intervalSeconds: 20,
      mode: "observation",
    }, { executor }),
    (error: unknown) => error instanceof AndroidFieldError
      && error.message === "ADB query failed"
      && !error.message.includes(privateSerial)
      && !error.message.includes("private-wifi"),
  );
});

class FixtureAdbExecutor implements AdbExecutor {
  readonly calls: string[][] = [];
  private batteryReads = 0;
  private wakeReads = 0;
  private apkDigestReads = 0;

  constructor(private readonly apkDigests: readonly string[] = [candidate.apkSha256]) {}

  async execute(readonlyArgs: readonly string[]): Promise<string> {
    const args = [...readonlyArgs];
    this.calls.push(args);
    if (args.length === 1 && args[0] === "devices") {
      return `List of devices attached\n${privateSerial}\tdevice product:private-wifi model:private\n`;
    }
    if (args.includes("package")) {
      return `userId=10123\ncodePath=/data/app/private-install-path\nversionCode=20000 minSdk=24\nversionName=2.0.0\n`;
    }
    if (args.includes("pm") && args.includes("path")) {
      return "package:/data/app/~~private-token==/private-install-path/base.apk\n";
    }
    if (args.includes("sha256sum")) {
      const digest = this.apkDigests[Math.min(this.apkDigestReads, this.apkDigests.length - 1)]!;
      this.apkDigestReads += 1;
      return `${digest}  /data/app/~~private-token==/private-install-path/base.apk\n`;
    }
    if (args.includes("cpuinfo")) {
      return `1.5% 111/${packageName}: 1% user + 0.5% kernel\n0.5% 112/${packageName}:pocket: 0.5% user\n20% TOTAL: 15% user + 5% kernel\n`;
    }
    if (args.includes("meminfo")) {
      return `TOTAL PSS: 102400 TOTAL RSS: 204800 TOTAL SWAP PSS: 0\n`;
    }
    if (args.includes("batterystats")) {
      this.wakeReads += 1;
      const total = this.wakeReads === 1 ? 1_000 : 1_100;
      const background = this.wakeReads === 1 ? 400 : 460;
      return `9,0,i,vers,31,999,REL,REL\n9,0,i,uid,10123,${packageName}\n9,10123,l,awl,${total},${background}\n`;
    }
    if (args.includes("battery")) {
      this.batteryReads += 1;
      const level = this.batteryReads === 1 ? 80 : 79;
      return `AC powered: false\nUSB powered: false\nWireless powered: false\nstatus: 3\nlevel: ${level}\nscale: 100\n`;
    }
    throw new Error("unexpected private command");
  }
}

function passingReport(): AndroidFieldReport {
  return {
    schemaVersion: 3,
    kind: "android_field_acceptance",
    evidenceKind: "adb_aggregate_measurement",
    candidate,
    transport: "outbound_relay",
    testWindow: {
      startedAt: "2026-08-25T00:00:00.000Z",
      completedAt: "2026-08-25T01:00:01.000Z",
    },
    app: {
      packageName,
      versionName: "2.0.0",
      versionCode: 20_000,
      apkSha256: candidate.apkSha256,
      digestVerifiedAtStartAndEnd: true,
    },
    measurement: {
      requestedDurationSeconds: 3_600,
      actualDurationSeconds: 3_601,
      intervalSeconds: 15,
      scheduledSamples: 241,
      processPresencePercent: 100,
      cpuCoveragePercent: 100,
      memoryCoveragePercent: 100,
    },
    cpuPercent: { mean: 1, p95: 2, max: 4 },
    memoryMib: {
      pss: { mean: 100, p95: 120, max: 150 },
      rss: { mean: 150, p95: 175, max: 190 },
    },
    battery: { state: "discharging", levelDropPercent: 2, percentPerHour: 2 },
    backgroundWake: { state: "available", durationMs: 36_000, percentOfMeasurement: 1 },
    gate: {
      mode: "observation",
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
}
