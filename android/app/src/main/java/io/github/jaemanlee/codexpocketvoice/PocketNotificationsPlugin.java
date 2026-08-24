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
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSArray;
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
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONObject;

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
    private static final AtomicBoolean UI_VISIBLE = new AtomicBoolean(false);
    private static PendingAction pendingAction;

    @Override
    public void load() {
        createWorkChannel(getContext());
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
            postWorkNotification(getContext(), kind, deviceId, operationId);
            JSObject result = new JSObject();
            result.put("posted", true);
            call.resolve(result);
        } catch (IllegalArgumentException error) {
            call.reject(error.getMessage());
        }
    }

    @PluginMethod
    public void configure(PluginCall call) {
        if (!"granted".equals(permissionState())) {
            call.reject("Android 알림 권한이 필요합니다.");
            return;
        }
        JSArray values = call.getArray("subscriptions");
        if (values == null || values.length() > PocketBackgroundEventPolicy.MAX_SUBSCRIPTIONS) {
            call.reject("백그라운드 알림 등록이 올바르지 않습니다.");
            return;
        }
        try {
            List<PocketBackgroundEventStore.Subscription> subscriptions = new ArrayList<>();
            for (int index = 0; index < values.length(); index += 1) {
                JSONObject item = values.getJSONObject(index);
                if (item.length() != 3) throw new IllegalArgumentException("백그라운드 알림 등록이 올바르지 않습니다.");
                subscriptions.add(new PocketBackgroundEventStore.Subscription(
                        item.getString(EXTRA_DEVICE_ID),
                        item.getInt("localPort"),
                        item.getString("token"),
                        0
                ));
            }
            PocketBackgroundEventStore.State state = new PocketBackgroundEventStore(getContext()).configure(subscriptions);
            if (state.subscriptions.isEmpty()) {
                getContext().stopService(new Intent(getContext(), PocketBackgroundEventService.class));
            } else {
                ContextCompat.startForegroundService(
                        getContext(),
                        new Intent(getContext(), PocketBackgroundEventService.class).setAction(PocketBackgroundEventService.ACTION_START)
                );
            }
            JSObject result = new JSObject();
            result.put("enabled", true);
            result.put("subscriptionCount", state.subscriptions.size());
            call.resolve(result);
        } catch (Exception error) {
            call.reject("백그라운드 알림을 설정할 수 없습니다.", error);
        }
    }

    @PluginMethod
    public void disable(PluginCall call) {
        try {
            new PocketBackgroundEventStore(getContext()).clear();
            getContext().stopService(new Intent(getContext(), PocketBackgroundEventService.class));
            JSObject result = new JSObject();
            result.put("enabled", false);
            result.put("subscriptionCount", 0);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("백그라운드 알림을 끌 수 없습니다.", error);
        }
    }

    @PluginMethod
    public void status(PluginCall call) {
        try {
            PocketBackgroundEventStore.State state = new PocketBackgroundEventStore(getContext()).load();
            JSObject result = new JSObject();
            result.put("enabled", state.enabled);
            result.put("subscriptionCount", state.subscriptions.size());
            result.put("running", PocketBackgroundEventService.isRunning());
            call.resolve(result);
        } catch (Exception error) {
            call.reject("백그라운드 알림 상태를 읽을 수 없습니다.", error);
        }
    }

    @PluginMethod
    public void consumePendingAction(PluginCall call) {
        PendingAction action = takePendingAction();
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
        try {
            if (presentedToken == null || !MessageDigest.isEqual(
                presentedToken.getBytes(StandardCharsets.UTF_8),
                expectedToken.getBytes(StandardCharsets.UTF_8)
            )) return;
            PendingAction action = new PendingAction(
                requiredIdentifier(intent.getStringExtra(EXTRA_DEVICE_ID), MAX_DEVICE_ID, EXTRA_DEVICE_ID),
                requiredIdentifier(intent.getStringExtra(EXTRA_OPERATION_ID), MAX_OPERATION_ID, EXTRA_OPERATION_ID)
            );
            synchronized (PocketNotificationsPlugin.class) {
                pendingAction = action;
            }
        } catch (IllegalArgumentException ignored) {
            // Ignore forged or corrupt notification actions without exposing identifiers.
        } finally {
            intent.removeExtra(EXTRA_ACTION_TOKEN);
            intent.removeExtra(EXTRA_DEVICE_ID);
            intent.removeExtra(EXTRA_OPERATION_ID);
            intent.setAction(Intent.ACTION_MAIN);
        }
    }

    static synchronized PendingAction takePendingAction() {
        PendingAction action = pendingAction;
        pendingAction = null;
        return action;
    }

    static void setUiVisible(boolean visible) {
        UI_VISIBLE.set(visible);
    }

    static boolean isUiVisible() {
        return UI_VISIBLE.get();
    }

    static boolean postWorkNotification(Context context, String kind, String deviceId, String operationId) {
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return false;
        kind = requiredKind(kind);
        deviceId = requiredIdentifier(deviceId, MAX_DEVICE_ID, EXTRA_DEVICE_ID);
        operationId = requiredIdentifier(operationId, MAX_OPERATION_ID, EXTRA_OPERATION_ID);
        createWorkChannel(context);
        Intent openIntent = createOpenOperationIntent(context, deviceId, operationId);
        int notificationId = Objects.hash(deviceId, operationId, kind) & 0x7fffffff;
        PendingIntent contentIntent = PendingIntent.getActivity(
            context,
            notificationId,
            openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        NotificationCompat.Builder notification = new NotificationCompat.Builder(context, CHANNEL_ID)
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
        context.getSystemService(NotificationManager.class).notify(notificationId, notification.build());
        return true;
    }

    static Intent createOpenOperationIntent(Context context, String deviceId, String operationId) {
        return new Intent(context, MainActivity.class)
            .setAction(ACTION_OPEN_OPERATION)
            .setPackage(context.getPackageName())
            .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra(EXTRA_ACTION_TOKEN, actionToken(context))
            .putExtra(EXTRA_DEVICE_ID, requiredIdentifier(deviceId, MAX_DEVICE_ID, EXTRA_DEVICE_ID))
            .putExtra(EXTRA_OPERATION_ID, requiredIdentifier(operationId, MAX_OPERATION_ID, EXTRA_OPERATION_ID));
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

    static void createWorkChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            "작업 상태",
            NotificationManager.IMPORTANCE_DEFAULT
        );
        channel.setDescription("완료, 승인 필요, 오류 상태만 표시합니다.");
        channel.setLockscreenVisibility(NotificationCompat.VISIBILITY_PRIVATE);
        context.getSystemService(NotificationManager.class).createNotificationChannel(channel);
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

    static final class PendingAction {
        final String deviceId;
        final String operationId;

        PendingAction(String deviceId, String operationId) {
            this.deviceId = deviceId;
            this.operationId = operationId;
        }
    }
}
