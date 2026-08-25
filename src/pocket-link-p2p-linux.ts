import { execFile, spawn, type ChildProcess } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";

const GO_ADDRESS = "192.168.49.1";
const GO_CIDR = `${GO_ADDRESS}/24`;
const DHCP_RANGE = "192.168.49.2,192.168.49.9,255.255.255.0,5m";
const MAX_COMMAND_BYTES = 64 * 1024;
const MAX_EVENT_LINE_BYTES = 8 * 1024;
const COMMAND_TIMEOUT_MS = 5_000;
const MONITOR_READY_TIMEOUT_MS = 3_000;
const DHCP_READY_DELAY_MS = 250;
const CHILD_CLOSE_TIMEOUT_MS = 1_000;
const FORMATION_TIMEOUT_MS = 30_000;
const SYSTEM_EXECUTABLE_DIRECTORIES = ["/usr/sbin", "/usr/bin", "/sbin", "/bin"] as const;

export interface LinuxPocketLinkP2pConfig {
  interfaceName: string;
  companionHost: "0.0.0.0";
  companionPort: number;
  acceptTimeoutMs: number;
  formationTimeoutMs: number;
  sessionTimeoutMs: number;
}

export type LinuxPocketLinkP2pStatus =
  | "preflight"
  | "accepting"
  | "forming"
  | "ready"
  | "cleaning";

export interface LinuxPocketLinkP2pResult {
  groupInterface: string;
  reason: "signal" | "session_timeout" | "group_removed";
}

export type LinuxPocketLinkP2pEvent =
  | { type: "pbc_request"; peerAddress: string }
  | { type: "group_started"; interfaceName: string; role: "GO" | "client" }
  | { type: "group_removed"; interfaceName: string; role: "GO" | "client" }
  | { type: "formation_failed" };

export interface LinuxPocketLinkP2pMonitor {
  close(): Promise<void>;
}

export interface LinuxPocketLinkDhcpService {
  failure: Promise<never>;
  close(): Promise<void>;
}

export interface LinuxPocketLinkP2pPlatform {
  preflight(): Promise<void>;
  startMonitor(
    onLine: (line: string) => void,
    onFailure: (error: Error) => void,
  ): Promise<LinuxPocketLinkP2pMonitor>;
  listen(seconds: number): Promise<void>;
  connect(peerAddress: string): Promise<void>;
  stopFind(): Promise<void>;
  removeGroup(interfaceName: string): Promise<void>;
  configureGroup(interfaceName: string): Promise<void>;
  removeGroupAddress(interfaceName: string): Promise<void>;
  startDhcp(interfaceName: string): Promise<LinuxPocketLinkDhcpService>;
  verifyCompanion(): Promise<void>;
}

export interface RunLinuxPocketLinkP2pOptions {
  signal?: AbortSignal;
  onStatus?: (status: LinuxPocketLinkP2pStatus) => void;
  platform?: LinuxPocketLinkP2pPlatform;
}

export function loadLinuxPocketLinkP2pConfig(
  environment: NodeJS.ProcessEnv = process.env,
): LinuxPocketLinkP2pConfig {
  if (environment.CODEX_POCKET_P2P_ENABLE !== "1") {
    throw new Error("CODEX_POCKET_P2P_ENABLE must be 1 for an explicit P2P session");
  }
  const interfaceName = requiredInterfaceName(environment.CODEX_POCKET_P2P_INTERFACE);
  if (environment.CODEX_POCKET_LINK_HOST !== "0.0.0.0") {
    throw new Error("CODEX_POCKET_LINK_HOST must be 0.0.0.0 for PocketLink P2P");
  }
  return {
    interfaceName,
    companionHost: "0.0.0.0",
    companionPort: boundedInteger(
      environment.CODEX_POCKET_LINK_PORT,
      8_789,
      1_024,
      65_535,
      "CODEX_POCKET_LINK_PORT",
    ),
    acceptTimeoutMs: boundedInteger(
      environment.CODEX_POCKET_P2P_ACCEPT_SECONDS,
      120,
      30,
      300,
      "CODEX_POCKET_P2P_ACCEPT_SECONDS",
    ) * 1_000,
    formationTimeoutMs: FORMATION_TIMEOUT_MS,
    sessionTimeoutMs: boundedInteger(
      environment.CODEX_POCKET_P2P_SESSION_SECONDS,
      900,
      60,
      14_400,
      "CODEX_POCKET_P2P_SESSION_SECONDS",
    ) * 1_000,
  };
}

export function parseLinuxPocketLinkP2pEvent(rawLine: string): LinuxPocketLinkP2pEvent | undefined {
  if (Buffer.byteLength(rawLine, "utf8") > MAX_EVENT_LINE_BYTES) return undefined;
  const line = rawLine
    .replace(/^\s*>\s*/, "")
    .replace(/^IFNAME=[^\s]+\s+/, "")
    .replace(/^<\d+>/, "")
    .trim();
  let match = line.match(/^P2P-PROV-DISC-PBC-REQ\s+([0-9A-Fa-f:]{17})(?:\s|$)/);
  if (match) {
    const peerAddress = match[1]!.toLowerCase();
    if (!isUnicastMacAddress(peerAddress)) return undefined;
    return { type: "pbc_request", peerAddress };
  }
  match = line.match(/^P2P-GROUP-STARTED\s+([^\s]+)\s+(GO|client)(?:\s|$)/);
  if (match && isInterfaceName(match[1]!)) {
    return {
      type: "group_started",
      interfaceName: match[1]!,
      role: match[2]! as "GO" | "client",
    };
  }
  match = line.match(/^P2P-GROUP-REMOVED\s+([^\s]+)\s+(GO|client)(?:\s|$)/);
  if (match && isInterfaceName(match[1]!)) {
    return {
      type: "group_removed",
      interfaceName: match[1]!,
      role: match[2]! as "GO" | "client",
    };
  }
  if (/^P2P-GROUP-FORMATION-FAILURE(?:\s|$)/.test(line)
      || /^P2P-GO-NEG-FAILURE(?:\s|$)/.test(line)) {
    return { type: "formation_failed" };
  }
  return undefined;
}

export function pocketLinkDnsmasqArgs(interfaceName: string): string[] {
  const safeInterface = requiredInterfaceName(interfaceName);
  return [
    "--conf-file=/dev/null",
    "--keep-in-foreground",
    "--pid-file",
    "--port=0",
    `--interface=${safeInterface}`,
    "--bind-interfaces",
    `--dhcp-range=${DHCP_RANGE}`,
    "--dhcp-option=option:router",
    "--dhcp-option=option:dns-server",
    "--dhcp-lease-max=1",
    "--leasefile-ro",
    "--quiet-dhcp",
  ];
}

export async function runLinuxPocketLinkP2p(
  config: LinuxPocketLinkP2pConfig,
  options: RunLinuxPocketLinkP2pOptions = {},
): Promise<LinuxPocketLinkP2pResult> {
  assertRuntimeConfig(config);
  const platform = options.platform ?? await SystemLinuxPocketLinkP2pPlatform.create(config);
  const inbox = new EventInbox();
  let monitor: LinuxPocketLinkP2pMonitor | undefined;
  let dhcp: LinuxPocketLinkDhcpService | undefined;
  let groupInterface: string | undefined;
  let addressConfigured = false;
  let controlTouched = false;
  let ready = false;
  notifyStatus(options.onStatus, "preflight");
  try {
    assertNotAborted(options.signal);
    await platform.preflight();
    assertNotAborted(options.signal);
    monitor = await platform.startMonitor(
      (line) => {
        const event = parseLinuxPocketLinkP2pEvent(line);
        if (event) inbox.push(event);
      },
      (error) => inbox.fail(error),
    );
    controlTouched = true;
    assertNotAborted(options.signal);
    await platform.listen(Math.ceil(config.acceptTimeoutMs / 1_000));
    assertNotAborted(options.signal);
    notifyStatus(options.onStatus, "accepting");

    const peerAddress = await waitForPbcRequest(inbox, config.acceptTimeoutMs, options.signal);
    notifyStatus(options.onStatus, "forming");
    await platform.connect(peerAddress);
    const started = await waitForGroup(inbox, config.formationTimeoutMs, options.signal);
    groupInterface = started.interfaceName;
    if (started.role !== "GO") {
      throw new Error("Linux did not become the PocketLink P2P group owner");
    }
    if (groupInterface === config.interfaceName) {
      throw new Error("PocketLink P2P requires a separate group interface");
    }
    assertNotAborted(options.signal);

    await platform.configureGroup(groupInterface);
    addressConfigured = true;
    assertNotAborted(options.signal);
    dhcp = await platform.startDhcp(groupInterface);
    assertNotAborted(options.signal);
    await platform.verifyCompanion();
    assertNotAborted(options.signal);
    ready = true;
    notifyStatus(options.onStatus, "ready");

    const reason = await Promise.race([
      waitForSessionEnd(inbox, groupInterface, config.sessionTimeoutMs, options.signal),
      dhcp.failure,
    ]);
    return { groupInterface, reason };
  } catch (error) {
    if (isAborted(error) && ready) {
      return { groupInterface: groupInterface!, reason: "signal" };
    }
    throw error;
  } finally {
    notifyStatus(options.onStatus, "cleaning");
    inbox.close();
    let cleanupComplete = await cleanupStep(() => dhcp?.close());
    if (addressConfigured && groupInterface) {
      cleanupComplete = await cleanupStep(() => platform.removeGroupAddress(groupInterface!)) && cleanupComplete;
    }
    if (groupInterface) {
      cleanupComplete = await cleanupStep(() => platform.removeGroup(groupInterface!)) && cleanupComplete;
    }
    if (controlTouched) cleanupComplete = await cleanupStep(() => platform.stopFind()) && cleanupComplete;
    cleanupComplete = await cleanupStep(() => monitor?.close()) && cleanupComplete;
    if (!cleanupComplete) {
      throw new Error("PocketLink P2P cleanup did not complete; inspect the scoped group before retrying");
    }
  }
}

class SystemLinuxPocketLinkP2pPlatform implements LinuxPocketLinkP2pPlatform {
  private constructor(
    private readonly config: LinuxPocketLinkP2pConfig,
    private readonly tools: SystemTools,
  ) {}

  static async create(config: LinuxPocketLinkP2pConfig): Promise<SystemLinuxPocketLinkP2pPlatform> {
    if (process.platform !== "linux") throw new Error("PocketLink P2P group owner requires Linux");
    if (typeof process.geteuid !== "function" || process.geteuid() !== 0) {
      throw new Error("codex-pocket-p2p must run as root in its standalone foreground process");
    }
    const [wpaCli, ip, dnsmasq, nmcli] = await Promise.all([
      resolveSystemExecutable("wpa_cli", true),
      resolveSystemExecutable("ip", true),
      resolveSystemExecutable("dnsmasq", true),
      resolveSystemExecutable("nmcli", false),
    ]);
    return new SystemLinuxPocketLinkP2pPlatform(config, { wpaCli: wpaCli!, ip: ip!, dnsmasq: dnsmasq!, nmcli });
  }

  async preflight(): Promise<void> {
    await this.run(this.tools.ip, ["-Version"], "ip preflight");
    await this.run(this.tools.dnsmasq, ["--version"], "dnsmasq preflight");
    const links = parseJsonArray(await this.run(
      this.tools.ip,
      ["-j", "link", "show", "dev", this.config.interfaceName],
      "P2P interface inspection",
    ), "P2P interface inspection");
    if (links.length !== 1 || links[0]?.ifname !== this.config.interfaceName) {
      throw new Error("CODEX_POCKET_P2P_INTERFACE does not identify one Linux interface");
    }
    if (this.tools.nmcli) {
      const managed = (await this.run(
        this.tools.nmcli,
        ["-t", "-g", "GENERAL.NM-MANAGED", "device", "show", this.config.interfaceName],
        "NetworkManager ownership inspection",
      )).trim().toLowerCase();
      if (managed === "yes") {
        throw new Error("NetworkManager must mark the P2P control interface unmanaged before this session");
      }
      if (managed !== "no") throw new Error("NetworkManager ownership could not be verified");
    }
    const pong = await this.runWpa(["ping"], "wpa_supplicant preflight");
    if (!hasExactLine(pong, "PONG")) throw new Error("wpa_supplicant control interface did not answer PING");
    await this.assertNoSubnetCollision();
  }

  async startMonitor(
    onLine: (line: string) => void,
    onFailure: (error: Error) => void,
  ): Promise<LinuxPocketLinkP2pMonitor> {
    const child = spawn(this.tools.wpaCli, ["-i", this.config.interfaceName], childOptions("pipe"));
    if (!child.stdout || !child.stderr) throw new Error("wpa_cli event monitor pipes are unavailable");
    const stdout = child.stdout;
    const stderr = child.stderr;
    let expectedClose = false;
    let ready = false;
    let buffer = "";
    let readyResolve: (() => void) | undefined;
    let readyReject: ((error: Error) => void) | undefined;
    const readyPromise = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    const fail = () => {
      const error = new Error("wpa_cli event monitor stopped unexpectedly");
      if (!ready) readyReject?.(error);
      if (!expectedClose) onFailure(error);
    };
    stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer, "utf8") > MAX_EVENT_LINE_BYTES && !buffer.includes("\n")) {
        buffer = "";
        if (!expectedClose) onFailure(new Error("wpa_cli event monitor produced an oversized line"));
        child.kill("SIGTERM");
        return;
      }
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (!ready && /Interactive mode/.test(line)) {
          ready = true;
          readyResolve?.();
        }
        onLine(line);
        newline = buffer.indexOf("\n");
      }
    });
    stderr.on("data", () => undefined);
    child.once("error", fail);
    child.once("close", fail);
    const timer = setTimeout(() => readyReject?.(new Error("wpa_cli event monitor did not become ready")), MONITOR_READY_TIMEOUT_MS);
    try {
      await readyPromise;
    } catch (error) {
      expectedClose = true;
      await closeChild(child);
      throw error;
    } finally {
      clearTimeout(timer);
    }
    return {
      close: async () => {
        if (expectedClose) return;
        expectedClose = true;
        await closeChild(child);
      },
    };
  }

  async listen(seconds: number): Promise<void> {
    await this.expectWpaOk(["p2p_listen", String(seconds)], "P2P listen");
  }

  async connect(peerAddress: string): Promise<void> {
    if (!isUnicastMacAddress(peerAddress)) throw new Error("P2P peer address is invalid");
    await this.expectWpaOk(["p2p_connect", peerAddress, "pbc", "go_intent=15"], "P2P connect");
  }

  async stopFind(): Promise<void> {
    await this.expectWpaOk(["p2p_stop_find"], "P2P stop");
  }

  async removeGroup(interfaceName: string): Promise<void> {
    const safeInterface = requiredInterfaceName(interfaceName);
    const available = await this.runWpa(["interface"], "P2P group inspection");
    if (!hasExactLine(available, safeInterface)) return;
    await this.expectWpaOk(["p2p_group_remove", safeInterface], "P2P group removal");
  }

  async configureGroup(interfaceName: string): Promise<void> {
    const safeInterface = requiredInterfaceName(interfaceName);
    const addresses = parseJsonArray(await this.run(
      this.tools.ip,
      ["-j", "-4", "address", "show", "dev", safeInterface],
      "P2P group address inspection",
    ), "P2P group address inspection");
    if (ipv4AddressEntries(addresses).length > 0) {
      throw new Error("P2P group interface already has an IPv4 address");
    }
    await this.run(this.tools.ip, ["link", "set", "dev", safeInterface, "up"], "P2P group link setup");
    await this.run(this.tools.ip, ["address", "add", GO_CIDR, "dev", safeInterface], "P2P group address setup");
  }

  async removeGroupAddress(interfaceName: string): Promise<void> {
    const safeInterface = requiredInterfaceName(interfaceName);
    const links = parseJsonArray(await this.run(
      this.tools.ip,
      ["-j", "link", "show"],
      "P2P group cleanup inspection",
    ), "P2P group cleanup inspection");
    if (!links.some((entry) => entry.ifname === safeInterface)) return;
    const addresses = parseJsonArray(await this.run(
      this.tools.ip,
      ["-j", "-4", "address", "show", "dev", safeInterface],
      "P2P group cleanup address inspection",
    ), "P2P group cleanup address inspection");
    if (!ipv4AddressEntries(addresses).includes(GO_CIDR)) return;
    await this.run(
      this.tools.ip,
      ["address", "delete", GO_CIDR, "dev", safeInterface],
      "P2P group address cleanup",
    );
  }

  async startDhcp(interfaceName: string): Promise<LinuxPocketLinkDhcpService> {
    const child = spawn(this.tools.dnsmasq, pocketLinkDnsmasqArgs(interfaceName), childOptions("ignore"));
    let expectedClose = false;
    let rejected = false;
    let rejectFailure: ((error: Error) => void) | undefined;
    const failure = new Promise<never>((_resolve, reject) => { rejectFailure = reject; });
    const fail = () => {
      if (expectedClose || rejected) return;
      rejected = true;
      rejectFailure?.(new Error("PocketLink P2P DHCP service stopped unexpectedly"));
    };
    child.once("error", fail);
    child.once("close", fail);
    await Promise.race([delay(DHCP_READY_DELAY_MS), failure]);
    return {
      failure,
      close: async () => {
        if (expectedClose) return;
        expectedClose = true;
        await closeChild(child);
      },
    };
  }

  async verifyCompanion(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = connect({ host: GO_ADDRESS, port: this.config.companionPort });
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        error ? reject(error) : resolve();
      };
      socket.setTimeout(2_000, () => finish(new Error("PocketLink Companion is not listening on the P2P interface")));
      socket.once("connect", () => finish());
      socket.once("error", () => finish(new Error("PocketLink Companion is not listening on the P2P interface")));
    });
  }

  private async expectWpaOk(args: string[], label: string): Promise<void> {
    const output = await this.runWpa(args, label);
    if (!hasExactLine(output, "OK")) throw new Error(`${label} was rejected by wpa_supplicant`);
  }

  private runWpa(args: string[], label: string): Promise<string> {
    return this.run(this.tools.wpaCli, ["-i", this.config.interfaceName, ...args], label);
  }

  private run(command: string, args: string[], label: string): Promise<string> {
    return runBoundedCommand(command, args, label);
  }

  private async assertNoSubnetCollision(): Promise<void> {
    const [addresses, routes] = await Promise.all([
      this.run(this.tools.ip, ["-j", "-4", "address", "show"], "IPv4 address inspection"),
      this.run(this.tools.ip, ["-j", "-4", "route", "show", "table", "all"], "IPv4 route inspection"),
    ]);
    const occupied = [
      ...ipv4AddressEntries(parseJsonArray(addresses, "IPv4 address inspection")),
      ...ipv4RouteEntries(parseJsonArray(routes, "IPv4 route inspection")),
    ];
    if (occupied.some((entry) => cidrsOverlap(entry, "192.168.49.0/24"))) {
      throw new Error("PocketLink P2P subnet 192.168.49.0/24 conflicts with an existing route or address");
    }
  }
}

interface SystemTools {
  wpaCli: string;
  ip: string;
  dnsmasq: string;
  nmcli?: string;
}

class EventInbox {
  private readonly events: LinuxPocketLinkP2pEvent[] = [];
  private readonly waiters = new Set<{
    resolve: (event: LinuxPocketLinkP2pEvent | undefined) => void;
    reject: (error: Error) => void;
    finish: () => void;
  }>();
  private failure?: Error;
  private closed = false;

  push(event: LinuxPocketLinkP2pEvent): void {
    if (this.closed || this.failure) return;
    const waiter = this.waiters.values().next().value;
    if (waiter) {
      waiter.finish();
      waiter.resolve(event);
      return;
    }
    this.events.push(event);
  }

  fail(error: Error): void {
    if (this.closed || this.failure) return;
    this.failure = error;
    for (const waiter of [...this.waiters]) {
      waiter.finish();
      waiter.reject(error);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of [...this.waiters]) {
      waiter.finish();
      waiter.reject(new Error("PocketLink P2P event monitor closed"));
    }
  }

  take(timeoutMs: number, signal?: AbortSignal): Promise<LinuxPocketLinkP2pEvent | undefined> {
    if (this.failure) return Promise.reject(this.failure);
    const queued = this.events.shift();
    if (queued) return Promise.resolve(queued);
    if (this.closed) return Promise.reject(new Error("PocketLink P2P event monitor closed"));
    if (signal?.aborted) return Promise.reject(abortedError());
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        this.waiters.delete(waiter);
      };
      const waiter = { resolve, reject, finish };
      const abort = () => {
        finish();
        reject(abortedError());
      };
      const timer = setTimeout(() => {
        finish();
        resolve(undefined);
      }, timeoutMs);
      this.waiters.add(waiter);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
}

async function waitForPbcRequest(
  inbox: EventInbox,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const remaining = Math.max(0, deadline - Date.now());
    if (remaining === 0) throw new Error("PocketLink P2P acceptance window expired");
    const event = await inbox.take(remaining, signal);
    if (!event) throw new Error("PocketLink P2P acceptance window expired");
    if (event.type === "pbc_request") return event.peerAddress;
    if (event.type === "group_started") {
      throw new Error("Another P2P group started during the PocketLink acceptance window");
    }
  }
}

async function waitForGroup(
  inbox: EventInbox,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Extract<LinuxPocketLinkP2pEvent, { type: "group_started" }>> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const remaining = Math.max(0, deadline - Date.now());
    if (remaining === 0) throw new Error("PocketLink P2P group formation timed out");
    const event = await inbox.take(remaining, signal);
    if (!event) throw new Error("PocketLink P2P group formation timed out");
    if (event.type === "group_started") return event;
    if (event.type === "formation_failed" || event.type === "group_removed") {
      throw new Error("PocketLink P2P group formation failed");
    }
  }
}

async function waitForSessionEnd(
  inbox: EventInbox,
  groupInterface: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<LinuxPocketLinkP2pResult["reason"]> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const remaining = Math.max(0, deadline - Date.now());
    if (remaining === 0) return "session_timeout";
    try {
      const event = await inbox.take(remaining, signal);
      if (!event) return "session_timeout";
      if (event.type === "group_removed" && event.interfaceName === groupInterface) return "group_removed";
      if (event.type === "formation_failed") throw new Error("PocketLink P2P group failed after startup");
    } catch (error) {
      if (isAborted(error)) return "signal";
      throw error;
    }
  }
}

function runBoundedCommand(command: string, args: string[], label: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      encoding: "utf8",
      env: systemEnvironment(),
      maxBuffer: MAX_COMMAND_BYTES,
      timeout: COMMAND_TIMEOUT_MS,
      windowsHide: true,
    }, (error, stdout) => {
      if (error) {
        reject(new Error(`${label} failed`));
        return;
      }
      resolve(stdout);
    });
  });
}

async function resolveSystemExecutable(name: string, required: boolean): Promise<string | undefined> {
  for (const directory of SYSTEM_EXECUTABLE_DIRECTORIES) {
    const candidate = join(directory, name);
    try {
      await access(candidate, fsConstants.X_OK);
      const resolved = await realpath(candidate);
      const info = await stat(resolved);
      if (!info.isFile() || info.uid !== 0 || (info.mode & 0o022) !== 0) continue;
      if (!SYSTEM_EXECUTABLE_DIRECTORIES.some((allowed) => resolved === join(allowed, name))) continue;
      return resolved;
    } catch {
      // Try the next fixed system location.
    }
  }
  if (required) throw new Error(`${name} is required in a root-owned system executable directory`);
  return undefined;
}

function childOptions(input: "pipe" | "ignore") {
  return {
    env: systemEnvironment(),
    shell: false as const,
    stdio: [input, "pipe", "pipe"] as ["pipe" | "ignore", "pipe", "pipe"],
    windowsHide: true,
  };
}

function systemEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
    LANG: "C",
    LC_ALL: "C",
  };
}

async function closeChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  child.kill("SIGTERM");
  const graceful = await Promise.race([closed.then(() => true), delay(CHILD_CLOSE_TIMEOUT_MS).then(() => false)]);
  if (!graceful && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await closed;
  }
}

function parseJsonArray(value: string, label: string): Array<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length > 4_096
        || parsed.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry))) {
      throw new Error("invalid shape");
    }
    return parsed as Array<Record<string, unknown>>;
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

function ipv4AddressEntries(entries: Array<Record<string, unknown>>): string[] {
  const result: string[] = [];
  for (const entry of entries) {
    const info = entry.addr_info;
    if (!Array.isArray(info) || info.length > 256) continue;
    for (const address of info) {
      if (!address || typeof address !== "object" || Array.isArray(address)) continue;
      const fields = address as Record<string, unknown>;
      if (fields.family !== "inet" || typeof fields.local !== "string" || !Number.isInteger(fields.prefixlen)) continue;
      const prefix = fields.prefixlen as number;
      if (prefix < 0 || prefix > 32 || !parseIpv4(fields.local)) continue;
      result.push(`${fields.local}/${prefix}`);
    }
  }
  return result;
}

function ipv4RouteEntries(entries: Array<Record<string, unknown>>): string[] {
  const result: string[] = [];
  for (const entry of entries) {
    const destination = entry.dst;
    if (typeof destination !== "string" || destination === "default") continue;
    const normalized = destination.includes("/") ? destination : `${destination}/32`;
    if (parseCidr(normalized)) result.push(normalized);
  }
  return result;
}

function cidrsOverlap(left: string, right: string): boolean {
  const a = parseCidr(left);
  const b = parseCidr(right);
  if (!a || !b) return false;
  const prefix = Math.min(a.prefix, b.prefix);
  const mask = prefix === 0 ? 0 : (0xffff_ffff << (32 - prefix)) >>> 0;
  return (a.address & mask) === (b.address & mask);
}

function parseCidr(value: string): { address: number; prefix: number } | undefined {
  const match = value.match(/^([^/]+)\/(\d{1,2})$/);
  if (!match) return undefined;
  const address = parseIpv4(match[1]!);
  const prefix = Number(match[2]);
  if (address === undefined || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return undefined;
  return { address, prefix };
}

function parseIpv4(value: string): number | undefined {
  const parts = value.split(".");
  if (parts.length !== 4) return undefined;
  let result = 0;
  for (const part of parts) {
    if (!/^(?:0|[1-9]\d{0,2})$/.test(part)) return undefined;
    const octet = Number(part);
    if (octet > 255) return undefined;
    result = ((result << 8) | octet) >>> 0;
  }
  return result;
}

function isUnicastMacAddress(value: string): boolean {
  if (!/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(value)) return false;
  const bytes = value.split(":").map((part) => Number.parseInt(part, 16));
  return (bytes[0]! & 1) === 0 && bytes.some((byte) => byte !== 0) && bytes.some((byte) => byte !== 0xff);
}

function requiredInterfaceName(value: string | undefined): string {
  if (!value || !isInterfaceName(value)) throw new Error("CODEX_POCKET_P2P_INTERFACE is invalid");
  return value;
}

function isInterfaceName(value: string): boolean {
  return /^[A-Za-z0-9_.-]{1,15}$/.test(value) && value !== "." && value !== "..";
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`${label} is invalid`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} is invalid`);
  }
  return parsed;
}

function assertRuntimeConfig(config: LinuxPocketLinkP2pConfig): void {
  requiredInterfaceName(config.interfaceName);
  if (config.companionHost !== "0.0.0.0") throw new Error("PocketLink P2P Companion host is invalid");
  for (const [label, value, minimum, maximum] of [
    ["Companion port", config.companionPort, 1_024, 65_535],
    ["accept timeout", config.acceptTimeoutMs, 1, 300_000],
    ["formation timeout", config.formationTimeoutMs, 1, 60_000],
    ["session timeout", config.sessionTimeoutMs, 1, 14_400_000],
  ] as const) {
    if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${label} is invalid`);
  }
}

function hasExactLine(output: string, expected: string): boolean {
  return output.split(/\r?\n/).some((line) => line.trim() === expected);
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortedError();
}

function abortedError(): Error {
  const error = new Error("PocketLink P2P session was cancelled");
  error.name = "AbortError";
  return error;
}

function isAborted(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

async function cleanupStep(action: () => Promise<void> | undefined): Promise<boolean> {
  try {
    await action();
    return true;
  } catch {
    return false;
  }
}

function notifyStatus(
  callback: ((status: LinuxPocketLinkP2pStatus) => void) | undefined,
  status: LinuxPocketLinkP2pStatus,
): void {
  try {
    callback?.(status);
  } catch {
    // Observer failures never alter or interrupt the network lifecycle.
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
