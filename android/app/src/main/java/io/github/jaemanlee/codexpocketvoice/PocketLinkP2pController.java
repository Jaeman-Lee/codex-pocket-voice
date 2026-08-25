package io.github.jaemanlee.codexpocketvoice;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.wifi.WpsInfo;
import android.net.wifi.p2p.WifiP2pConfig;
import android.net.wifi.p2p.WifiP2pDevice;
import android.net.wifi.p2p.WifiP2pDeviceList;
import android.net.wifi.p2p.WifiP2pGroup;
import android.net.wifi.p2p.WifiP2pInfo;
import android.net.wifi.p2p.WifiP2pManager;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;

import androidx.core.content.ContextCompat;

import java.io.IOException;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

final class PocketLinkP2pController {
    interface DiscoveryCallback {
        void onComplete(List<Candidate> candidates);
        void onError(String message);
    }

    static final class Candidate {
        final String id;
        final String name;
        final String deviceAddress;
        final long expiresAt;

        Candidate(String id, String name, String deviceAddress, long expiresAt) {
            this.id = id;
            this.name = name;
            this.deviceAddress = deviceAddress;
            this.expiresAt = expiresAt;
        }
    }

    private static PocketLinkP2pController instance;

    static synchronized PocketLinkP2pController get(Context context) {
        if (instance == null) instance = new PocketLinkP2pController(context.getApplicationContext());
        return instance;
    }

    private final Context context;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final SecureRandom random = new SecureRandom();
    private final WifiP2pManager manager;
    private final WifiP2pManager.Channel channel;
    private final Map<String, Candidate> reviewedCandidates = new LinkedHashMap<>();
    private final BroadcastReceiver receiver;
    private DiscoveryCallback discoveryCallback;
    private final Map<String, Candidate> discoveryCandidates = new LinkedHashMap<>();
    private Runnable discoveryTimeout;
    private CompletableFuture<String> connectionFuture;
    private String connectingDeviceAddress;
    private boolean connectRequested;
    private Runnable connectionTimeout;
    private String connectedDeviceAddress;
    private String connectedGroupOwnerHost;

    private PocketLinkP2pController(Context context) {
        this.context = context;
        manager = (WifiP2pManager) context.getSystemService(Context.WIFI_P2P_SERVICE);
        channel = manager == null ? null : manager.initialize(context, Looper.getMainLooper(), () -> {
            synchronized (PocketLinkP2pController.this) {
                connectedDeviceAddress = null;
                connectedGroupOwnerHost = null;
                failConnectionLocked(new IOException("Wi-Fi Direct channel was lost"), false);
            }
        });
        receiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context ignored, Intent intent) {
                String action = intent.getAction();
                if (WifiP2pManager.WIFI_P2P_STATE_CHANGED_ACTION.equals(action)) {
                    int state = intent.getIntExtra(WifiP2pManager.EXTRA_WIFI_STATE, -1);
                    if (state != WifiP2pManager.WIFI_P2P_STATE_ENABLED) {
                        failUnavailable("Wi-Fi Direct가 꺼져 있거나 지원되지 않습니다.");
                    }
                } else if (WifiP2pManager.WIFI_P2P_PEERS_CHANGED_ACTION.equals(action)) {
                    requestPeers();
                } else if (WifiP2pManager.WIFI_P2P_CONNECTION_CHANGED_ACTION.equals(action)) {
                    inspectConnection();
                }
            }
        };
        if (manager != null && channel != null) {
            IntentFilter filter = new IntentFilter();
            filter.addAction(WifiP2pManager.WIFI_P2P_STATE_CHANGED_ACTION);
            filter.addAction(WifiP2pManager.WIFI_P2P_PEERS_CHANGED_ACTION);
            filter.addAction(WifiP2pManager.WIFI_P2P_CONNECTION_CHANGED_ACTION);
            ContextCompat.registerReceiver(
                    context,
                    receiver,
                    filter,
                    ContextCompat.RECEIVER_NOT_EXPORTED
            );
        }
    }

    synchronized void discover(DiscoveryCallback callback) {
        if (manager == null || channel == null) {
            callback.onError("이 기기는 Wi-Fi Direct를 지원하지 않습니다.");
            return;
        }
        if (discoveryCallback != null) {
            callback.onError("PocketLink P2P 검색이 이미 진행 중입니다.");
            return;
        }
        pruneCandidatesLocked(System.currentTimeMillis());
        discoveryCandidates.clear();
        discoveryCallback = callback;
        mainHandler.post(() -> {
            try {
                manager.discoverPeers(channel, new WifiP2pManager.ActionListener() {
                    @Override
                    public void onSuccess() {
                        requestPeers();
                    }

                    @Override
                    public void onFailure(int reason) {
                        finishDiscoveryError("Wi-Fi Direct 검색을 시작하지 못했습니다. (" + reason + ")");
                    }
                });
                Runnable timeout = this::finishDiscovery;
                synchronized (this) {
                    discoveryTimeout = timeout;
                }
                mainHandler.postDelayed(timeout, PocketLinkP2pPolicy.DISCOVERY_WINDOW_MS);
            } catch (SecurityException error) {
                finishDiscoveryError("근처 Wi-Fi 기기 권한이 없습니다.");
            }
        });
    }

    synchronized void cancelDiscovery() {
        if (discoveryCallback == null) return;
        finishDiscoveryErrorLocked("PocketLink P2P 검색이 취소되었습니다.");
    }

    synchronized PocketLinkConfigStore.P2pConfig reviewedConfig(String candidateId, long now) {
        if (!PocketLinkP2pPolicy.validCandidateId(candidateId)) return null;
        pruneCandidatesLocked(now);
        Candidate candidate = reviewedCandidates.get(candidateId);
        if (candidate == null || now >= candidate.expiresAt) return null;
        return new PocketLinkConfigStore.P2pConfig(candidate.deviceAddress);
    }

    synchronized void disconnect(PocketLinkConfigStore.P2pConfig config) {
        if (config == null || !config.deviceAddress.equals(connectedDeviceAddress)) return;
        connectedDeviceAddress = null;
        connectedGroupOwnerHost = null;
        removeGroupQuietly();
    }

    String connectBlocking(PocketLinkConfigStore.P2pConfig config) throws Exception {
        CompletableFuture<String> future;
        synchronized (this) {
            if (config.deviceAddress.equals(connectedDeviceAddress) && connectedGroupOwnerHost != null) {
                return connectedGroupOwnerHost;
            }
            if (connectionFuture != null) {
                if (!config.deviceAddress.equals(connectingDeviceAddress)) {
                    throw new IOException("another Wi-Fi Direct peer connection is in progress");
                }
                future = connectionFuture;
            } else {
                connectionFuture = new CompletableFuture<>();
                connectingDeviceAddress = config.deviceAddress;
                connectRequested = false;
                future = connectionFuture;
                mainHandler.post(this::beginConnection);
            }
        }
        try {
            return future.get(PocketLinkP2pPolicy.CONNECTION_TIMEOUT_MS + 2_000L, TimeUnit.MILLISECONDS);
        } catch (TimeoutException error) {
            synchronized (this) {
                failConnectionLocked(new IOException("Wi-Fi Direct connection timed out"), connectRequested);
            }
            throw new IOException("Wi-Fi Direct connection timed out", error);
        } catch (ExecutionException error) {
            Throwable cause = error.getCause();
            if (cause instanceof Exception) throw (Exception) cause;
            throw new IOException("Wi-Fi Direct connection failed", cause);
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new IOException("Wi-Fi Direct connection was interrupted", error);
        }
    }

    private void beginConnection() {
        if (manager == null || channel == null) {
            failConnection(new IOException("Wi-Fi Direct is unavailable"), false);
            return;
        }
        try {
            manager.requestGroupInfo(channel, group -> {
                String target;
                synchronized (this) {
                    target = connectingDeviceAddress;
                }
                if (target == null) return;
                if (group != null && group.isGroupOwner()) {
                    failConnection(new IOException("Android cannot be the PocketLink P2P group owner"), false);
                    return;
                }
                WifiP2pDevice owner = group == null ? null : group.getOwner();
                if (owner != null && target.equalsIgnoreCase(owner.deviceAddress)) {
                    inspectConnection();
                    return;
                }
                if (group != null) {
                    failConnection(new IOException("another Wi-Fi Direct group is active"), false);
                    return;
                }
                discoverForConnection();
            });
        } catch (SecurityException error) {
            failConnection(new IOException("nearby Wi-Fi permission is unavailable", error), false);
        }
    }

    private void discoverForConnection() {
        try {
            manager.discoverPeers(channel, new WifiP2pManager.ActionListener() {
                @Override
                public void onSuccess() {
                    requestPeers();
                }

                @Override
                public void onFailure(int reason) {
                    failConnection(new IOException("Wi-Fi Direct discovery failed: " + reason), false);
                }
            });
            Runnable timeout = () -> failConnection(
                    new IOException("Wi-Fi Direct peer was not found"),
                    connectRequested
            );
            synchronized (this) {
                connectionTimeout = timeout;
            }
            mainHandler.postDelayed(timeout, PocketLinkP2pPolicy.CONNECTION_TIMEOUT_MS);
        } catch (SecurityException error) {
            failConnection(new IOException("nearby Wi-Fi permission is unavailable", error), false);
        }
    }

    private void requestPeers() {
        if (manager == null || channel == null) return;
        try {
            manager.requestPeers(channel, this::receivePeers);
        } catch (SecurityException error) {
            failUnavailable("근처 Wi-Fi 기기 권한이 없습니다.");
        }
    }

    private void receivePeers(WifiP2pDeviceList peers) {
        String target;
        boolean shouldConnect;
        synchronized (this) {
            long expiresAt = System.currentTimeMillis() + PocketLinkP2pPolicy.REVIEW_WINDOW_MS;
            if (discoveryCallback != null) {
                for (WifiP2pDevice device : peers.getDeviceList()) {
                    if (discoveryCandidates.size() >= PocketLinkP2pPolicy.MAX_CANDIDATES) break;
                    String name = PocketLinkP2pPolicy.normalizeDeviceName(device.deviceName);
                    if (name == null || !PocketLinkP2pPolicy.validDeviceAddress(device.deviceAddress)) continue;
                    String address = device.deviceAddress.toLowerCase();
                    if (!discoveryCandidates.containsKey(address)) {
                        discoveryCandidates.put(address, new Candidate(candidateId(), name, address, expiresAt));
                    }
                }
            }
            target = connectingDeviceAddress;
            shouldConnect = connectionFuture != null && !connectRequested;
        }
        if (!shouldConnect || target == null) return;
        for (WifiP2pDevice device : peers.getDeviceList()) {
            if (target.equalsIgnoreCase(device.deviceAddress)) {
                connectPeer(target);
                return;
            }
        }
    }

    private void connectPeer(String deviceAddress) {
        synchronized (this) {
            if (connectionFuture == null || connectRequested
                    || !deviceAddress.equals(connectingDeviceAddress)) return;
            connectRequested = true;
        }
        WifiP2pConfig config = new WifiP2pConfig();
        config.deviceAddress = deviceAddress;
        config.wps.setup = WpsInfo.PBC;
        config.groupOwnerIntent = WifiP2pConfig.GROUP_OWNER_INTENT_MIN;
        try {
            manager.stopPeerDiscovery(channel, new EmptyActionListener());
            manager.connect(channel, config, new WifiP2pManager.ActionListener() {
                @Override
                public void onSuccess() {
                    // WIFI_P2P_CONNECTION_CHANGED_ACTION provides the verified group owner.
                }

                @Override
                public void onFailure(int reason) {
                    failConnection(new IOException("Wi-Fi Direct connect failed: " + reason), true);
                }
            });
        } catch (SecurityException error) {
            failConnection(new IOException("nearby Wi-Fi permission is unavailable", error), false);
        }
    }

    private void inspectConnection() {
        if (manager == null || channel == null) return;
        try {
            manager.requestGroupInfo(channel, group -> {
                String target;
                synchronized (this) {
                    target = connectingDeviceAddress;
                    if (target == null && group == null) {
                        connectedDeviceAddress = null;
                        connectedGroupOwnerHost = null;
                        return;
                    }
                }
                if (target == null) return;
                if (group != null && group.isGroupOwner()) {
                    failConnection(new IOException("Android cannot be the PocketLink P2P group owner"), true);
                    return;
                }
                WifiP2pDevice owner = group == null ? null : group.getOwner();
                if (owner == null || !target.equalsIgnoreCase(owner.deviceAddress)) {
                    if (group != null) {
                        boolean removeGroup;
                        synchronized (this) {
                            removeGroup = connectRequested;
                        }
                        failConnection(new IOException("unexpected Wi-Fi Direct group owner"), removeGroup);
                    }
                    return;
                }
                manager.requestConnectionInfo(channel, info -> finishConnection(target, info));
            });
        } catch (SecurityException error) {
            failConnection(new IOException("nearby Wi-Fi permission is unavailable", error), false);
        }
    }

    private void finishConnection(String target, WifiP2pInfo info) {
        if (info == null || !info.groupFormed || info.isGroupOwner || info.groupOwnerAddress == null) {
            if (info != null && info.groupFormed && info.isGroupOwner) {
                failConnection(new IOException("Android cannot be the PocketLink P2P group owner"), true);
            }
            return;
        }
        String host = info.groupOwnerAddress.getHostAddress();
        if (host == null || host.isEmpty()) {
            failConnection(new IOException("Wi-Fi Direct group owner address is unavailable"), true);
            return;
        }
        synchronized (this) {
            if (connectionFuture == null || !target.equals(connectingDeviceAddress)) return;
            connectedDeviceAddress = target;
            connectedGroupOwnerHost = host;
            CompletableFuture<String> future = connectionFuture;
            clearConnectionAttemptLocked();
            future.complete(host);
        }
    }

    private void finishDiscovery() {
        DiscoveryCallback callback;
        List<Candidate> candidates;
        synchronized (this) {
            callback = discoveryCallback;
            if (callback == null) return;
            long now = System.currentTimeMillis();
            candidates = new ArrayList<>();
            for (Candidate candidate : discoveryCandidates.values()) {
                Candidate reviewed = new Candidate(
                        candidate.id,
                        candidate.name,
                        candidate.deviceAddress,
                        now + PocketLinkP2pPolicy.REVIEW_WINDOW_MS
                );
                candidates.add(reviewed);
                reviewedCandidates.put(reviewed.id, reviewed);
            }
            pruneCandidatesLocked(now);
            clearDiscoveryLocked();
        }
        stopDiscoveryQuietly();
        callback.onComplete(candidates);
    }

    private void finishDiscoveryError(String message) {
        synchronized (this) {
            finishDiscoveryErrorLocked(message);
        }
    }

    private void finishDiscoveryErrorLocked(String message) {
        DiscoveryCallback callback = discoveryCallback;
        if (callback == null) return;
        clearDiscoveryLocked();
        stopDiscoveryQuietly();
        callback.onError(message);
    }

    private void failUnavailable(String message) {
        synchronized (this) {
            finishDiscoveryErrorLocked(message);
            failConnectionLocked(new IOException(message), false);
        }
    }

    private void failConnection(Exception error, boolean removeGroup) {
        synchronized (this) {
            failConnectionLocked(error, removeGroup);
        }
    }

    private void failConnectionLocked(Exception error, boolean removeGroup) {
        CompletableFuture<String> future = connectionFuture;
        if (future == null) return;
        clearConnectionAttemptLocked();
        if (removeGroup) removeGroupQuietly();
        future.completeExceptionally(error);
    }

    private void clearDiscoveryLocked() {
        if (discoveryTimeout != null) mainHandler.removeCallbacks(discoveryTimeout);
        discoveryTimeout = null;
        discoveryCallback = null;
        discoveryCandidates.clear();
    }

    private void clearConnectionAttemptLocked() {
        if (connectionTimeout != null) mainHandler.removeCallbacks(connectionTimeout);
        connectionTimeout = null;
        connectionFuture = null;
        connectingDeviceAddress = null;
        connectRequested = false;
    }

    private void pruneCandidatesLocked(long now) {
        reviewedCandidates.values().removeIf(candidate -> now >= candidate.expiresAt);
        while (reviewedCandidates.size() > PocketLinkP2pPolicy.MAX_CANDIDATES) {
            reviewedCandidates.remove(reviewedCandidates.keySet().iterator().next());
        }
    }

    private String candidateId() {
        byte[] value = new byte[18];
        random.nextBytes(value);
        return Base64.encodeToString(value, Base64.NO_WRAP | Base64.NO_PADDING | Base64.URL_SAFE);
    }

    private void stopDiscoveryQuietly() {
        if (manager == null || channel == null) return;
        try {
            manager.stopPeerDiscovery(channel, new EmptyActionListener());
        } catch (SecurityException ignored) {}
    }

    private void removeGroupQuietly() {
        if (manager == null || channel == null) return;
        mainHandler.post(() -> {
            try {
                manager.removeGroup(channel, new EmptyActionListener());
            } catch (SecurityException ignored) {}
        });
    }

    private static final class EmptyActionListener implements WifiP2pManager.ActionListener {
        @Override
        public void onSuccess() {}

        @Override
        public void onFailure(int reason) {}
    }
}
