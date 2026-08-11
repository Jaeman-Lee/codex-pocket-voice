#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
if [ ! -f "$repo_dir/dist/src/index.js" ]; then
  printf '%s\n' "Build first: cd $repo_dir && npm install && npm run build" >&2
  exit 1
fi

export CODEX_VOICE_ROOTS=${CODEX_VOICE_ROOTS:-"$repo_dir"}
exec node "$repo_dir/dist/src/index.js"
