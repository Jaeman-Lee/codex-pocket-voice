# Roadmap

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

## Product invariant — both devices are real coding targets

Codex Pocket must never become only a remote chat screen. The PC and the smartphone are equal, first-class execution targets:

- Each device connects to its own Codex, Claude Code, or future CLI account.
- Each device can create and modify real local projects, run commands and tests, and retain Git state.
- Prompts, responses, command events, diffs, attachments, and queue state are stored locally for offline review.
- Work queued while a target is offline resumes only after that target reconnects; it must not silently move to another device or a cloud runner.
- An optional Pocket account pairs devices and syncs encrypted metadata. It does not replace the CLI or become the owner of project files.

Model inference can still require internet access, but project files and completed work records must remain available on the device that performed the work.

## Phase 3 — durable local work journal

Implementation status: v1.6 introduces the versioned `WorkJournal` boundary, IndexedDB persistence with a localStorage fallback, offline conversation restore, and target-bound prompt queue recovery. Native Android SQLite, full event/diff journaling, retention controls, and reconciliation migrations remain in progress.

- Add an app-owned SQLite work journal for conversations, queued prompts, command events, diffs, attachments, and target metadata.
- Make project history and completed results readable while PC, phone CLI, or network connectivity is unavailable.
- Reconcile the local journal with each CLI thread store after reconnection without duplicating turns.
- Clearly distinguish `saved locally`, `queued`, `running on phone`, `running on PC`, and `synced` states.
- Provide export, retention, and delete controls without placing private content in the public repository.

## Phase 4 — first-class smartphone development runtime

- Keep the phone CLI runner independent from the PC runner.
- Add phone project creation, file browsing, diff review, test output, Git status, and recovery from interrupted background work.
- Treat the current Termux integration as the first `RuntimeAdapter`, not as permanent application architecture.
- Automate compatible Termux setup and health recovery while the embedded runtime is being developed.

## Phase 5 — embedded secure device transport

Develop transport as an independently testable module with a stable interface:

- `SshTailscaleTransport`: compatibility adapter for the current deployment.
- `PocketLinkTransport`: app-managed pairing, device identity, encrypted sessions, direct LAN/P2P connection when possible, and an outbound relay fallback.
- Store device private keys in Android Keystore or the desktop OS credential store.
- Support QR or one-time-code pairing, device revocation, key rotation, reconnect, and explicit target identity.
- Keep gateway and CLI services private; never expose their loopback ports directly to the public network.

The end-state UX must not require users to install, configure, or understand Tailscale, SSH keys, IP addresses, or port forwarding. Tailscale and SSH remain optional compatibility transports.

## Phase 6 — embedded Android CLI runtime

Develop the functions currently supplied by Termux as a separate runtime module rather than coupling them to the React UI:

- `TermuxRuntime`: maintained compatibility adapter.
- `PocketRuntimeAndroid`: app-owned foreground execution service, process supervisor, PTY, workspace filesystem, Git, shell toolchain, CLI lifecycle, logs, and safe update channel.
- Provider adapters remain separate from the runtime so Codex, Claude Code, and future CLIs can be installed, authenticated, updated, tested, and removed independently.
- Runtime permissions, workspace roots, command policy, and credentials must have native security boundaries and auditable tests.

The implementation may reuse appropriately licensed open-source components, but must not copy Termux or Tailscale credentials, identity, or configuration into the application.

## Final definition of done

- A user installs Codex Pocket on Android and Pocket Companion on each computer they want to use.
- Pairing is completed once with a QR or one-time code.
- The user can select `this smartphone` or any paired PC and run that device's CLI against that device's real files.
- Code, Git state, and work history persist locally and remain reviewable offline.
- Termux and Tailscale are not required installations; their adapters remain available for migration and advanced users.
- No provider password, API key, SSH private key, device private key, or personal network value is committed to source control or stored in plaintext UI storage.
