# Security policy

## Supported releases

Security fixes are applied to the latest release and the current `main` branch.
Older APKs may use an incompatible gateway protocol and should be upgraded.

## Reporting a vulnerability

Do not open a public issue for a vulnerability that exposes credentials, project
content, or device access. Use GitHub's private vulnerability reporting for this
repository. Include the affected version, reproduction steps, and whether the
issue requires another local app, a paired client, or network access.

Never include real SSH keys, Codex or Claude credentials, pairing tokens, private
addresses, or project content in a report. Replace them with redacted examples.

## Security boundaries

- Gateways bind only to loopback and require a paired bearer token.
- Pairing codes expire and failed attempts are rate limited.
- Android stores tokens and journal keys with Android Keystore encryption.
- Linux stores only token hashes in a mode `0600` state file.
- Project paths remain limited to configured workspace roots.
- The app never grants elevated Codex approval requests.

Loopback, SSH, and Tailscale are transport layers, not substitutes for gateway
authentication. Never expose gateway ports directly to a public network.
