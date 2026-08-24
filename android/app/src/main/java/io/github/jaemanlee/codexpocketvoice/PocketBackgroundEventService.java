package io.github.jaemanlee.codexpocketvoice;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

import androidx.core.app.NotificationCompat;

import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

public class PocketBackgroundEventService extends Service {
    static final String ACTION_START = "io.github.jaemanlee.codexpocketvoice.BACKGROUND_EVENTS_START";
    private static final String CHANNEL_ID = "codex-pocket-background-events";
    private static final int NOTIFICATION_ID = 2602;
    private static final int CONNECT_TIMEOUT_MS = 10_000;
    private static final int READ_TIMEOUT_MS = 45_000;
    private static final int INITIAL_RETRY_MS = 1_000;
    private static final int MAX_RETRY_MS = 60_000;
    private static final AtomicBoolean RUNNING = new AtomicBoolean(false);

    private final List<Monitor> monitors = new ArrayList<>();
    private final AtomicBoolean stopping = new AtomicBoolean(false);
    private ExecutorService controlExecutor;
    private ExecutorService monitorExecutor;
    private PocketBackgroundEventStore store;

    static boolean isRunning() {
        return RUNNING.get();
    }

    @Override
    public void onCreate() {
        super.onCreate();
        stopping.set(false);
        store = new PocketBackgroundEventStore(this);
        controlExecutor = Executors.newSingleThreadExecutor();
        monitorExecutor = Executors.newFixedThreadPool(PocketBackgroundEventPolicy.MAX_SUBSCRIPTIONS);
        createNotificationChannel();
        PocketNotificationsPlugin.createWorkChannel(this);
        RUNNING.set(true);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        startForegroundCompat(notification("백그라운드 작업 알림을 준비하는 중…"));
        controlExecutor.execute(this::reload);
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        stopping.set(true);
        closeMonitors();
        if (controlExecutor != null) controlExecutor.shutdownNow();
        if (monitorExecutor != null) monitorExecutor.shutdownNow();
        RUNNING.set(false);
        super.onDestroy();
    }

    private void reload() {
        if (stopping.get()) return;
        closeMonitors();
        final PocketBackgroundEventStore.State state;
        try {
            state = store.load();
        } catch (Exception error) {
            updateNotification("백그라운드 알림 설정을 읽지 못했습니다.");
            return;
        }
        if (stopping.get()) return;
        if (!state.enabled || state.subscriptions.isEmpty()) {
            stopForeground(STOP_FOREGROUND_REMOVE);
            stopSelf();
            return;
        }
        synchronized (monitors) {
            if (stopping.get()) return;
            for (PocketBackgroundEventStore.Subscription subscription : state.subscriptions) {
                Monitor monitor = new Monitor(subscription);
                monitors.add(monitor);
                monitorExecutor.execute(monitor);
            }
        }
        if (stopping.get()) return;
        updateNotification("Companion " + state.subscriptions.size() + "대의 완료·승인 상태 확인 중");
    }

    private void closeMonitors() {
        synchronized (monitors) {
            for (Monitor monitor : monitors) monitor.close();
            monitors.clear();
        }
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "백그라운드 작업 연결",
                NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription("선택한 Linux Companion의 완료·승인 상태만 확인합니다.");
        channel.setLockscreenVisibility(NotificationCompat.VISIBILITY_PRIVATE);
        getSystemService(NotificationManager.class).createNotificationChannel(channel);
    }

    private Notification notification(String text) {
        Intent open = new Intent(this, MainActivity.class)
                .setPackage(getPackageName())
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent contentIntent = PendingIntent.getActivity(
                this,
                NOTIFICATION_ID,
                open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_pocket_link)
                .setContentTitle("Codex Pocket Voice")
                .setContentText(text)
                .setContentIntent(contentIntent)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .build();
    }

    private void startForegroundCompat(Notification notification) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
    }

    private void updateNotification(String text) {
        getSystemService(NotificationManager.class).notify(NOTIFICATION_ID, notification(text));
    }

    private final class Monitor implements Runnable, PocketBackgroundEventParser.Listener {
        private final PocketBackgroundEventStore.Subscription subscription;
        private final AtomicBoolean active = new AtomicBoolean(true);
        private volatile HttpURLConnection connection;
        private volatile long cursor;

        Monitor(PocketBackgroundEventStore.Subscription subscription) {
            this.subscription = subscription;
            this.cursor = subscription.cursor;
        }

        @Override
        public void run() {
            int retryMs = INITIAL_RETRY_MS;
            while (active.get()) {
                try {
                    connect();
                    retryMs = INITIAL_RETRY_MS;
                } catch (IOException | RuntimeException ignored) {
                    // The foreground status remains generic; credentials and network details are never logged.
                } finally {
                    HttpURLConnection current = connection;
                    connection = null;
                    if (current != null) current.disconnect();
                }
                if (!awaitRetry(retryMs)) return;
                retryMs = Math.min(MAX_RETRY_MS, retryMs * 2);
            }
        }

        private void connect() throws IOException {
            URL endpoint = new URL(
                    "http",
                    "127.0.0.1",
                    subscription.localPort,
                    "/api/events/notifications"
            );
            HttpURLConnection opened = (HttpURLConnection) endpoint.openConnection();
            connection = opened;
            opened.setRequestMethod("GET");
            opened.setConnectTimeout(CONNECT_TIMEOUT_MS);
            opened.setReadTimeout(READ_TIMEOUT_MS);
            opened.setUseCaches(false);
            opened.setInstanceFollowRedirects(false);
            opened.setRequestProperty("Accept", "text/event-stream");
            opened.setRequestProperty("Authorization", "Bearer " + subscription.token);
            if (cursor > 0) opened.setRequestProperty("Last-Event-ID", Long.toString(cursor));
            int status = opened.getResponseCode();
            if (status != HttpURLConnection.HTTP_OK) throw new IOException("Background event request failed");
            String contentType = opened.getHeaderField("Content-Type");
            if (contentType == null || !contentType.toLowerCase(java.util.Locale.US).startsWith("text/event-stream")) {
                throw new IOException("Background event content type is invalid");
            }
            try (InputStream input = opened.getInputStream()) {
                PocketBackgroundEventParser.read(input, this);
            }
        }

        @Override
        public void onNotification(PocketBackgroundEventParser.NotificationEvent event) throws IOException {
            if (!active.get()) return;
            if (PocketBackgroundEventPolicy.shouldNotify(
                    event.kind,
                    event.occurredAt,
                    event.expiresAt,
                    System.currentTimeMillis()
            ) && !PocketNotificationsPlugin.isUiVisible()) {
                try {
                    PocketNotificationsPlugin.postWorkNotification(
                            PocketBackgroundEventService.this,
                            event.kind,
                            subscription.deviceId,
                            event.operationId
                    );
                } catch (RuntimeException ignored) {
                    // A revoked OS notification permission must not stop cursor reconciliation.
                }
            }
            persistCursor(event.cursor, false);
        }

        @Override
        public void onCursor(long nextCursor, boolean reset) throws IOException {
            persistCursor(nextCursor, reset);
        }

        private void persistCursor(long nextCursor, boolean reset) throws IOException {
            try {
                cursor = store.updateCursor(subscription, nextCursor, reset);
            } catch (Exception error) {
                throw new IOException("Background event cursor could not be stored", error);
            }
        }

        private boolean awaitRetry(long milliseconds) {
            synchronized (this) {
                if (!active.get()) return false;
                try {
                    wait(milliseconds);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    return false;
                }
                return active.get();
            }
        }

        void close() {
            if (!active.getAndSet(false)) return;
            HttpURLConnection current = connection;
            if (current != null) current.disconnect();
            synchronized (this) {
                notifyAll();
            }
        }
    }
}
