package io.github.jaemanlee.codexpocketvoice;

import android.content.ActivityNotFoundException;
import android.content.Intent;
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
        if (getPermissionState("runCommand") != PermissionState.GRANTED) {
            requestPermissionForAlias("runCommand", call, "permissionResult");
            return;
        }
        startTunnel(call);
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
            startTermuxCommand(
                "/data/data/com.termux/files/usr/bin/phone-codex-web",
                new String[] { "start" }
            );
            JSObject result = new JSObject();
            result.put("scheduled", true);
            result.put("pc", true);
            result.put("phone", true);
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
}
