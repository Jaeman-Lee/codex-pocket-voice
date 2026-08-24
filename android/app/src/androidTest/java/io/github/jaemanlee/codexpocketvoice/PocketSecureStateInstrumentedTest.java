package io.github.jaemanlee.codexpocketvoice;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Base64;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.security.PrivateKey;
import java.security.cert.X509Certificate;
import java.util.Arrays;
import java.util.Collections;

import javax.net.ssl.KeyManager;
import javax.net.ssl.X509KeyManager;

@RunWith(AndroidJUnit4.class)
public final class PocketSecureStateInstrumentedTest {
    private static final int CONFIG_PORT = 39_123;
    private static final int COPIED_CONFIG_PORT = 39_124;
    private static final int IDENTITY_PORT = 39_125;
    private static final int BACKGROUND_PORT = 39_126;
    private static final String CONFIG_PREFERENCES = "codex_pocket_link_config";
    private static final String BACKGROUND_PREFERENCES = "codex_pocket_background_events";

    private Context context;
    private PocketLinkConfigStore configStore;
    private PocketLinkIdentityStore identityStore;
    private PocketBackgroundEventStore backgroundStore;

    @Before
    public void setUp() throws Exception {
        context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        configStore = new PocketLinkConfigStore(context);
        identityStore = new PocketLinkIdentityStore();
        backgroundStore = new PocketBackgroundEventStore(context);
        clearTestState();
    }

    @After
    public void tearDown() throws Exception {
        clearTestState();
    }

    @Test
    public void linkConfigRoundTripsWithoutPlaintextPreferences() throws Exception {
        String companionHost = "192.0.2.41";
        String relayHost = "198.51.100.42";
        String relayServerName = "relay.example.test";
        String relaySlot = repeat('s', 22);
        String relaySecret = repeat('k', 43);
        String p2pDeviceAddress = "02:11:22:33:44:55";
        PocketLinkConfigStore.P2pConfig p2p = new PocketLinkConfigStore.P2pConfig(p2pDeviceAddress);
        PocketLinkConfigStore.RelayConfig relay = new PocketLinkConfigStore.RelayConfig(
                relayHost,
                8_443,
                relayServerName,
                pin((byte) 4),
                relaySlot,
                relaySecret
        );
        PocketLinkConfigStore.Config expected = new PocketLinkConfigStore.Config(
                "Synthetic relay",
                CONFIG_PORT,
                companionHost,
                8_444,
                pin((byte) 1),
                pin((byte) 2),
                true,
                PocketLinkIdentityStore.SLOT_A,
                PocketLinkIdentityStore.SLOT_B,
                PocketLinkRoutePolicy.AUTO,
                p2p,
                relay
        );

        configStore.save(expected);

        SharedPreferences preferences = context.getSharedPreferences(CONFIG_PREFERENCES, Context.MODE_PRIVATE);
        String stored = preferences.getString("link-" + CONFIG_PORT, null);
        assertNotNull(stored);
        assertTrue(stored.startsWith("v1."));
        assertFalse(stored.contains(companionHost));
        assertFalse(stored.contains(relayHost));
        assertFalse(stored.contains(relayServerName));
        assertFalse(stored.contains(relaySlot));
        assertFalse(stored.contains(relaySecret));
        assertFalse(stored.contains(p2pDeviceAddress));

        PocketLinkConfigStore.Config actual = configStore.load(CONFIG_PORT);
        assertNotNull(actual);
        assertEquals("Synthetic relay", actual.label);
        assertEquals(CONFIG_PORT, actual.localPort);
        assertEquals(companionHost, actual.host);
        assertEquals(8_444, actual.remotePort);
        assertEquals(PocketLinkIdentityStore.SLOT_A, actual.identitySlot);
        assertEquals(PocketLinkIdentityStore.SLOT_B, actual.pendingIdentitySlot);
        assertEquals("auto", actual.route());
        assertNotNull(actual.p2p);
        assertEquals(p2pDeviceAddress, actual.p2p.deviceAddress);
        assertNotNull(actual.relay);
        assertEquals(relayHost, actual.relay.host);
        assertEquals(relayServerName, actual.relay.serverName);
        assertEquals(relaySlot, actual.relay.slot);
        assertEquals(relaySecret, actual.relay.secret);
        assertEquals(1, configStore.active().size());

        configStore.setActive(CONFIG_PORT, false);
        assertFalse(configStore.load(CONFIG_PORT).active);
        assertTrue(configStore.active().isEmpty());
    }

    @Test
    public void linkConfigCiphertextIsBoundToItsPortEntry() throws Exception {
        PocketLinkConfigStore.Config config = new PocketLinkConfigStore.Config(
                "Synthetic direct",
                CONFIG_PORT,
                "192.0.2.51",
                8_443,
                pin((byte) 5),
                "",
                true
        );
        configStore.save(config);

        SharedPreferences preferences = context.getSharedPreferences(CONFIG_PREFERENCES, Context.MODE_PRIVATE);
        String ciphertext = preferences.getString("link-" + CONFIG_PORT, null);
        assertNotNull(ciphertext);
        assertTrue(preferences.edit().putString("link-" + COPIED_CONFIG_PORT, ciphertext).commit());

        Exception failure = null;
        try {
            configStore.load(COPIED_CONFIG_PORT);
        } catch (Exception error) {
            failure = error;
        }
        assertNotNull("AES-GCM AAD must reject ciphertext copied to another port", failure);
    }

    @Test
    public void identitySlotsUseDistinctNonExportableKeystoreKeys() throws Exception {
        PocketLinkIdentityStore.Identity identityA = identityStore.ensure(
                IDENTITY_PORT,
                PocketLinkIdentityStore.SLOT_A
        );
        PocketLinkIdentityStore.Identity identityB = identityStore.ensure(
                IDENTITY_PORT,
                PocketLinkIdentityStore.SLOT_B
        );

        assertTrue(identityStore.exists(IDENTITY_PORT, PocketLinkIdentityStore.SLOT_A));
        assertTrue(identityStore.exists(IDENTITY_PORT, PocketLinkIdentityStore.SLOT_B));

        X509KeyManager managerA = keyManager(identityA);
        X509KeyManager managerB = keyManager(identityB);
        String aliasA = managerA.chooseClientAlias(new String[] { "EC" }, null, null);
        String aliasB = managerB.chooseClientAlias(new String[] { "EC" }, null, null);
        assertNotNull(aliasA);
        assertNotNull(aliasB);
        assertNotEquals(aliasA, aliasB);

        PrivateKey privateKeyA = managerA.getPrivateKey(aliasA);
        PrivateKey privateKeyB = managerB.getPrivateKey(aliasB);
        assertNotNull(privateKeyA);
        assertNotNull(privateKeyB);
        assertNull("Android Keystore private keys must not be exportable", privateKeyA.getEncoded());
        assertNull("Android Keystore private keys must not be exportable", privateKeyB.getEncoded());

        X509Certificate[] chainA = managerA.getCertificateChain(aliasA);
        X509Certificate[] chainB = managerB.getCertificateChain(aliasB);
        assertNotNull(chainA);
        assertNotNull(chainB);
        assertTrue(chainA.length > 0);
        assertTrue(chainB.length > 0);
        chainA[0].checkValidity();
        chainB[0].checkValidity();
        assertFalse(Arrays.equals(
                chainA[0].getPublicKey().getEncoded(),
                chainB[0].getPublicKey().getEncoded()
        ));

        identityStore.remove(IDENTITY_PORT, PocketLinkIdentityStore.SLOT_A);
        assertFalse(identityStore.exists(IDENTITY_PORT, PocketLinkIdentityStore.SLOT_A));
        assertTrue(identityStore.exists(IDENTITY_PORT, PocketLinkIdentityStore.SLOT_B));
    }

    @Test
    public void backgroundStateIsEncryptedAndCursorUpdatesAreDurable() throws Exception {
        String deviceId = "synthetic-device";
        String token = repeat('t', 43);
        PocketBackgroundEventStore.Subscription target = new PocketBackgroundEventStore.Subscription(
                deviceId,
                BACKGROUND_PORT,
                token,
                99
        );

        PocketBackgroundEventStore.State configured = backgroundStore.configure(Collections.singletonList(target));
        assertTrue(configured.enabled);
        assertEquals(1, configured.subscriptions.size());
        assertEquals(0, configured.subscriptions.get(0).cursor);

        SharedPreferences preferences = context.getSharedPreferences(BACKGROUND_PREFERENCES, Context.MODE_PRIVATE);
        String stored = preferences.getString("state", null);
        assertNotNull(stored);
        assertFalse(stored.contains(deviceId));
        assertFalse(stored.contains(token));

        assertEquals(7, backgroundStore.updateCursor(target, 7, false));
        assertEquals(7, backgroundStore.updateCursor(target, 3, false));
        assertEquals(2, backgroundStore.updateCursor(target, 2, true));
        assertEquals(2, backgroundStore.load().subscriptions.get(0).cursor);

        PocketBackgroundEventStore.State reconfigured = backgroundStore.configure(Collections.singletonList(target));
        assertEquals(2, reconfigured.subscriptions.get(0).cursor);

        String tampered = replaceFirstCiphertextCharacter(preferences.getString("state", null));
        assertTrue(preferences.edit().putString("state", tampered).commit());
        Exception failure = null;
        try {
            backgroundStore.load();
        } catch (Exception error) {
            failure = error;
        }
        assertNotNull("AES-GCM must reject modified background state", failure);

        backgroundStore.clear();
        PocketBackgroundEventStore.State cleared = backgroundStore.load();
        assertFalse(cleared.enabled);
        assertTrue(cleared.subscriptions.isEmpty());
    }

    private void clearTestState() throws Exception {
        SharedPreferences configPreferences = context.getSharedPreferences(
                CONFIG_PREFERENCES,
                Context.MODE_PRIVATE
        );
        SharedPreferences backgroundPreferences = context.getSharedPreferences(
                BACKGROUND_PREFERENCES,
                Context.MODE_PRIVATE
        );
        assertTrue(configPreferences.edit().clear().commit());
        assertTrue(backgroundPreferences.edit().clear().commit());
        identityStore.remove(IDENTITY_PORT);
    }

    private static X509KeyManager keyManager(PocketLinkIdentityStore.Identity identity) {
        KeyManager[] managers = identity.keyManagers();
        assertEquals(1, managers.length);
        assertTrue(managers[0] instanceof X509KeyManager);
        return (X509KeyManager) managers[0];
    }

    private static String pin(byte fill) {
        byte[] digest = new byte[32];
        Arrays.fill(digest, fill);
        return "sha256/" + Base64.encodeToString(digest, Base64.NO_WRAP);
    }

    private static String repeat(char character, int length) {
        char[] value = new char[length];
        Arrays.fill(value, character);
        return new String(value);
    }

    private static String replaceFirstCiphertextCharacter(String value) {
        assertNotNull(value);
        int separator = value.indexOf('.');
        assertTrue(separator >= 0 && separator + 1 < value.length());
        char current = value.charAt(separator + 1);
        char replacement = current == 'A' ? 'B' : 'A';
        return value.substring(0, separator + 1) + replacement + value.substring(separator + 2);
    }
}
