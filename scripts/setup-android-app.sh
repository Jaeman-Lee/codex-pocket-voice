#!/usr/bin/env bash

set -eu

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_DIR=$(cd -- "$SCRIPT_DIR/.." && pwd)
COMMAND_PATH="$PREFIX/bin/pc-codex-web"
PROPERTIES_DIR="$HOME/.termux"
PROPERTIES_FILE="$PROPERTIES_DIR/termux.properties"

mkdir -p "$PREFIX/bin" "$PROPERTIES_DIR"

if [ -e "$COMMAND_PATH" ] && [ ! -L "$COMMAND_PATH" ]; then
    printf '기존 일반 파일을 덮어쓰지 않습니다: %s\n' "$COMMAND_PATH" >&2
    exit 1
fi
ln -sfn "$REPO_DIR/scripts/pc-codex-web.sh" "$COMMAND_PATH"

touch "$PROPERTIES_FILE"
if grep -q '^allow-external-apps=' "$PROPERTIES_FILE"; then
    sed -i 's/^allow-external-apps=.*/allow-external-apps=true/' "$PROPERTIES_FILE"
else
    printf '\nallow-external-apps=true\n' >> "$PROPERTIES_FILE"
fi

chmod 700 "$REPO_DIR/scripts/pc-codex-web.sh" "$COMMAND_PATH"
command -v termux-reload-settings >/dev/null 2>&1 && termux-reload-settings || true

printf 'Android 앱 연동 준비 완료.\n'
printf '앱 설치 후 Android 설정에서 Codex Pocket Voice의 “Termux 명령 실행” 권한을 허용하세요.\n'
