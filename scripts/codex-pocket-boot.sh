#!/data/data/com.termux/files/usr/bin/bash

# Google Play Termux includes Termux:Boot. F-Droid/GitHub builds can use the
# separate Termux:Boot add-on with this same script.
termux-wake-lock >/dev/null 2>&1 || true
pc-codex-web start >/dev/null 2>&1 || true
