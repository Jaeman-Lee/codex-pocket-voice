package io.github.jaemanlee.codexpocketvoice;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.SystemClock;
import android.util.Base64;

import androidx.core.app.NotificationCompat;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Semaphore;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLParameters;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.TrustManager;
import javax.net.ssl.TrustManagerFactory;
import javax.net.ssl.X509TrustManager;

public class PocketLinkService extends Service {
    static final String ACTION_START = "io.github.jaemanlee.codexpocketvoice.POCKET_LINK_START";
    static final String ACTION_STOP = "io.github.jaemanlee.codexpocketvoice.POCKET_LINK_STOP";
    static final String EXTRA_LOCAL_PORT = "localPort";
    private static final String CHANNEL_ID = "pocket-link";
    private static final int NOTIFICATION_ID = 2601;
    private static final int MAX_LINKS = 8;
    private static final int MAX_CONNECTIONS_PER_LINK = 8;
    private static final ConcurrentHashMap<Integer, Forwarder> RUNNING = new ConcurrentHashMap<>();
    private static final ConcurrentHashMap<Integer, String> ERRORS = new ConcurrentHashMap<>();
    private static final ConcurrentHashMap<Integer, PinObservation> PIN_OBSERVATIONS = new ConcurrentHashMap<>();
    private static final ConcurrentHashMap<Integer, String> ACTIVE_IDENTITY_SLOTS = new ConcurrentHashMap<>();
    private static final ConcurrentHashMap<Integer, String> LAST_VERIFIED_ROUTES = new ConcurrentHashMap<>();

    private ExecutorService controlExecutor;
    private ExecutorService connectionExecutor;
    private PocketLinkConfigStore configStore;
    private PocketLinkP2pController p2pController;

    static boolean isRunning(int localPort) {
        Forwarder forwarder = RUNNING.get(localPort);
        return forwarder != null && forwarder.isRunning();
    }

    static String error(int localPort) {
        return ERRORS.get(localPort);
    }

    static String pinSlot(int localPort) {
        PinObservation observation = PIN_OBSERVATIONS.get(localPort);
        return observation == null ? null : observation.slot;
    }

    static Long pinObservedAt(int localPort) {
        PinObservation observation = PIN_OBSERVATIONS.get(localPort);
        return observation == null ? null : observation.observedAt;
    }

    static boolean pinObservationMatches(int localPort, String slot, String expectedPin) {
        PinObservation observation = PIN_OBSERVATIONS.get(localPort);
        return observation != null && expectedPin != null
                && MessageDigest.isEqual(
                        observation.slot.getBytes(StandardCharsets.UTF_8),
                        slot.getBytes(StandardCharsets.UTF_8)
                )
                && MessageDigest.isEqual(
                        observation.pin.getBytes(StandardCharsets.UTF_8),
                        expectedPin.getBytes(StandardCharsets.UTF_8)
                );
    }

    static boolean identitySlotActive(int localPort, String expectedSlot) {
        String activeSlot = ACTIVE_IDENTITY_SLOTS.get(localPort);
        return activeSlot != null && activeSlot.equals(expectedSlot);
    }

    static String lastVerifiedRoute(int localPort) {
        return LAST_VERIFIED_ROUTES.get(localPort);
    }

    static void clearPinSlot(int localPort) {
        PIN_OBSERVATIONS.remove(localPort);
    }

    @Override
    public void onCreate() {
        super.onCreate();
        configStore = new PocketLinkConfigStore(this);
        p2pController = PocketLinkP2pController.get(this);
        controlExecutor = Executors.newSingleThreadExecutor();
        connectionExecutor = Executors.newFixedThreadPool(16);
        createNotificationChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        startForegroundCompat(notification("PocketLink 연결을 준비하는 중…"));
        if (intent == null) {
            controlExecutor.execute(this::restoreActiveLinks);
            return START_STICKY;
        }
        int localPort = intent.getIntExtra(EXTRA_LOCAL_PORT, -1);
        if (ACTION_STOP.equals(intent.getAction())) {
            controlExecutor.execute(() -> stopLink(localPort, true));
        } else if (ACTION_START.equals(intent.getAction())) {
            controlExecutor.execute(() -> startLink(localPort));
        }
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        for (Forwarder forwarder : RUNNING.values()) forwarder.close();
        RUNNING.clear();
        PIN_OBSERVATIONS.clear();
        ACTIVE_IDENTITY_SLOTS.clear();
        LAST_VERIFIED_ROUTES.clear();
        if (controlExecutor != null) controlExecutor.shutdownNow();
        if (connectionExecutor != null) connectionExecutor.shutdownNow();
        super.onDestroy();
    }

    private void restoreActiveLinks() {
        try {
            List<PocketLinkConfigStore.Config> configs = configStore.active();
            if (configs.isEmpty()) {
                stopForeground(STOP_FOREGROUND_REMOVE);
                stopSelf();
                return;
            }
            for (PocketLinkConfigStore.Config config : configs) startLink(config);
        } catch (Exception error) {
            updateNotification("PocketLink 설정을 복구하지 못했습니다.");
        }
    }

    private void startLink(int localPort) {
        try {
            PocketLinkConfigStore.Config config = configStore.load(localPort);
            if (config == null) throw new IllegalArgumentException("PocketLink 설정이 없습니다.");
            configStore.setActive(localPort, true);
            startLink(config.withActive(true));
        } catch (Exception error) {
            ERRORS.put(localPort, safeError(error));
            updateNotification("PocketLink 연결을 시작하지 못했습니다.");
        }
    }

    private void startLink(PocketLinkConfigStore.Config config) {
        Forwarder previous = RUNNING.remove(config.localPort);
        if (previous != null) previous.close();
        PIN_OBSERVATIONS.remove(config.localPort);
        ACTIVE_IDENTITY_SLOTS.remove(config.localPort);
        LAST_VERIFIED_ROUTES.remove(config.localPort);
        if (RUNNING.size() >= MAX_LINKS) {
            ERRORS.put(config.localPort, "PocketLink 등록 한도를 초과했습니다.");
            updateNotification("PocketLink 등록 한도를 초과했습니다.");
            return;
        }
        Forwarder forwarder = null;
        try {
            PocketLinkIdentityStore.Identity identity = new PocketLinkIdentityStore().ensure(
                    config.localPort,
                    config.effectiveIdentitySlot()
            );
            forwarder = new Forwarder(config, identity, p2pController, connectionExecutor);
            forwarder.start();
            RUNNING.put(config.localPort, forwarder);
            ACTIVE_IDENTITY_SLOTS.put(config.localPort, config.effectiveIdentitySlot());
            ERRORS.remove(config.localPort);
            updateNotification(config.label + "의 암호화 요청을 기다리는 중");
        } catch (Exception error) {
            if (forwarder != null) forwarder.close();
            ERRORS.put(config.localPort, safeError(error));
            updateNotification(config.label + " 연결을 열지 못했습니다.");
        }
    }

    private void stopLink(int localPort, boolean disable) {
        Forwarder forwarder = RUNNING.remove(localPort);
        if (forwarder != null) forwarder.close();
        ERRORS.remove(localPort);
        PIN_OBSERVATIONS.remove(localPort);
        ACTIVE_IDENTITY_SLOTS.remove(localPort);
        LAST_VERIFIED_ROUTES.remove(localPort);
        if (disable) {
            try {
                configStore.setActive(localPort, false);
            } catch (Exception ignored) {
                // The caller removes the encrypted config separately when deleting a target.
            }
        }
        if (RUNNING.isEmpty()) {
            stopForeground(STOP_FOREGROUND_REMOVE);
            stopSelf();
        } else {
            updateNotification("PocketLink 연결 " + RUNNING.size() + "개 유지 중");
        }
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "PocketLink 연결",
                NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription("Linux Companion과 암호화 연결을 유지합니다.");
        getSystemService(NotificationManager.class).createNotificationChannel(channel);
    }

    private Notification notification(String text) {
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent contentIntent = PendingIntent.getActivity(
                this,
                0,
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

    private static String safeError(Exception error) {
        if (error instanceof java.net.BindException) return "로컬 포트를 이미 사용 중입니다.";
        if (error instanceof P2pConnectionException) return "PocketLink P2P 연결을 사용할 수 없습니다.";
        if (error instanceof RelayConnectionException) return "PocketLink 릴레이를 사용할 수 없습니다.";
        if (error instanceof CertificateException) return "Companion 인증서 검증에 실패했습니다.";
        return "암호화 연결을 만들 수 없습니다.";
    }

    private static final class Forwarder {
        private final PocketLinkConfigStore.Config config;
        private final PocketLinkIdentityStore.Identity identity;
        private final PocketLinkP2pController p2pController;
        private final ExecutorService connectionExecutor;
        private final PocketLinkRoutePolicy routePolicy;
        private final Semaphore capacity = new Semaphore(MAX_CONNECTIONS_PER_LINK);
        private final AtomicBoolean running = new AtomicBoolean(false);
        private final Set<Connection> connections = ConcurrentHashMap.newKeySet();
        private ServerSocket listener;
        private Thread acceptThread;

        Forwarder(
                PocketLinkConfigStore.Config config,
                PocketLinkIdentityStore.Identity identity,
                PocketLinkP2pController p2pController,
                ExecutorService connectionExecutor
        ) {
            this.config = config;
            this.identity = identity;
            this.p2pController = p2pController;
            this.connectionExecutor = connectionExecutor;
            this.routePolicy = new PocketLinkRoutePolicy(
                    config.route(),
                    config.p2p != null,
                    config.relay != null
            );
        }

        void start() throws Exception {
            listener = new ServerSocket();
            listener.setReuseAddress(true);
            listener.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), config.localPort), 16);
            running.set(true);
            acceptThread = new Thread(this::acceptLoop, "PocketLink-" + config.localPort);
            acceptThread.setDaemon(true);
            acceptThread.start();
        }

        boolean isRunning() {
            return running.get() && listener != null && !listener.isClosed();
        }

        void close() {
            running.set(false);
            if (listener != null) {
                try { listener.close(); } catch (IOException ignored) {}
            }
            for (Connection connection : new ArrayList<>(connections)) connection.close();
            connections.clear();
            if (acceptThread != null) acceptThread.interrupt();
        }

        private void acceptLoop() {
            while (running.get()) {
                try {
                    Socket local = listener.accept();
                    if (!local.getInetAddress().isLoopbackAddress() || !capacity.tryAcquire()) {
                        local.close();
                        continue;
                    }
                    connectionExecutor.execute(() -> connect(local));
                } catch (IOException error) {
                    if (running.get()) ERRORS.put(config.localPort, "로컬 연결을 받을 수 없습니다.");
                    return;
                }
            }
        }

        private void connect(Socket local) {
            Socket remote = null;
            try {
                RouteSocket verified = tlsSocket(config, identity, routePolicy);
                remote = verified.socket;
                LAST_VERIFIED_ROUTES.put(config.localPort, verified.route);
                ERRORS.remove(config.localPort);
                Connection connection = new Connection(local, remote, capacity, connections, connectionExecutor);
                connections.add(connection);
                connection.start();
                return;
            } catch (Exception error) {
                ERRORS.put(config.localPort, safeError(error));
            }
            closeQuietly(local);
            closeQuietly(remote);
            capacity.release();
        }

        private RouteSocket tlsSocket(
                PocketLinkConfigStore.Config config,
                PocketLinkIdentityStore.Identity identity,
                PocketLinkRoutePolicy routePolicy
        ) throws Exception {
            Exception lastTransportFailure = null;
            for (String route : routePolicy.attempts(SystemClock.elapsedRealtime())) {
                Socket transport;
                try {
                    transport = PocketLinkRoutePolicy.DIRECT.equals(route)
                            ? directTransport(config.host, config.remotePort)
                            : PocketLinkRoutePolicy.P2P.equals(route)
                                    ? p2pTransport(p2pController, config.p2p, config.remotePort)
                                    : relayTransport(config.relay);
                } catch (Exception error) {
                    routePolicy.recordTransportFailure(route, SystemClock.elapsedRealtime());
                    lastTransportFailure = error;
                    continue;
                }
                try {
                    Socket verified = companionTlsSocket(transport, config, identity);
                    routePolicy.recordVerifiedRoute(route);
                    return new RouteSocket(route, verified);
                } catch (Exception error) {
                    closeQuietly(transport);
                    throw error;
                }
            }
            if (lastTransportFailure != null) throw lastTransportFailure;
            throw new IllegalStateException("PocketLink route policy produced no attempt");
        }

        private static Socket directTransport(String host, int port) throws Exception {
            Socket transport = new Socket();
            try {
                transport.connect(new InetSocketAddress(host, port), PocketRelayProtocol.CONNECT_TIMEOUT_MS);
                return transport;
            } catch (Exception error) {
                closeQuietly(transport);
                throw error;
            }
        }

        private static Socket p2pTransport(
                PocketLinkP2pController controller,
                PocketLinkConfigStore.P2pConfig p2p,
                int port
        ) throws Exception {
            try {
                String groupOwnerHost = controller.connectBlocking(p2p);
                return directTransport(groupOwnerHost, port);
            } catch (Exception error) {
                throw new P2pConnectionException(error);
            }
        }

        private static Socket relayTransport(PocketLinkConfigStore.RelayConfig relay) throws Exception {
            Socket transport = new Socket();
            SSLSocket outer = null;
            try {
                transport.connect(
                        new InetSocketAddress(relay.host, relay.port),
                        PocketRelayProtocol.CONNECT_TIMEOUT_MS
                );
                SSLContext context = SSLContext.getInstance("TLS");
                context.init(
                        null,
                        new TrustManager[] {
                                new RelayPinnedTrustManager(platformTrustManager(), relay.serverPublicKeyPin)
                        },
                        new SecureRandom()
                );
                outer = (SSLSocket) context.getSocketFactory().createSocket(
                        transport,
                        relay.serverName,
                        relay.port,
                        true
                );
                outer.setSoTimeout(PocketRelayProtocol.RESPONSE_TIMEOUT_MS);
                enableModernTls(outer);
                SSLParameters parameters = outer.getSSLParameters();
                parameters.setEndpointIdentificationAlgorithm("HTTPS");
                outer.setSSLParameters(parameters);
                outer.startHandshake();
                PocketRelayProtocol.attach(
                        outer.getInputStream(),
                        outer.getOutputStream(),
                        relay.slot,
                        relay.secret
                );
                outer.setSoTimeout(0);
                return outer;
            } catch (Exception error) {
                closeQuietly(outer);
                if (outer == null) closeQuietly(transport);
                throw new RelayConnectionException(error);
            }
        }

        private static Socket companionTlsSocket(
                Socket transport,
                PocketLinkConfigStore.Config config,
                PocketLinkIdentityStore.Identity identity
        ) throws Exception {
            SSLContext context = SSLContext.getInstance("TLS");
            AtomicReference<String> matchedPinSlot = new AtomicReference<>();
            context.init(
                    identity.keyManagers(),
                    new TrustManager[] { new PinnedTrustManager(config.primaryPin, config.backupPin, matchedPinSlot) },
                    new SecureRandom()
            );
            SSLSocketFactory factory = context.getSocketFactory();
            SSLSocket socket = (SSLSocket) factory.createSocket(transport, config.host, config.remotePort, true);
            socket.setSoTimeout(10_000);
            enableModernTls(socket);
            SSLParameters parameters = socket.getSSLParameters();
            parameters.setEndpointIdentificationAlgorithm("HTTPS");
            socket.setSSLParameters(parameters);
            socket.startHandshake();
            String pinSlot = matchedPinSlot.get();
            if (pinSlot == null) throw new CertificateException("server public key pin was not recorded");
            PIN_OBSERVATIONS.put(
                    config.localPort,
                    new PinObservation(
                            pinSlot,
                            System.currentTimeMillis(),
                            "backup".equals(pinSlot) ? config.backupPin : config.primaryPin
                    )
            );
            socket.setSoTimeout(0);
            return socket;
        }

        private static X509TrustManager platformTrustManager() throws Exception {
            TrustManagerFactory factory = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
            factory.init((KeyStore) null);
            for (TrustManager manager : factory.getTrustManagers()) {
                if (manager instanceof X509TrustManager) return (X509TrustManager) manager;
            }
            throw new IllegalStateException("platform X509 trust manager is unavailable");
        }

        private static void enableModernTls(SSLSocket socket) {
            List<String> enabled = new ArrayList<>();
            for (String protocol : socket.getSupportedProtocols()) {
                if ("TLSv1.2".equals(protocol) || "TLSv1.3".equals(protocol)) enabled.add(protocol);
            }
            if (enabled.isEmpty()) throw new IllegalStateException("TLS 1.2 or newer is unavailable");
            socket.setEnabledProtocols(enabled.toArray(new String[0]));
        }
    }

    private static final class RouteSocket {
        final String route;
        final Socket socket;

        RouteSocket(String route, Socket socket) {
            this.route = route;
            this.socket = socket;
        }
    }

    private static final class Connection {
        private final Socket local;
        private final Socket remote;
        private final Semaphore capacity;
        private final Set<Connection> owner;
        private final ExecutorService executor;
        private final AtomicInteger directions = new AtomicInteger(2);
        private final AtomicBoolean closed = new AtomicBoolean(false);

        Connection(Socket local, Socket remote, Semaphore capacity, Set<Connection> owner, ExecutorService executor) {
            this.local = local;
            this.remote = remote;
            this.capacity = capacity;
            this.owner = owner;
            this.executor = executor;
        }

        void start() throws Exception {
            local.setTcpNoDelay(true);
            remote.setTcpNoDelay(true);
            executor.execute(() -> copy(local, remote));
            executor.execute(() -> copy(remote, local));
        }

        void close() {
            if (!closed.compareAndSet(false, true)) return;
            closeQuietly(local);
            closeQuietly(remote);
            owner.remove(this);
            capacity.release();
        }

        private void copy(Socket source, Socket destination) {
            byte[] buffer = new byte[32 * 1024];
            try {
                InputStream input = source.getInputStream();
                OutputStream output = destination.getOutputStream();
                int count;
                while ((count = input.read(buffer)) >= 0) {
                    if (count == 0) continue;
                    output.write(buffer, 0, count);
                    output.flush();
                }
                try { destination.shutdownOutput(); } catch (IOException ignored) {}
            } catch (IOException ignored) {
                // The browser event stream reconnects after either half closes.
            } finally {
                if (directions.decrementAndGet() == 0) close();
            }
        }
    }

    private static final class PinObservation {
        final String slot;
        final long observedAt;
        final String pin;

        PinObservation(String slot, long observedAt, String pin) {
            this.slot = slot;
            this.observedAt = observedAt;
            this.pin = pin;
        }
    }

    private static final class PinnedTrustManager implements X509TrustManager {
        private final byte[] primaryPin;
        private final byte[] backupPin;
        private final AtomicReference<String> matchedPinSlot;

        PinnedTrustManager(String primaryPin, String backupPin, AtomicReference<String> matchedPinSlot) {
            this.primaryPin = decodePublicKeyPin(primaryPin);
            this.backupPin = backupPin == null || backupPin.isEmpty() ? null : decodePublicKeyPin(backupPin);
            this.matchedPinSlot = matchedPinSlot;
        }

        @Override
        public void checkClientTrusted(X509Certificate[] chain, String authType) throws CertificateException {
            throw new CertificateException("client certificates are not accepted");
        }

        @Override
        public void checkServerTrusted(X509Certificate[] chain, String authType) throws CertificateException {
            if (chain == null || chain.length == 0) throw new CertificateException("missing server certificate");
            chain[0].checkValidity();
            try {
                byte[] actual = MessageDigest.getInstance("SHA-256").digest(chain[0].getPublicKey().getEncoded());
                if (MessageDigest.isEqual(actual, primaryPin)) {
                    matchedPinSlot.set("primary");
                    return;
                }
                if (backupPin != null && MessageDigest.isEqual(actual, backupPin)) {
                    matchedPinSlot.set("backup");
                    return;
                }
            } catch (Exception error) {
                throw new CertificateException("cannot verify server public key", error);
            }
            throw new CertificateException("server public key pin mismatch");
        }

        @Override
        public X509Certificate[] getAcceptedIssuers() {
            return new X509Certificate[0];
        }

    }

    private static final class RelayPinnedTrustManager implements X509TrustManager {
        private final X509TrustManager platform;
        private final byte[] publicKeyPin;

        RelayPinnedTrustManager(X509TrustManager platform, String publicKeyPin) {
            this.platform = platform;
            this.publicKeyPin = decodePublicKeyPin(publicKeyPin);
        }

        @Override
        public void checkClientTrusted(X509Certificate[] chain, String authType) throws CertificateException {
            throw new CertificateException("client certificates are not accepted");
        }

        @Override
        public void checkServerTrusted(X509Certificate[] chain, String authType) throws CertificateException {
            platform.checkServerTrusted(chain, authType);
            if (chain == null || chain.length == 0) throw new CertificateException("missing relay certificate");
            try {
                byte[] actual = MessageDigest.getInstance("SHA-256").digest(chain[0].getPublicKey().getEncoded());
                if (!MessageDigest.isEqual(actual, publicKeyPin)) {
                    throw new CertificateException("relay public key pin mismatch");
                }
            } catch (CertificateException error) {
                throw error;
            } catch (Exception error) {
                throw new CertificateException("cannot verify relay public key", error);
            }
        }

        @Override
        public X509Certificate[] getAcceptedIssuers() {
            return platform.getAcceptedIssuers();
        }
    }

    private static final class RelayConnectionException extends IOException {
        RelayConnectionException(Exception cause) {
            super("Pocket relay connection failed", cause);
        }
    }

    private static final class P2pConnectionException extends IOException {
        P2pConnectionException(Exception cause) {
            super("PocketLink P2P connection failed", cause);
        }
    }

    private static byte[] decodePublicKeyPin(String value) {
        if (value == null || !value.matches("sha256/[A-Za-z0-9+/]{43}=")) {
            throw new IllegalArgumentException("invalid SPKI pin");
        }
        return Base64.decode(value.substring("sha256/".length()), Base64.NO_WRAP);
    }

    private static void closeQuietly(Socket socket) {
        if (socket == null) return;
        try { socket.close(); } catch (IOException ignored) {}
    }
}
