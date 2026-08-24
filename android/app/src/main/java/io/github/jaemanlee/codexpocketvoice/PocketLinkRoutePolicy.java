package io.github.jaemanlee.codexpocketvoice;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;

final class PocketLinkRoutePolicy {
    static final String DIRECT = "direct";
    static final String RELAY = "relay";
    static final String AUTO = "auto";
    static final long DIRECT_RETRY_COOLDOWN_MS = 30_000L;

    private final String mode;
    private final boolean relayAvailable;
    private long directRetryAt;

    PocketLinkRoutePolicy(String mode, boolean relayAvailable) {
        validateConfiguration(mode, relayAvailable);
        this.mode = mode;
        this.relayAvailable = relayAvailable;
    }

    synchronized List<String> attempts(long elapsedRealtime) {
        requireMonotonicTime(elapsedRealtime);
        if (DIRECT.equals(mode)) return Collections.singletonList(DIRECT);
        if (RELAY.equals(mode)) return Collections.singletonList(RELAY);
        if (elapsedRealtime < directRetryAt) return Collections.singletonList(RELAY);
        return Collections.unmodifiableList(Arrays.asList(DIRECT, RELAY));
    }

    synchronized void recordTransportFailure(String route, long elapsedRealtime) {
        validateAttempt(route);
        requireMonotonicTime(elapsedRealtime);
        if (AUTO.equals(mode) && DIRECT.equals(route)) {
            directRetryAt = boundedAdd(elapsedRealtime, DIRECT_RETRY_COOLDOWN_MS);
        }
    }

    synchronized void recordVerifiedRoute(String route) {
        validateAttempt(route);
        if (DIRECT.equals(route)) directRetryAt = 0;
    }

    static void validateConfiguration(String mode, boolean relayAvailable) {
        if (!DIRECT.equals(mode) && !RELAY.equals(mode) && !AUTO.equals(mode)) {
            throw new IllegalArgumentException("invalid PocketLink route mode");
        }
        if (DIRECT.equals(mode) && relayAvailable) {
            throw new IllegalArgumentException("PocketLink route credentials do not match the mode");
        }
        if (!DIRECT.equals(mode) && !relayAvailable) {
            throw new IllegalArgumentException("PocketLink route credentials do not match the mode");
        }
    }

    private void validateAttempt(String route) {
        if (!DIRECT.equals(route) && !RELAY.equals(route)) {
            throw new IllegalArgumentException("invalid PocketLink route attempt");
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
