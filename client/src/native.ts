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

interface NativeTunnelPlugin {
  start(): Promise<{ scheduled: boolean; pc?: boolean; manual?: boolean; message?: string }>;
}

export const NativeSpeech = registerPlugin<NativeSpeechPlugin>("PocketSpeech");
export const NativeTunnel = registerPlugin<NativeTunnelPlugin>("PocketTunnel");

export function isNativeApp(): boolean {
  return Capacitor.isNativePlatform();
}
