package io.github.jaemanlee.codexpocketvoice;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

@CapacitorPlugin(
    name = "PocketTunnel",
    permissions = { @Permission(alias = "runCommand", strings = { "com.termux.permission.RUN_COMMAND" }) }
)
public class PocketTunnelPlugin extends Plugin {
    private static final String TERMUX_PACKAGE = "com.termux";
    private static final String TERMUX_SERVICE = "com.termux.app.RunCommandService";

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
    public void configurePocketLink(PluginCall call) {
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
        try {
            PocketLinkConfigStore.Config config = new PocketLinkConfigStore.Config(
                    label, localPort, host, remotePort, primaryPin, backupPin, false
            );
            new PocketLinkConfigStore(getContext()).save(config);
            saved = true;
            startPocketLinkService(localPort);
            JSObject result = new JSObject();
            result.put("configured", true);
            result.put("transport", "pocketlink");
            result.put("localPort", localPort);
            call.resolve(result);
        } catch (Exception error) {
            if (saved) {
                try { new PocketLinkConfigStore(getContext()).remove(localPort); } catch (Exception ignored) {}
            }
            call.reject("PocketLink 설정을 Android Keystore로 보호하지 못했습니다.", error);
        }
    }

    @PluginMethod
    public void removePocketLink(PluginCall call) {
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
            call.resolve();
        } catch (Exception error) {
            call.reject("PocketLink 설정을 삭제하지 못했습니다.", error);
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
            boolean configured = new PocketLinkConfigStore(getContext()).load(localPort) != null;
            JSObject result = new JSObject();
            result.put("configured", configured);
            result.put("running", configured && PocketLinkService.isRunning(localPort));
            result.put("transport", configured ? "pocketlink" : "termux");
            String error = PocketLinkService.error(localPort);
            if (error != null) result.put("error", error);
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
