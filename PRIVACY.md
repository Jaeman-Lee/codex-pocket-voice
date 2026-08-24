# Privacy

Codex Pocket Voice does not operate an application account service and does not
collect analytics. Project files and AI execution stay on the selected Linux PC;
the Android app stores only client state needed to display and queue that work.

The app stores the following locally:

- paired device identifiers and encrypted gateway tokens;
- opt-in Android background-notification loopback ports and replay cursors,
  encrypted with a separate Android Keystore key;
- selected projects, models, language preferences, and device labels;
- encrypted conversation summaries and queued prompts;
- encrypted run operations and replayable common events on the selected Linux
  Companion for the configured retention period;
- uploaded media and generated frames on the target device for the configured
  retention period;
- CLI-owned session and authentication data managed by Codex or Claude Code on
  the selected Linux PC.

The background-notification endpoint sends only a notification schema version,
generic kind, operation identifier, event time, and approval expiry when needed.
It does not send prompts, workspace paths, provider responses, diffs, commands,
or tool details to the native notification service.

Model inference follows the selected CLI provider's account and privacy terms.
Optional local Ollama video analysis runs on the target Linux PC, while the
resulting summary and selected frames may be included in a later Codex request.

Android application backup is disabled. Uninstalling the app removes app-owned
Android data; CLI files, projects, uploaded media, Termux tunnel configuration,
and Linux Companion state must be removed separately by their owner.
