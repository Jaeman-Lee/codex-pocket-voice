package io.github.jaemanlee.codexpocketvoice;

import java.net.URL;
import java.util.Collections;
import java.util.List;
import java.util.regex.Pattern;

final class PocketOfficialRelease {
    static final String OWNER = "Jaeman-Lee";
    static final String REPOSITORY = "codex-pocket-voice";
    static final String API_VERSION = "2026-03-10";
    static final String LATEST_RELEASE_URL =
            "https://api.github.com/repos/" + OWNER + "/" + REPOSITORY + "/releases/latest";
    static final long MAX_RELEASE_JSON_BYTES = 1024L * 1024L;
    static final long MAX_BUNDLE_BYTES = 1024L * 1024L * 1024L + 68L * 1024L * 1024L;
    static final int MAX_ASSETS = 128;
    static final int MAX_REDIRECTS = 3;

    private static final Pattern TAG = Pattern.compile("^v\\d+\\.\\d+\\.\\d+$");
    private static final Pattern DIGEST = Pattern.compile("^sha256:[a-f0-9]{64}$");
    private static final Pattern PUBLISHED_AT = Pattern.compile(
            "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$"
    );

    private PocketOfficialRelease() {}

    static Evaluation evaluate(RawRelease release, long currentVersionCode) {
        if (release == null || release.id <= 0L || release.draft || release.prerelease) {
            throw new SecurityException("공식 정식 Release 응답이 올바르지 않습니다.");
        }
        if (release.tagName == null || !TAG.matcher(release.tagName).matches()) {
            throw new SecurityException("공식 Release tag가 SemVer가 아닙니다.");
        }
        String version = release.tagName.substring(1);
        long versionCode = semverCode(version);
        String expectedReleaseUrl = "https://github.com/" + OWNER + "/" + REPOSITORY
                + "/releases/tag/" + release.tagName;
        if (!expectedReleaseUrl.equals(release.htmlUrl)) {
            throw new SecurityException("공식 Release 주소가 저장소와 일치하지 않습니다.");
        }
        if (release.publishedAt == null || !PUBLISHED_AT.matcher(release.publishedAt).matches()) {
            throw new SecurityException("공식 Release 게시 시각이 올바르지 않습니다.");
        }
        if (release.assets == null || release.assets.size() > MAX_ASSETS) {
            throw new SecurityException("공식 Release asset 목록이 허용 범위를 벗어났습니다.");
        }
        if (versionCode <= currentVersionCode) {
            return new Evaluation(false, version, versionCode, release.publishedAt, release.htmlUrl, null);
        }

        String expectedName = "Codex-Pocket-Voice-v" + version + "-update.zip";
        RawAsset selected = null;
        for (RawAsset asset : release.assets) {
            if (asset != null && expectedName.equals(asset.name)) {
                if (selected != null) throw new SecurityException("공식 업데이트 ZIP asset이 중복되었습니다.");
                selected = asset;
            }
        }
        if (selected == null) throw new SecurityException("공식 업데이트 ZIP asset을 찾을 수 없습니다.");
        if (selected.id <= 0L || !"uploaded".equals(selected.state)
                || !"application/zip".equals(selected.contentType)) {
            throw new SecurityException("공식 업데이트 ZIP asset 상태가 올바르지 않습니다.");
        }
        if (selected.bytes <= 0L || selected.bytes > MAX_BUNDLE_BYTES) {
            throw new SecurityException("공식 업데이트 ZIP 크기가 허용 범위를 벗어났습니다.");
        }
        if (selected.digest == null || !DIGEST.matcher(selected.digest).matches()) {
            throw new SecurityException("공식 업데이트 ZIP SHA-256 digest가 없습니다.");
        }
        String expectedAssetApiUrl = assetApiUrl(selected.id);
        if (!expectedAssetApiUrl.equals(selected.apiUrl)) {
            throw new SecurityException("공식 업데이트 asset API 주소가 저장소와 일치하지 않습니다.");
        }
        Candidate candidate = new Candidate(
                version,
                versionCode,
                release.publishedAt,
                release.htmlUrl,
                selected.id,
                selected.name,
                selected.bytes,
                selected.digest.substring("sha256:".length()),
                selected.apiUrl
        );
        return new Evaluation(true, version, versionCode, release.publishedAt, release.htmlUrl, candidate);
    }

    static URL initialAssetUrl(Candidate candidate) throws Exception {
        if (candidate == null || !assetApiUrl(candidate.assetId).equals(candidate.assetApiUrl)) {
            throw new SecurityException("공식 업데이트 asset 요청이 올바르지 않습니다.");
        }
        return new URL(candidate.assetApiUrl);
    }

    static void validateRedirect(URL source, URL target, int redirectCount) {
        if (source == null || target == null || redirectCount < 1 || redirectCount > MAX_REDIRECTS) {
            throw new SecurityException("공식 업데이트 다운로드 redirect가 너무 많습니다.");
        }
        if (!"https".equalsIgnoreCase(target.getProtocol())
                || target.getUserInfo() != null
                || target.getRef() != null
                || (target.getPort() != -1 && target.getPort() != 443)) {
            throw new SecurityException("공식 업데이트 download redirect가 안전하지 않습니다.");
        }
        String sourceHost = source.getHost().toLowerCase();
        String targetHost = target.getHost().toLowerCase();
        boolean sourceAllowed = "api.github.com".equals(sourceHost)
                || sourceHost.endsWith(".githubusercontent.com");
        boolean targetAllowed = targetHost.endsWith(".githubusercontent.com");
        if (!sourceAllowed || !targetAllowed || target.getPath() == null || target.getPath().isEmpty()) {
            throw new SecurityException("공식 업데이트 download redirect host가 허용되지 않습니다.");
        }
    }

    private static String assetApiUrl(long assetId) {
        return "https://api.github.com/repos/" + OWNER + "/" + REPOSITORY
                + "/releases/assets/" + assetId;
    }

    private static long semverCode(String version) {
        String[] parts = version.split("\\.", -1);
        if (parts.length != 3) throw new SecurityException("공식 Release 버전이 올바르지 않습니다.");
        try {
            long major = Long.parseLong(parts[0]);
            long minor = Long.parseLong(parts[1]);
            long patch = Long.parseLong(parts[2]);
            if (major <= 0L || major > 214_748L || minor > 99L || patch > 99L) {
                throw new SecurityException("공식 Release versionCode 범위가 올바르지 않습니다.");
            }
            long code = major * 10_000L + minor * 100L + patch;
            if (code <= 0L || code > Integer.MAX_VALUE) {
                throw new SecurityException("공식 Release versionCode 범위가 올바르지 않습니다.");
            }
            return code;
        } catch (NumberFormatException error) {
            throw new SecurityException("공식 Release 버전이 올바르지 않습니다.");
        }
    }

    static final class RawRelease {
        final long id;
        final String tagName;
        final String htmlUrl;
        final String publishedAt;
        final boolean draft;
        final boolean prerelease;
        final List<RawAsset> assets;

        RawRelease(long id, String tagName, String htmlUrl, String publishedAt, boolean draft,
                   boolean prerelease, List<RawAsset> assets) {
            this.id = id;
            this.tagName = tagName;
            this.htmlUrl = htmlUrl;
            this.publishedAt = publishedAt;
            this.draft = draft;
            this.prerelease = prerelease;
            this.assets = assets == null ? Collections.emptyList() : assets;
        }
    }

    static final class RawAsset {
        final long id;
        final String name;
        final String state;
        final String contentType;
        final long bytes;
        final String digest;
        final String apiUrl;

        RawAsset(long id, String name, String state, String contentType, long bytes, String digest, String apiUrl) {
            this.id = id;
            this.name = name;
            this.state = state;
            this.contentType = contentType;
            this.bytes = bytes;
            this.digest = digest;
            this.apiUrl = apiUrl;
        }
    }

    static final class Evaluation {
        final boolean available;
        final String version;
        final long versionCode;
        final String publishedAt;
        final String releaseUrl;
        final Candidate candidate;

        Evaluation(boolean available, String version, long versionCode, String publishedAt,
                   String releaseUrl, Candidate candidate) {
            this.available = available;
            this.version = version;
            this.versionCode = versionCode;
            this.publishedAt = publishedAt;
            this.releaseUrl = releaseUrl;
            this.candidate = candidate;
        }
    }

    static final class Candidate {
        final String version;
        final long versionCode;
        final String publishedAt;
        final String releaseUrl;
        final long assetId;
        final String assetName;
        final long assetBytes;
        final String assetSha256;
        final String assetApiUrl;

        Candidate(String version, long versionCode, String publishedAt, String releaseUrl, long assetId,
                  String assetName, long assetBytes, String assetSha256, String assetApiUrl) {
            this.version = version;
            this.versionCode = versionCode;
            this.publishedAt = publishedAt;
            this.releaseUrl = releaseUrl;
            this.assetId = assetId;
            this.assetName = assetName;
            this.assetBytes = assetBytes;
            this.assetSha256 = assetSha256;
            this.assetApiUrl = assetApiUrl;
        }
    }
}
