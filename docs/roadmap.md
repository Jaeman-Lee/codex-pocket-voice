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
