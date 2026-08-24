import assert from "node:assert/strict";
import test from "node:test";
import {
  loadLinuxPocketLinkP2pConfig,
  parseLinuxPocketLinkP2pEvent,
  pocketLinkDnsmasqArgs,
  runLinuxPocketLinkP2p,
  type LinuxPocketLinkDhcpService,
  type LinuxPocketLinkP2pConfig,
  type LinuxPocketLinkP2pPlatform,
} from "../src/pocket-link-p2p-linux.js";

const BASE_CONFIG: LinuxPocketLinkP2pConfig = {
  interfaceName: "wlan0",
  companionHost: "0.0.0.0",
  companionPort: 8_789,
  acceptTimeoutMs: 100,
  formationTimeoutMs: 100,
  sessionTimeoutMs: 1_000,
};

test("Linux PocketLink P2P config is explicit, bounded, and requires an IPv4 wildcard listener", () => {
  const config = loadLinuxPocketLinkP2pConfig({
    CODEX_POCKET_P2P_ENABLE: "1",
    CODEX_POCKET_P2P_INTERFACE: "wlp2s0",
    CODEX_POCKET_LINK_HOST: "0.0.0.0",
  });
  assert.deepEqual(config, {
    interfaceName: "wlp2s0",
    companionHost: "0.0.0.0",
    companionPort: 8_789,
    acceptTimeoutMs: 120_000,
    formationTimeoutMs: 30_000,
    sessionTimeoutMs: 900_000,
  });
  const bounded = loadLinuxPocketLinkP2pConfig({
    CODEX_POCKET_P2P_ENABLE: "1",
    CODEX_POCKET_P2P_INTERFACE: "p2p-dev-wlan0",
    CODEX_POCKET_LINK_HOST: "0.0.0.0",
    CODEX_POCKET_LINK_PORT: "9443",
    CODEX_POCKET_P2P_ACCEPT_SECONDS: "30",
    CODEX_POCKET_P2P_SESSION_SECONDS: "14400",
  });
  assert.equal(bounded.companionPort, 9_443);
  assert.equal(bounded.acceptTimeoutMs, 30_000);
  assert.equal(bounded.sessionTimeoutMs, 14_400_000);

  for (const environment of [
    {},
    {
      CODEX_POCKET_P2P_ENABLE: "1",
      CODEX_POCKET_P2P_INTERFACE: "wlan0;reboot",
      CODEX_POCKET_LINK_HOST: "0.0.0.0",
    },
    {
      CODEX_POCKET_P2P_ENABLE: "1",
      CODEX_POCKET_P2P_INTERFACE: "wlan0",
      CODEX_POCKET_LINK_HOST: "127.0.0.1",
    },
    {
      CODEX_POCKET_P2P_ENABLE: "1",
      CODEX_POCKET_P2P_INTERFACE: "wlan0",
      CODEX_POCKET_LINK_HOST: "0.0.0.0",
      CODEX_POCKET_P2P_ACCEPT_SECONDS: "301",
    },
  ]) {
    assert.throws(() => loadLinuxPocketLinkP2pConfig(environment), /P2P|POCKET_LINK_HOST/);
  }
});

test("Linux PocketLink P2P event parser retains only bounded control fields", () => {
  assert.deepEqual(
    parseLinuxPocketLinkP2pEvent(
      "<3>P2P-PROV-DISC-PBC-REQ 02:11:22:33:44:55 p2p_dev_addr=02:11:22:33:44:55 name='Phone'",
    ),
    { type: "pbc_request", peerAddress: "02:11:22:33:44:55" },
  );
  const started = parseLinuxPocketLinkP2pEvent(
    "> <3>P2P-GROUP-STARTED p2p-wlan0-0 GO ssid=\"DIRECT-secret\" passphrase=\"do-not-retain\" go_dev_addr=02:aa:bb:cc:dd:ee",
  );
  assert.deepEqual(started, { type: "group_started", interfaceName: "p2p-wlan0-0", role: "GO" });
  assert.doesNotMatch(JSON.stringify(started), /secret|passphrase|do-not-retain|02:aa/);
  assert.deepEqual(
    parseLinuxPocketLinkP2pEvent("IFNAME=wlan0 <3>P2P-GROUP-REMOVED p2p-wlan0-0 GO"),
    { type: "group_removed", interfaceName: "p2p-wlan0-0", role: "GO" },
  );
  assert.deepEqual(
    parseLinuxPocketLinkP2pEvent("<3>P2P-GROUP-FORMATION-FAILURE reason=FREQ_CONFLICT"),
    { type: "formation_failed" },
  );
  assert.equal(parseLinuxPocketLinkP2pEvent("P2P-PROV-DISC-PBC-REQ 00:00:00:00:00:00"), undefined);
  assert.equal(parseLinuxPocketLinkP2pEvent("P2P-PROV-DISC-PBC-REQ 01:11:22:33:44:55"), undefined);
  assert.equal(parseLinuxPocketLinkP2pEvent(`P2P-GROUP-STARTED ${"x".repeat(16)} GO`), undefined);
  assert.equal(parseLinuxPocketLinkP2pEvent("x".repeat(8_193)), undefined);
});

test("PocketLink P2P DHCP is interface-only, non-routing, non-DNS, and memory-only", () => {
  const args = pocketLinkDnsmasqArgs("p2p-wlan0-0");
  assert.deepEqual(args, [
    "--conf-file=/dev/null",
    "--keep-in-foreground",
    "--pid-file",
    "--port=0",
    "--interface=p2p-wlan0-0",
    "--bind-interfaces",
    "--dhcp-range=192.168.49.2,192.168.49.9,255.255.255.0,5m",
    "--dhcp-option=option:router",
    "--dhcp-option=option:dns-server",
    "--dhcp-lease-max=1",
    "--leasefile-ro",
    "--quiet-dhcp",
  ]);
  assert.doesNotMatch(args.join(" "), /dhcp-script|log-dhcp|server=|resolv-file|router,/);
  assert.throws(() => pocketLinkDnsmasqArgs("wlan0;touch"), /INTERFACE/);
});

test("Linux PocketLink P2P accepts one peer, requires GO, verifies Companion, and cleans in reverse", async () => {
  const platform = new FakePlatform("GO");
  const controller = new AbortController();
  const statuses: string[] = [];
  const result = await runLinuxPocketLinkP2p(BASE_CONFIG, {
    platform,
    signal: controller.signal,
    onStatus(status) {
      statuses.push(status);
      if (status === "ready") controller.abort();
    },
  });
  assert.deepEqual(result, { groupInterface: "p2p-wlan0-0", reason: "signal" });
  assert.deepEqual(statuses, ["preflight", "accepting", "forming", "ready", "cleaning"]);
  assert.deepEqual(platform.calls, [
    "preflight",
    "monitor:start",
    "listen:1",
    "connect:02:11:22:33:44:55",
    "configure:p2p-wlan0-0",
    "dhcp:start:p2p-wlan0-0",
    "companion:verify",
    "dhcp:close",
    "address:remove:p2p-wlan0-0",
    "group:remove:p2p-wlan0-0",
    "find:stop",
    "monitor:close",
  ]);
  assert.doesNotMatch(statuses.join(" "), /02:11|passphrase|peer/i);
});

test("Linux PocketLink P2P rejects a client role before adding IP or DHCP and still removes its group", async () => {
  const platform = new FakePlatform("client");
  await assert.rejects(
    runLinuxPocketLinkP2p(BASE_CONFIG, { platform }),
    /did not become.*group owner/,
  );
  assert.deepEqual(platform.calls, [
    "preflight",
    "monitor:start",
    "listen:1",
    "connect:02:11:22:33:44:55",
    "group:remove:p2p-wlan0-0",
    "find:stop",
    "monitor:close",
  ]);
});

test("Linux PocketLink P2P removes DHCP, address, and group after Companion verification fails", async () => {
  const platform = new FakePlatform("GO", true);
  await assert.rejects(
    runLinuxPocketLinkP2p(BASE_CONFIG, { platform }),
    /Companion verification failed/,
  );
  assert.deepEqual(platform.calls.slice(-5), [
    "dhcp:close",
    "address:remove:p2p-wlan0-0",
    "group:remove:p2p-wlan0-0",
    "find:stop",
    "monitor:close",
  ]);
});

test("Linux PocketLink P2P reports incomplete cleanup after attempting every remaining step", async () => {
  const platform = new FakePlatform("client");
  platform.failStop = true;
  await assert.rejects(
    runLinuxPocketLinkP2p(BASE_CONFIG, { platform }),
    /cleanup did not complete/,
  );
  assert.deepEqual(platform.calls.slice(-3), [
    "group:remove:p2p-wlan0-0",
    "find:stop",
    "monitor:close",
  ]);
});

test("Linux PocketLink P2P acceptance expires without changing a group network", async () => {
  const platform = new FakePlatform(undefined);
  await assert.rejects(
    runLinuxPocketLinkP2p({ ...BASE_CONFIG, acceptTimeoutMs: 10 }, { platform }),
    /acceptance window expired/,
  );
  assert.deepEqual(platform.calls, [
    "preflight",
    "monitor:start",
    "listen:1",
    "find:stop",
    "monitor:close",
  ]);
});

class FakePlatform implements LinuxPocketLinkP2pPlatform {
  readonly calls: string[] = [];
  failStop = false;
  private onLine?: (line: string) => void;

  constructor(
    private readonly role: "GO" | "client" | undefined,
    private readonly failVerify = false,
  ) {}

  async preflight(): Promise<void> { this.calls.push("preflight"); }

  async startMonitor(onLine: (line: string) => void): Promise<{ close(): Promise<void> }> {
    this.calls.push("monitor:start");
    this.onLine = onLine;
    return { close: async () => { this.calls.push("monitor:close"); } };
  }

  async listen(seconds: number): Promise<void> {
    this.calls.push(`listen:${seconds}`);
    if (this.role) {
      this.onLine?.("<3>P2P-PROV-DISC-PBC-REQ 02:11:22:33:44:55 name='not retained'");
    }
  }

  async connect(peerAddress: string): Promise<void> {
    this.calls.push(`connect:${peerAddress}`);
    this.onLine?.(`<3>P2P-GROUP-STARTED p2p-wlan0-0 ${this.role} passphrase=\"not retained\"`);
  }

  async stopFind(): Promise<void> {
    this.calls.push("find:stop");
    if (this.failStop) throw new Error("synthetic cleanup failure");
  }
  async removeGroup(interfaceName: string): Promise<void> { this.calls.push(`group:remove:${interfaceName}`); }
  async configureGroup(interfaceName: string): Promise<void> { this.calls.push(`configure:${interfaceName}`); }
  async removeGroupAddress(interfaceName: string): Promise<void> { this.calls.push(`address:remove:${interfaceName}`); }

  async startDhcp(interfaceName: string): Promise<LinuxPocketLinkDhcpService> {
    this.calls.push(`dhcp:start:${interfaceName}`);
    return {
      failure: new Promise<never>(() => undefined),
      close: async () => { this.calls.push("dhcp:close"); },
    };
  }

  async verifyCompanion(): Promise<void> {
    this.calls.push("companion:verify");
    if (this.failVerify) throw new Error("Companion verification failed");
  }
}
