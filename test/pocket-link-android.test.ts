import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Android PocketLink keeps encrypted config native and pins bounded direct or relay mTLS", async () => {
  const [manifest, gradle, plugin, service, store, identity, routePolicy, relayProtocol, discovery, discoveryPolicy, nativeApi, clientApi, app] = await Promise.all([
    source("../android/app/src/main/AndroidManifest.xml"),
    source("../android/app/build.gradle"),
    source("../android/app/src/main/java/io/github/jaemanlee/codexpocketvoice/PocketTunnelPlugin.java"),
    source("../android/app/src/main/java/io/github/jaemanlee/codexpocketvoice/PocketLinkService.java"),
    source("../android/app/src/main/java/io/github/jaemanlee/codexpocketvoice/PocketLinkConfigStore.java"),
    source("../android/app/src/main/java/io/github/jaemanlee/codexpocketvoice/PocketLinkIdentityStore.java"),
    source("../android/app/src/main/java/io/github/jaemanlee/codexpocketvoice/PocketLinkRoutePolicy.java"),
    source("../android/app/src/main/java/io/github/jaemanlee/codexpocketvoice/PocketRelayProtocol.java"),
    source("../android/app/src/main/java/io/github/jaemanlee/codexpocketvoice/PocketLinkNsdDiscovery.java"),
    source("../android/app/src/main/java/io/github/jaemanlee/codexpocketvoice/PocketLinkDiscoveryPolicy.java"),
    source("../client/src/native.ts"),
    source("../client/src/api.ts"),
    source("../client/src/App.tsx"),
  ]);

  assert.match(manifest, /android:foregroundServiceType="connectedDevice"/);
  assert.match(manifest, /android\.permission\.FOREGROUND_SERVICE_CONNECTED_DEVICE/);
  assert.match(manifest, /android\.permission\.CHANGE_NETWORK_STATE/);
  assert.match(manifest, /android\.permission\.CHANGE_WIFI_MULTICAST_STATE/);
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
  assert.match(store, /value\.put\("version", 3\)/);
  assert.match(store, /RelayConfig/);
  assert.match(store, /value\.put\("secret", secret\)/);
  assert.match(store, /value\.put\("route", route\)/);
  assert.match(store, /PocketLinkRoutePolicy\.validateConfiguration/);
  assert.match(routePolicy, /AUTO = "auto"/);
  assert.match(routePolicy, /DIRECT_RETRY_COOLDOWN_MS = 30_000L/);
  assert.match(routePolicy, /Arrays\.asList\(DIRECT, RELAY\)/);
  assert.match(routePolicy, /recordTransportFailure/);
  assert.match(routePolicy, /recordVerifiedRoute/);
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
  assert.match(service, /routePolicy\.attempts\(SystemClock\.elapsedRealtime\(\)\)/);
  assert.match(service, /PocketLinkRoutePolicy\.DIRECT\.equals\(route\)[\s\S]*directTransport[\s\S]*relayTransport/);
  assert.match(service, /recordTransportFailure\(route, SystemClock\.elapsedRealtime\(\)\)/);
  assert.match(service, /companionTlsSocket\(transport, config, identity\)[\s\S]*recordVerifiedRoute\(route\)/);
  assert.match(service, /LAST_VERIFIED_ROUTES\.put\(config\.localPort, verified\.route\)/);
  assert.match(service, /platformTrustManager\(\)/);
  assert.match(service, /platform\.checkServerTrusted\(chain, authType\)/);
  assert.match(service, /RelayPinnedTrustManager/);
  assert.match(service, /PocketRelayProtocol\.attach/);
  assert.match(service, /companionTlsSocket\(transport, config, identity\)/);
  assert.match(service, /pinObservationMatches/);
  assert.doesNotMatch(service, /return true|ALLOW_ALL|TrustAll/);
  assert.doesNotMatch(service, /codex app-server|node |npm |git |ffmpeg|ollama/i);
  assert.match(relayProtocol, /MAX_FRAME_BYTES = 2_048/);
  assert.equal(relayProtocol.includes('role\\":\\"client'), true);
  assert.match(relayProtocol, /validateSlot/);
  assert.match(relayProtocol, /validateSecret/);
  assert.match(relayProtocol, /constantTimeEquals/);
  assert.doesNotMatch(relayProtocol, /BufferedReader|readLine\(/);

  assert.match(discovery, /DISCOVERY_WINDOW_MS = 8_000L/);
  assert.match(discovery, /createMulticastLock\("codex-pocket-link-discovery"\)/);
  assert.match(discovery, /postDelayed\(timeout, DISCOVERY_WINDOW_MS\)/);
  assert.match(discovery, /stopServiceDiscovery\(discoveryListener\)/);
  assert.match(discovery, /MAX_PENDING_SERVICES/);
  assert.match(discovery, /MAX_SEEN_SERVICES/);
  assert.match(discovery, /MAX_CANDIDATES/);
  assert.match(discovery, /getAttributes\(\)/);
  assert.match(discoveryPolicy, /SERVICE_TYPE = "_codexpocket\._tcp\."/);
  assert.match(discoveryPolicy, /attributes\.size\(\) != 1/);
  assert.match(discoveryPolicy, /first == 10/);
  assert.match(discoveryPolicy, /first == 192 && second == 168/);
  assert.match(discoveryPolicy, /\(bytes\[0\] & 0xfe\) == 0xfc/);
  assert.doesNotMatch(discoveryPolicy, /pin|pairing|token|deviceId|workspace/i);

  assert.match(plugin, /자동으로 SSH 연결로 우회하지 않습니다/);
  assert.match(plugin, /configurePocketLink/);
  assert.match(plugin, /scanPocketLinkQr/);
  assert.match(plugin, /discoverPocketLinks/);
  assert.match(plugin, /DISCOVERY_REVIEW_MAX_AGE_MS = 120_000L/);
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
  assert.match(plugin, /PocketLinkRoutePolicy\.RELAY\.equals\(route\) \|\| PocketLinkRoutePolicy\.AUTO\.equals\(route\)/);
  assert.match(plugin, /relayServerPublicKeyPin/);
  assert.match(plugin, /normalizedRelaySecret/);
  assert.match(plugin, /PIN_PROMOTION_MAX_AGE_MS = 120_000L/);
  assert.match(plugin, /observationAge < 0 \|\| observationAge > PIN_PROMOTION_MAX_AGE_MS/);
  assert.match(plugin, /PocketLinkService\.error\(localPort\) != null/);
  assert.match(plugin, /withServerPins\(config\.backupPin, ""\)/);
  assert.match(plugin, /retiredPreviousPin/);
  assert.match(plugin, /backupPinConfigured/);
  assert.match(plugin, /lastVerifiedRoute/);
  assert.doesNotMatch(plugin, /result\.put\("(?:primaryPin|backupPin|relayHost|relaySlot|relaySecret)"/);
  assert.match(plugin, /transport", "termux"/);
  assert.match(plugin, /transport", "pocketlink"/);
  assert.match(nativeApi, /pinSlot\?: "primary" \| "backup"/);
  assert.match(nativeApi, /discoverPocketLinks/);
  assert.match(nativeApi, /stagePocketLinkBackupPin/);
  assert.match(nativeApi, /clearPocketLinkBackupPin/);
  assert.match(nativeApi, /promotePocketLinkPin/);
  assert.match(nativeApi, /preparePocketLinkIdentityRotation/);
  assert.match(nativeApi, /commitPocketLinkIdentityRotation/);
  assert.match(nativeApi, /abortPocketLinkIdentityRotation/);
  assert.match(nativeApi, /PocketLinkRoute = "direct" \| "relay" \| "auto"/);
  assert.match(nativeApi, /lastVerifiedRoute\?: "direct" \| "relay"/);
  assert.match(nativeApi, /relayServerPublicKeyPin/);
  assert.match(nativeApi, /relaySecret\?: string/);
  assert.match(clientApi, /PocketLinkIdentityRotationRequiredError/);
  assert.match(clientApi, /data\.code === "TLS_DEVICE_MISMATCH"[\s\S]*throw new PocketLinkIdentityRotationRequiredError/);
  assert.match(app, /새 pin 확정 · 이전 pin 폐기/);
  assert.match(app, /현재 기본 pin은 유지되며 자동 승격되지 않습니다/);
  assert.match(app, /새 단말 key 생성 · 교체 시작/);
  assert.match(app, /교체 상태 확인 · 계속/);
  assert.match(app, /같은 LAN에서 찾기/);
  assert.match(app, /LAN 주소만 선택됨 · pin은 미확인/);
  assert.match(app, /Companion 화면의 SPKI pin을 직접 대조/);
  assert.match(app, /아웃바운드 릴레이 · 이중 TLS/);
  assert.match(app, /공인 CA hostname과 SPKI pin을 모두 검증/);
  assert.match(app, /두 TLS pin 확인 후 릴레이 등록/);
  assert.match(app, /자동 · LAN 우선, 도달 불가 시 릴레이/);
  assert.match(app, /TLS·pin·mTLS 실패는 우회하지 않으며 SSH로 전환하지 않습니다/);
});

async function source(path: string): Promise<string> {
  return readFile(new URL(path, import.meta.url), "utf8");
}
