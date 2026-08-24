import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Android work notifications survive WebView death with encrypted bounded loopback subscriptions", async () => {
  const [plugin, service, reconnectSignal, store, parser, policy, activity, manifest, nativeApi, app, api] = await Promise.all([
    source("../android/app/src/main/java/io/github/jaemanlee/codexpocketvoice/PocketNotificationsPlugin.java"),
    source("../android/app/src/main/java/io/github/jaemanlee/codexpocketvoice/PocketBackgroundEventService.java"),
    source("../android/app/src/main/java/io/github/jaemanlee/codexpocketvoice/PocketReconnectSignal.java"),
    source("../android/app/src/main/java/io/github/jaemanlee/codexpocketvoice/PocketBackgroundEventStore.java"),
    source("../android/app/src/main/java/io/github/jaemanlee/codexpocketvoice/PocketBackgroundEventParser.java"),
    source("../android/app/src/main/java/io/github/jaemanlee/codexpocketvoice/PocketBackgroundEventPolicy.java"),
    source("../android/app/src/main/java/io/github/jaemanlee/codexpocketvoice/MainActivity.java"),
    source("../android/app/src/main/AndroidManifest.xml"),
    source("../client/src/native.ts"),
    source("../client/src/App.tsx"),
    source("../client/src/api.ts"),
  ]);

  assert.match(manifest, /android\.permission\.POST_NOTIFICATIONS/);
  assert.match(manifest, /android\.permission\.ACCESS_NETWORK_STATE/);
  assert.match(manifest, /PocketBackgroundEventService/);
  assert.match(manifest, /android:exported="false"[\s\S]*android:foregroundServiceType="connectedDevice"/);
  assert.match(activity, /registerPlugin\(PocketNotificationsPlugin\.class\)/);
  assert.match(activity, /onCreate[\s\S]*PocketNotificationsPlugin\.captureIntent[\s\S]*super\.onCreate/);
  assert.match(activity, /onNewIntent[\s\S]*PocketNotificationsPlugin\.captureIntent[\s\S]*super\.onNewIntent[\s\S]*setIntent/);
  assert.match(activity, /onStart[\s\S]*setUiVisible\(true\)/);
  assert.match(activity, /onStop[\s\S]*setUiVisible\(false\)/);
  assert.match(plugin, /@Permission\(alias = "notifications"/);
  assert.match(plugin, /NotificationManagerCompat[\s\S]*areNotificationsEnabled/);
  assert.match(plugin, /void configure\(PluginCall call\)/);
  assert.match(plugin, /void disable\(PluginCall call\)/);
  assert.match(plugin, /ContextCompat\.startForegroundService/);
  assert.match(plugin, /VISIBILITY_PRIVATE/);
  assert.match(plugin, /MAX_DEVICE_ID = 120/);
  assert.match(plugin, /MAX_OPERATION_ID = 200/);
  assert.match(plugin, /MessageDigest\.isEqual/);
  assert.match(plugin, /new SecureRandom\(\)\.nextBytes/);
  assert.match(plugin, /createOpenOperationIntent\(context, deviceId, operationId\)/);
  assert.match(plugin, /PendingAction action = takePendingAction\(\)/);
  assert.match(plugin, /finally \{[\s\S]*removeExtra\(EXTRA_ACTION_TOKEN\)[\s\S]*setAction\(Intent\.ACTION_MAIN\)/);
  assert.match(plugin, /setPackage\(context\.getPackageName\(\)\)/);
  assert.match(plugin, /FLAG_UPDATE_CURRENT \| PendingIntent\.FLAG_IMMUTABLE/);
  assert.doesNotMatch(plugin, /getString\("(?:prompt|workspace|cwd|finalResponse|redactedSummary)"\)/);

  assert.match(service, /START_STICKY/);
  assert.match(service, /FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE/);
  assert.match(service, /new URL\([\s\S]*"127\.0\.0\.1"[\s\S]*"\/api\/events\/notifications"/);
  assert.match(service, /setRequestProperty\("Authorization", "Bearer " \+ subscription\.token\)/);
  assert.match(service, /setRequestProperty\("Last-Event-ID"/);
  assert.match(service, /MAX_RETRY_MS = 60_000/);
  assert.match(service, /registerDefaultNetworkCallback\(callback\)/);
  assert.match(service, /onAvailable\(Network network\)[\s\S]*reconnectMonitorsForNetworkChange\(\)/);
  assert.match(service, /onLost\(Network network\)[\s\S]*reconnectMonitorsForNetworkChange\(\)/);
  assert.match(service, /networkChanged\(\)[\s\S]*reconnectSignal\.signal\(\)[\s\S]*current\.disconnect\(\)/);
  assert.match(service, /onDestroy\(\)[\s\S]*stopping\.set\(true\)[\s\S]*unregisterConnectivityCallback\(\)[\s\S]*closeMonitors\(\)/);
  assert.match(service, /private void reload\(\)[\s\S]*if \(stopping\.get\(\)\) return/);
  assert.match(reconnectSignal, /generation == observedGeneration/);
  assert.match(reconnectSignal, /System\.nanoTime\(\)/);
  assert.match(reconnectSignal, /notifyAll\(\)/);
  assert.doesNotMatch(service, /(?:print|Log\.)[^\n]*(?:token|operationId|occurredAt)/i);
  assert.doesNotMatch(service, /prompt|workspace|cwd|finalResponse|redactedSummary/);

  assert.match(store, /AndroidKeyStore/);
  assert.match(store, /AES\/GCM\/NoPadding/);
  assert.match(store, /updateAAD\(AAD\)/);
  assert.match(store, /\.commit\(\)/);
  assert.match(store, /STATE_LOCK/);
  assert.match(store, /MAX_SUBSCRIPTIONS/);
  assert.doesNotMatch(store, /prompt|workspace|cwd|finalResponse|redactedSummary/);
  assert.match(parser, /requireExactKeys/);
  assert.match(parser, /MAX_SSE_LINE_BYTES/);
  assert.match(parser, /MAX_SSE_EVENT_BYTES/);
  assert.match(policy, /MAX_REPLAY_AGE_MS = 10 \* 60_000L/);
  assert.match(policy, /MAX_SUBSCRIPTIONS = 8/);

  assert.match(nativeApi, /NativeNotifications/);
  assert.match(nativeApi, /"completed" \| "approval" \| "failed"/);
  assert.match(nativeApi, /configure\(options: \{ subscriptions: NativeBackgroundEventSubscription\[\] \}\)/);
  assert.match(api, /backgroundEventSubscriptions/);
  assert.match(app, /NativeNotifications\.configure\(\{ subscriptions/);
  assert.match(app, /NativeNotifications\.disable\(\)/);
  assert.match(app, /replayingEventsRef\.current/);
  assert.match(app, /notificationsEnabledRef\.current/);
  assert.match(app, /listDeviceTargets\(\)\.find\(\(item\) => item\.id === action\.deviceId\)/);
  assert.match(app, /operations\.find\(\(operation\) => operation\.id === action\.operationId\)/);
  assert.match(app, /알림의 작업이 현재 Companion 보존 범위에 없습니다/);
  assert.doesNotMatch(app, /NativeNotifications\.post\(/);
});

async function source(path: string): Promise<string> {
  return readFile(new URL(path, import.meta.url), "utf8");
}
