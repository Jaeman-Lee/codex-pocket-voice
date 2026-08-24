package io.github.jaemanlee.codexpocketvoice;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import java.util.Arrays;
import java.util.Collections;

import org.junit.Test;

public class PocketLinkRoutePolicyTest {
    @Test
    public void fixedModesNeverInventAnotherRoute() {
        PocketLinkRoutePolicy direct = new PocketLinkRoutePolicy(PocketLinkRoutePolicy.DIRECT, false, false);
        PocketLinkRoutePolicy p2p = new PocketLinkRoutePolicy(PocketLinkRoutePolicy.P2P, true, false);
        PocketLinkRoutePolicy relay = new PocketLinkRoutePolicy(PocketLinkRoutePolicy.RELAY, false, true);

        assertEquals(Collections.singletonList(PocketLinkRoutePolicy.DIRECT), direct.attempts(0));
        assertEquals(Collections.singletonList(PocketLinkRoutePolicy.P2P), p2p.attempts(0));
        assertEquals(Collections.singletonList(PocketLinkRoutePolicy.RELAY), relay.attempts(0));
        direct.recordTransportFailure(PocketLinkRoutePolicy.DIRECT, 1);
        p2p.recordTransportFailure(PocketLinkRoutePolicy.P2P, 1);
        relay.recordTransportFailure(PocketLinkRoutePolicy.RELAY, 1);
        assertEquals(Collections.singletonList(PocketLinkRoutePolicy.DIRECT), direct.attempts(2));
        assertEquals(Collections.singletonList(PocketLinkRoutePolicy.P2P), p2p.attempts(2));
        assertEquals(Collections.singletonList(PocketLinkRoutePolicy.RELAY), relay.attempts(2));
    }

    @Test
    public void autoPrefersDirectThenBoundsRepeatedUnreachableAttempts() {
        PocketLinkRoutePolicy policy = new PocketLinkRoutePolicy(PocketLinkRoutePolicy.AUTO, true, true);

        assertEquals(
                Arrays.asList(
                        PocketLinkRoutePolicy.DIRECT,
                        PocketLinkRoutePolicy.P2P,
                        PocketLinkRoutePolicy.RELAY
                ),
                policy.attempts(10)
        );
        policy.recordTransportFailure(PocketLinkRoutePolicy.DIRECT, 10);
        assertEquals(
                Arrays.asList(PocketLinkRoutePolicy.P2P, PocketLinkRoutePolicy.RELAY),
                policy.attempts(10 + PocketLinkRoutePolicy.DIRECT_RETRY_COOLDOWN_MS - 1)
        );
        policy.recordTransportFailure(PocketLinkRoutePolicy.P2P, 20);
        assertEquals(
                Collections.singletonList(PocketLinkRoutePolicy.RELAY),
                policy.attempts(100)
        );
        assertEquals(
                Arrays.asList(PocketLinkRoutePolicy.DIRECT, PocketLinkRoutePolicy.RELAY),
                policy.attempts(10 + PocketLinkRoutePolicy.DIRECT_RETRY_COOLDOWN_MS)
        );
        assertEquals(
                Arrays.asList(
                        PocketLinkRoutePolicy.DIRECT,
                        PocketLinkRoutePolicy.P2P,
                        PocketLinkRoutePolicy.RELAY
                ),
                policy.attempts(20 + PocketLinkRoutePolicy.P2P_RETRY_COOLDOWN_MS)
        );
    }

    @Test
    public void verifiedDirectRouteClearsTheCooldown() {
        PocketLinkRoutePolicy policy = new PocketLinkRoutePolicy(PocketLinkRoutePolicy.AUTO, true, true);
        policy.recordTransportFailure(PocketLinkRoutePolicy.DIRECT, 100);
        policy.recordTransportFailure(PocketLinkRoutePolicy.P2P, 100);
        assertEquals(Collections.singletonList(PocketLinkRoutePolicy.RELAY), policy.attempts(101));

        policy.recordVerifiedRoute(PocketLinkRoutePolicy.DIRECT);

        assertEquals(
                Arrays.asList(PocketLinkRoutePolicy.DIRECT, PocketLinkRoutePolicy.RELAY),
                policy.attempts(101)
        );
        policy.recordVerifiedRoute(PocketLinkRoutePolicy.P2P);
        assertEquals(
                Arrays.asList(
                        PocketLinkRoutePolicy.DIRECT,
                        PocketLinkRoutePolicy.P2P,
                        PocketLinkRoutePolicy.RELAY
                ),
                policy.attempts(101)
        );
    }

    @Test
    public void routeModeAndCredentialShapeMustAgree() {
        assertThrows(IllegalArgumentException.class, () -> new PocketLinkRoutePolicy("unknown", false, false));
        assertThrows(IllegalArgumentException.class, () -> new PocketLinkRoutePolicy(
                PocketLinkRoutePolicy.DIRECT,
                true,
                false
        ));
        assertThrows(IllegalArgumentException.class, () -> new PocketLinkRoutePolicy(
                PocketLinkRoutePolicy.P2P,
                false,
                true
        ));
        assertThrows(IllegalArgumentException.class, () -> new PocketLinkRoutePolicy(
                PocketLinkRoutePolicy.RELAY,
                true,
                true
        ));
        assertThrows(IllegalArgumentException.class, () -> new PocketLinkRoutePolicy(
                PocketLinkRoutePolicy.RELAY,
                false,
                false
        ));
        assertThrows(IllegalArgumentException.class, () -> new PocketLinkRoutePolicy(
                PocketLinkRoutePolicy.AUTO,
                true,
                false
        ));
        PocketLinkRoutePolicy p2p = new PocketLinkRoutePolicy(PocketLinkRoutePolicy.P2P, true, false);
        assertThrows(IllegalArgumentException.class, () -> p2p.recordVerifiedRoute(PocketLinkRoutePolicy.DIRECT));
    }
}
