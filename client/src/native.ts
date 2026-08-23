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
  status(options: { localPort: number }): Promise<PocketLinkStatus>;
}

export const NativeSpeech = registerPlugin<NativeSpeechPlugin>("PocketSpeech");
export const NativeTunnel = registerPlugin<NativeTunnelPlugin>("PocketTunnel");

export function isNativeApp(): boolean {
  return Capacitor.isNativePlatform();
}
