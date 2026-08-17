# Codex app-server schema

The checked-in TypeScript bindings under `generated/app-server` are generated,
not hand edited. They were verified against `codex-cli 0.147.3` on 2026-08-17:

```sh
codex app-server generate-ts --experimental --out generated/app-server
./scripts/check-app-server-schema.sh
```

The gateway declares `experimentalApi` during initialization because generated
experimental request and response fields require that capability. A Codex CLI
upgrade must pass unit tests, the real no-model integration tests, and the schema
check before the compatibility baseline in this document is updated.
