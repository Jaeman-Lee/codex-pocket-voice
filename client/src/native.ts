import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";

export interface NativeSpeechResult {
  transcript: string;
}

export interface NativeSpeechState {
  state: "listening" | "processing" | "restarting" | "stopping" | "stopped";
  continuous: boolean;
}

export interface NativeSpeechError {
  message: string;
  recoverable: boolean;
}

interface NativeSpeechPlugin {
  start(options: { language: string; continuous: boolean }): Promise<{ started: boolean; continuous: boolean }>;
  stop(): Promise<void>;
  addListener(eventName: "speechPartial", listener: (event: NativeSpeechResult) => void): Promise<PluginListenerHandle>;
  addListener(eventName: "speechFinal", listener: (event: NativeSpeechResult) => void): Promise<PluginListenerHandle>;
  addListener(eventName: "speechState", listener: (event: NativeSpeechState) => void): Promise<PluginListenerHandle>;
  addListener(eventName: "speechError", listener: (event: NativeSpeechError) => void): Promise<PluginListenerHandle>;
}

export interface NativeTunnelResult {
  scheduled: boolean;
  pc?: boolean;
  manual?: boolean;
  message?: string;
  transport?: "termux" | "pocketlink";
  localPort?: number;
}

export interface PocketLinkStatus {
  configured: boolean;
  running: boolean;
  transport: "termux" | "pocketlink";
  error?: string;
  backupPinConfigured?: boolean;
  identityRotationPending?: boolean;
  identityReady?: boolean;
  identityRotationReady?: boolean;
  pinSlot?: "primary" | "backup";
  pinObservedAt?: number;
}

interface NativeTunnelPlugin {
  scanPocketLinkQr(): Promise<{ cancelled: boolean; value?: string }>;
  start(options?: { localPort?: number }): Promise<NativeTunnelResult>;
  configurePocketLink(options: {
    label: string;
    localPort: number;
    host: string;
    remotePort: number;
    primaryPin: string;
    backupPin?: string;
  }): Promise<{ configured: boolean; transport: "pocketlink"; localPort: number }>;
  removePocketLink(options: { localPort: number }): Promise<void>;
  preparePocketLinkIdentityRotation(options: { localPort: number }): Promise<{
    prepared: boolean;
    resumed: boolean;
  }>;
  commitPocketLinkIdentityRotation(options: { localPort: number }): Promise<{
    committed: boolean;
    retiredPreviousIdentity: boolean;
  }>;
  abortPocketLinkIdentityRotation(options: { localPort: number }): Promise<{
    aborted: boolean;
    retainedPreviousIdentity: boolean;
  }>;
  stagePocketLinkBackupPin(options: { localPort: number; backupPin: string }): Promise<{ staged: boolean }>;
  clearPocketLinkBackupPin(options: { localPort: number }): Promise<{
    cleared: boolean;
    retainedPrimaryPin: boolean;
  }>;
  promotePocketLinkPin(options: { localPort: number }): Promise<{
    promoted: boolean;
    retiredPreviousPin: boolean;
  }>;
  status(options: { localPort: number }): Promise<PocketLinkStatus>;
}

export type NativeNotificationKind = "completed" | "approval" | "failed";
export type NativeNotificationPermission = "granted" | "denied" | "prompt";

export interface NativeNotificationAction {
  pending: boolean;
  deviceId?: string;
  operationId?: string;
}

interface NativeNotificationsPlugin {
  checkPermission(): Promise<{ state: NativeNotificationPermission }>;
  requestPermission(): Promise<{ state: NativeNotificationPermission }>;
  post(options: { kind: NativeNotificationKind; deviceId: string; operationId: string }): Promise<{ posted: boolean }>;
  consumePendingAction(): Promise<NativeNotificationAction>;
}

export const NativeSpeech = registerPlugin<NativeSpeechPlugin>("PocketSpeech");
export const NativeTunnel = registerPlugin<NativeTunnelPlugin>("PocketTunnel");
export const NativeNotifications = registerPlugin<NativeNotificationsPlugin>("PocketNotifications");

export function isNativeApp(): boolean {
  return Capacitor.isNativePlatform();
}
