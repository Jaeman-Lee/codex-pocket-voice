import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Android PocketLink keeps encrypted config native and pins a bounded mTLS forwarder", async () => {
  const [manifest, plugin, service, store, identity, nativeApi, clientApi] = await Promise.all([
    source("../android/app/src/main/AndroidManifest.xml"),
    source("../android/app/src/main/java/io/github/jaemanlee/codexpocketvoice/PocketTunnelPlugin.java"),
    source("../android/app/src/main/java/io/github/jaemanlee/codexpocketvoice/PocketLinkService.java"),
    source("../android/app/src/main/java/io/github/jaemanlee/codexpocketvoice/PocketLinkConfigStore.java"),
    source("../android/app/src/main/java/io/github/jaemanlee/codexpocketvoice/PocketLinkIdentityStore.java"),
    source("../client/src/native.ts"),
    source("../client/src/api.ts"),
  ]);

  assert.match(manifest, /android:foregroundServiceType="connectedDevice"/);
  assert.match(manifest, /android\.permission\.FOREGROUND_SERVICE_CONNECTED_DEVICE/);
  assert.match(manifest, /android\.permission\.CHANGE_NETWORK_STATE/);
  assert.match(manifest, /android:name="\.PocketLinkService"[\s\S]*android:exported="false"/);

  assert.match(store, /AndroidKeyStore/);
  assert.match(store, /AES\/GCM\/NoPadding/);
  assert.match(store, /updateAAD\(entry\.getBytes/);
  assert.match(identity, /AndroidKeyStore/);
  assert.match(identity, /KEY_ALGORITHM_EC/);
  assert.match(identity, /secp256r1/);
  assert.match(identity, /PURPOSE_SIGN \| KeyProperties\.PURPOSE_VERIFY/);
  assert.match(identity, /X509KeyManager/);
  assert.doesNotMatch(identity, /getEncoded\(\)|Base64|SharedPreferences/);
  assert.doesNotMatch(nativeApi, /privateKey|certificateFile/);
  assert.doesNotMatch(clientApi, /PocketLinkHost|primaryPin|backupPin/);

  assert.match(service, /InetAddress\.getByName\("127\.0\.0\.1"\)/);
  assert.match(service, /MAX_CONNECTIONS_PER_LINK = 8/);
  assert.match(service, /MAX_LINKS = 8/);
  assert.match(service, /newFixedThreadPool\(16\)/);
  assert.match(service, /setEndpointIdentificationAlgorithm\("HTTPS"\)/);
  assert.match(service, /identity\.keyManagers\(\)/);
  assert.match(service, /checkValidity\(\)/);
  assert.match(service, /getPublicKey\(\)\.getEncoded\(\)/);
  assert.match(service, /MessageDigest\.isEqual/);
  assert.doesNotMatch(service, /return true|ALLOW_ALL|TrustAll/);
  assert.doesNotMatch(service, /codex app-server|node |npm |git |ffmpeg|ollama/i);

  assert.match(plugin, /자동으로 SSH 연결로 우회하지 않습니다/);
  assert.match(plugin, /configurePocketLink/);
  assert.match(plugin, /removePocketLink/);
  assert.match(plugin, /transport", "termux"/);
  assert.match(plugin, /transport", "pocketlink"/);
});

async function source(path: string): Promise<string> {
  return readFile(new URL(path, import.meta.url), "utf8");
}
