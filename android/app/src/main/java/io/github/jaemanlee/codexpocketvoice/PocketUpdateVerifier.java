package io.github.jaemanlee.codexpocketvoice;

import android.content.Context;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.content.pm.SigningInfo;
import android.os.Build;
import android.util.Base64;
import androidx.core.content.pm.PackageInfoCompat;
import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.text.ParsePosition;
import java.text.SimpleDateFormat;
import java.util.Arrays;
import java.util.Date;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TimeZone;
import java.util.UUID;
import java.util.regex.Pattern;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import org.json.JSONArray;
import org.json.JSONObject;

final class PocketUpdateVerifier {
    private static final long MAX_APK_BYTES = 1024L * 1024L * 1024L;
    private static final long MAX_SBOM_BYTES = 64L * 1024L * 1024L;
    private static final long MAX_MANIFEST_BYTES = 65_536L;
    private static final long MAX_SIGNATURE_BYTES = 16_384L;
    private static final long MAX_CERTIFICATE_BYTES = 16_384L;
    private static final long MAX_CHECKSUM_BYTES = 4_096L;
    private static final long MAX_ARCHIVE_BYTES = MAX_APK_BYTES + MAX_SBOM_BYTES + 4L * 1024L * 1024L;
    private static final int MAX_ENTRIES = 6;
    private static final String MANIFEST_FILE = "update-manifest.json";
    private static final String SIGNATURE_FILE = "update-manifest.sig";
    private static final String CERTIFICATE_FILE = "update-manifest-cert.pem";
    private static final String CHECKSUM_FILE = "SHA256SUMS";
    private static final Pattern SIMPLE_FILENAME = Pattern.compile("^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$");
    private static final Pattern APPLICATION_ID = Pattern.compile("^[a-z][a-z0-9_]*(?:\\.[a-z][a-z0-9_]*)+$");
    private static final Pattern VERSION = Pattern.compile("^\\d+\\.\\d+\\.\\d+$");
    private static final Pattern CHANNEL = Pattern.compile("^[a-z0-9][a-z0-9-]{0,31}$");
    private static final Pattern SHA256 = Pattern.compile("^[a-f0-9]{64}$");
    private static final Pattern COMMIT = Pattern.compile("^[a-f0-9]{40}$");
    private static final Pattern TIMESTAMP = Pattern.compile("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$");
    private static final Pattern BASE64_SIGNATURE = Pattern.compile("^[A-Za-z0-9+/]+={0,2}$");

    private PocketUpdateVerifier() {}

    static VerifiedBundle verify(Context context, InputStream archive, File cacheRoot) throws Exception {
        File bundleDirectory = new File(cacheRoot, "bundle-" + UUID.randomUUID());
        if (!bundleDirectory.mkdir()) throw new IOException("업데이트 검증 폴더를 만들 수 없습니다.");
        try {
            Map<String, File> files = extractArchive(archive, bundleDirectory);
            byte[] manifestBytes = readBounded(requiredFile(files, MANIFEST_FILE), MAX_MANIFEST_BYTES, "update manifest");
            Manifest manifest = parseManifest(manifestBytes);
            Set<String> expectedFiles = new HashSet<>(Arrays.asList(
                    MANIFEST_FILE, SIGNATURE_FILE, CERTIFICATE_FILE, CHECKSUM_FILE,
                    manifest.apk.file, manifest.sbom.file
            ));
            if (!files.keySet().equals(expectedFiles)) throw new SecurityException("업데이트 ZIP 파일 구성이 올바르지 않습니다.");

            verifyArtifact(requiredFile(files, manifest.apk.file), manifest.apk, MAX_APK_BYTES);
            verifyArtifact(requiredFile(files, manifest.sbom.file), manifest.sbom, MAX_SBOM_BYTES);
            verifyChecksum(requiredFile(files, CHECKSUM_FILE), manifest.apk);

            X509Certificate certificate = readCertificate(requiredFile(files, CERTIFICATE_FILE));
            certificate.checkValidity(new Date());
            String certificateSha256 = digest(certificate.getEncoded());
            if (!MessageDigest.isEqual(
                    certificateSha256.getBytes(StandardCharsets.US_ASCII),
                    manifest.signingCertificateSha256.getBytes(StandardCharsets.US_ASCII)
            )) throw new SecurityException("업데이트 인증서 fingerprint가 manifest와 다릅니다.");
            verifyDetachedSignature(
                    manifestBytes,
                    readBounded(requiredFile(files, SIGNATURE_FILE), MAX_SIGNATURE_BYTES, "manifest signature"),
                    certificate
            );

            PackageInfo currentPackage = currentPackage(context);
            String currentSigner = soleSignerSha256(currentPackage);
            if (!MessageDigest.isEqual(
                    currentSigner.getBytes(StandardCharsets.US_ASCII),
                    certificateSha256.getBytes(StandardCharsets.US_ASCII)
            )) throw new SecurityException("업데이트 인증서가 현재 설치 앱의 signer와 다릅니다.");

            File apk = requiredFile(files, manifest.apk.file);
            PackageInfo archivePackage = archivePackage(context, apk);
            if (!context.getPackageName().equals(manifest.applicationId)
                    || !context.getPackageName().equals(archivePackage.packageName)) {
                throw new SecurityException("업데이트 package ID가 현재 앱과 다릅니다.");
            }
            String apkSigner = soleSignerSha256(archivePackage);
            if (!MessageDigest.isEqual(
                    apkSigner.getBytes(StandardCharsets.US_ASCII),
                    certificateSha256.getBytes(StandardCharsets.US_ASCII)
            )) throw new SecurityException("APK signer가 update manifest 인증서와 다릅니다.");

            long currentVersionCode = PackageInfoCompat.getLongVersionCode(currentPackage);
            long apkVersionCode = PackageInfoCompat.getLongVersionCode(archivePackage);
            if (apkVersionCode != manifest.versionCode || archivePackage.versionName == null
                    || !archivePackage.versionName.equals(manifest.version)) {
                throw new SecurityException("APK 버전이 update manifest와 다릅니다.");
            }
            if (manifest.versionCode <= currentVersionCode) {
                throw new SecurityException("현재 버전보다 높은 versionCode의 업데이트만 설치할 수 있습니다.");
            }

            return new VerifiedBundle(
                    bundleDirectory,
                    apk,
                    manifest.apk.sha256,
                    manifest.applicationId,
                    manifest.version,
                    manifest.versionCode,
                    currentPackage.versionName == null ? "" : currentPackage.versionName,
                    currentVersionCode,
                    manifest.channel,
                    manifest.commit,
                    manifest.createdAt,
                    certificateSha256,
                    manifest.apk.bytes
            );
        } catch (Exception error) {
            deleteDirectory(bundleDirectory);
            throw error;
        }
    }

    static void deleteDirectory(File directory) {
        if (directory == null || !directory.exists()) return;
        File[] children = directory.listFiles();
        if (children != null) {
            for (File child : children) {
                if (child.isDirectory()) deleteDirectory(child);
                else child.delete();
            }
        }
        directory.delete();
    }

    static String fileSha256(File file) throws Exception {
        MessageDigest messageDigest = MessageDigest.getInstance("SHA-256");
        byte[] buffer = new byte[32 * 1024];
        try (InputStream input = new BufferedInputStream(new FileInputStream(file))) {
            int read;
            while ((read = input.read(buffer)) != -1) messageDigest.update(buffer, 0, read);
        }
        return hex(messageDigest.digest());
    }

    private static Map<String, File> extractArchive(InputStream source, File directory) throws Exception {
        Map<String, File> files = new HashMap<>();
        long totalBytes = 0L;
        try (ZipInputStream zip = new ZipInputStream(new BufferedInputStream(
                new BoundedInputStream(source, MAX_ARCHIVE_BYTES)
        ))) {
            ZipEntry entry;
            while ((entry = zip.getNextEntry()) != null) {
                if (entry.isDirectory()) throw new SecurityException("업데이트 ZIP은 최상위 파일만 포함해야 합니다.");
                String name = entry.getName();
                assertSimpleFilename(name);
                if (files.size() >= MAX_ENTRIES || files.containsKey(name)) {
                    throw new SecurityException("업데이트 ZIP 항목이 중복되었거나 너무 많습니다.");
                }
                long limit = entryLimit(name);
                if (limit < 0 || entry.getSize() > limit) throw new SecurityException("업데이트 ZIP 항목이 허용 범위를 벗어났습니다.");
                File output = new File(directory, name);
                if (!output.createNewFile()) throw new SecurityException("업데이트 ZIP 항목을 안전하게 만들 수 없습니다.");
                long written = copyBounded(zip, output, limit);
                totalBytes += written;
                if (written <= 0 || totalBytes > MAX_ARCHIVE_BYTES) {
                    throw new SecurityException("업데이트 ZIP 크기가 올바르지 않습니다.");
                }
                files.put(name, output);
                zip.closeEntry();
            }
        }
        if (files.size() != MAX_ENTRIES) throw new SecurityException("업데이트 ZIP에는 정확히 6개 파일이 필요합니다.");
        return files;
    }

    private static long copyBounded(InputStream source, File destination, long limit) throws Exception {
        byte[] buffer = new byte[32 * 1024];
        long total = 0L;
        try (BufferedOutputStream output = new BufferedOutputStream(new FileOutputStream(destination))) {
            int read;
            while ((read = source.read(buffer)) != -1) {
                total += read;
                if (total > limit) throw new SecurityException("업데이트 ZIP 항목이 너무 큽니다.");
                output.write(buffer, 0, read);
            }
            output.flush();
        }
        return total;
    }

    private static long entryLimit(String name) {
        if (MANIFEST_FILE.equals(name)) return MAX_MANIFEST_BYTES;
        if (SIGNATURE_FILE.equals(name)) return MAX_SIGNATURE_BYTES;
        if (CERTIFICATE_FILE.equals(name)) return MAX_CERTIFICATE_BYTES;
        if (CHECKSUM_FILE.equals(name)) return MAX_CHECKSUM_BYTES;
        if (name.endsWith(".apk")) return MAX_APK_BYTES;
        if (name.endsWith(".json")) return MAX_SBOM_BYTES;
        return -1L;
    }

    private static Manifest parseManifest(byte[] bytes) throws Exception {
        String encoded = decodeUtf8(bytes, "update manifest");
        JSONObject value = new JSONObject(encoded);
        exactKeys(value, "schemaVersion", "applicationId", "version", "versionCode", "channel", "commit",
                "createdAt", "signed", "signingCertificateSha256", "artifacts");
        Object signed = value.get("signed");
        if (strictLong(value, "schemaVersion") != 1L || !(signed instanceof Boolean) || !((Boolean) signed)) {
            throw new SecurityException("서명된 schema 1 update manifest가 필요합니다.");
        }
        String applicationId = strictString(value, "applicationId", APPLICATION_ID, "applicationId");
        String version = strictString(value, "version", VERSION, "version");
        long versionCode = strictLong(value, "versionCode");
        if (versionCode <= 0 || versionCode > Integer.MAX_VALUE || semverCode(version) != versionCode) {
            throw new SecurityException("update manifest versionCode가 올바르지 않습니다.");
        }
        String channel = strictString(value, "channel", CHANNEL, "channel");
        String commit = strictString(value, "commit", COMMIT, "commit");
        String createdAt = value.optString("createdAt", "");
        if (!canonicalTimestamp(createdAt)) throw new SecurityException("update manifest 생성 시각이 올바르지 않습니다.");
        String certificateSha256 = strictString(value, "signingCertificateSha256", SHA256, "certificate fingerprint");
        JSONArray artifacts = value.getJSONArray("artifacts");
        if (artifacts.length() != 2) throw new SecurityException("APK와 SBOM artifact가 모두 필요합니다.");
        Artifact apk = null;
        Artifact sbom = null;
        for (int index = 0; index < artifacts.length(); index += 1) {
            Artifact artifact = parseArtifact(artifacts.getJSONObject(index));
            if ("apk".equals(artifact.kind)) {
                if (apk != null) throw new SecurityException("APK artifact가 중복되었습니다.");
                apk = artifact;
            } else if ("sbom".equals(artifact.kind)) {
                if (sbom != null) throw new SecurityException("SBOM artifact가 중복되었습니다.");
                sbom = artifact;
            }
        }
        if (apk == null || sbom == null || !apk.file.endsWith(".apk") || !apk.file.contains("v" + version)) {
            throw new SecurityException("APK artifact 이름이 버전과 일치하지 않습니다.");
        }
        if (!sbom.file.endsWith(".json")) throw new SecurityException("SBOM artifact 이름이 올바르지 않습니다.");
        return new Manifest(applicationId, version, versionCode, channel, commit, createdAt, certificateSha256, apk, sbom);
    }

    private static Artifact parseArtifact(JSONObject value) throws Exception {
        exactKeys(value, "kind", "file", "sha256", "bytes");
        String kind = value.optString("kind", "");
        if (!"apk".equals(kind) && !"sbom".equals(kind)) throw new SecurityException("artifact 종류가 올바르지 않습니다.");
        String file = value.optString("file", "");
        assertSimpleFilename(file);
        String sha256 = strictString(value, "sha256", SHA256, "artifact SHA-256");
        long bytes = strictLong(value, "bytes");
        long maximum = "apk".equals(kind) ? MAX_APK_BYTES : MAX_SBOM_BYTES;
        if (bytes <= 0 || bytes > maximum) throw new SecurityException("artifact 크기가 올바르지 않습니다.");
        return new Artifact(kind, file, sha256, bytes);
    }

    private static void verifyArtifact(File file, Artifact artifact, long maximum) throws Exception {
        if (!file.isFile() || file.length() != artifact.bytes || file.length() <= 0 || file.length() > maximum) {
            throw new SecurityException(artifact.kind + " artifact 크기가 manifest와 다릅니다.");
        }
        String actual = fileSha256(file);
        if (!MessageDigest.isEqual(
                actual.getBytes(StandardCharsets.US_ASCII),
                artifact.sha256.getBytes(StandardCharsets.US_ASCII)
        )) throw new SecurityException(artifact.kind + " artifact SHA-256이 manifest와 다릅니다.");
    }

    private static void verifyChecksum(File file, Artifact apk) throws Exception {
        String value = decodeUtf8(readBounded(file, MAX_CHECKSUM_BYTES, CHECKSUM_FILE), CHECKSUM_FILE);
        String expected = apk.sha256 + "  " + apk.file;
        if (!value.equals(expected) && !value.equals(expected + "\n")) {
            throw new SecurityException("SHA256SUMS가 signed manifest와 다릅니다.");
        }
    }

    private static X509Certificate readCertificate(File file) throws Exception {
        byte[] bytes = readBounded(file, MAX_CERTIFICATE_BYTES, "manifest certificate");
        return (X509Certificate) CertificateFactory.getInstance("X.509")
                .generateCertificate(new ByteArrayInputStream(bytes));
    }

    private static void verifyDetachedSignature(byte[] manifest, byte[] encodedBytes, X509Certificate certificate)
            throws Exception {
        String encoded = new String(encodedBytes, StandardCharsets.US_ASCII).trim();
        if (!BASE64_SIGNATURE.matcher(encoded).matches() || encoded.length() % 4 != 0) {
            throw new SecurityException("update manifest 서명이 올바른 base64가 아닙니다.");
        }
        String keyAlgorithm = certificate.getPublicKey().getAlgorithm();
        String signatureAlgorithm;
        if ("RSA".equals(keyAlgorithm)) signatureAlgorithm = "SHA256withRSA";
        else if ("EC".equals(keyAlgorithm)) signatureAlgorithm = "SHA256withECDSA";
        else throw new SecurityException("지원하지 않는 update manifest 서명 알고리즘입니다.");
        java.security.Signature verifier = java.security.Signature.getInstance(signatureAlgorithm);
        verifier.initVerify(certificate.getPublicKey());
        verifier.update(manifest);
        if (!verifier.verify(Base64.decode(encoded, Base64.NO_WRAP))) {
            throw new SecurityException("update manifest 서명이 올바르지 않습니다.");
        }
    }

    private static PackageInfo currentPackage(Context context) throws Exception {
        int flags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                ? PackageManager.GET_SIGNING_CERTIFICATES
                : PackageManager.GET_SIGNATURES;
        return context.getPackageManager().getPackageInfo(context.getPackageName(), flags);
    }

    private static PackageInfo archivePackage(Context context, File apk) {
        int flags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                ? PackageManager.GET_SIGNING_CERTIFICATES
                : PackageManager.GET_SIGNATURES;
        PackageInfo info = context.getPackageManager().getPackageArchiveInfo(apk.getAbsolutePath(), flags);
        if (info == null) throw new SecurityException("APK package 정보를 검증할 수 없습니다.");
        return info;
    }

    @SuppressWarnings("deprecation")
    private static String soleSignerSha256(PackageInfo info) throws Exception {
        Signature[] signatures;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            SigningInfo signingInfo = info.signingInfo;
            if (signingInfo == null) throw new SecurityException("APK signer 정보가 없습니다.");
            signatures = signingInfo.getApkContentsSigners();
        } else {
            signatures = info.signatures;
        }
        if (signatures == null || signatures.length != 1) {
            throw new SecurityException("정확히 하나의 APK signer가 필요합니다.");
        }
        return digest(signatures[0].toByteArray());
    }

    private static byte[] readBounded(File file, long limit, String label) throws Exception {
        if (!file.isFile() || file.length() <= 0 || file.length() > limit || file.length() > Integer.MAX_VALUE) {
            throw new SecurityException(label + " 크기가 올바르지 않습니다.");
        }
        ByteArrayOutputStream output = new ByteArrayOutputStream((int) file.length());
        byte[] buffer = new byte[8 * 1024];
        try (InputStream input = new BufferedInputStream(new FileInputStream(file))) {
            int read;
            while ((read = input.read(buffer)) != -1) {
                if (output.size() + read > limit) throw new SecurityException(label + " 크기가 너무 큽니다.");
                output.write(buffer, 0, read);
            }
        }
        return output.toByteArray();
    }

    private static String decodeUtf8(byte[] bytes, String label) throws Exception {
        String value = new String(bytes, StandardCharsets.UTF_8);
        if (!Arrays.equals(value.getBytes(StandardCharsets.UTF_8), bytes)) {
            throw new SecurityException(label + "가 올바른 UTF-8이 아닙니다.");
        }
        return value;
    }

    private static long strictLong(JSONObject value, String name) throws Exception {
        Object raw = value.get(name);
        if (!(raw instanceof Integer) && !(raw instanceof Long)) {
            throw new SecurityException(name + "은 정수여야 합니다.");
        }
        return ((Number) raw).longValue();
    }

    private static String strictString(JSONObject value, String name, Pattern pattern, String label) throws Exception {
        Object raw = value.get(name);
        if (!(raw instanceof String) || !pattern.matcher((String) raw).matches()) {
            throw new SecurityException(label + " 형식이 올바르지 않습니다.");
        }
        return (String) raw;
    }

    private static void exactKeys(JSONObject value, String... expected) {
        Set<String> wanted = new HashSet<>(Arrays.asList(expected));
        if (value.length() != wanted.size()) throw new SecurityException("update manifest 필드 구성이 올바르지 않습니다.");
        java.util.Iterator<String> keys = value.keys();
        while (keys.hasNext()) {
            if (!wanted.contains(keys.next())) throw new SecurityException("update manifest 필드 구성이 올바르지 않습니다.");
        }
    }

    private static long semverCode(String version) {
        String[] parts = version.split("\\.", -1);
        if (parts.length != 3) return -1L;
        try {
            long major = Long.parseLong(parts[0]);
            long minor = Long.parseLong(parts[1]);
            long patch = Long.parseLong(parts[2]);
            if (minor > 99 || patch > 99 || major > Integer.MAX_VALUE / 10_000L) return -1L;
            return major * 10_000L + minor * 100L + patch;
        } catch (NumberFormatException error) {
            return -1L;
        }
    }

    private static boolean canonicalTimestamp(String value) {
        if (!TIMESTAMP.matcher(value).matches()) return false;
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        format.setLenient(false);
        format.setTimeZone(TimeZone.getTimeZone("UTC"));
        ParsePosition position = new ParsePosition(0);
        Date parsed = format.parse(value, position);
        return parsed != null && position.getIndex() == value.length() && format.format(parsed).equals(value);
    }

    private static File requiredFile(Map<String, File> files, String name) {
        File file = files.get(name);
        if (file == null) throw new SecurityException("업데이트 ZIP에 " + name + " 파일이 없습니다.");
        return file;
    }

    private static void assertSimpleFilename(String value) {
        if (value == null || !SIMPLE_FILENAME.matcher(value).matches() || ".".equals(value) || "..".equals(value)) {
            throw new SecurityException("업데이트 ZIP 파일 이름이 올바르지 않습니다.");
        }
    }

    private static String digest(byte[] value) throws Exception {
        return hex(MessageDigest.getInstance("SHA-256").digest(value));
    }

    private static String hex(byte[] value) {
        StringBuilder encoded = new StringBuilder(value.length * 2);
        for (byte item : value) encoded.append(String.format(Locale.ROOT, "%02x", item & 0xff));
        return encoded.toString();
    }

    static final class VerifiedBundle {
        final File directory;
        final File apk;
        final String apkSha256;
        final String applicationId;
        final String version;
        final long versionCode;
        final String currentVersion;
        final long currentVersionCode;
        final String channel;
        final String commit;
        final String createdAt;
        final String certificateSha256;
        final long apkBytes;

        VerifiedBundle(
                File directory,
                File apk,
                String apkSha256,
                String applicationId,
                String version,
                long versionCode,
                String currentVersion,
                long currentVersionCode,
                String channel,
                String commit,
                String createdAt,
                String certificateSha256,
                long apkBytes
        ) {
            this.directory = directory;
            this.apk = apk;
            this.apkSha256 = apkSha256;
            this.applicationId = applicationId;
            this.version = version;
            this.versionCode = versionCode;
            this.currentVersion = currentVersion;
            this.currentVersionCode = currentVersionCode;
            this.channel = channel;
            this.commit = commit;
            this.createdAt = createdAt;
            this.certificateSha256 = certificateSha256;
            this.apkBytes = apkBytes;
        }
    }

    private static final class Manifest {
        final String applicationId;
        final String version;
        final long versionCode;
        final String channel;
        final String commit;
        final String createdAt;
        final String signingCertificateSha256;
        final Artifact apk;
        final Artifact sbom;

        Manifest(String applicationId, String version, long versionCode, String channel, String commit,
                String createdAt, String signingCertificateSha256, Artifact apk, Artifact sbom) {
            this.applicationId = applicationId;
            this.version = version;
            this.versionCode = versionCode;
            this.channel = channel;
            this.commit = commit;
            this.createdAt = createdAt;
            this.signingCertificateSha256 = signingCertificateSha256;
            this.apk = apk;
            this.sbom = sbom;
        }
    }

    private static final class Artifact {
        final String kind;
        final String file;
        final String sha256;
        final long bytes;

        Artifact(String kind, String file, String sha256, long bytes) {
            this.kind = kind;
            this.file = file;
            this.sha256 = sha256;
            this.bytes = bytes;
        }
    }

    private static final class BoundedInputStream extends FilterInputStream {
        private final long maximum;
        private long consumed;

        BoundedInputStream(InputStream source, long maximum) {
            super(source);
            this.maximum = maximum;
        }

        @Override
        public int read() throws IOException {
            int value = super.read();
            if (value != -1) record(1L);
            return value;
        }

        @Override
        public int read(byte[] buffer, int offset, int length) throws IOException {
            int read = super.read(buffer, offset, length);
            if (read > 0) record(read);
            return read;
        }

        private void record(long read) throws IOException {
            consumed += read;
            if (consumed > maximum) throw new IOException("업데이트 ZIP 입력이 너무 큽니다.");
        }
    }
}
