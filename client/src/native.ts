import { Capacitor, registerPlugin } from "@capacitor/core";

interface NativeSpeechResult {
  transcript: string;
  cancelled?: boolean;
}

interface NativeSpeechPlugin {
  listen(options: { language: string; prompt?: string }): Promise<NativeSpeechResult>;
}

interface NativeTunnelPlugin {
  start(): Promise<{ scheduled: boolean }>;
}

export const NativeSpeech = registerPlugin<NativeSpeechPlugin>("PocketSpeech");
export const NativeTunnel = registerPlugin<NativeTunnelPlugin>("PocketTunnel");

export function isNativeApp(): boolean {
  return Capacitor.isNativePlatform();
}
