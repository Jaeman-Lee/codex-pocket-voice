package io.github.jaemanlee.codexpocketvoice;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.URL;
import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import javax.net.ssl.HttpsURLConnection;
import org.json.JSONArray;
import org.json.JSONObject;

final class PocketOfficialReleaseClient {
    private static final int CONNECT_TIMEOUT_MS = 15_000;
    private static final int READ_TIMEOUT_MS = 30_000;
    private static final String USER_AGENT = "Codex-Pocket-Voice-Android";

    PocketOfficialRelease.RawRelease fetchLatest() throws Exception {
        URL url = new URL(PocketOfficialRelease.LATEST_RELEASE_URL);
        HttpsURLConnection connection = open(url, "application/vnd.github+json");
        try {
            int status = connection.getResponseCode();
            if (status != HttpsURLConnection.HTTP_OK) {
                throw new IllegalStateException(status == 404
                        ? "공식 정식 Release가 아직 없습니다."
                        : "공식 Release 조회에 실패했습니다 (HTTP " + status + ").");
            }
            byte[] bytes = readBounded(
                    connection.getInputStream(), PocketOfficialRelease.MAX_RELEASE_JSON_BYTES,
                    "공식 Release 응답"
            );
            String encoded = StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(bytes))
                    .toString();
            return parse(new JSONObject(encoded));
        } finally {
            connection.disconnect();
        }
    }

    File download(PocketOfficialRelease.Candidate candidate, File cacheRoot) throws Exception {
        URL current = PocketOfficialRelease.initialAssetUrl(candidate);
        File output = new File(cacheRoot, "official-" + UUID.randomUUID() + ".zip");
        if (!output.createNewFile()) throw new IllegalStateException("업데이트 다운로드 파일을 만들 수 없습니다.");
        boolean complete = false;
        try {
            for (int redirects = 0; redirects <= PocketOfficialRelease.MAX_REDIRECTS; redirects += 1) {
                HttpsURLConnection connection = open(current, "application/octet-stream");
                try {
                    int status = connection.getResponseCode();
                    if (status == HttpsURLConnection.HTTP_MOVED_TEMP) {
                        if (redirects >= PocketOfficialRelease.MAX_REDIRECTS) {
                            throw new SecurityException("공식 업데이트 다운로드 redirect가 너무 많습니다.");
                        }
                        String location = connection.getHeaderField("Location");
                        if (location == null || location.length() > 8_192) {
                            throw new SecurityException("공식 업데이트 download redirect가 올바르지 않습니다.");
                        }
                        URL next = new URL(current, location);
                        PocketOfficialRelease.validateRedirect(current, next, redirects + 1);
                        current = next;
                        continue;
                    }
                    if (status != HttpsURLConnection.HTTP_OK) {
                        throw new IllegalStateException("공식 업데이트 다운로드에 실패했습니다 (HTTP " + status + ").");
                    }
                    long declaredBytes = connection.getContentLengthLong();
                    if (declaredBytes > PocketOfficialRelease.MAX_BUNDLE_BYTES
                            || (declaredBytes >= 0L && declaredBytes != candidate.assetBytes)) {
                        throw new SecurityException("공식 업데이트 다운로드 크기가 Release 정보와 다릅니다.");
                    }
                    copyAndVerify(connection.getInputStream(), output, candidate);
                    complete = true;
                    return output;
                } finally {
                    connection.disconnect();
                }
            }
            throw new SecurityException("공식 업데이트 다운로드 redirect가 너무 많습니다.");
        } finally {
            if (!complete) output.delete();
        }
    }

    private static HttpsURLConnection open(URL url, String accept) throws Exception {
        if (!"https".equalsIgnoreCase(url.getProtocol())) {
            throw new SecurityException("공식 업데이트 연결은 HTTPS만 허용합니다.");
        }
        HttpsURLConnection connection = (HttpsURLConnection) url.openConnection();
        connection.setInstanceFollowRedirects(false);
        connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
        connection.setReadTimeout(READ_TIMEOUT_MS);
        connection.setUseCaches(false);
        connection.setRequestProperty("Accept", accept);
        connection.setRequestProperty("X-GitHub-Api-Version", PocketOfficialRelease.API_VERSION);
        connection.setRequestProperty("User-Agent", USER_AGENT);
        connection.setRequestProperty("Cache-Control", "no-cache");
        return connection;
    }

    private static PocketOfficialRelease.RawRelease parse(JSONObject value) throws Exception {
        JSONArray assetsValue = requiredArray(value, "assets");
        if (assetsValue.length() > PocketOfficialRelease.MAX_ASSETS) {
            throw new SecurityException("공식 Release asset 목록이 너무 큽니다.");
        }
        List<PocketOfficialRelease.RawAsset> assets = new ArrayList<>();
        for (int index = 0; index < assetsValue.length(); index += 1) {
            JSONObject asset = assetsValue.optJSONObject(index);
            if (asset == null) throw new SecurityException("공식 Release asset 정보가 올바르지 않습니다.");
            Object digest = asset.opt("digest");
            assets.add(new PocketOfficialRelease.RawAsset(
                    strictLong(asset, "id"),
                    strictString(asset, "name"),
                    strictString(asset, "state"),
                    strictString(asset, "content_type"),
                    strictLong(asset, "size"),
                    digest instanceof String ? (String) digest : null,
                    strictString(asset, "url")
            ));
        }
        return new PocketOfficialRelease.RawRelease(
                strictLong(value, "id"),
                strictString(value, "tag_name"),
                strictString(value, "html_url"),
                strictString(value, "published_at"),
                strictBoolean(value, "draft"),
                strictBoolean(value, "prerelease"),
                assets
        );
    }

    private static void copyAndVerify(InputStream source, File output, PocketOfficialRelease.Candidate candidate)
            throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        byte[] buffer = new byte[32 * 1024];
        long total = 0L;
        try (InputStream input = new BufferedInputStream(source);
             BufferedOutputStream destination = new BufferedOutputStream(new FileOutputStream(output, false))) {
            int read;
            while ((read = input.read(buffer)) != -1) {
                total += read;
                if (total > candidate.assetBytes || total > PocketOfficialRelease.MAX_BUNDLE_BYTES) {
                    throw new SecurityException("공식 업데이트 다운로드가 허용 크기를 초과했습니다.");
                }
                digest.update(buffer, 0, read);
                destination.write(buffer, 0, read);
            }
            destination.flush();
        }
        if (total != candidate.assetBytes) {
            throw new SecurityException("공식 업데이트 다운로드 크기가 Release 정보와 다릅니다.");
        }
        String actual = hex(digest.digest());
        if (!MessageDigest.isEqual(
                actual.getBytes(StandardCharsets.US_ASCII),
                candidate.assetSha256.getBytes(StandardCharsets.US_ASCII)
        )) throw new SecurityException("공식 업데이트 다운로드 SHA-256이 Release 정보와 다릅니다.");
    }

    private static byte[] readBounded(InputStream source, long limit, String label) throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[8 * 1024];
        try (InputStream input = new BufferedInputStream(source)) {
            int read;
            while ((read = input.read(buffer)) != -1) {
                if ((long) output.size() + read > limit) {
                    throw new SecurityException(label + "이 너무 큽니다.");
                }
                output.write(buffer, 0, read);
            }
        }
        if (output.size() == 0) throw new SecurityException(label + "이 비어 있습니다.");
        return output.toByteArray();
    }

    private static JSONArray requiredArray(JSONObject value, String key) {
        Object member = value.opt(key);
        if (!(member instanceof JSONArray)) throw new SecurityException("공식 Release 응답이 올바르지 않습니다.");
        return (JSONArray) member;
    }

    private static String strictString(JSONObject value, String key) {
        Object member = value.opt(key);
        if (!(member instanceof String) || ((String) member).isEmpty() || ((String) member).length() > 8_192) {
            throw new SecurityException("공식 Release 응답이 올바르지 않습니다.");
        }
        return (String) member;
    }

    private static boolean strictBoolean(JSONObject value, String key) {
        Object member = value.opt(key);
        if (!(member instanceof Boolean)) throw new SecurityException("공식 Release 응답이 올바르지 않습니다.");
        return (Boolean) member;
    }

    private static long strictLong(JSONObject value, String key) {
        Object member = value.opt(key);
        if (!(member instanceof Integer) && !(member instanceof Long)) {
            throw new SecurityException("공식 Release 숫자 필드가 올바르지 않습니다.");
        }
        return ((Number) member).longValue();
    }

    private static String hex(byte[] bytes) {
        StringBuilder value = new StringBuilder(bytes.length * 2);
        for (byte item : bytes) value.append(String.format("%02x", item & 0xff));
        return value.toString();
    }
}
