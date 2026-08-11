#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
projects_home=${CODEX_PROJECTS_HOME:-"$HOME/workspace"}

if [ -z "${CODEX_VOICE_ROOTS:-}" ] && [ -d "$projects_home" ]; then
  CODEX_VOICE_ROOTS=$(find "$projects_home" -maxdepth 7 -type d -name .git -printf '%h\n' 2>/dev/null | sort -u | paste -sd ':' -)
  export CODEX_VOICE_ROOTS
fi

if [ -z "${CODEX_VOICE_ROOTS:-}" ]; then
  export CODEX_VOICE_ROOTS=$repo_dir
fi

if [ -d "$HOME/.nvm/versions/node" ]; then
  node_bin=$(find "$HOME/.nvm/versions/node" -path '*/bin/node' -type f -perm -u+x 2>/dev/null | sort -V | tail -1)
  if [ -n "$node_bin" ]; then
    PATH="$(dirname "$node_bin"):$PATH"
    export PATH
  fi
fi

export CODEX_BIN=${CODEX_BIN:-"$HOME/.local/bin/codex"}
export CODEX_WEB_PORT=${CODEX_WEB_PORT:-8787}
exec "$repo_dir/scripts/start-web.sh"
