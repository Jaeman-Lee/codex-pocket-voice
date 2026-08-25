import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Android updates require a reviewed, same-signer, higher-version signed bundle", async () => {
  const [activity, manifest, paths, verifier, plugin, officialRelease, releaseClient, nativeApi, app, css, workflow] = await Promise.all([
    source("../android/app/src/main/java/io/github/jaemanlee/codexpocketvoice/MainActivity.java"),
    source("../android/app/src/main/AndroidManifest.xml"),
    source("../android/app/src/main/res/xml/file_paths.xml"),
    source("../android/app/src/main/java/io/github/jaemanlee/codexpocketvoice/PocketUpdateVerifier.java"),
    source("../android/app/src/main/java/io/github/jaemanlee/codexpocketvoice/PocketUpdatePlugin.java"),
    source("../android/app/src/main/java/io/github/jaemanlee/codexpocketvoice/PocketOfficialRelease.java"),
    source("../android/app/src/main/java/io/github/jaemanlee/codexpocketvoice/PocketOfficialReleaseClient.java"),
    source("../client/src/native.ts"),
    source("../client/src/App.tsx"),
    source("../client/src/styles.css"),
    source("../.github/workflows/android-debug.yml"),
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
  assert.match(plugin, /discoverOfficial/);
  assert.match(plugin, /downloadOfficial/);
  assert.match(plugin, /DISCOVERY_MAX_AGE_MS = 10L \* 60L \* 1000L/);
  assert.match(plugin, /discoveredUpdate != selected/);
  assert.match(plugin, /officialReleaseClient\.download\(selected\.candidate/);
  assert.match(plugin, /selected\.candidate\.version\.equals\(bundle\.version\)/);
  assert.doesNotMatch(plugin, /DownloadManager|ACTION_VIEW|browser_download_url/);

  assert.match(officialRelease, /OWNER = "Jaeman-Lee"/);
  assert.match(officialRelease, /REPOSITORY = "codex-pocket-voice"/);
  assert.match(officialRelease, /releases\/latest/);
  assert.match(officialRelease, /Codex-Pocket-Voice-v" \+ version \+ "-update\.zip/);
  assert.match(officialRelease, /application\/zip/);
  assert.match(officialRelease, /sha256:\[a-f0-9\]\{64\}/);
  assert.match(officialRelease, /versionCode <= currentVersionCode/);
  assert.match(officialRelease, /targetHost\.endsWith\("\.githubusercontent\.com"\)/);
  assert.doesNotMatch(officialRelease, /TrustAll|ALLOW_ALL|http:\/\//);

  assert.match(releaseClient, /MAX_RELEASE_JSON_BYTES/);
  assert.match(releaseClient, /setInstanceFollowRedirects\(false\)/);
  assert.match(releaseClient, /application\/octet-stream/);
  assert.match(releaseClient, /HTTP_MOVED_TEMP/);
  assert.match(releaseClient, /total != candidate\.assetBytes/);
  assert.match(releaseClient, /candidate\.assetSha256/);
  assert.doesNotMatch(releaseClient, /Authorization|browser_download_url|setInstanceFollowRedirects\(true\)/);

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
  assert.match(nativeApi, /NativeOfficialReleaseStatus/);
  assert.match(nativeApi, /selectBundle/);
  assert.match(nativeApi, /discoverOfficial/);
  assert.match(nativeApi, /downloadOfficial/);
  assert.match(nativeApi, /installVerified/);
  assert.match(nativeApi, /discard/);
  assert.match(app, /서명과 APK를 확인했습니다/);
  assert.match(app, /취소·파일 폐기/);
  assert.match(app, /검증된 APK 설치 확인/);
  assert.match(app, /Android 시스템 확인 없이 자동 설치하지 않습니다/);
  assert.match(app, /자동·백그라운드 조회는 하지 않습니다/);
  assert.match(app, /다운로드·서명 검증/);
  assert.match(app, /updateReview\.token/);
  assert.match(app, /Date\.now\(\) >= updateReview\.expiresAt/);
  assert.match(css, /\.update-manager \{[^}]*min-width:\s*0/);
  assert.match(css, /\.update-review dd, \.update-discovery dd \{[^}]*overflow-wrap:\s*anywhere/);
  assert.match(css, /@media \(max-width: 560px\)[\s\S]*\.update-manager-head \{[^}]*flex-direction:\s*column/);
  assert.match(css, /@media \(max-width: 560px\)[\s\S]*\.update-review-actions \{[^}]*minmax\(0,\s*1fr\)/);

  assert.match(workflow, /gradlew testReleaseUnitTest/);
  assert.match(workflow, /Codex-Pocket-Voice-v\$\{version\}-update\.zip/);
  assert.match(workflow, /zip -X -j "\$bundle"/);
  assert.match(workflow, /test "\$\{#entries\[@\]\}" -eq 6/);
});

async function source(path: string): Promise<string> {
  return readFile(new URL(path, import.meta.url), "utf8");
}
