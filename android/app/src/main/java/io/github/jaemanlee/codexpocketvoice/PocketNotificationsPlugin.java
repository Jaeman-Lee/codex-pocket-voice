package io.github.jaemanlee.codexpocketvoice;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.util.Base64;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Objects;

@CapacitorPlugin(
    name = "PocketNotifications",
    permissions = { @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }) }
)
public class PocketNotificationsPlugin extends Plugin {
    static final String ACTION_OPEN_OPERATION = "io.github.jaemanlee.codexpocketvoice.OPEN_OPERATION";
    private static final String CHANNEL_ID = "codex-pocket-work";
    private static final String EXTRA_ACTION_TOKEN = "actionToken";
    private static final String EXTRA_DEVICE_ID = "deviceId";
    private static final String EXTRA_OPERATION_ID = "operationId";
    private static final String PREFERENCES = "pocket_notification_actions";
    private static final String TOKEN_KEY = "token";
    private static final int MAX_DEVICE_ID = 120;
    private static final int MAX_OPERATION_ID = 200;
    private static PendingAction pendingAction;

    @Override
    public void load() {
        createChannel();
    }

    @PluginMethod
    public void checkPermission(PluginCall call) {
        JSObject result = new JSObject();
        result.put("state", permissionState());
        call.resolve(result);
    }

    @PluginMethod
    public void requestPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
            || getPermissionState("notifications") == PermissionState.GRANTED) {
            resolvePermission(call);
            return;
        }
        requestPermissionForAlias("notifications", call, "permissionResult");
    }

    @PermissionCallback
    private void permissionResult(PluginCall call) {
        resolvePermission(call);
    }

    @PluginMethod
    public void post(PluginCall call) {
        if (!"granted".equals(permissionState())) {
            call.reject("Android 알림 권한이 필요합니다.");
            return;
        }
        try {
            String kind = requiredKind(call.getString("kind"));
            String deviceId = requiredIdentifier(call.getString(EXTRA_DEVICE_ID), MAX_DEVICE_ID, EXTRA_DEVICE_ID);
            String operationId = requiredIdentifier(call.getString(EXTRA_OPERATION_ID), MAX_OPERATION_ID, EXTRA_OPERATION_ID);
            Intent openIntent = new Intent(getContext(), MainActivity.class)
                .setAction(ACTION_OPEN_OPERATION)
                .setPackage(getContext().getPackageName())
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP)
                .putExtra(EXTRA_ACTION_TOKEN, actionToken(getContext()))
                .putExtra(EXTRA_DEVICE_ID, deviceId)
                .putExtra(EXTRA_OPERATION_ID, operationId);
            int notificationId = Objects.hash(deviceId, operationId, kind) & 0x7fffffff;
            PendingIntent contentIntent = PendingIntent.getActivity(
                getContext(),
                notificationId,
                openIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
            );
            NotificationCompat.Builder notification = new NotificationCompat.Builder(getContext(), CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_pocket_link)
                .setContentTitle("Codex Pocket Voice")
                .setContentText(notificationText(kind))
                .setContentIntent(contentIntent)
                .setAutoCancel(true)
                .setOnlyAlertOnce(true)
                .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
                .setCategory("approval".equals(kind)
                    ? NotificationCompat.CATEGORY_REMINDER
                    : "failed".equals(kind) ? NotificationCompat.CATEGORY_ERROR : NotificationCompat.CATEGORY_STATUS)
                .setPriority(NotificationCompat.PRIORITY_DEFAULT);
            getContext().getSystemService(NotificationManager.class).notify(notificationId, notification.build());
            JSObject result = new JSObject();
            result.put("posted", true);
            call.resolve(result);
        } catch (IllegalArgumentException error) {
            call.reject(error.getMessage());
        }
    }

    @PluginMethod
    public void consumePendingAction(PluginCall call) {
        PendingAction action;
        synchronized (PocketNotificationsPlugin.class) {
            action = pendingAction;
            pendingAction = null;
        }
        JSObject result = new JSObject();
        result.put("pending", action != null);
        if (action != null) {
            result.put(EXTRA_DEVICE_ID, action.deviceId);
            result.put(EXTRA_OPERATION_ID, action.operationId);
        }
        call.resolve(result);
    }

    static void captureIntent(Context context, Intent intent) {
        if (intent == null || !ACTION_OPEN_OPERATION.equals(intent.getAction())) return;
        String presentedToken = intent.getStringExtra(EXTRA_ACTION_TOKEN);
        String expectedToken = actionToken(context);
        if (presentedToken == null || !MessageDigest.isEqual(
            presentedToken.getBytes(StandardCharsets.UTF_8),
            expectedToken.getBytes(StandardCharsets.UTF_8)
        )) return;
        try {
            PendingAction action = new PendingAction(
                requiredIdentifier(intent.getStringExtra(EXTRA_DEVICE_ID), MAX_DEVICE_ID, EXTRA_DEVICE_ID),
                requiredIdentifier(intent.getStringExtra(EXTRA_OPERATION_ID), MAX_OPERATION_ID, EXTRA_OPERATION_ID)
            );
            synchronized (PocketNotificationsPlugin.class) {
                pendingAction = action;
            }
            intent.removeExtra(EXTRA_ACTION_TOKEN);
            intent.removeExtra(EXTRA_DEVICE_ID);
            intent.removeExtra(EXTRA_OPERATION_ID);
            intent.setAction(Intent.ACTION_MAIN);
        } catch (IllegalArgumentException ignored) {
            // Ignore forged or corrupt notification actions without exposing identifiers.
        }
    }

    private void resolvePermission(PluginCall call) {
        JSObject result = new JSObject();
        result.put("state", permissionState());
        call.resolve(result);
    }

    private String permissionState() {
        if (!NotificationManagerCompat.from(getContext()).areNotificationsEnabled()) return "denied";
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return "granted";
        PermissionState state = getPermissionState("notifications");
        if (state == PermissionState.GRANTED) return "granted";
        if (state == PermissionState.DENIED) return "denied";
        return "prompt";
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            "작업 상태",
            NotificationManager.IMPORTANCE_DEFAULT
        );
        channel.setDescription("완료, 승인 필요, 오류 상태만 표시합니다.");
        channel.setLockscreenVisibility(NotificationCompat.VISIBILITY_PRIVATE);
        getContext().getSystemService(NotificationManager.class).createNotificationChannel(channel);
    }

    private static String requiredKind(String kind) {
        if (!"completed".equals(kind) && !"approval".equals(kind) && !"failed".equals(kind)) {
            throw new IllegalArgumentException("알림 종류가 올바르지 않습니다.");
        }
        return kind;
    }

    private static String requiredIdentifier(String value, int maximum, String name) {
        if (value == null || value.isEmpty() || value.length() > maximum || value.matches(".*[\\x00-\\x1f\\x7f].*")) {
            throw new IllegalArgumentException(name + " 값이 올바르지 않습니다.");
        }
        return value;
    }

    private static String notificationText(String kind) {
        if ("approval".equals(kind)) return "화면에서 검토할 작업이 있습니다.";
        if ("failed".equals(kind)) return "작업이 실패했습니다. 앱에서 확인하세요.";
        return "작업이 끝났습니다. 앱에서 결과를 확인하세요.";
    }

    private static synchronized String actionToken(Context context) {
        SharedPreferences preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
        String existing = preferences.getString(TOKEN_KEY, "");
        if (!existing.isEmpty()) return existing;
        byte[] bytes = new byte[32];
        new SecureRandom().nextBytes(bytes);
        String created = Base64.encodeToString(bytes, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
        preferences.edit().putString(TOKEN_KEY, created).commit();
        return created;
    }

    private static final class PendingAction {
        final String deviceId;
        final String operationId;

        PendingAction(String deviceId, String operationId) {
            this.deviceId = deviceId;
            this.operationId = operationId;
        }
    }
}
