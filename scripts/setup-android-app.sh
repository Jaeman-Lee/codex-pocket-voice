#!/usr/bin/env bash

set -eu

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_DIR=$(cd -- "$SCRIPT_DIR/.." && pwd)
COMMAND_PATH="$PREFIX/bin/pc-codex-web"
PHONE_COMMAND_PATH="$PREFIX/bin/phone-codex-web"
BOOT_COMMAND_PATH="$HOME/.termux/boot/codex-pocket-voice"
TASK_COMMAND_PATH="$HOME/.shortcuts/tasks/codex-pocket-voice"
PROPERTIES_DIR="$HOME/.termux"
PROPERTIES_FILE="$PROPERTIES_DIR/termux.properties"

mkdir -p "$PREFIX/bin" "$PROPERTIES_DIR" "$(dirname "$BOOT_COMMAND_PATH")" "$(dirname "$TASK_COMMAND_PATH")"

if [ -e "$COMMAND_PATH" ] && [ ! -L "$COMMAND_PATH" ]; then
    printf '기존 일반 파일을 덮어쓰지 않습니다: %s\n' "$COMMAND_PATH" >&2
    exit 1
fi
ln -sfn "$REPO_DIR/scripts/pc-codex-web.sh" "$COMMAND_PATH"
ln -sfn "$REPO_DIR/scripts/phone-codex-web.sh" "$PHONE_COMMAND_PATH"
ln -sfn "$REPO_DIR/scripts/codex-pocket-boot.sh" "$BOOT_COMMAND_PATH"
ln -sfn "$REPO_DIR/scripts/codex-pocket-boot.sh" "$TASK_COMMAND_PATH"

touch "$PROPERTIES_FILE"
if grep -q '^allow-external-apps=' "$PROPERTIES_FILE"; then
    sed -i 's/^allow-external-apps=.*/allow-external-apps=true/' "$PROPERTIES_FILE"
else
    printf '\nallow-external-apps=true\n' >> "$PROPERTIES_FILE"
fi

chmod 700 "$REPO_DIR/scripts/pc-codex-web.sh" "$REPO_DIR/scripts/phone-codex-web.sh" "$REPO_DIR/scripts/codex-pocket-boot.sh" "$COMMAND_PATH" "$PHONE_COMMAND_PATH" "$BOOT_COMMAND_PATH" "$TASK_COMMAND_PATH"
command -v termux-reload-settings >/dev/null 2>&1 && termux-reload-settings || true

if command -v termux-job-scheduler >/dev/null 2>&1; then
    termux-job-scheduler \
        --script "$BOOT_COMMAND_PATH" \
        --job-id 932701 \
        --period-ms 0 \
        --battery-not-low false \
        --storage-not-low false >/dev/null 2>&1 || true
    termux-job-scheduler \
        --script "$BOOT_COMMAND_PATH" \
        --job-id 932702 \
        --period-ms 900000 \
        --persisted true \
        --battery-not-low false \
        --storage-not-low false >/dev/null 2>&1 || true
fi

printf 'Android 앱 연동 준비 완료.\n'
printf 'PC와 스마트폰 Codex gateway를 앱에서 자동으로 시작합니다.\n'
printf 'Google Play Termux에서는 내장 Boot와 15분 자가복구 작업을 사용합니다.\n'
printf 'F-Droid/GitHub판 Termux는 앱 설정에서 “Termux 명령 실행” 권한도 허용하세요.\n'
