package io.github.jaemanlee.codexpocketvoice;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;

import java.math.BigInteger;
import java.net.Socket;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.Principal;
import java.security.PrivateKey;
import java.security.SecureRandom;
import java.security.cert.X509Certificate;
import java.security.spec.ECGenParameterSpec;
import java.util.Calendar;

import javax.net.ssl.KeyManager;
import javax.net.ssl.X509KeyManager;
import javax.security.auth.x500.X500Principal;

final class PocketLinkIdentityStore {
    private static final String ANDROID_KEY_STORE = "AndroidKeyStore";
    private static final String ALIAS_PREFIX = "codex-pocket-link-device-v1-";
    static final String SLOT_A = "a";
    static final String SLOT_B = "b";

    synchronized boolean exists(int localPort) throws Exception {
        return exists(localPort, SLOT_A);
    }

    synchronized boolean exists(int localPort, String slot) throws Exception {
        KeyStore keyStore = loadKeyStore();
        return keyStore.containsAlias(alias(localPort, slot));
    }

    synchronized Identity ensure(int localPort) throws Exception {
        return ensure(localPort, SLOT_A);
    }

    synchronized Identity ensure(int localPort, String slot) throws Exception {
        String alias = alias(localPort, slot);
        KeyStore keyStore = loadKeyStore();
        if (!keyStore.containsAlias(alias)) generate(alias);
        keyStore = loadKeyStore();
        PrivateKey privateKey = (PrivateKey) keyStore.getKey(alias, null);
        java.security.cert.Certificate[] storedChain = keyStore.getCertificateChain(alias);
        if (privateKey == null || storedChain == null || storedChain.length == 0) {
            throw new IllegalStateException("PocketLink device identity is incomplete");
        }
        X509Certificate[] chain = new X509Certificate[storedChain.length];
        for (int index = 0; index < storedChain.length; index += 1) {
            if (!(storedChain[index] instanceof X509Certificate)) {
                throw new IllegalStateException("PocketLink device certificate is invalid");
            }
            chain[index] = (X509Certificate) storedChain[index];
        }
        chain[0].checkValidity();
        return new Identity(alias, privateKey, chain);
    }

    synchronized void remove(int localPort) throws Exception {
        remove(localPort, SLOT_A);
        remove(localPort, SLOT_B);
    }

    synchronized void remove(int localPort, String slot) throws Exception {
        KeyStore keyStore = loadKeyStore();
        String alias = alias(localPort, slot);
        if (keyStore.containsAlias(alias)) keyStore.deleteEntry(alias);
    }

    static String nextSlot(String slot) {
        if (SLOT_A.equals(slot)) return SLOT_B;
        if (SLOT_B.equals(slot)) return SLOT_A;
        throw new IllegalArgumentException("invalid identity slot");
    }

    private static void generate(String alias) throws Exception {
        Calendar notBefore = Calendar.getInstance();
        notBefore.add(Calendar.DAY_OF_YEAR, -1);
        Calendar notAfter = Calendar.getInstance();
        notAfter.add(Calendar.YEAR, 10);
        BigInteger serial = new BigInteger(128, new SecureRandom()).abs().add(BigInteger.ONE);
        KeyPairGenerator generator = KeyPairGenerator.getInstance(
                KeyProperties.KEY_ALGORITHM_EC,
                ANDROID_KEY_STORE
        );
        generator.initialize(new KeyGenParameterSpec.Builder(
                alias,
                KeyProperties.PURPOSE_SIGN | KeyProperties.PURPOSE_VERIFY)
                .setAlgorithmParameterSpec(new ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .setCertificateSubject(new X500Principal("CN=Codex Pocket Voice PocketLink"))
                .setCertificateSerialNumber(serial)
                .setCertificateNotBefore(notBefore.getTime())
                .setCertificateNotAfter(notAfter.getTime())
                .setUserAuthenticationRequired(false)
                .build());
        generator.generateKeyPair();
    }

    private static KeyStore loadKeyStore() throws Exception {
        KeyStore keyStore = KeyStore.getInstance(ANDROID_KEY_STORE);
        keyStore.load(null);
        return keyStore;
    }

    private static String alias(int localPort, String slot) {
        if (localPort < 1024 || localPort > 65535) throw new IllegalArgumentException("invalid local port");
        if (SLOT_A.equals(slot)) return ALIAS_PREFIX + localPort;
        if (SLOT_B.equals(slot)) return ALIAS_PREFIX + localPort + "-b";
        throw new IllegalArgumentException("invalid identity slot");
    }

    static final class Identity {
        private final String alias;
        private final PrivateKey privateKey;
        private final X509Certificate[] chain;

        Identity(String alias, PrivateKey privateKey, X509Certificate[] chain) {
            this.alias = alias;
            this.privateKey = privateKey;
            this.chain = chain.clone();
        }

        KeyManager[] keyManagers() {
            return new KeyManager[] { new BoundKeyManager(alias, privateKey, chain) };
        }
    }

    private static final class BoundKeyManager implements X509KeyManager {
        private final String alias;
        private final PrivateKey privateKey;
        private final X509Certificate[] chain;

        BoundKeyManager(String alias, PrivateKey privateKey, X509Certificate[] chain) {
            this.alias = alias;
            this.privateKey = privateKey;
            this.chain = chain.clone();
        }

        @Override
        public String[] getClientAliases(String keyType, Principal[] issuers) {
            return supports(keyType) ? new String[] { alias } : null;
        }

        @Override
        public String chooseClientAlias(String[] keyTypes, Principal[] issuers, Socket socket) {
            if (keyTypes == null) return alias;
            for (String keyType : keyTypes) if (supports(keyType)) return alias;
            return null;
        }

        @Override
        public String[] getServerAliases(String keyType, Principal[] issuers) {
            return null;
        }

        @Override
        public String chooseServerAlias(String keyType, Principal[] issuers, Socket socket) {
            return null;
        }

        @Override
        public X509Certificate[] getCertificateChain(String requestedAlias) {
            return alias.equals(requestedAlias) ? chain.clone() : null;
        }

        @Override
        public PrivateKey getPrivateKey(String requestedAlias) {
            return alias.equals(requestedAlias) ? privateKey : null;
        }

        private static boolean supports(String keyType) {
            return keyType != null && (keyType.equalsIgnoreCase("EC") || keyType.startsWith("EC_"));
        }
    }
}
