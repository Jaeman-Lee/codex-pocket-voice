package io.github.jaemanlee.codexpocketvoice;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import java.util.Arrays;
import java.util.Collections;

import org.junit.Test;

public class PocketLinkRoutePolicyTest {
    @Test
    public void fixedModesNeverInventAnotherRoute() {
        PocketLinkRoutePolicy direct = new PocketLinkRoutePolicy(PocketLinkRoutePolicy.DIRECT, false);
        PocketLinkRoutePolicy relay = new PocketLinkRoutePolicy(PocketLinkRoutePolicy.RELAY, true);

        assertEquals(Collections.singletonList(PocketLinkRoutePolicy.DIRECT), direct.attempts(0));
        assertEquals(Collections.singletonList(PocketLinkRoutePolicy.RELAY), relay.attempts(0));
        direct.recordTransportFailure(PocketLinkRoutePolicy.DIRECT, 1);
        relay.recordTransportFailure(PocketLinkRoutePolicy.RELAY, 1);
        assertEquals(Collections.singletonList(PocketLinkRoutePolicy.DIRECT), direct.attempts(2));
        assertEquals(Collections.singletonList(PocketLinkRoutePolicy.RELAY), relay.attempts(2));
    }

    @Test
    public void autoPrefersDirectThenBoundsRepeatedUnreachableAttempts() {
        PocketLinkRoutePolicy policy = new PocketLinkRoutePolicy(PocketLinkRoutePolicy.AUTO, true);

        assertEquals(
                Arrays.asList(PocketLinkRoutePolicy.DIRECT, PocketLinkRoutePolicy.RELAY),
                policy.attempts(10)
        );
        policy.recordTransportFailure(PocketLinkRoutePolicy.DIRECT, 10);
        assertEquals(
                Collections.singletonList(PocketLinkRoutePolicy.RELAY),
                policy.attempts(10 + PocketLinkRoutePolicy.DIRECT_RETRY_COOLDOWN_MS - 1)
        );
        assertEquals(
                Arrays.asList(PocketLinkRoutePolicy.DIRECT, PocketLinkRoutePolicy.RELAY),
                policy.attempts(10 + PocketLinkRoutePolicy.DIRECT_RETRY_COOLDOWN_MS)
        );
    }

    @Test
    public void verifiedDirectRouteClearsTheCooldown() {
        PocketLinkRoutePolicy policy = new PocketLinkRoutePolicy(PocketLinkRoutePolicy.AUTO, true);
        policy.recordTransportFailure(PocketLinkRoutePolicy.DIRECT, 100);
        assertEquals(Collections.singletonList(PocketLinkRoutePolicy.RELAY), policy.attempts(101));

        policy.recordVerifiedRoute(PocketLinkRoutePolicy.DIRECT);

        assertEquals(
                Arrays.asList(PocketLinkRoutePolicy.DIRECT, PocketLinkRoutePolicy.RELAY),
                policy.attempts(101)
        );
    }

    @Test
    public void routeModeAndCredentialShapeMustAgree() {
        assertThrows(IllegalArgumentException.class, () -> new PocketLinkRoutePolicy("unknown", false));
        assertThrows(IllegalArgumentException.class, () -> new PocketLinkRoutePolicy(
                PocketLinkRoutePolicy.DIRECT,
                true
        ));
        assertThrows(IllegalArgumentException.class, () -> new PocketLinkRoutePolicy(
                PocketLinkRoutePolicy.RELAY,
                false
        ));
        assertThrows(IllegalArgumentException.class, () -> new PocketLinkRoutePolicy(
                PocketLinkRoutePolicy.AUTO,
                false
        ));
    }
}
