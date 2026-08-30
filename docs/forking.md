# Forking and branding

The official package ID is `io.github.jaemanlee.codexpocketvoice.stable`. Set a
unique package ID for a fork without editing source files:

```sh
export POCKET_APPLICATION_ID=com.example.codexpocket
npm run android:debug
```

Change the app name and icons in Android resources, and sign releases with a key
owned by the fork maintainer. Never reuse the official signing key or package ID.
GitHub Actions produces an unsigned APK when repository signing secrets are not
configured. The APK, SHA-256 checksum, and CycloneDX dependency SBOM are uploaded
together.
