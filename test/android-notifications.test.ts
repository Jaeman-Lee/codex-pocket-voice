import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Android work notifications are opt-in, private, bounded, and open only retained operation IDs", async () => {
  const [plugin, activity, manifest, nativeApi, app] = await Promise.all([
    source("../android/app/src/main/java/io/github/jaemanlee/codexpocketvoice/PocketNotificationsPlugin.java"),
    source("../android/app/src/main/java/io/github/jaemanlee/codexpocketvoice/MainActivity.java"),
    source("../android/app/src/main/AndroidManifest.xml"),
    source("../client/src/native.ts"),
    source("../client/src/App.tsx"),
  ]);

  assert.match(manifest, /android\.permission\.POST_NOTIFICATIONS/);
  assert.match(activity, /registerPlugin\(PocketNotificationsPlugin\.class\)/);
  assert.match(activity, /onNewIntent[\s\S]*PocketNotificationsPlugin\.captureIntent/);
  assert.match(plugin, /@Permission\(alias = "notifications"/);
  assert.match(plugin, /NotificationManagerCompat[\s\S]*areNotificationsEnabled/);
  assert.match(plugin, /VISIBILITY_PRIVATE/);
  assert.match(plugin, /MAX_DEVICE_ID = 120/);
  assert.match(plugin, /MAX_OPERATION_ID = 200/);
  assert.match(plugin, /MessageDigest\.isEqual/);
  assert.match(plugin, /new SecureRandom\(\)\.nextBytes/);
  assert.match(plugin, /setPackage\(getContext\(\)\.getPackageName\(\)\)/);
  assert.match(plugin, /FLAG_UPDATE_CURRENT \| PendingIntent\.FLAG_IMMUTABLE/);
  assert.doesNotMatch(plugin, /getString\("(?:prompt|workspace|cwd|finalResponse|redactedSummary)"\)/);

  assert.match(nativeApi, /NativeNotifications/);
  assert.match(nativeApi, /"completed" \| "approval" \| "failed"/);
  assert.match(app, /document\.visibilityState === "visible"/);
  assert.match(app, /replayingEventsRef\.current/);
  assert.match(app, /notificationsEnabledRef\.current/);
  assert.match(app, /listDeviceTargets\(\)\.find\(\(item\) => item\.id === action\.deviceId\)/);
  assert.match(app, /operations\.find\(\(operation\) => operation\.id === action\.operationId\)/);
  assert.match(app, /알림의 작업이 현재 Companion 보존 범위에 없습니다/);
  assert.doesNotMatch(app, /NativeNotifications\.post\(\{[^}]*prompt/);
});

async function source(path: string): Promise<string> {
  return readFile(new URL(path, import.meta.url), "utf8");
}
