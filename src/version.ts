export const APP_VERSION = "2.0.0";
export const GATEWAY_PROTOCOL_VERSION = 3;
export const GATEWAY_PROTOCOL_MINIMUM = 2;

export const GATEWAY_CAPABILITIES = {
  securePairing: true,
  dynamicDevices: true,
  encryptedJournal: true,
  providerRegistry: true,
  mediaPersistence: false,
  sessionHandoff: true,
  providerRuntime: true,
  eventReplay: true,
  approvalBroker: true,
  usageAccounting: true,
  journalManagement: true,
  pocketLinkTls: true,
  pocketLinkMtls: true,
} as const;
