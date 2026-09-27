#!/bin/sh
# Prepare the historical 1.8.4 candidate without replacing the PC's Codex CLI.
set -eu
repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
test_cli_version=0.149.0
test_tools=${XDG_DATA_HOME:-"$HOME/.local/share"}/codex-pocket-voice/test-tools
test_cli_prefix=$test_tools/codex-$test_cli_version

if [ "$(node -p "JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8')).version" "$repo_dir/package.json")" != "1.8.4" ]; then
  printf '%s\n' 'This preparation script is scoped to the 1.8.4 candidate.' >&2
  exit 1
fi
if [ ! -x "$test_cli_prefix/node_modules/.bin/codex" ]; then
  mkdir -p "$test_cli_prefix"
  npm install --prefix "$test_cli_prefix" --no-save --no-package-lock "@openai/codex@$test_cli_version"
fi
export CODEX_BIN=$test_cli_prefix/node_modules/.bin/codex
if [ "$("$CODEX_BIN" --version)" != "codex-cli $test_cli_version" ]; then
  printf '%s\n' 'Unexpected test Codex CLI version.' >&2
  exit 1
fi
cd "$repo_dir"
npm ci
npm run build
npm run check
npm test
npm run test:integration
npm run check:app-server-schema
printf '\nPrepared candidate with isolated Codex CLI %s. No service was started or replaced.\n' "$test_cli_version"
