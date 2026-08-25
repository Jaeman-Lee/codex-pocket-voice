import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.security.Key;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.Signature;
import java.util.Arrays;
import java.util.Base64;

public final class ReleaseManifestSigner {
    private ReleaseManifestSigner() {}

    public static void main(String[] args) throws Exception {
        if (args.length != 4 || !"sign".equals(args[0])) {
            throw new IllegalArgumentException("Usage: ReleaseManifestSigner sign <keystore> <manifest> <signature-output>");
        }
        String alias = requiredEnvironment("ANDROID_KEY_ALIAS");
        char[] storePassword = requiredEnvironment("ANDROID_KEYSTORE_PASSWORD").toCharArray();
        String keyPasswordValue = System.getenv("ANDROID_KEY_PASSWORD");
        char[] keyPassword = (keyPasswordValue == null || keyPasswordValue.isEmpty())
            ? storePassword.clone()
            : keyPasswordValue.toCharArray();
        try {
            KeyStore keyStore = KeyStore.getInstance(new File(args[1]), storePassword);
            Key key = keyStore.getKey(alias, keyPassword);
            if (!(key instanceof PrivateKey privateKey)) throw new IllegalArgumentException("Signing alias is not a private key");
            String algorithm = switch (privateKey.getAlgorithm()) {
                case "RSA" -> "SHA256withRSA";
                case "EC" -> "SHA256withECDSA";
                default -> throw new IllegalArgumentException("Unsupported release signing key algorithm");
            };
            byte[] manifest = Files.readAllBytes(Path.of(args[2]));
            if (manifest.length == 0 || manifest.length > 65_536) {
                throw new IllegalArgumentException("Update manifest size is invalid");
            }
            Signature signer = Signature.getInstance(algorithm);
            signer.initSign(privateKey);
            signer.update(manifest);
            String encoded = Base64.getEncoder().encodeToString(signer.sign()) + "\n";
            Files.writeString(
                Path.of(args[3]),
                encoded,
                StandardCharsets.US_ASCII,
                StandardOpenOption.CREATE_NEW,
                StandardOpenOption.WRITE
            );
        } finally {
            Arrays.fill(storePassword, '\0');
            Arrays.fill(keyPassword, '\0');
        }
    }

    private static String requiredEnvironment(String name) {
        String value = System.getenv(name);
        if (value == null || value.isEmpty()) throw new IllegalArgumentException(name + " is required");
        return value;
    }
}
