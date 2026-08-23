# Roadmap

## Supported PC platform

The desktop/server companion targets **Linux only**. Native Windows and macOS
packages, installers, platform-specific process management, credential stores,
and support testing are intentionally out of scope. WSL, virtual machines, and
containers may work but are not official support targets.

Keep runtime and transport boundaries small and implementation-neutral when
that does not add meaningful work, but do not build or test alternate operating
system implementations. This preserves a future extension point without
turning cross-platform support into a current deliverable.

## Phase 1 — mobile voice and compact chat UI

- Replace the external Google voice dialog with in-app Android speech recognition.
- Support a short press for one-shot dictation.
- Support a long press for continuous dictation that stays active until the microphone is tapped again.
- Hide the software keyboard-oriented input while continuous dictation is active.
- Let the project and conversation selectors slide closed so the chat transcript gets more space.

## Phase 2 — user-owned onboarding and configuration

Remove environment-specific assumptions from the installation flow and expose them as user-editable settings:

- SSH host or Tailscale address, user, and port
- SSH key selection or generation without copying private key material into the repository
- PC application directory and startup command
- Local and remote tunnel ports
- Allowed workspace roots and default project
- Speech recognition language and voice preferences
- Connection diagnostics and a safe “test connection” flow

Configuration must remain local to the user's device, avoid source-control commits, validate paths and ports, and redact credentials and identifying network details from logs and support exports. Prefer Android-protected storage for app-owned secrets. The setup UI should explain when a setting belongs to the Android app, Termux, or the PC.

## Product invariant — the phone stays a lightweight client

Codex Pocket intentionally runs development workloads on Linux PCs so Android remains responsive:

- Each Linux PC connects to its own Codex, Claude Code, or future CLI account.
- Linux PCs create and modify real local projects, run commands and tests, process media, and retain Git state.
- Android handles the UI, speech recognition, encrypted connection state, offline history, and prompt queues without starting a local Codex or Node.js gateway.
- Work queued while a PC is offline resumes only after that PC reconnects; it must not silently move to another PC or a cloud runner.
- An optional Pocket account pairs devices and syncs encrypted metadata. It does not replace the CLI or become the owner of project files.

Model inference can still require internet access, but project files and execution records remain on the PC that performed the work. The phone keeps only the encrypted client-side journal needed for review and queueing.

## Phase 3 — durable local work journal

Implementation status: v1.6 introduces the versioned `WorkJournal` boundary, IndexedDB persistence with a localStorage fallback, offline conversation restore, and target-bound prompt queue recovery. Native Android SQLite, full event/diff journaling, retention controls, and reconciliation migrations remain in progress.

- Add an app-owned SQLite work journal for conversations, queued prompts, command events, diffs, attachments, and target metadata.
- Make project history and completed results readable while the PC or network connectivity is unavailable.
- Reconcile the local journal with each CLI thread store after reconnection without duplicating turns.
- Clearly distinguish `saved on phone`, `queued for PC`, `running on PC`, and `synced` states.
- Provide export, retention, and delete controls without placing private content in the public repository.

## Phase 4 — first-class remote PC workflow

- Add PC project creation, file browsing, diff review, test output, Git status, and recovery from interrupted background work.
- Let one client release a durable Codex thread and let another paired phone or laptop resume it without interrupting the PC turn.
- Keep every resource-intensive process, including Codex, Node.js, ffmpeg, and Ollama, off Android.
- Measure Android CPU, memory, battery, and background wake time as release gates.
- Make offline and reconnect states explicit without starting a fallback phone runtime.

## Phase 5 — embedded secure device transport

Develop transport as an independently testable module with a stable interface:

- `SshTailscaleTransport`: compatibility adapter for the current deployment.
- `PocketLinkTransport`: app-managed pairing, device identity, encrypted sessions, direct LAN/P2P connection when possible, and an outbound relay fallback.
- Store device private keys in Android Keystore or a Linux-protected credential store.
- Support QR or one-time-code pairing, device revocation, key rotation, reconnect, and explicit target identity.
- Keep gateway and CLI services private; never expose their loopback ports directly to the public network.

The end-state UX must not require users to install, configure, or understand Tailscale, SSH keys, IP addresses, or port forwarding. Tailscale and SSH remain optional compatibility transports.

## Phase 6 — lightweight native Android transport

Replace the remaining Termux transport dependency without embedding a development runtime:

- `SshTailscaleTransport`: maintained compatibility adapter through Termux.
- `PocketLinkTransport`: app-owned pairing, encrypted connection, reconnect, and notification transport.
- Provider adapters and all CLI lifecycle management remain in the Linux Companion.
- The Android service must enforce a small memory/CPU budget and must never download or execute Codex, Node.js, Git, ffmpeg, Ollama, or model weights.

The implementation may reuse appropriately licensed open-source components, but must not copy Termux or Tailscale credentials, identity, or configuration into the application.

## Final definition of done

- A user installs Codex Pocket on Android and Pocket Companion on each supported Linux computer they want to use.
- Pairing is completed once with a QR or one-time code.
- The user can select any paired Linux PC and run that PC's CLI against that PC's real files.
- Code and Git state persist on the selected PC; encrypted conversation history remains reviewable on the phone while offline.
- Termux and Tailscale are not required installations; their adapters remain available for migration and advanced users.
- No Codex, Node.js gateway, media model, or project build runs on Android.
- No provider password, API key, SSH private key, device private key, or personal network value is committed to source control or stored in plaintext UI storage.
