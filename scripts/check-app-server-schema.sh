#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
temporary=$(mktemp -d)
cleanup() {
  rm -rf -- "$temporary"
}
trap cleanup EXIT INT TERM

codex_bin=${CODEX_BIN:-codex}
"$codex_bin" app-server generate-ts --experimental --out "$temporary/app-server" >/dev/null
if ! diff -qr "$repo_dir/generated/app-server" "$temporary/app-server"; then
  printf '%s\n' 'Generated app-server bindings do not match the installed Codex CLI.' >&2
  printf 'Regenerate with: %s app-server generate-ts --experimental --out %s/generated/app-server\n' "$codex_bin" "$repo_dir" >&2
  exit 1
fi
printf 'App-server bindings match %s\n' "$("$codex_bin" --version)"
