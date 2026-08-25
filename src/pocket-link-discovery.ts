import Bonjour from "bonjour-service";

export const POCKET_LINK_DISCOVERY_SERVICE_TYPE = "codexpocket";
export const POCKET_LINK_DISCOVERY_PROTOCOL_VERSION = "1";

interface PublishedService {
  stop: CallableFunction;
}

interface BonjourClient {
  publish(options: {
    name: string;
    type: string;
    protocol: "tcp";
    port: number;
    txt: { v: string };
    probe: boolean;
  }): PublishedService;
  destroy(callback?: CallableFunction): void;
}

export interface PocketLinkDiscoveryAdvertisement {
  close(): void;
}

export interface PocketLinkDiscoveryAdvertisementOptions {
  deviceName: string;
  port: number;
  onError?: () => void;
  createBonjour?: (onError: () => void) => BonjourClient;
}

export function pocketLinkDiscoveryEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  const value = environment.CODEX_POCKET_LINK_DISCOVERY;
  if (value === undefined || value === "" || value === "0") return false;
  if (value === "1") return true;
  throw new Error("CODEX_POCKET_LINK_DISCOVERY must be 0 or 1");
}

export function startPocketLinkDiscoveryAdvertisement(
  options: PocketLinkDiscoveryAdvertisementOptions,
): PocketLinkDiscoveryAdvertisement {
  const name = normalizedDeviceName(options.deviceName);
  if (!Number.isInteger(options.port) || options.port < 1_024 || options.port > 65_535) {
    throw new Error("PocketLink discovery port is invalid");
  }
  const onError = once(options.onError ?? (() => undefined));
  const createBonjour = options.createBonjour
    ?? ((errorCallback: () => void): BonjourClient => new Bonjour(undefined, errorCallback));
  const bonjour = createBonjour(onError);
  let service: PublishedService;
  try {
    service = bonjour.publish({
      name,
      type: POCKET_LINK_DISCOVERY_SERVICE_TYPE,
      protocol: "tcp",
      port: options.port,
      txt: { v: POCKET_LINK_DISCOVERY_PROTOCOL_VERSION },
      probe: true,
    });
  } catch (error) {
    try { bonjour.destroy(); } catch { /* already closed */ }
    throw error;
  }

  let closed = false;
  return {
    close() {
      if (closed) return;
      closed = true;
      try {
        service.stop();
      } finally {
        bonjour.destroy();
      }
    },
  };
}

function normalizedDeviceName(value: string): string {
  const name = value.normalize("NFC").trim();
  if (!name || name.length > 60 || /[\p{Cc}\p{Cf}]/u.test(name)) {
    throw new Error("PocketLink discovery device name is invalid");
  }
  return name;
}

function once(callback: () => void): () => void {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    callback();
  };
}
