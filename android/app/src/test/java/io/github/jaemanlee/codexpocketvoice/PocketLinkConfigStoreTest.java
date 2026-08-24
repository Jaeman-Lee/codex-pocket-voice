package io.github.jaemanlee.codexpocketvoice;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;

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
        assertEquals(2, config.toJson().getInt("version"));
        assertEquals(false, config.toJson().has("relay"));
    }

    @Test
    public void schemaTwoRelayRoundTripKeepsTwoTlsIdentitiesSeparate() throws Exception {
        PocketLinkConfigStore.RelayConfig relay = new PocketLinkConfigStore.RelayConfig(
                "192.0.2.8",
                9443,
                "relay.example.test",
                PIN,
                SLOT,
                SECRET
        );
        PocketLinkConfigStore.Config original = new PocketLinkConfigStore.Config(
                "Linux PC",
                8790,
                "companion.example.test",
                8789,
                PIN,
                "",
                false,
                PocketLinkIdentityStore.SLOT_A,
                "",
                relay
        );

        PocketLinkConfigStore.Config restored = PocketLinkConfigStore.Config.fromJson(original.toJson());

        assertEquals("relay", restored.route());
        assertEquals("companion.example.test", restored.host);
        assertEquals("192.0.2.8", restored.relay.host);
        assertEquals("relay.example.test", restored.relay.serverName);
        assertEquals(SLOT, restored.relay.slot);
        assertEquals(SECRET, restored.relay.secret);
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
}
