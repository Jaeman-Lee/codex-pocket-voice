package io.github.jaemanlee.codexpocketvoice;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

final class PocketBackgroundEventStore {
    private static final String KEY_ALIAS = "codex-pocket-background-events-v1";
    private static final String PREFERENCES = "codex_pocket_background_events";
    private static final String STATE_KEY = "state";
    private static final String TRANSFORMATION = "AES/GCM/NoPadding";
    private static final byte[] AAD = "codex-pocket-background-events:v1".getBytes(StandardCharsets.UTF_8);
    private static final Object STATE_LOCK = new Object();
    private final Context context;

    static final class Subscription {
        final String deviceId;
        final int localPort;
        final String token;
        final long cursor;

        Subscription(String deviceId, int localPort, String token, long cursor) {
            if (!PocketBackgroundEventPolicy.validIdentifier(
                    deviceId,
                    PocketBackgroundEventPolicy.MAX_DEVICE_ID
            )) throw new IllegalArgumentException("deviceId 값이 올바르지 않습니다.");
            if (!PocketBackgroundEventPolicy.validPort(localPort)) {
                throw new IllegalArgumentException("localPort 값이 올바르지 않습니다.");
            }
            if (!PocketBackgroundEventPolicy.validToken(token)) {
                throw new IllegalArgumentException("token 값이 올바르지 않습니다.");
            }
            if (cursor < 0 || cursor > PocketBackgroundEventPolicy.MAX_CURSOR) {
                throw new IllegalArgumentException("cursor 값이 올바르지 않습니다.");
            }
            this.deviceId = deviceId;
            this.localPort = localPort;
            this.token = token;
            this.cursor = cursor;
        }

        Subscription withCursor(long value) {
            return new Subscription(deviceId, localPort, token, value);
        }

        boolean sameTarget(Subscription other) {
            return deviceId.equals(other.deviceId) && localPort == other.localPort
                    && MessageDigest.isEqual(
                            token.getBytes(StandardCharsets.UTF_8),
                            other.token.getBytes(StandardCharsets.UTF_8)
                    );
        }
    }

    static final class State {
        final boolean enabled;
        final List<Subscription> subscriptions;

        State(boolean enabled, List<Subscription> subscriptions) {
            this.enabled = enabled;
            this.subscriptions = Collections.unmodifiableList(new ArrayList<>(subscriptions));
        }
    }

    PocketBackgroundEventStore(Context context) {
        this.context = context.getApplicationContext();
    }

    State load() throws Exception {
        synchronized (STATE_LOCK) {
            return loadLocked();
        }
    }

    private State loadLocked() throws Exception {
        String encoded = preferences().getString(STATE_KEY, null);
        if (encoded == null) return new State(false, Collections.emptyList());
        return decode(decrypt(encoded));
    }

    State configure(List<Subscription> requested) throws Exception {
        synchronized (STATE_LOCK) {
            validateUnique(requested);
            State previous = loadLocked();
            List<Subscription> next = new ArrayList<>();
            for (Subscription subscription : requested) {
                Subscription existing = null;
                for (Subscription candidate : previous.subscriptions) {
                    if (subscription.sameTarget(candidate)) {
                        existing = candidate;
                        break;
                    }
                }
                next.add(existing == null ? subscription.withCursor(0) : subscription.withCursor(existing.cursor));
            }
            State state = new State(true, next);
            write(state);
            return state;
        }
    }

    void clear() throws Exception {
        synchronized (STATE_LOCK) {
            if (!preferences().edit().remove(STATE_KEY).commit()) {
                throw new IllegalStateException("백그라운드 알림 설정을 지우지 못했습니다.");
            }
        }
    }

    long updateCursor(Subscription target, long cursor, boolean reset) throws Exception {
        synchronized (STATE_LOCK) {
            if (cursor < 0 || cursor > PocketBackgroundEventPolicy.MAX_CURSOR) {
                throw new IllegalArgumentException("cursor 값이 올바르지 않습니다.");
            }
            State state = loadLocked();
            if (!state.enabled) return target.cursor;
            List<Subscription> next = new ArrayList<>();
            long applied = target.cursor;
            boolean matched = false;
            for (Subscription subscription : state.subscriptions) {
                if (!subscription.sameTarget(target)) {
                    next.add(subscription);
                    continue;
                }
                matched = true;
                applied = reset ? cursor : Math.max(subscription.cursor, cursor);
                next.add(subscription.withCursor(applied));
            }
            if (!matched) return target.cursor;
            write(new State(true, next));
            return applied;
        }
    }

    private void write(State state) throws Exception {
        String encrypted = encrypt(encode(state));
        if (!preferences().edit().putString(STATE_KEY, encrypted).commit()) {
            throw new IllegalStateException("백그라운드 알림 설정을 저장하지 못했습니다.");
        }
    }

    private static String encode(State state) throws Exception {
        JSONObject root = new JSONObject();
        root.put("version", 1);
        root.put("enabled", state.enabled);
        JSONArray subscriptions = new JSONArray();
        for (Subscription subscription : state.subscriptions) {
            JSONObject item = new JSONObject();
            item.put("deviceId", subscription.deviceId);
            item.put("localPort", subscription.localPort);
            item.put("token", subscription.token);
            item.put("cursor", subscription.cursor);
            subscriptions.put(item);
        }
        root.put("subscriptions", subscriptions);
        return root.toString();
    }

    private static State decode(String serialized) throws Exception {
        JSONObject root = new JSONObject(serialized);
        if (root.length() != 3 || root.optInt("version", -1) != 1
                || !root.has("enabled") || !root.has("subscriptions")) {
            throw new IllegalArgumentException("백그라운드 알림 설정이 올바르지 않습니다.");
        }
        boolean enabled = root.getBoolean("enabled");
        JSONArray values = root.getJSONArray("subscriptions");
        if (values.length() > PocketBackgroundEventPolicy.MAX_SUBSCRIPTIONS) {
            throw new IllegalArgumentException("백그라운드 알림 등록 한도를 초과했습니다.");
        }
        List<Subscription> subscriptions = new ArrayList<>();
        for (int index = 0; index < values.length(); index += 1) {
            JSONObject item = values.getJSONObject(index);
            if (item.length() != 4) throw new IllegalArgumentException("백그라운드 알림 등록이 올바르지 않습니다.");
            subscriptions.add(new Subscription(
                    item.getString("deviceId"),
                    item.getInt("localPort"),
                    item.getString("token"),
                    item.getLong("cursor")
            ));
        }
        validateUnique(subscriptions);
        return new State(enabled, subscriptions);
    }

    private static void validateUnique(List<Subscription> subscriptions) {
        if (subscriptions.size() > PocketBackgroundEventPolicy.MAX_SUBSCRIPTIONS) {
            throw new IllegalArgumentException("백그라운드 알림 등록 한도를 초과했습니다.");
        }
        Set<String> deviceIds = new HashSet<>();
        Set<Integer> ports = new HashSet<>();
        for (Subscription subscription : subscriptions) {
            if (!deviceIds.add(subscription.deviceId) || !ports.add(subscription.localPort)) {
                throw new IllegalArgumentException("백그라운드 알림 등록이 중복되었습니다.");
            }
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

    private String encrypt(String value) throws Exception {
        Cipher cipher = Cipher.getInstance(TRANSFORMATION);
        cipher.init(Cipher.ENCRYPT_MODE, secretKey());
        cipher.updateAAD(AAD);
        byte[] ciphertext = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
        return Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP)
                + "." + Base64.encodeToString(ciphertext, Base64.NO_WRAP);
    }

    private String decrypt(String encoded) throws Exception {
        String[] parts = encoded.split("\\.", 2);
        if (parts.length != 2) throw new IllegalArgumentException("invalid encrypted background state");
        byte[] iv = Base64.decode(parts[0], Base64.NO_WRAP);
        byte[] ciphertext = Base64.decode(parts[1], Base64.NO_WRAP);
        if (iv.length != 12 || ciphertext.length < 16 || ciphertext.length > 16 * 1024) {
            throw new IllegalArgumentException("invalid encrypted background state");
        }
        Cipher cipher = Cipher.getInstance(TRANSFORMATION);
        cipher.init(Cipher.DECRYPT_MODE, secretKey(), new GCMParameterSpec(128, iv));
        cipher.updateAAD(AAD);
        return new String(cipher.doFinal(ciphertext), StandardCharsets.UTF_8);
    }
}
