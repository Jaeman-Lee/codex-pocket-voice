import { registerPlugin } from "@capacitor/core";
import { isNativeApp } from "./native";

interface SecureStoragePlugin {
  get(options: { key: string }): Promise<{ value: string | null }>;
  set(options: { key: string; value: string }): Promise<void>;
  remove(options: { key: string }): Promise<void>;
}

const NativeSecureStorage = registerPlugin<SecureStoragePlugin>("PocketSecureStorage");
const WEB_PREFIX = "codex-pocket-secure:";

export async function secureGet(key: string): Promise<string | null> {
  if (isNativeApp()) return (await NativeSecureStorage.get({ key })).value;
  return localStorage.getItem(`${WEB_PREFIX}${key}`);
}

export async function secureSet(key: string, value: string): Promise<void> {
  if (isNativeApp()) {
    await NativeSecureStorage.set({ key, value });
    return;
  }
  localStorage.setItem(`${WEB_PREFIX}${key}`, value);
}

export async function secureRemove(key: string): Promise<void> {
  if (isNativeApp()) {
    await NativeSecureStorage.remove({ key });
    return;
  }
  localStorage.removeItem(`${WEB_PREFIX}${key}`);
}
