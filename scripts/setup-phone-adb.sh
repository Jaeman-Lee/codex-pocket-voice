#!/bin/sh
# Install Google's standalone platform tools for this user's test workspace.
set -eu
test_tools=${XDG_DATA_HOME:-"$HOME/.local/share"}/codex-pocket-voice/test-tools
adb_dir=$test_tools/platform-tools
if [ -x "$adb_dir/adb" ]; then
  "$adb_dir/adb" version
  exit 0
fi
if [ -e "$adb_dir" ]; then
  printf '%s\n' 'Existing platform-tools directory is incomplete; inspect it before retrying.' >&2
  exit 1
fi
mkdir -p "$test_tools"
test_download=$(mktemp -d "$test_tools/adb-download.XXXXXX")
trap 'rm -rf -- "$test_download"' EXIT HUP INT TERM
curl --fail --location --proto '=https' --tlsv1.2 \
  https://dl.google.com/android/repository/platform-tools-latest-linux.zip \
  --output "$test_download/platform-tools.zip"
unzip -q "$test_download/platform-tools.zip" -d "$test_download"
test -x "$test_download/platform-tools/adb"
sha256sum "$test_download/platform-tools.zip" > "$test_download/platform-tools/download.sha256"
mv "$test_download/platform-tools" "$adb_dir"
"$adb_dir/adb" version
printf '\nADB prepared. On the phone, connect USB and allow USB debugging for this PC.\n'
