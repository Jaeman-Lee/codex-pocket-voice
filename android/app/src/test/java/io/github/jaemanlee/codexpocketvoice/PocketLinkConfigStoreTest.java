package io.github.jaemanlee.codexpocketvoice;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;

public class PocketLinkConfigStoreTest {
    private static final String PIN = "sha256/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    private static final String SLOT = "abcdefghijklmnopqrstuv";
    private static final String SECRET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ";

    @Test
    public void schemaOneDirectConfigMigratesWithoutInventingRelayCredentials() throws Exception {
        JSONObject legacy = new JSONObject();
        legacy.put("version", 1);
        legacy.put("label", "Linux PC");
        legacy.put("localPort", 8790);
        legacy.put("host", "companion.example.test");
        legacy.put("remotePort", 8789);
        legacy.put("primaryPin", PIN);
        legacy.put("backupPin", "");
        legacy.put("active", true);
        legacy.put("identitySlot", PocketLinkIdentityStore.SLOT_A);
        legacy.put("pendingIdentitySlot", "");

        PocketLinkConfigStore.Config config = PocketLinkConfigStore.Config.fromJson(legacy);

        assertEquals("direct", config.route());
        assertNull(config.relay);
        assertEquals(4, config.toJson().getInt("version"));
        assertEquals("direct", config.toJson().getString("route"));
        assertEquals(false, config.toJson().has("relay"));
    }

    @Test
    public void schemaTwoRelayMigratesWithTwoTlsIdentitiesSeparate() throws Exception {
        PocketLinkConfigStore.RelayConfig relay = new PocketLinkConfigStore.RelayConfig(
                "192.0.2.8",
                9443,
                "relay.example.test",
                PIN,
                SLOT,
                SECRET
        );
        JSONObject legacy = baseConfig(2);
        legacy.put("relay", relay.toJson());

        PocketLinkConfigStore.Config restored = PocketLinkConfigStore.Config.fromJson(legacy);

        assertEquals("relay", restored.route());
        assertEquals("companion.example.test", restored.host);
        assertEquals("192.0.2.8", restored.relay.host);
        assertEquals("relay.example.test", restored.relay.serverName);
        assertEquals(SLOT, restored.relay.slot);
        assertEquals(SECRET, restored.relay.secret);
        assertEquals(4, restored.toJson().getInt("version"));
        assertEquals("relay", restored.toJson().getString("route"));
    }

    @Test
    public void schemaThreeAutoMigratesWithEncryptedRelayFallback() throws Exception {
        PocketLinkConfigStore.RelayConfig relay = new PocketLinkConfigStore.RelayConfig(
                "192.0.2.8",
                9443,
                "relay.example.test",
                PIN,
                SLOT,
                SECRET
        );
        JSONObject legacy = baseConfig(3);
        legacy.put("route", PocketLinkRoutePolicy.AUTO);
        legacy.put("relay", relay.toJson());

        PocketLinkConfigStore.Config restored = PocketLinkConfigStore.Config.fromJson(legacy);

        assertEquals("auto", restored.route());
        assertEquals("companion.example.test", restored.host);
        assertEquals("192.0.2.8", restored.relay.host);
        assertEquals(SECRET, restored.relay.secret);
        assertTrue(restored.toJson().has("relay"));
    }

    @Test
    public void schemaFourP2pAndAutoKeepPeerAddressNativeOnly() throws Exception {
        PocketLinkConfigStore.P2pConfig p2p = new PocketLinkConfigStore.P2pConfig("02:11:22:33:44:55");
        PocketLinkConfigStore.RelayConfig relay = new PocketLinkConfigStore.RelayConfig(
                "192.0.2.8", 9443, "relay.example.test", PIN, SLOT, SECRET
        );
        PocketLinkConfigStore.Config fixed = new PocketLinkConfigStore.Config(
                "Linux PC", 8790, "companion.example.test", 8789, PIN, "", false,
                PocketLinkIdentityStore.SLOT_A, "", PocketLinkRoutePolicy.P2P, p2p, null
        );
        PocketLinkConfigStore.Config automatic = new PocketLinkConfigStore.Config(
                "Linux PC", 8790, "companion.example.test", 8789, PIN, "", false,
                PocketLinkIdentityStore.SLOT_A, "", PocketLinkRoutePolicy.AUTO, p2p, relay
        );

        PocketLinkConfigStore.Config fixedRestored = PocketLinkConfigStore.Config.fromJson(fixed.toJson());
        PocketLinkConfigStore.Config autoRestored = PocketLinkConfigStore.Config.fromJson(automatic.toJson());

        assertEquals("p2p", fixedRestored.route());
        assertEquals("02:11:22:33:44:55", fixedRestored.p2p.deviceAddress);
        assertNull(fixedRestored.relay);
        assertEquals("auto", autoRestored.route());
        assertEquals("02:11:22:33:44:55", autoRestored.p2p.deviceAddress);
        assertEquals(SECRET, autoRestored.relay.secret);
    }

    @Test
    public void routeModeRejectsMissingOrUnexpectedRelayCredentials() throws Exception {
        PocketLinkConfigStore.RelayConfig relay = new PocketLinkConfigStore.RelayConfig(
                "192.0.2.8", 9443, "relay.example.test", PIN, SLOT, SECRET
        );
        assertThrows(IllegalArgumentException.class, () -> new PocketLinkConfigStore.Config(
                "Linux PC", 8790, "companion.example.test", 8789, PIN, "", false,
                PocketLinkIdentityStore.SLOT_A, "", PocketLinkRoutePolicy.DIRECT, null, relay
        ));
        assertThrows(IllegalArgumentException.class, () -> new PocketLinkConfigStore.Config(
                "Linux PC", 8790, "companion.example.test", 8789, PIN, "", false,
                PocketLinkIdentityStore.SLOT_A, "", PocketLinkRoutePolicy.AUTO, null, null
        ));
        assertThrows(IllegalArgumentException.class, () -> new PocketLinkConfigStore.Config(
                "Linux PC", 8790, "companion.example.test", 8789, PIN, "", false,
                PocketLinkIdentityStore.SLOT_A, "", PocketLinkRoutePolicy.P2P, null, relay
        ));

        JSONObject malformed = baseConfig(3);
        malformed.put("route", "auto");
        assertThrows(IllegalArgumentException.class, () -> PocketLinkConfigStore.Config.fromJson(malformed));
    }

    @Test
    public void relayConfigRejectsWildcardWeakAndMalformedValues() {
        assertThrows(IllegalArgumentException.class, () -> new PocketLinkConfigStore.RelayConfig(
                "0.0.0.0", 9443, "relay.example.test", PIN, SLOT, SECRET
        ));
        assertThrows(IllegalArgumentException.class, () -> new PocketLinkConfigStore.RelayConfig(
                "relay.example.test", 9443, "bad..host", PIN, SLOT, SECRET
        ));
        assertThrows(IllegalArgumentException.class, () -> new PocketLinkConfigStore.RelayConfig(
                "relay.example.test", 9443, "relay.example.test", PIN, "short", SECRET
        ));
        assertThrows(IllegalArgumentException.class, () -> new PocketLinkConfigStore.RelayConfig(
                "relay.example.test", 9443, "relay.example.test", PIN, SLOT, "short"
        ));
    }

    private static JSONObject baseConfig(int version) throws Exception {
        JSONObject value = new JSONObject();
        value.put("version", version);
        value.put("label", "Linux PC");
        value.put("localPort", 8790);
        value.put("host", "companion.example.test");
        value.put("remotePort", 8789);
        value.put("primaryPin", PIN);
        value.put("backupPin", "");
        value.put("active", false);
        value.put("identitySlot", PocketLinkIdentityStore.SLOT_A);
        value.put("pendingIdentitySlot", "");
        return value;
    }
}
