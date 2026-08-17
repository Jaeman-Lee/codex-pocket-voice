export const APP_VERSION = "1.7.1";
export const GATEWAY_PROTOCOL_VERSION = 2;
export const GATEWAY_PROTOCOL_MINIMUM = 2;

export const GATEWAY_CAPABILITIES = {
  securePairing: true,
  dynamicDevices: true,
  encryptedJournal: true,
  providerRegistry: true,
  mediaPersistence: false,
} as const;
