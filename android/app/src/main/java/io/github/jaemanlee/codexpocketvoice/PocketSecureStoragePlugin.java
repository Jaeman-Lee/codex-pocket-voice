package io.github.jaemanlee.codexpocketvoice;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

@CapacitorPlugin(name = "PocketSecureStorage")
public class PocketSecureStoragePlugin extends Plugin {
    private static final String KEY_ALIAS = "codex-pocket-secure-storage-v1";
    private static final String PREFERENCES = "codex_pocket_secure_storage";
    private static final String TRANSFORMATION = "AES/GCM/NoPadding";

    @PluginMethod
    public void get(PluginCall call) {
        String key = validatedKey(call);
        if (key == null) return;
        try {
            String encoded = preferences().getString(key, null);
            JSObject result = new JSObject();
            result.put("value", encoded == null ? null : decrypt(encoded));
            call.resolve(result);
        } catch (Exception error) {
            call.reject("보안 저장소를 읽을 수 없습니다.", error);
        }
    }

    @PluginMethod
    public void set(PluginCall call) {
        String key = validatedKey(call);
        if (key == null) return;
        String value = call.getString("value");
        if (value == null) {
            call.reject("value가 필요합니다.");
            return;
        }
        try {
            preferences().edit().putString(key, encrypt(value)).apply();
            call.resolve();
        } catch (Exception error) {
            call.reject("보안 저장소에 기록할 수 없습니다.", error);
        }
    }

    @PluginMethod
    public void remove(PluginCall call) {
        String key = validatedKey(call);
        if (key == null) return;
        preferences().edit().remove(key).apply();
        call.resolve();
    }

    private String validatedKey(PluginCall call) {
        String key = call.getString("key");
        if (key == null || !key.matches("[A-Za-z0-9._:-]{1,120}")) {
            call.reject("유효한 key가 필요합니다.");
            return null;
        }
        return key;
    }

    private SharedPreferences preferences() {
        return getContext().getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
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
        byte[] ciphertext = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
        return Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP)
                + "." + Base64.encodeToString(ciphertext, Base64.NO_WRAP);
    }

    private String decrypt(String encoded) throws Exception {
        String[] parts = encoded.split("\\.", 2);
        if (parts.length != 2) throw new IllegalArgumentException("invalid encrypted value");
        byte[] iv = Base64.decode(parts[0], Base64.NO_WRAP);
        byte[] ciphertext = Base64.decode(parts[1], Base64.NO_WRAP);
        Cipher cipher = Cipher.getInstance(TRANSFORMATION);
        cipher.init(Cipher.DECRYPT_MODE, secretKey(), new GCMParameterSpec(128, iv));
        return new String(cipher.doFinal(ciphertext), StandardCharsets.UTF_8);
    }
}
