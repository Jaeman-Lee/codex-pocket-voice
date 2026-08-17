# Privacy

Codex Pocket Voice does not operate an application account service and does not
collect analytics. Project files stay on the selected Android or Linux device.

The app stores the following locally:

- paired device identifiers and encrypted gateway tokens;
- selected projects, models, language preferences, and device labels;
- encrypted conversation summaries and queued prompts;
- uploaded media and generated frames on the target device for the configured
  retention period;
- CLI-owned session and authentication data managed by Codex or Claude Code.

Model inference follows the selected CLI provider's account and privacy terms.
Optional local Ollama video analysis stays on the target Linux PC, while the
resulting summary and selected frames may be included in a later Codex request.

Android application backup is disabled. Uninstalling the app removes app-owned
Android data; CLI files, projects, Termux data, and Linux Companion state must be
removed separately by their owner.
