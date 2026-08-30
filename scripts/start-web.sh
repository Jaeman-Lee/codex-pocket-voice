#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
if [ ! -f "$repo_dir/dist/src/web-index.js" ]; then
  printf '%s\n' "Build first: cd $repo_dir && npm install && npm run build" >&2
  exit 1
fi
if [ ! -f "$repo_dir/client/dist/index.html" ]; then
  printf '%s\n' "Build the React client first: cd $repo_dir && npm run build:client" >&2
  exit 1
fi

export CODEX_VOICE_ROOTS=${CODEX_VOICE_ROOTS:-"$repo_dir"}
export CODEX_WEB_HOST=127.0.0.1
export CODEX_WEB_PORT=${CODEX_WEB_PORT:-8787}
exec node "$repo_dir/dist/src/web-index.js"
