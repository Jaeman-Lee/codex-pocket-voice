#!/bin/sh
# An isolated, loopback-only Companion for USB-forwarded Android acceptance.
set -eu
repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
test_tools=${XDG_DATA_HOME:-"$HOME/.local/share"}/codex-pocket-voice/test-tools
test_state=${XDG_STATE_HOME:-"$HOME/.local/state"}/codex-pocket-voice/phone-test
export CODEX_BIN=$test_tools/codex-0.149.0/node_modules/.bin/codex
if [ ! -x "$CODEX_BIN" ] || [ ! -f "$repo_dir/dist/src/web-index.js" ]; then
  printf '%s\n' 'Run sh scripts/prepare-phone-test.sh first.' >&2
  exit 1
fi
umask 077
mkdir -p "$test_state/projects" "$test_state/media"
export CODEX_WEB_HOST=127.0.0.1
export CODEX_WEB_PORT=8792
export CODEX_POCKET_AUTH_STATE=$test_state/gateway-auth.json
export CODEX_POCKET_HANDOFF_STATE=$test_state/session-handoff.json
export CODEX_POCKET_MEDIA_DIR=$test_state/media
export CODEX_DEVICE_NAME='Android USB test'
export CODEX_PROJECT_CREATION_ROOTS=$test_state/projects
export CODEX_VOICE_ROOTS=$repo_dir:$test_state/projects
cd "$repo_dir"
exec node dist/src/web-index.js
