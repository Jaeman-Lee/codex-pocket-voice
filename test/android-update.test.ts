import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Android updates require a reviewed, same-signer, higher-version signed bundle", async () => {
  const [activity, manifest, paths, verifier, plugin, nativeApi, app, css] = await Promise.all([
    source("../android/app/src/main/java/io/github/jaemanlee/codexpocketvoice/MainActivity.java"),
    source("../android/app/src/main/AndroidManifest.xml"),
    source("../android/app/src/main/res/xml/file_paths.xml"),
    source("../android/app/src/main/java/io/github/jaemanlee/codexpocketvoice/PocketUpdateVerifier.java"),
    source("../android/app/src/main/java/io/github/jaemanlee/codexpocketvoice/PocketUpdatePlugin.java"),
    source("../client/src/native.ts"),
    source("../client/src/App.tsx"),
    source("../client/src/styles.css"),
  ]);

  assert.match(activity, /registerPlugin\(PocketUpdatePlugin\.class\)/);
  assert.match(manifest, /android\.permission\.REQUEST_INSTALL_PACKAGES/);
  assert.match(manifest, /android:name="androidx\.core\.content\.FileProvider"[\s\S]*android:exported="false"/);
  assert.match(paths, /cache-path name="verified_updates" path="verified-updates\/"/);

  assert.match(plugin, /Intent\.ACTION_OPEN_DOCUMENT/);
  assert.match(plugin, /setType\("application\/zip"\)/);
  assert.match(plugin, /Executors\.newSingleThreadExecutor/);
  assert.match(plugin, /destroyed = true/);
  assert.match(plugin, /if \(destroyed\) \{[\s\S]*deleteDirectory\(bundle\.directory\)/);
  assert.match(plugin, /previous = verifiedUpdate;[\s\S]*deleteDirectory\(previous\.bundle\.directory\)/);
  assert.match(plugin, /REVIEW_MAX_AGE_MS = 10L \* 60L \* 1000L/);
  assert.match(plugin, /new SecureRandom\(\)/);
  assert.match(plugin, /MessageDigest\.isEqual/);
  assert.match(plugin, /PocketUpdateVerifier\.fileSha256\(selected\.bundle\.apk\)/);
  assert.match(plugin, /canRequestPackageInstalls\(\)/);
  assert.match(plugin, /ACTION_MANAGE_UNKNOWN_APP_SOURCES/);
  assert.match(plugin, /Intent\.ACTION_INSTALL_PACKAGE/);
  assert.match(plugin, /FLAG_GRANT_READ_URI_PERMISSION/);
  assert.match(plugin, /FileProvider\.getUriForFile/);
  assert.match(plugin, /discardVerified\(\)[\s\S]*deleteDirectory/);
  assert.doesNotMatch(plugin, /https?:\/\/|DownloadManager|ACTION_VIEW/);

  assert.match(verifier, /MAX_ENTRIES = 6/);
  assert.match(verifier, /MAX_APK_BYTES = 1024L \* 1024L \* 1024L/);
  assert.match(verifier, /MAX_SBOM_BYTES = 64L \* 1024L \* 1024L/);
  assert.match(verifier, /new BoundedInputStream\(source, MAX_ARCHIVE_BYTES\)/);
  assert.match(verifier, /assertSimpleFilename\(name\)/);
  assert.match(verifier, /files\.containsKey\(name\)/);
  assert.match(verifier, /files\.keySet\(\)\.equals\(expectedFiles\)/);
  assert.match(verifier, /update-manifest\.json/);
  assert.match(verifier, /update-manifest\.sig/);
  assert.match(verifier, /update-manifest-cert\.pem/);
  assert.match(verifier, /SHA256SUMS/);
  assert.match(verifier, /signed instanceof Boolean/);
  assert.match(verifier, /SHA256withRSA/);
  assert.match(verifier, /SHA256withECDSA/);
  assert.match(verifier, /certificate\.checkValidity/);
  assert.match(verifier, /currentSigner[\s\S]*certificateSha256/);
  assert.match(verifier, /apkSigner[\s\S]*certificateSha256/);
  assert.match(verifier, /context\.getPackageName\(\)\.equals\(manifest\.applicationId\)/);
  assert.match(verifier, /manifest\.versionCode <= currentVersionCode/);
  assert.match(verifier, /getPackageArchiveInfo/);
  assert.match(verifier, /getApkContentsSigners/);
  assert.match(verifier, /MessageDigest\.isEqual/);
  assert.doesNotMatch(verifier, /allowUnsigned|allowSameVersion|TrustAll|ALLOW_ALL/);

  assert.match(nativeApi, /NativeUpdateReview/);
  assert.match(nativeApi, /selectBundle/);
  assert.match(nativeApi, /installVerified/);
  assert.match(nativeApi, /discard/);
  assert.match(app, /서명과 APK를 확인했습니다/);
  assert.match(app, /취소·파일 폐기/);
  assert.match(app, /검증된 APK 설치 확인/);
  assert.match(app, /Android 시스템 확인 없이 자동 설치하지 않습니다/);
  assert.match(app, /updateReview\.token/);
  assert.match(app, /Date\.now\(\) >= updateReview\.expiresAt/);
  assert.match(css, /\.update-manager \{[^}]*min-width:\s*0/);
  assert.match(css, /\.update-review dd \{[^}]*overflow-wrap:\s*anywhere/);
  assert.match(css, /@media \(max-width: 560px\)[\s\S]*\.update-review-actions \{[^}]*minmax\(0,\s*1fr\)/);
});

async function source(path: string): Promise<string> {
  return readFile(new URL(path, import.meta.url), "utf8");
}
