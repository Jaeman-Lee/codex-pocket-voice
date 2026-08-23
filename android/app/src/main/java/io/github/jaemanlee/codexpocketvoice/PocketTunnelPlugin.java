package io.github.jaemanlee.codexpocketvoice;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import androidx.activity.result.ActivityResult;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.journeyapps.barcodescanner.ScanContract;
import com.journeyapps.barcodescanner.ScanIntentResult;
import com.journeyapps.barcodescanner.ScanOptions;

@CapacitorPlugin(
    name = "PocketTunnel",
    permissions = { @Permission(alias = "runCommand", strings = { "com.termux.permission.RUN_COMMAND" }) }
)
public class PocketTunnelPlugin extends Plugin {
    private static final String TERMUX_PACKAGE = "com.termux";
    private static final String TERMUX_SERVICE = "com.termux.app.RunCommandService";
    private static final long PIN_PROMOTION_MAX_AGE_MS = 120_000L;

    @PluginMethod
    public void scanPocketLinkQr(PluginCall call) {
        ScanOptions options = new ScanOptions()
                .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                .setPrompt("Linux Companion의 PocketLink QR을 스캔하세요")
                .setBeepEnabled(false)
                .setBarcodeImageEnabled(false)
                .setOrientationLocked(false)
                .setTimeout(120_000);
        startActivityForResult(call, options.createScanIntent(getContext()), "scanPocketLinkQrResult");
    }

    @ActivityCallback
    private void scanPocketLinkQrResult(PluginCall call, ActivityResult activityResult) {
        if (call == null) return;
        ScanIntentResult result = new ScanContract().parseResult(
                activityResult.getResultCode(),
                activityResult.getData()
        );
        String contents = result.getContents();
        JSObject response = new JSObject();
        if (contents == null) {
            response.put("cancelled", true);
            call.resolve(response);
            return;
        }
        if (contents.length() > 2048 || !contents.startsWith("codex-pocket://pair?")) {
            call.reject("Codex Pocket Voice용 PocketLink QR이 아닙니다.");
            return;
        }
        response.put("cancelled", false);
        response.put("value", contents);
        call.resolve(response);
    }

    @PluginMethod
    public void start(PluginCall call) {
        int localPort = optionalPort(call, "localPort", 8788);
        if (localPort < 0) {
            call.reject("localPort는 1024~65535 사이여야 합니다.");
            return;
        }
        try {
            PocketLinkConfigStore.Config config = new PocketLinkConfigStore(getContext()).load(localPort);
            if (config != null) {
                startPocketLinkService(localPort);
                JSObject result = new JSObject();
                result.put("scheduled", true);
                result.put("pc", true);
                result.put("transport", "pocketlink");
                result.put("localPort", localPort);
                call.resolve(result);
                return;
            }
        } catch (Exception error) {
            call.reject("PocketLink 보안 설정을 읽을 수 없습니다. 자동으로 SSH 연결로 우회하지 않습니다.", error);
            return;
        }
        if (!canRunCommand()) {
            JSObject result = new JSObject();
            result.put("scheduled", false);
            result.put("manual", true);
            result.put("transport", "termux");
            result.put("message", "Google Play Termux에서는 내장 Boot 자동 시작을 사용합니다. 연결이 꺼져 있으면 Termux에서 codex-pocket-voice 작업을 한 번 실행해 주세요.");
            call.resolve(result);
            return;
        }
        if (getPermissionState("runCommand") != PermissionState.GRANTED) {
            requestPermissionForAlias("runCommand", call, "permissionResult");
            return;
        }
        startTunnel(call);
    }

    @PluginMethod
    public synchronized void configurePocketLink(PluginCall call) {
        String label = normalizedLabel(call.getString("label"));
        String host = normalizedHost(call.getString("host"));
        String primaryPin = normalizedPin(call.getString("primaryPin"), false);
        String backupPin = normalizedPin(call.getString("backupPin"), true);
        int localPort = optionalPort(call, "localPort", -1);
        int remotePort = optionalPort(call, "remotePort", -1);
        if (label == null || host == null || primaryPin == null || backupPin == null || localPort < 0 || remotePort < 0) {
            call.reject("PocketLink 연결 정보가 올바르지 않습니다.");
            return;
        }
        if (!backupPin.isEmpty() && backupPin.equals(primaryPin)) {
            call.reject("교체용 SPKI pin은 기본 pin과 달라야 합니다.");
            return;
        }
        boolean saved = false;
        boolean createdIdentity = false;
        PocketLinkConfigStore.Config previous = null;
        PocketLinkConfigStore configStore = new PocketLinkConfigStore(getContext());
        PocketLinkIdentityStore identityStore = new PocketLinkIdentityStore();
        try {
            previous = configStore.load(localPort);
            boolean hadIdentity = identityStore.exists(localPort);
            identityStore.ensure(localPort);
            createdIdentity = !hadIdentity;
            PocketLinkConfigStore.Config config = new PocketLinkConfigStore.Config(
                    label, localPort, host, remotePort, primaryPin, backupPin, false
            );
            configStore.save(config);
            saved = true;
            startPocketLinkService(localPort);
            JSObject result = new JSObject();
            result.put("configured", true);
            result.put("transport", "pocketlink");
            result.put("localPort", localPort);
            call.resolve(result);
        } catch (Exception error) {
            if (saved) {
                try {
                    if (previous == null) configStore.remove(localPort);
                    else configStore.save(previous);
                } catch (Exception ignored) {}
            }
            if (createdIdentity && previous == null) {
                try { identityStore.remove(localPort); } catch (Exception ignored) {}
            }
            call.reject("PocketLink 설정과 단말 identity를 Android Keystore로 보호하지 못했습니다.", error);
        }
    }

    @PluginMethod
    public synchronized void removePocketLink(PluginCall call) {
        int localPort = optionalPort(call, "localPort", -1);
        if (localPort < 0) {
            call.reject("localPort는 1024~65535 사이여야 합니다.");
            return;
        }
        try {
            Intent stop = new Intent(getContext(), PocketLinkService.class);
            stop.setAction(PocketLinkService.ACTION_STOP);
            stop.putExtra(PocketLinkService.EXTRA_LOCAL_PORT, localPort);
            ContextCompat.startForegroundService(getContext(), stop);
            new PocketLinkConfigStore(getContext()).remove(localPort);
            new PocketLinkIdentityStore().remove(localPort);
            call.resolve();
        } catch (Exception error) {
            call.reject("PocketLink 설정을 삭제하지 못했습니다.", error);
        }
    }

    @PluginMethod
    public synchronized void preparePocketLinkIdentityRotation(PluginCall call) {
        int localPort = optionalPort(call, "localPort", -1);
        if (localPort < 0) {
            call.reject("localPort는 1024~65535 사이여야 합니다.");
            return;
        }
        PocketLinkConfigStore configStore = new PocketLinkConfigStore(getContext());
        PocketLinkIdentityStore identityStore = new PocketLinkIdentityStore();
        String nextSlot = null;
        boolean saved = false;
        try {
            PocketLinkConfigStore.Config config = configStore.load(localPort);
            if (config == null) {
                call.reject("PocketLink 설정이 없습니다.");
                return;
            }
            if (!config.pendingIdentitySlot.isEmpty()) {
                identityStore.ensure(localPort, config.pendingIdentitySlot);
                PocketLinkService.clearPinSlot(localPort);
                startPocketLinkService(localPort);
                JSObject result = new JSObject();
                result.put("prepared", true);
                result.put("resumed", true);
                call.resolve(result);
                return;
            }
            nextSlot = PocketLinkIdentityStore.nextSlot(config.identitySlot);
            identityStore.remove(localPort, nextSlot);
            identityStore.ensure(localPort, nextSlot);
            configStore.save(config.withPendingIdentitySlot(nextSlot));
            saved = true;
            PocketLinkService.clearPinSlot(localPort);
            startPocketLinkService(localPort);
            JSObject result = new JSObject();
            result.put("prepared", true);
            result.put("resumed", false);
            call.resolve(result);
        } catch (Exception error) {
            if (!saved && nextSlot != null) {
                try { identityStore.remove(localPort, nextSlot); } catch (Exception ignored) {}
            }
            call.reject("새 PocketLink 단말 identity를 준비하지 못했습니다.", error);
        }
    }

    @PluginMethod
    public synchronized void commitPocketLinkIdentityRotation(PluginCall call) {
        int localPort = optionalPort(call, "localPort", -1);
        if (localPort < 0) {
            call.reject("localPort는 1024~65535 사이여야 합니다.");
            return;
        }
        try {
            PocketLinkConfigStore configStore = new PocketLinkConfigStore(getContext());
            PocketLinkConfigStore.Config config = configStore.load(localPort);
            if (config == null || config.pendingIdentitySlot.isEmpty()) {
                call.reject("확정할 PocketLink 단말 identity 교체가 없습니다.");
                return;
            }
            PocketLinkIdentityStore identityStore = new PocketLinkIdentityStore();
            identityStore.ensure(localPort, config.pendingIdentitySlot);
            identityStore.remove(localPort, config.identitySlot);
            configStore.save(config.commitPendingIdentitySlot());
            PocketLinkService.clearPinSlot(localPort);
            startPocketLinkService(localPort);
            JSObject result = new JSObject();
            result.put("committed", true);
            result.put("retiredPreviousIdentity", true);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("PocketLink 단말 identity 교체를 확정하지 못했습니다.", error);
        }
    }

    @PluginMethod
    public synchronized void abortPocketLinkIdentityRotation(PluginCall call) {
        int localPort = optionalPort(call, "localPort", -1);
        if (localPort < 0) {
            call.reject("localPort는 1024~65535 사이여야 합니다.");
            return;
        }
        try {
            PocketLinkConfigStore configStore = new PocketLinkConfigStore(getContext());
            PocketLinkConfigStore.Config config = configStore.load(localPort);
            if (config == null || config.pendingIdentitySlot.isEmpty()) {
                call.reject("중단할 PocketLink 단말 identity 교체가 없습니다.");
                return;
            }
            String pendingSlot = config.pendingIdentitySlot;
            configStore.save(config.withPendingIdentitySlot(""));
            PocketLinkService.clearPinSlot(localPort);
            startPocketLinkService(localPort);
            new PocketLinkIdentityStore().remove(localPort, pendingSlot);
            JSObject result = new JSObject();
            result.put("aborted", true);
            result.put("retainedPreviousIdentity", true);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("PocketLink 단말 identity 교체를 중단하지 못했습니다.", error);
        }
    }

    @PluginMethod
    public synchronized void stagePocketLinkBackupPin(PluginCall call) {
        int localPort = optionalPort(call, "localPort", -1);
        String backupPin = normalizedPin(call.getString("backupPin"), false);
        if (localPort < 0 || backupPin == null) {
            call.reject("교체용 SPKI pin이 올바르지 않습니다.");
            return;
        }
        try {
            PocketLinkConfigStore configStore = new PocketLinkConfigStore(getContext());
            PocketLinkConfigStore.Config config = configStore.load(localPort);
            if (config == null) {
                call.reject("PocketLink 설정이 없습니다.");
                return;
            }
            if (backupPin.equals(config.primaryPin)) {
                call.reject("교체용 SPKI pin은 현재 기본 pin과 달라야 합니다.");
                return;
            }
            PocketLinkConfigStore.Config staged = config.withServerPins(config.primaryPin, backupPin);
            configStore.save(staged);
            PocketLinkService.clearPinSlot(localPort);
            startPocketLinkService(localPort);
            JSObject result = new JSObject();
            result.put("staged", true);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("교체용 PocketLink pin을 준비하지 못했습니다.", error);
        }
    }

    @PluginMethod
    public synchronized void clearPocketLinkBackupPin(PluginCall call) {
        int localPort = optionalPort(call, "localPort", -1);
        if (localPort < 0) {
            call.reject("localPort는 1024~65535 사이여야 합니다.");
            return;
        }
        try {
            PocketLinkConfigStore configStore = new PocketLinkConfigStore(getContext());
            PocketLinkConfigStore.Config config = configStore.load(localPort);
            if (config == null || config.backupPin == null || config.backupPin.isEmpty()) {
                call.reject("취소할 교체용 SPKI pin이 없습니다.");
                return;
            }
            PocketLinkConfigStore.Config cleared = config.withServerPins(config.primaryPin, "");
            configStore.save(cleared);
            PocketLinkService.clearPinSlot(localPort);
            startPocketLinkService(localPort);
            JSObject result = new JSObject();
            result.put("cleared", true);
            result.put("retainedPrimaryPin", true);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("교체용 PocketLink pin 준비를 취소하지 못했습니다.", error);
        }
    }

    @PluginMethod
    public synchronized void promotePocketLinkPin(PluginCall call) {
        int localPort = optionalPort(call, "localPort", -1);
        if (localPort < 0) {
            call.reject("localPort는 1024~65535 사이여야 합니다.");
            return;
        }
        try {
            PocketLinkConfigStore configStore = new PocketLinkConfigStore(getContext());
            PocketLinkConfigStore.Config config = configStore.load(localPort);
            Long observedAt = PocketLinkService.pinObservedAt(localPort);
            if (config == null || config.backupPin == null || config.backupPin.isEmpty()) {
                call.reject("승격할 교체용 SPKI pin이 없습니다.");
                return;
            }
            long observationAge = observedAt == null ? -1 : System.currentTimeMillis() - observedAt;
            if (!PocketLinkService.pinObservationMatches(localPort, "backup", config.backupPin) || observedAt == null
                    || observationAge < 0 || observationAge > PIN_PROMOTION_MAX_AGE_MS
                    || PocketLinkService.error(localPort) != null) {
                call.reject("최근 2분 안에 교체용 pin으로 성공한 연결을 먼저 확인해야 합니다.");
                return;
            }
            PocketLinkConfigStore.Config promoted = config.withServerPins(config.backupPin, "");
            configStore.save(promoted);
            PocketLinkService.clearPinSlot(localPort);
            startPocketLinkService(localPort);
            JSObject result = new JSObject();
            result.put("promoted", true);
            result.put("retiredPreviousPin", true);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("PocketLink pin 교체를 확정하지 못했습니다.", error);
        }
    }

    @PluginMethod
    public void status(PluginCall call) {
        int localPort = optionalPort(call, "localPort", 8788);
        if (localPort < 0) {
            call.reject("localPort는 1024~65535 사이여야 합니다.");
            return;
        }
        try {
            PocketLinkConfigStore.Config config = new PocketLinkConfigStore(getContext()).load(localPort);
            boolean configured = config != null;
            JSObject result = new JSObject();
            result.put("configured", configured);
            result.put("running", configured && PocketLinkService.isRunning(localPort));
            result.put("transport", configured ? "pocketlink" : "termux");
            if (configured) {
                result.put("backupPinConfigured", config.backupPin != null && !config.backupPin.isEmpty());
                result.put("identityRotationPending", !config.pendingIdentitySlot.isEmpty());
                result.put("identityReady", PocketLinkService.identitySlotActive(
                        localPort,
                        config.effectiveIdentitySlot()
                ));
                result.put("identityRotationReady", !config.pendingIdentitySlot.isEmpty()
                        && PocketLinkService.identitySlotActive(localPort, config.pendingIdentitySlot));
            }
            String error = PocketLinkService.error(localPort);
            if (error != null) result.put("error", error);
            String pinSlot = PocketLinkService.pinSlot(localPort);
            Long pinObservedAt = PocketLinkService.pinObservedAt(localPort);
            String configuredPin = config == null ? null
                    : "backup".equals(pinSlot) ? config.backupPin : config.primaryPin;
            if (pinSlot != null && pinObservedAt != null
                    && PocketLinkService.pinObservationMatches(localPort, pinSlot, configuredPin)) {
                result.put("pinSlot", pinSlot);
                result.put("pinObservedAt", pinObservedAt);
            }
            call.resolve(result);
        } catch (Exception error) {
            call.reject("PocketLink 상태를 읽을 수 없습니다.", error);
        }
    }

    private boolean canRunCommand() {
        Intent intent = new Intent();
        intent.setClassName(TERMUX_PACKAGE, TERMUX_SERVICE);
        intent.setAction("com.termux.RUN_COMMAND");
        return getContext().getPackageManager().resolveService(intent, 0) != null;
    }

    @PermissionCallback
    private void permissionResult(PluginCall call) {
        if (getPermissionState("runCommand") != PermissionState.GRANTED) {
            call.reject("앱 설정에서 ‘Termux 명령 실행’ 권한을 허용해 주세요.");
            return;
        }
        startTunnel(call);
    }

    private void startTunnel(PluginCall call) {
        try {
            startTermuxCommand(
                "/data/data/com.termux/files/usr/bin/pc-codex-web",
                new String[] { "start" }
            );
            JSObject result = new JSObject();
            result.put("scheduled", true);
            result.put("pc", true);
            result.put("transport", "termux");
            call.resolve(result);
        } catch (SecurityException error) {
            call.reject("Termux 명령 권한이 없습니다. 앱 설정의 추가 권한을 확인해 주세요.", error);
        } catch (ActivityNotFoundException error) {
            call.reject("Termux를 찾을 수 없습니다. F-Droid 또는 GitHub판 Termux를 설치해 주세요.", error);
        } catch (Exception error) {
            call.reject("Termux에서 Codex 연결을 시작하지 못했습니다: " + error.getMessage(), error);
        }
    }

    private void startTermuxCommand(String commandPath, String[] arguments) {
        Intent intent = new Intent();
        intent.setClassName(TERMUX_PACKAGE, TERMUX_SERVICE);
        intent.setAction("com.termux.RUN_COMMAND");
        intent.putExtra("com.termux.RUN_COMMAND_PATH", commandPath);
        intent.putExtra("com.termux.RUN_COMMAND_ARGUMENTS", arguments);
        intent.putExtra(
            "com.termux.RUN_COMMAND_WORKDIR",
            "/data/data/com.termux/files/home"
        );
        intent.putExtra("com.termux.RUN_COMMAND_BACKGROUND", true);
        getContext().startService(intent);
    }

    private void startPocketLinkService(int localPort) {
        Intent intent = new Intent(getContext(), PocketLinkService.class);
        intent.setAction(PocketLinkService.ACTION_START);
        intent.putExtra(PocketLinkService.EXTRA_LOCAL_PORT, localPort);
        ContextCompat.startForegroundService(getContext(), intent);
    }

    private int optionalPort(PluginCall call, String name, int fallback) {
        Integer value = call.getInt(name);
        int port = value == null ? fallback : value;
        return port < 1024 || port > 65535 ? -1 : port;
    }

    private String normalizedLabel(String value) {
        if (value == null) return null;
        String label = value.trim();
        return label.isEmpty() || label.length() > 60 ? null : label;
    }

    private String normalizedHost(String value) {
        if (value == null) return null;
        String host = value.trim();
        if (host.isEmpty() || host.length() > 253 || host.equals("0.0.0.0") || host.equals("::")
                || host.equalsIgnoreCase("localhost") || !host.matches("[A-Za-z0-9.:-]+")) return null;
        return host;
    }

    private String normalizedPin(String value, boolean optional) {
        if (value == null || value.trim().isEmpty()) return optional ? "" : null;
        String pin = value.trim();
        return pin.matches("sha256/[A-Za-z0-9+/]{43}=") ? pin : null;
    }
}
