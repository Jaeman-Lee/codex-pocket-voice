package io.github.jaemanlee.codexpocketvoice;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.ArrayList;
import java.util.List;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

final class PocketLinkConfigStore {
    private static final String KEY_ALIAS = "codex-pocket-link-config-v1";
    private static final String PREFERENCES = "codex_pocket_link_config";
    private static final String TRANSFORMATION = "AES/GCM/NoPadding";
    private static final String PREFIX = "link-";
    private final Context context;

    PocketLinkConfigStore(Context context) {
        this.context = context.getApplicationContext();
    }

    synchronized void save(Config config) throws Exception {
        write(config.localPort, config);
    }

    synchronized Config load(int localPort) throws Exception {
        String entry = entry(localPort);
        String encoded = preferences().getString(entry, null);
        return encoded == null ? null : Config.fromJson(new JSONObject(decrypt(entry, encoded)));
    }

    synchronized List<Config> active() throws Exception {
        List<Config> configs = new ArrayList<>();
        for (String key : preferences().getAll().keySet()) {
            if (!key.startsWith(PREFIX)) continue;
            String encoded = preferences().getString(key, null);
            if (encoded == null) continue;
            Config config = Config.fromJson(new JSONObject(decrypt(key, encoded)));
            if (config.active) configs.add(config);
        }
        return configs;
    }

    synchronized void setActive(int localPort, boolean active) throws Exception {
        Config config = load(localPort);
        if (config == null) throw new IllegalArgumentException("PocketLink 설정이 없습니다.");
        write(localPort, config.withActive(active));
    }

    synchronized void remove(int localPort) {
        if (!preferences().edit().remove(entry(localPort)).commit()) {
            throw new IllegalStateException("PocketLink 설정을 삭제하지 못했습니다.");
        }
    }

    private void write(int localPort, Config config) throws Exception {
        String entry = entry(localPort);
        if (!preferences().edit().putString(entry, encrypt(entry, config.toJson().toString())).commit()) {
            throw new IllegalStateException("PocketLink 설정을 저장하지 못했습니다.");
        }
    }

    private SharedPreferences preferences() {
        return context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
    }

    private SecretKey secretKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
        keyStore.load(null);
        if (keyStore.containsAlias(KEY_ALIAS)) {
            return ((KeyStore.SecretKeyEntry) keyStore.getEntry(KEY_ALIAS, null)).getSecretKey();
        }
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .build());
        return generator.generateKey();
    }

    private String encrypt(String entry, String value) throws Exception {
        Cipher cipher = Cipher.getInstance(TRANSFORMATION);
        cipher.init(Cipher.ENCRYPT_MODE, secretKey());
        cipher.updateAAD(entry.getBytes(StandardCharsets.UTF_8));
        byte[] ciphertext = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
        return "v1." + Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP)
                + "." + Base64.encodeToString(ciphertext, Base64.NO_WRAP);
    }

    private String decrypt(String entry, String encoded) throws Exception {
        String[] parts = encoded.split("\\.", 3);
        if (parts.length != 3 || !"v1".equals(parts[0])) throw new IllegalArgumentException("invalid encrypted config");
        byte[] iv = Base64.decode(parts[1], Base64.NO_WRAP);
        byte[] ciphertext = Base64.decode(parts[2], Base64.NO_WRAP);
        if (iv.length != 12 || ciphertext.length < 16) throw new IllegalArgumentException("invalid encrypted config");
        Cipher cipher = Cipher.getInstance(TRANSFORMATION);
        cipher.init(Cipher.DECRYPT_MODE, secretKey(), new GCMParameterSpec(128, iv));
        cipher.updateAAD(entry.getBytes(StandardCharsets.UTF_8));
        return new String(cipher.doFinal(ciphertext), StandardCharsets.UTF_8);
    }

    private static String entry(int localPort) {
        if (localPort < 1024 || localPort > 65535) throw new IllegalArgumentException("invalid local port");
        return PREFIX + localPort;
    }

    static final class Config {
        final String label;
        final int localPort;
        final String host;
        final int remotePort;
        final String primaryPin;
        final String backupPin;
        final boolean active;
        final String identitySlot;
        final String pendingIdentitySlot;
        final String route;
        final P2pConfig p2p;
        final RelayConfig relay;

        Config(String label, int localPort, String host, int remotePort, String primaryPin, String backupPin, boolean active) {
            this(
                    label, localPort, host, remotePort, primaryPin, backupPin, active,
                    PocketLinkIdentityStore.SLOT_A, "", PocketLinkRoutePolicy.DIRECT, null, null
            );
        }

        Config(
                String label,
                int localPort,
                String host,
                int remotePort,
                String primaryPin,
                String backupPin,
                boolean active,
                String identitySlot,
                String pendingIdentitySlot
        ) {
            this(
                    label, localPort, host, remotePort, primaryPin, backupPin, active,
                    identitySlot, pendingIdentitySlot, PocketLinkRoutePolicy.DIRECT, null, null
            );
        }

        Config(
                String label,
                int localPort,
                String host,
                int remotePort,
                String primaryPin,
                String backupPin,
                boolean active,
                String identitySlot,
                String pendingIdentitySlot,
                RelayConfig relay
        ) {
            this(
                    label, localPort, host, remotePort, primaryPin, backupPin, active,
                    identitySlot, pendingIdentitySlot,
                    relay == null ? PocketLinkRoutePolicy.DIRECT : PocketLinkRoutePolicy.RELAY,
                    null,
                    relay
            );
        }

        Config(
                String label,
                int localPort,
                String host,
                int remotePort,
                String primaryPin,
                String backupPin,
                boolean active,
                String identitySlot,
                String pendingIdentitySlot,
                String route,
                RelayConfig relay
        ) {
            this(
                    label, localPort, host, remotePort, primaryPin, backupPin, active,
                    identitySlot, pendingIdentitySlot, route, null, relay
            );
        }

        Config(
                String label,
                int localPort,
                String host,
                int remotePort,
                String primaryPin,
                String backupPin,
                boolean active,
                String identitySlot,
                String pendingIdentitySlot,
                String route,
                P2pConfig p2p,
                RelayConfig relay
        ) {
            if (!PocketLinkIdentityStore.SLOT_A.equals(identitySlot)
                    && !PocketLinkIdentityStore.SLOT_B.equals(identitySlot)) {
                throw new IllegalArgumentException("invalid identity slot");
            }
            if (pendingIdentitySlot == null) pendingIdentitySlot = "";
            if (!pendingIdentitySlot.isEmpty()
                    && ((!PocketLinkIdentityStore.SLOT_A.equals(pendingIdentitySlot)
                    && !PocketLinkIdentityStore.SLOT_B.equals(pendingIdentitySlot))
                    || pendingIdentitySlot.equals(identitySlot))) {
                throw new IllegalArgumentException("invalid pending identity slot");
            }
            PocketLinkRoutePolicy.validateConfiguration(route, p2p != null, relay != null);
            this.label = label;
            this.localPort = localPort;
            this.host = host;
            this.remotePort = remotePort;
            this.primaryPin = primaryPin;
            this.backupPin = backupPin;
            this.active = active;
            this.identitySlot = identitySlot;
            this.pendingIdentitySlot = pendingIdentitySlot;
            this.route = route;
            this.p2p = p2p;
            this.relay = relay;
        }

        Config withActive(boolean nextActive) {
            return new Config(
                    label, localPort, host, remotePort, primaryPin, backupPin, nextActive,
                    identitySlot, pendingIdentitySlot, route, p2p, relay
            );
        }

        Config withServerPins(String nextPrimaryPin, String nextBackupPin) {
            return new Config(
                    label, localPort, host, remotePort, nextPrimaryPin, nextBackupPin, active,
                    identitySlot, pendingIdentitySlot, route, p2p, relay
            );
        }

        Config withPendingIdentitySlot(String nextPendingIdentitySlot) {
            return new Config(
                    label, localPort, host, remotePort, primaryPin, backupPin, active,
                    identitySlot, nextPendingIdentitySlot, route, p2p, relay
            );
        }

        Config commitPendingIdentitySlot() {
            if (pendingIdentitySlot.isEmpty()) throw new IllegalStateException("identity rotation is not pending");
            return new Config(
                    label, localPort, host, remotePort, primaryPin, backupPin, active,
                    pendingIdentitySlot, "", route, p2p, relay
            );
        }

        String effectiveIdentitySlot() {
            return pendingIdentitySlot.isEmpty() ? identitySlot : pendingIdentitySlot;
        }

        String route() {
            return route;
        }

        JSONObject toJson() throws Exception {
            JSONObject value = new JSONObject();
            value.put("version", 4);
            value.put("label", label);
            value.put("localPort", localPort);
            value.put("host", host);
            value.put("remotePort", remotePort);
            value.put("primaryPin", primaryPin);
            value.put("backupPin", backupPin);
            value.put("active", active);
            value.put("identitySlot", identitySlot);
            value.put("pendingIdentitySlot", pendingIdentitySlot);
            value.put("route", route);
            if (p2p != null) value.put("p2p", p2p.toJson());
            if (relay != null) value.put("relay", relay.toJson());
            return value;
        }

        static Config fromJson(JSONObject value) throws Exception {
            int version = value.getInt("version");
            if (version != 1 && version != 2 && version != 3 && version != 4) {
                throw new IllegalArgumentException("unsupported config version");
            }
            P2pConfig p2p = version == 4 && value.has("p2p")
                    ? P2pConfig.fromJson(value.getJSONObject("p2p"))
                    : null;
            RelayConfig relay = version >= 2 && value.has("relay")
                    ? RelayConfig.fromJson(value.getJSONObject("relay"))
                    : null;
            String route = version >= 3
                    ? value.getString("route")
                    : relay == null ? PocketLinkRoutePolicy.DIRECT : PocketLinkRoutePolicy.RELAY;
            return new Config(
                    value.getString("label"),
                    value.getInt("localPort"),
                    value.getString("host"),
                    value.getInt("remotePort"),
                    value.getString("primaryPin"),
                    value.optString("backupPin", ""),
                    value.optBoolean("active", false),
                    value.optString("identitySlot", PocketLinkIdentityStore.SLOT_A),
                    value.optString("pendingIdentitySlot", ""),
                    route,
                    p2p,
                    relay
            );
        }
    }

    static final class P2pConfig {
        final String deviceAddress;

        P2pConfig(String deviceAddress) {
            if (!PocketLinkP2pPolicy.validDeviceAddress(deviceAddress)) {
                throw new IllegalArgumentException("invalid PocketLink P2P device address");
            }
            this.deviceAddress = deviceAddress.toLowerCase();
        }

        JSONObject toJson() throws Exception {
            JSONObject value = new JSONObject();
            value.put("version", 1);
            value.put("deviceAddress", deviceAddress);
            return value;
        }

        static P2pConfig fromJson(JSONObject value) throws Exception {
            if (value.length() != 2 || value.getInt("version") != 1) {
                throw new IllegalArgumentException("unsupported PocketLink P2P config version");
            }
            return new P2pConfig(value.getString("deviceAddress"));
        }
    }

    static final class RelayConfig {
        final String host;
        final int port;
        final String serverName;
        final String serverPublicKeyPin;
        final String slot;
        final String secret;

        RelayConfig(
                String host,
                int port,
                String serverName,
                String serverPublicKeyPin,
                String slot,
                String secret
        ) {
            if (!PocketRelayProtocol.isConnectionHost(host)
                    || !PocketRelayProtocol.isConnectionHost(serverName)
                    || port < 1_024 || port > 65_535
                    || serverPublicKeyPin == null
                    || !serverPublicKeyPin.matches("sha256/[A-Za-z0-9+/]{43}=")) {
                throw new IllegalArgumentException("invalid relay TLS configuration");
            }
            PocketRelayProtocol.validateSlot(slot);
            PocketRelayProtocol.validateSecret(secret);
            this.host = host;
            this.port = port;
            this.serverName = serverName;
            this.serverPublicKeyPin = serverPublicKeyPin;
            this.slot = slot;
            this.secret = secret;
        }

        JSONObject toJson() throws Exception {
            JSONObject value = new JSONObject();
            value.put("version", 1);
            value.put("host", host);
            value.put("port", port);
            value.put("serverName", serverName);
            value.put("serverPublicKeyPin", serverPublicKeyPin);
            value.put("slot", slot);
            value.put("secret", secret);
            return value;
        }

        static RelayConfig fromJson(JSONObject value) throws Exception {
            if (value.getInt("version") != 1) throw new IllegalArgumentException("unsupported relay config version");
            return new RelayConfig(
                    value.getString("host"),
                    value.getInt("port"),
                    value.getString("serverName"),
                    value.getString("serverPublicKeyPin"),
                    value.getString("slot"),
                    value.getString("secret")
            );
        }
    }
}
