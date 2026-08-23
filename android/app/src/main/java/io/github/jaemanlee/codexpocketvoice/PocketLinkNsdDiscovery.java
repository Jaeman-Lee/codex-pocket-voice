package io.github.jaemanlee.codexpocketvoice;

import android.content.Context;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import java.net.InetAddress;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

final class PocketLinkNsdDiscovery {
    static final long DISCOVERY_WINDOW_MS = 8_000L;

    interface Callback {
        void onComplete(List<PocketLinkDiscoveryPolicy.Candidate> candidates);
        void onError();
    }

    private final NsdManager nsdManager;
    private final WifiManager wifiManager;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ArrayDeque<NsdServiceInfo> pending = new ArrayDeque<>();
    private final Set<String> seenServices = new HashSet<>();
    private final Set<String> seenCandidates = new HashSet<>();
    private final List<PocketLinkDiscoveryPolicy.Candidate> candidates = new ArrayList<>();
    private final Callback callback;
    private final Runnable timeout = this::complete;
    private WifiManager.MulticastLock multicastLock;
    private boolean discoveryRequested;
    private boolean resolving;
    private boolean finished;

    PocketLinkNsdDiscovery(Context context, Callback callback) {
        Context applicationContext = context.getApplicationContext();
        this.nsdManager = (NsdManager) applicationContext.getSystemService(Context.NSD_SERVICE);
        this.wifiManager = (WifiManager) applicationContext.getSystemService(Context.WIFI_SERVICE);
        this.callback = callback;
    }

    void start() {
        if (nsdManager == null || wifiManager == null) {
            fail();
            return;
        }
        try {
            multicastLock = wifiManager.createMulticastLock("codex-pocket-link-discovery");
            multicastLock.setReferenceCounted(false);
            multicastLock.acquire();
            handler.postDelayed(timeout, DISCOVERY_WINDOW_MS);
            discoveryRequested = true;
            nsdManager.discoverServices(
                    PocketLinkDiscoveryPolicy.SERVICE_TYPE,
                    NsdManager.PROTOCOL_DNS_SD,
                    discoveryListener
            );
        } catch (Exception error) {
            fail();
        }
    }

    void cancel() {
        finish(false, false);
    }

    private final NsdManager.DiscoveryListener discoveryListener = new NsdManager.DiscoveryListener() {
        @Override
        public void onDiscoveryStarted(String serviceType) {
            // The request is already tracked so timeout/cancel can always stop it.
        }

        @Override
        public void onServiceFound(NsdServiceInfo serviceInfo) {
            if (finished || candidates.size() >= PocketLinkDiscoveryPolicy.MAX_CANDIDATES
                    || pending.size() >= PocketLinkDiscoveryPolicy.MAX_PENDING_SERVICES
                    || seenServices.size() >= PocketLinkDiscoveryPolicy.MAX_SEEN_SERVICES
                    || !PocketLinkDiscoveryPolicy.SERVICE_TYPE.equals(
                            PocketLinkDiscoveryPolicy.canonicalServiceType(serviceInfo.getServiceType()))) return;
            String key = serviceInfo.getServiceName() + "\u0000" + serviceInfo.getServiceType();
            if (!seenServices.add(key)) return;
            pending.add(serviceInfo);
            resolveNext();
        }

        @Override
        public void onServiceLost(NsdServiceInfo serviceInfo) {
            // The final candidate is a short-lived review hint, never a trusted or persistent binding.
        }

        @Override
        public void onDiscoveryStopped(String serviceType) {
            discoveryRequested = false;
        }

        @Override
        public void onStartDiscoveryFailed(String serviceType, int errorCode) {
            fail();
        }

        @Override
        public void onStopDiscoveryFailed(String serviceType, int errorCode) {
            discoveryRequested = false;
        }
    };

    private void resolveNext() {
        if (finished || resolving || candidates.size() >= PocketLinkDiscoveryPolicy.MAX_CANDIDATES) return;
        NsdServiceInfo service = pending.poll();
        if (service == null) return;
        resolving = true;
        try {
            nsdManager.resolveService(service, new NsdManager.ResolveListener() {
                @Override
                public void onResolveFailed(NsdServiceInfo serviceInfo, int errorCode) {
                    resolving = false;
                    resolveNext();
                }

                @Override
                public void onServiceResolved(NsdServiceInfo serviceInfo) {
                    resolving = false;
                    if (!finished) {
                        try {
                            PocketLinkDiscoveryPolicy.Candidate candidate = PocketLinkDiscoveryPolicy.candidate(
                                    serviceInfo.getServiceName(),
                                    serviceInfo.getServiceType(),
                                    serviceInfo.getPort(),
                                    serviceInfo.getAttributes(),
                                    resolvedAddresses(serviceInfo)
                            );
                            if (seenCandidates.add(candidate.key())) candidates.add(candidate);
                        } catch (Exception ignored) {
                            // An untrusted or malformed LAN advertisement is omitted rather than exposed to WebView.
                        }
                    }
                    resolveNext();
                }
            });
        } catch (Exception error) {
            resolving = false;
            resolveNext();
        }
    }

    private static List<InetAddress> resolvedAddresses(NsdServiceInfo serviceInfo) {
        List<InetAddress> addresses = new ArrayList<>();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            addresses.addAll(serviceInfo.getHostAddresses());
        } else if (serviceInfo.getHost() != null) {
            addresses.add(serviceInfo.getHost());
        }
        return addresses;
    }

    private void complete() {
        candidates.sort(Comparator
                .comparing((PocketLinkDiscoveryPolicy.Candidate candidate) -> candidate.name)
                .thenComparing(candidate -> candidate.host)
                .thenComparingInt(candidate -> candidate.port));
        finish(true, false);
    }

    private void fail() {
        finish(false, true);
    }

    private void finish(boolean notifyComplete, boolean notifyError) {
        if (finished) return;
        finished = true;
        handler.removeCallbacks(timeout);
        if (discoveryRequested) {
            try { nsdManager.stopServiceDiscovery(discoveryListener); } catch (Exception ignored) {}
            discoveryRequested = false;
        }
        if (multicastLock != null && multicastLock.isHeld()) {
            try { multicastLock.release(); } catch (Exception ignored) {}
        }
        pending.clear();
        if (notifyError) callback.onError();
        else if (notifyComplete) callback.onComplete(new ArrayList<>(candidates));
    }
}
