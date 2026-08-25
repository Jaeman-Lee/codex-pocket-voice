package io.github.jaemanlee.codexpocketvoice;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import java.net.URL;
import java.util.Arrays;
import java.util.Collections;
import org.junit.Test;

public class PocketOfficialReleaseTest {
    private static final long ASSET_ID = 42L;
    private static final String VERSION = "2.1.0";
    private static final String TAG = "v" + VERSION;
    private static final String RELEASE_URL =
            "https://github.com/Jaeman-Lee/codex-pocket-voice/releases/tag/" + TAG;
    private static final String ASSET_NAME = "Codex-Pocket-Voice-v" + VERSION + "-update.zip";
    private static final String ASSET_API_URL =
            "https://api.github.com/repos/Jaeman-Lee/codex-pocket-voice/releases/assets/" + ASSET_ID;
    private static final String DIGEST = "sha256:" + "a".repeat(64);

    @Test
    public void olderOrSameLatestNeedsNoBundleAndOffersNoDownload() {
        PocketOfficialRelease.RawRelease release = release(
                "v2.0.0", "https://github.com/Jaeman-Lee/codex-pocket-voice/releases/tag/v2.0.0",
                Collections.emptyList()
        );

        PocketOfficialRelease.Evaluation result = PocketOfficialRelease.evaluate(release, 20_000L);

        assertFalse(result.available);
        assertEquals("2.0.0", result.version);
        assertEquals(20_000L, result.versionCode);
        assertEquals(null, result.candidate);
    }

    @Test
    public void newerLatestRequiresOneExactBoundedDigestedZip() {
        PocketOfficialRelease.Evaluation result = PocketOfficialRelease.evaluate(
                release(TAG, RELEASE_URL, Collections.singletonList(asset())),
                20_000L
        );

        assertTrue(result.available);
        assertEquals(VERSION, result.candidate.version);
        assertEquals(20_100L, result.candidate.versionCode);
        assertEquals(ASSET_NAME, result.candidate.assetName);
        assertEquals("a".repeat(64), result.candidate.assetSha256);
        assertEquals(ASSET_API_URL, result.candidate.assetApiUrl);
    }

    @Test
    public void duplicateOrMalformedOfficialAssetsFailClosed() {
        assertThrows(SecurityException.class, () -> PocketOfficialRelease.evaluate(
                release(TAG, RELEASE_URL, Arrays.asList(asset(), asset())), 20_000L
        ));
        assertThrows(SecurityException.class, () -> PocketOfficialRelease.evaluate(
                release(TAG, RELEASE_URL, Collections.singletonList(new PocketOfficialRelease.RawAsset(
                        ASSET_ID, ASSET_NAME, "uploaded", "application/zip", 4096L,
                        null, ASSET_API_URL
                ))), 20_000L
        ));
        assertThrows(SecurityException.class, () -> PocketOfficialRelease.evaluate(
                release(TAG, RELEASE_URL, Collections.singletonList(new PocketOfficialRelease.RawAsset(
                        ASSET_ID, ASSET_NAME, "uploaded", "application/octet-stream", 4096L,
                        DIGEST, ASSET_API_URL
                ))), 20_000L
        ));
        assertThrows(SecurityException.class, () -> PocketOfficialRelease.evaluate(
                release(TAG, RELEASE_URL, Collections.singletonList(new PocketOfficialRelease.RawAsset(
                        ASSET_ID, ASSET_NAME, "uploaded", "application/zip", 4096L,
                        DIGEST, "https://api.github.com/repos/attacker/project/releases/assets/42"
                ))), 20_000L
        ));
    }

    @Test
    public void releaseIdentityAndSemverMappingFailClosed() {
        assertThrows(SecurityException.class, () -> PocketOfficialRelease.evaluate(
                release("v2.100.0", "https://github.com/Jaeman-Lee/codex-pocket-voice/releases/tag/v2.100.0",
                        Collections.singletonList(asset())),
                20_000L
        ));
        assertThrows(SecurityException.class, () -> PocketOfficialRelease.evaluate(
                release(TAG, "https://github.com/attacker/project/releases/tag/" + TAG,
                        Collections.singletonList(asset())),
                20_000L
        ));
        PocketOfficialRelease.RawRelease draft = new PocketOfficialRelease.RawRelease(
                1L, TAG, RELEASE_URL, "2026-08-24T12:00:00Z", true, false,
                Collections.singletonList(asset())
        );
        assertThrows(SecurityException.class, () -> PocketOfficialRelease.evaluate(draft, 20_000L));
    }

    @Test
    public void redirectsStayOnHttpsGithubControlledAssetHosts() throws Exception {
        URL api = new URL(ASSET_API_URL);
        PocketOfficialRelease.validateRedirect(
                api,
                new URL("https://release-assets.githubusercontent.com/github-production-release-asset/file.zip?sig=x"),
                1
        );
        PocketOfficialRelease.validateRedirect(
                new URL("https://release-assets.githubusercontent.com/github-production-release-asset/file.zip?sig=x"),
                new URL("https://objects.githubusercontent.com/github-production-release-asset/file.zip?sig=y"),
                2
        );

        assertThrows(SecurityException.class, () -> PocketOfficialRelease.validateRedirect(
                api, new URL("http://release-assets.githubusercontent.com/file.zip"), 1
        ));
        assertThrows(SecurityException.class, () -> PocketOfficialRelease.validateRedirect(
                api, new URL("https://release-assets.githubusercontent.com.evil.test/file.zip"), 1
        ));
        assertThrows(SecurityException.class, () -> PocketOfficialRelease.validateRedirect(
                api, new URL("https://user@release-assets.githubusercontent.com/file.zip"), 1
        ));
        assertThrows(SecurityException.class, () -> PocketOfficialRelease.validateRedirect(
                api, new URL("https://release-assets.githubusercontent.com/file.zip"), 4
        ));
    }

    private static PocketOfficialRelease.RawRelease release(
            String tag, String releaseUrl, java.util.List<PocketOfficialRelease.RawAsset> assets
    ) {
        return new PocketOfficialRelease.RawRelease(
                1L, tag, releaseUrl, "2026-08-24T12:00:00Z", false, false, assets
        );
    }

    private static PocketOfficialRelease.RawAsset asset() {
        return new PocketOfficialRelease.RawAsset(
                ASSET_ID, ASSET_NAME, "uploaded", "application/zip", 4096L,
                DIGEST, ASSET_API_URL
        );
    }
}
