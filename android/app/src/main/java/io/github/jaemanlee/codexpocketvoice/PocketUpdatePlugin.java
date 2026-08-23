package io.github.jaemanlee.codexpocketvoice;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import androidx.core.content.FileProvider;
import androidx.core.content.pm.PackageInfoCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "PocketUpdate")
public class PocketUpdatePlugin extends Plugin {
    private static final long REVIEW_MAX_AGE_MS = 10L * 60L * 1000L;
    private static final long DISCOVERY_MAX_AGE_MS = 10L * 60L * 1000L;
    private final Object stateLock = new Object();
    private final SecureRandom random = new SecureRandom();
    private final PocketOfficialReleaseClient officialReleaseClient = new PocketOfficialReleaseClient();
    private ExecutorService verifierExecutor;
    private VerifiedUpdate verifiedUpdate;
    private DiscoveredUpdate discoveredUpdate;
    private boolean officialDownloadBusy;
    private volatile boolean destroyed;

    @Override
    public void load() {
        destroyed = false;
        verifierExecutor = Executors.newSingleThreadExecutor();
        PocketUpdateVerifier.deleteDirectory(updateCacheRoot());
        updateCacheRoot().mkdirs();
    }

    @Override
    protected void handleOnDestroy() {
        destroyed = true;
        if (verifierExecutor != null) verifierExecutor.shutdownNow();
        discardState();
        super.handleOnDestroy();
    }

    @PluginMethod
    public void selectBundle(PluginCall call) {
        discardDiscovered();
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT)
                .addCategory(Intent.CATEGORY_OPENABLE)
                .setType("application/zip");
        startActivityForResult(call, intent, "selectBundleResult");
    }

    @ActivityCallback
    private void selectBundleResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != android.app.Activity.RESULT_OK || result.getData() == null
                || result.getData().getData() == null) {
            JSObject cancelled = new JSObject();
            cancelled.put("cancelled", true);
            call.resolve(cancelled);
            return;
        }
        Uri uri = result.getData().getData();
        discardVerified();
        discardDiscovered();
        verifierExecutor.execute(() -> verifySelection(call, uri));
    }

    @PluginMethod
    public void discoverOfficial(PluginCall call) {
        if (verifierExecutor == null || verifierExecutor.isShutdown()) {
            call.reject("업데이트 조회기를 사용할 수 없습니다.");
            return;
        }
        synchronized (stateLock) {
            if (officialDownloadBusy) {
                call.reject("공식 업데이트 다운로드가 이미 진행 중입니다.");
                return;
            }
        }
        discardVerified();
        discardDiscovered();
        verifierExecutor.execute(() -> discoverOfficialRelease(call));
    }

    @PluginMethod
    public void downloadOfficial(PluginCall call) {
        String token = call.getString("token", "");
        DiscoveredUpdate selected;
        synchronized (stateLock) {
            selected = discoveredUpdate;
            if (officialDownloadBusy) {
                call.reject("공식 업데이트 다운로드가 이미 진행 중입니다.");
                return;
            }
            if (selected == null || !secureEquals(selected.token, token)) {
                call.reject("조회한 공식 업데이트가 없거나 download token이 올바르지 않습니다.");
                return;
            }
            long age = System.currentTimeMillis() - selected.discoveredAt;
            if (age < 0L || age > DISCOVERY_MAX_AGE_MS) {
                discoveredUpdate = null;
                call.reject("공식 업데이트 조회가 만료되었습니다. 다시 조회해 주세요.");
                return;
            }
            officialDownloadBusy = true;
        }
        discardVerified();
        verifierExecutor.execute(() -> downloadAndVerifyOfficial(call, selected));
    }

    @PluginMethod
    public void discard(PluginCall call) {
        discardState();
        call.resolve();
    }

    @PluginMethod
    public void installVerified(PluginCall call) {
        String token = call.getString("token", "");
        VerifiedUpdate selected;
        synchronized (stateLock) {
            selected = verifiedUpdate;
        }
        if (selected == null || !secureEquals(selected.token, token)) {
            call.reject("검증한 업데이트가 없거나 설치 token이 올바르지 않습니다.");
            return;
        }
        if (System.currentTimeMillis() - selected.verifiedAt < 0
                || System.currentTimeMillis() - selected.verifiedAt > REVIEW_MAX_AGE_MS) {
            discardVerified();
            call.reject("업데이트 검토가 만료되었습니다. ZIP을 다시 선택해 주세요.");
            return;
        }
        try {
            if (!selected.bundle.apk.isFile() || selected.bundle.apk.length() != selected.bundle.apkBytes
                    || !secureEquals(PocketUpdateVerifier.fileSha256(selected.bundle.apk), selected.bundle.apkSha256)) {
                discardVerified();
                call.reject("검증 후 APK가 변경되어 설치하지 않았습니다.");
                return;
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                    && !getContext().getPackageManager().canRequestPackageInstalls()) {
                Intent settings = new Intent(
                        Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + getContext().getPackageName())
                );
                getActivity().startActivity(settings);
                JSObject response = new JSObject();
                response.put("launched", false);
                response.put("settingsRequired", true);
                call.resolve(response);
                return;
            }
            Uri apkUri = FileProvider.getUriForFile(
                    getContext(),
                    getContext().getPackageName() + ".fileprovider",
                    selected.bundle.apk
            );
            Intent install = new Intent(Intent.ACTION_INSTALL_PACKAGE)
                    .setData(apkUri)
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    .putExtra(Intent.EXTRA_NOT_UNKNOWN_SOURCE, false)
                    .putExtra(Intent.EXTRA_RETURN_RESULT, false);
            getActivity().startActivity(install);
            JSObject response = new JSObject();
            response.put("launched", true);
            response.put("settingsRequired", false);
            call.resolve(response);
        } catch (ActivityNotFoundException error) {
            call.reject("Android package installer를 열 수 없습니다.", error);
        } catch (Exception error) {
            call.reject("검증된 APK 설치 확인창을 열지 못했습니다.", error);
        }
    }

    private void verifySelection(PluginCall call, Uri uri) {
        try (InputStream input = getContext().getContentResolver().openInputStream(uri)) {
            if (input == null) throw new IllegalArgumentException("선택한 업데이트 ZIP을 읽을 수 없습니다.");
            PocketUpdateVerifier.VerifiedBundle bundle = PocketUpdateVerifier.verify(
                    getContext(), input, updateCacheRoot()
            );
            VerifiedUpdate update = new VerifiedUpdate(randomToken(), System.currentTimeMillis(), bundle);
            VerifiedUpdate previous;
            synchronized (stateLock) {
                if (destroyed) {
                    PocketUpdateVerifier.deleteDirectory(bundle.directory);
                    return;
                }
                previous = verifiedUpdate;
                verifiedUpdate = update;
            }
            if (previous != null) PocketUpdateVerifier.deleteDirectory(previous.bundle.directory);
            JSObject response = reviewResponse(update);
            response.put("cancelled", false);
            call.resolve(response);
        } catch (Exception error) {
            discardVerified();
            call.reject(safeError(error), error);
        }
    }

    private void discoverOfficialRelease(PluginCall call) {
        try {
            PackageInfo currentPackage = getContext().getPackageManager().getPackageInfo(
                    getContext().getPackageName(), 0
            );
            long currentVersionCode = PackageInfoCompat.getLongVersionCode(currentPackage);
            String currentVersion = currentPackage.versionName == null ? "" : currentPackage.versionName;
            PocketOfficialRelease.Evaluation release = PocketOfficialRelease.evaluate(
                    officialReleaseClient.fetchLatest(), currentVersionCode
            );
            JSObject response = new JSObject();
            response.put("available", release.available);
            response.put("currentVersion", currentVersion);
            response.put("currentVersionCode", currentVersionCode);
            response.put("latestVersion", release.version);
            response.put("latestVersionCode", release.versionCode);
            response.put("publishedAt", release.publishedAt);
            response.put("releaseUrl", release.releaseUrl);
            if (release.available && release.candidate != null) {
                DiscoveredUpdate discovered = new DiscoveredUpdate(
                        randomToken(), System.currentTimeMillis(), release.candidate
                );
                synchronized (stateLock) {
                    if (destroyed) return;
                    discoveredUpdate = discovered;
                }
                response.put("token", discovered.token);
                response.put("assetName", release.candidate.assetName);
                response.put("assetBytes", release.candidate.assetBytes);
                response.put("assetSha256", release.candidate.assetSha256);
                response.put("expiresAt", discovered.discoveredAt + DISCOVERY_MAX_AGE_MS);
            }
            call.resolve(response);
        } catch (Exception error) {
            discardDiscovered();
            call.reject(safeError(error));
        }
    }

    private void downloadAndVerifyOfficial(PluginCall call, DiscoveredUpdate selected) {
        File archive = null;
        PocketUpdateVerifier.VerifiedBundle bundle = null;
        try {
            archive = officialReleaseClient.download(selected.candidate, updateCacheRoot());
            try (InputStream input = new FileInputStream(archive)) {
                bundle = PocketUpdateVerifier.verify(getContext(), input, updateCacheRoot());
            }
            if (!selected.candidate.version.equals(bundle.version)
                    || selected.candidate.versionCode != bundle.versionCode) {
                throw new SecurityException("공식 Release와 signed manifest 버전이 다릅니다.");
            }
            VerifiedUpdate update = new VerifiedUpdate(randomToken(), System.currentTimeMillis(), bundle);
            VerifiedUpdate previous;
            synchronized (stateLock) {
                if (destroyed || discoveredUpdate != selected) {
                    PocketUpdateVerifier.deleteDirectory(bundle.directory);
                    bundle = null;
                    throw new IllegalStateException("공식 업데이트 다운로드가 취소되었습니다.");
                }
                previous = verifiedUpdate;
                verifiedUpdate = update;
                discoveredUpdate = null;
                officialDownloadBusy = false;
            }
            bundle = null;
            if (previous != null) PocketUpdateVerifier.deleteDirectory(previous.bundle.directory);
            JSObject response = reviewResponse(update);
            response.put("cancelled", false);
            call.resolve(response);
        } catch (Exception error) {
            if (bundle != null) PocketUpdateVerifier.deleteDirectory(bundle.directory);
            synchronized (stateLock) {
                if (discoveredUpdate == selected) discoveredUpdate = null;
                officialDownloadBusy = false;
            }
            if (!destroyed) call.reject(safeError(error));
        } finally {
            if (archive != null) archive.delete();
        }
    }

    private JSObject reviewResponse(VerifiedUpdate update) {
        PocketUpdateVerifier.VerifiedBundle bundle = update.bundle;
        JSObject response = new JSObject();
        response.put("token", update.token);
        response.put("applicationId", bundle.applicationId);
        response.put("version", bundle.version);
        response.put("versionCode", bundle.versionCode);
        response.put("currentVersion", bundle.currentVersion);
        response.put("currentVersionCode", bundle.currentVersionCode);
        response.put("channel", bundle.channel);
        response.put("commit", bundle.commit);
        response.put("createdAt", bundle.createdAt);
        response.put("certificateSha256", bundle.certificateSha256);
        response.put("apkSha256", bundle.apkSha256);
        response.put("apkBytes", bundle.apkBytes);
        response.put("expiresAt", update.verifiedAt + REVIEW_MAX_AGE_MS);
        return response;
    }

    private void discardVerified() {
        VerifiedUpdate previous;
        synchronized (stateLock) {
            previous = verifiedUpdate;
            verifiedUpdate = null;
        }
        if (previous != null) PocketUpdateVerifier.deleteDirectory(previous.bundle.directory);
    }

    private void discardDiscovered() {
        synchronized (stateLock) {
            discoveredUpdate = null;
        }
    }

    private void discardState() {
        discardDiscovered();
        discardVerified();
    }

    private String randomToken() {
        byte[] tokenBytes = new byte[32];
        random.nextBytes(tokenBytes);
        return Base64.encodeToString(tokenBytes, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
    }

    private File updateCacheRoot() {
        return new File(getContext().getCacheDir(), "verified-updates");
    }

    private static boolean secureEquals(String left, String right) {
        if (left == null || right == null) return false;
        return MessageDigest.isEqual(
                left.getBytes(StandardCharsets.UTF_8),
                right.getBytes(StandardCharsets.UTF_8)
        );
    }

    private static String safeError(Exception error) {
        String message = error.getMessage();
        if (message == null || message.trim().isEmpty() || message.length() > 240) {
            return "업데이트 ZIP을 안전하게 검증하지 못했습니다.";
        }
        return message;
    }

    private static final class VerifiedUpdate {
        final String token;
        final long verifiedAt;
        final PocketUpdateVerifier.VerifiedBundle bundle;

        VerifiedUpdate(String token, long verifiedAt, PocketUpdateVerifier.VerifiedBundle bundle) {
            this.token = token;
            this.verifiedAt = verifiedAt;
            this.bundle = bundle;
        }
    }

    private static final class DiscoveredUpdate {
        final String token;
        final long discoveredAt;
        final PocketOfficialRelease.Candidate candidate;

        DiscoveredUpdate(String token, long discoveredAt, PocketOfficialRelease.Candidate candidate) {
            this.token = token;
            this.discoveredAt = discoveredAt;
            this.candidate = candidate;
        }
    }
}
