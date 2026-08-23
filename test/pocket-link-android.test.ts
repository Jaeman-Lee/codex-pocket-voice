import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Android PocketLink keeps encrypted config native and pins a bounded mTLS forwarder", async () => {
  const [manifest, gradle, plugin, service, store, identity, nativeApi, clientApi, app] = await Promise.all([
    source("../android/app/src/main/AndroidManifest.xml"),
    source("../android/app/build.gradle"),
    source("../android/app/src/main/java/io/github/jaemanlee/codexpocketvoice/PocketTunnelPlugin.java"),
    source("../android/app/src/main/java/io/github/jaemanlee/codexpocketvoice/PocketLinkService.java"),
    source("../android/app/src/main/java/io/github/jaemanlee/codexpocketvoice/PocketLinkConfigStore.java"),
    source("../android/app/src/main/java/io/github/jaemanlee/codexpocketvoice/PocketLinkIdentityStore.java"),
    source("../client/src/native.ts"),
    source("../client/src/api.ts"),
    source("../client/src/App.tsx"),
  ]);

  assert.match(manifest, /android:foregroundServiceType="connectedDevice"/);
  assert.match(manifest, /android\.permission\.FOREGROUND_SERVICE_CONNECTED_DEVICE/);
  assert.match(manifest, /android\.permission\.CHANGE_NETWORK_STATE/);
  assert.match(manifest, /android:name="\.PocketLinkService"[\s\S]*android:exported="false"/);
  assert.match(manifest, /android\.permission\.CAMERA/);
  assert.match(manifest, /android\.hardware\.camera" android:required="false"/);
  assert.match(gradle, /zxing-android-embedded:4\.3\.0/);

  assert.match(store, /AndroidKeyStore/);
  assert.match(store, /AES\/GCM\/NoPadding/);
  assert.match(store, /updateAAD\(entry\.getBytes/);
  assert.match(identity, /AndroidKeyStore/);
  assert.match(identity, /KEY_ALGORITHM_EC/);
  assert.match(identity, /secp256r1/);
  assert.match(identity, /PURPOSE_SIGN \| KeyProperties\.PURPOSE_VERIFY/);
  assert.match(identity, /X509KeyManager/);
  assert.match(identity, /SLOT_A = "a"/);
  assert.match(identity, /SLOT_B = "b"/);
  assert.match(identity, /nextSlot/);
  assert.match(identity, /ALIAS_PREFIX \+ localPort \+ "-b"/);
  assert.match(identity, /remove\(localPort, SLOT_A\)[\s\S]*remove\(localPort, SLOT_B\)/);
  assert.doesNotMatch(identity, /getEncoded\(\)|Base64|SharedPreferences/);
  assert.match(store, /identitySlot/);
  assert.match(store, /pendingIdentitySlot/);
  assert.match(store, /effectiveIdentitySlot/);
  assert.match(store, /commitPendingIdentitySlot/);
  assert.doesNotMatch(nativeApi, /privateKey|certificateFile/);
  assert.doesNotMatch(clientApi, /PocketLinkHost|primaryPin|backupPin/);

  assert.match(service, /InetAddress\.getByName\("127\.0\.0\.1"\)/);
  assert.match(service, /MAX_CONNECTIONS_PER_LINK = 8/);
  assert.match(service, /MAX_LINKS = 8/);
  assert.match(service, /newFixedThreadPool\(16\)/);
  assert.match(service, /setEndpointIdentificationAlgorithm\("HTTPS"\)/);
  assert.match(service, /identity\.keyManagers\(\)/);
  assert.match(service, /config\.effectiveIdentitySlot\(\)/);
  assert.match(service, /ACTIVE_IDENTITY_SLOTS/);
  assert.match(service, /checkValidity\(\)/);
  assert.match(service, /getPublicKey\(\)\.getEncoded\(\)/);
  assert.match(service, /MessageDigest\.isEqual/);
  assert.match(service, /matchedPinSlot\.set\("primary"\)/);
  assert.match(service, /matchedPinSlot\.set\("backup"\)/);
  assert.match(service, /socket\.startHandshake\(\);[\s\S]*PIN_OBSERVATIONS\.put/);
  assert.match(service, /pinObservationMatches/);
  assert.doesNotMatch(service, /return true|ALLOW_ALL|TrustAll/);
  assert.doesNotMatch(service, /codex app-server|node |npm |git |ffmpeg|ollama/i);

  assert.match(plugin, /자동으로 SSH 연결로 우회하지 않습니다/);
  assert.match(plugin, /configurePocketLink/);
  assert.match(plugin, /scanPocketLinkQr/);
  assert.match(plugin, /setDesiredBarcodeFormats\(ScanOptions\.QR_CODE\)/);
  assert.match(plugin, /setBarcodeImageEnabled\(false\)/);
  assert.match(plugin, /contents\.length\(\) > 2048/);
  assert.doesNotMatch(plugin, /ONE_D_CODE_TYPES|ALL_CODE_TYPES/);
  assert.match(plugin, /removePocketLink/);
  assert.match(plugin, /stagePocketLinkBackupPin/);
  assert.match(plugin, /clearPocketLinkBackupPin/);
  assert.match(plugin, /promotePocketLinkPin/);
  assert.match(plugin, /preparePocketLinkIdentityRotation/);
  assert.match(plugin, /commitPocketLinkIdentityRotation/);
  assert.match(plugin, /abortPocketLinkIdentityRotation/);
  assert.match(plugin, /identityRotationPending/);
  assert.match(plugin, /identityRotationReady/);
  assert.match(plugin, /PIN_PROMOTION_MAX_AGE_MS = 120_000L/);
  assert.match(plugin, /observationAge < 0 \|\| observationAge > PIN_PROMOTION_MAX_AGE_MS/);
  assert.match(plugin, /PocketLinkService\.error\(localPort\) != null/);
  assert.match(plugin, /withServerPins\(config\.backupPin, ""\)/);
  assert.match(plugin, /retiredPreviousPin/);
  assert.match(plugin, /backupPinConfigured/);
  assert.doesNotMatch(plugin, /result\.put\("(?:primaryPin|backupPin)"/);
  assert.match(plugin, /transport", "termux"/);
  assert.match(plugin, /transport", "pocketlink"/);
  assert.match(nativeApi, /pinSlot\?: "primary" \| "backup"/);
  assert.match(nativeApi, /stagePocketLinkBackupPin/);
  assert.match(nativeApi, /clearPocketLinkBackupPin/);
  assert.match(nativeApi, /promotePocketLinkPin/);
  assert.match(nativeApi, /preparePocketLinkIdentityRotation/);
  assert.match(nativeApi, /commitPocketLinkIdentityRotation/);
  assert.match(nativeApi, /abortPocketLinkIdentityRotation/);
  assert.match(clientApi, /PocketLinkIdentityRotationRequiredError/);
  assert.match(clientApi, /data\.code === "TLS_DEVICE_MISMATCH"[\s\S]*throw new PocketLinkIdentityRotationRequiredError/);
  assert.match(app, /새 pin 확정 · 이전 pin 폐기/);
  assert.match(app, /현재 기본 pin은 유지되며 자동 승격되지 않습니다/);
  assert.match(app, /새 단말 key 생성 · 교체 시작/);
  assert.match(app, /교체 상태 확인 · 계속/);
});

async function source(path: string): Promise<string> {
  return readFile(new URL(path, import.meta.url), "utf8");
}
