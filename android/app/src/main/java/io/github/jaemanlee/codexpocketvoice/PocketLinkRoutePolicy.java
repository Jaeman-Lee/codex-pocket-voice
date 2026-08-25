package io.github.jaemanlee.codexpocketvoice;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

final class PocketLinkRoutePolicy {
    static final String DIRECT = "direct";
    static final String P2P = "p2p";
    static final String RELAY = "relay";
    static final String AUTO = "auto";
    static final long DIRECT_RETRY_COOLDOWN_MS = 30_000L;
    static final long P2P_RETRY_COOLDOWN_MS = 60_000L;

    private final String mode;
    private final boolean p2pAvailable;
    private final boolean relayAvailable;
    private long directRetryAt;
    private long p2pRetryAt;

    PocketLinkRoutePolicy(String mode, boolean p2pAvailable, boolean relayAvailable) {
        validateConfiguration(mode, p2pAvailable, relayAvailable);
        this.mode = mode;
        this.p2pAvailable = p2pAvailable;
        this.relayAvailable = relayAvailable;
    }

    synchronized List<String> attempts(long elapsedRealtime) {
        requireMonotonicTime(elapsedRealtime);
        if (DIRECT.equals(mode)) return Collections.singletonList(DIRECT);
        if (P2P.equals(mode)) return Collections.singletonList(P2P);
        if (RELAY.equals(mode)) return Collections.singletonList(RELAY);
        List<String> routes = new ArrayList<>(3);
        if (elapsedRealtime >= directRetryAt) routes.add(DIRECT);
        if (p2pAvailable && elapsedRealtime >= p2pRetryAt) routes.add(P2P);
        routes.add(RELAY);
        return Collections.unmodifiableList(routes);
    }

    synchronized void recordTransportFailure(String route, long elapsedRealtime) {
        validateAttempt(route);
        requireMonotonicTime(elapsedRealtime);
        if (AUTO.equals(mode) && DIRECT.equals(route)) {
            directRetryAt = boundedAdd(elapsedRealtime, DIRECT_RETRY_COOLDOWN_MS);
        }
        if (AUTO.equals(mode) && P2P.equals(route)) {
            p2pRetryAt = boundedAdd(elapsedRealtime, P2P_RETRY_COOLDOWN_MS);
        }
    }

    synchronized void recordVerifiedRoute(String route) {
        validateAttempt(route);
        if (DIRECT.equals(route)) directRetryAt = 0;
        if (P2P.equals(route)) p2pRetryAt = 0;
    }

    static void validateConfiguration(String mode, boolean p2pAvailable, boolean relayAvailable) {
        if (!DIRECT.equals(mode) && !P2P.equals(mode) && !RELAY.equals(mode) && !AUTO.equals(mode)) {
            throw new IllegalArgumentException("invalid PocketLink route mode");
        }
        if (DIRECT.equals(mode) && (p2pAvailable || relayAvailable)) {
            throw new IllegalArgumentException("PocketLink route credentials do not match the mode");
        }
        if (P2P.equals(mode) && (!p2pAvailable || relayAvailable)) {
            throw new IllegalArgumentException("PocketLink route credentials do not match the mode");
        }
        if (RELAY.equals(mode) && (p2pAvailable || !relayAvailable)) {
            throw new IllegalArgumentException("PocketLink route credentials do not match the mode");
        }
        if (AUTO.equals(mode) && !relayAvailable) {
            throw new IllegalArgumentException("PocketLink route credentials do not match the mode");
        }
    }

    private void validateAttempt(String route) {
        if (!DIRECT.equals(route) && !P2P.equals(route) && !RELAY.equals(route)) {
            throw new IllegalArgumentException("invalid PocketLink route attempt");
        }
        if (DIRECT.equals(route) && !DIRECT.equals(mode) && !AUTO.equals(mode)) {
            throw new IllegalArgumentException("PocketLink direct route is unavailable");
        }
        if (P2P.equals(route) && !p2pAvailable) {
            throw new IllegalArgumentException("PocketLink P2P is unavailable");
        }
        if (RELAY.equals(route) && !relayAvailable) {
            throw new IllegalArgumentException("PocketLink relay is unavailable");
        }
    }

    private static void requireMonotonicTime(long elapsedRealtime) {
        if (elapsedRealtime < 0) throw new IllegalArgumentException("invalid monotonic time");
    }

    private static long boundedAdd(long value, long increment) {
        return value > Long.MAX_VALUE - increment ? Long.MAX_VALUE : value + increment;
    }
}
