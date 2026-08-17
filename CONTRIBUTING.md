# Contributing

Codex Pocket Voice supports an Android client and Linux Companion. Native
Windows and macOS support is intentionally out of scope.

Before opening a pull request:

```sh
npm ci
npm run check
npm test
```

Keep provider, runtime, and transport adapters separate. Do not commit account
credentials, pairing tokens, private device or network values, signing keys,
generated secrets, personal project paths, or captured conversation content.

Forks can set `POCKET_APPLICATION_ID` when building Android to avoid colliding
with the official package. A fork without signing secrets receives an unsigned
APK artifact from GitHub Actions and must provide its own signing identity.
