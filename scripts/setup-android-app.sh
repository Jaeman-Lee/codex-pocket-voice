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

# Older releases started a second Codex gateway on the phone. Stop that
# resource-heavy runtime and remove its launcher while keeping the migration
# script in the repository so an existing installation can be shut down.
if [ -L "$PHONE_COMMAND_PATH" ]; then
    LEGACY_PHONE_TARGET=$(readlink -f -- "$PHONE_COMMAND_PATH" 2>/dev/null || true)
    if [ "$LEGACY_PHONE_TARGET" = "$REPO_DIR/scripts/phone-codex-web.sh" ]; then
        "$PHONE_COMMAND_PATH" stop >/dev/null 2>&1 || true
        rm -f -- "$PHONE_COMMAND_PATH"
    fi
fi
ln -sfn "$REPO_DIR/scripts/codex-pocket-boot.sh" "$BOOT_COMMAND_PATH"
ln -sfn "$REPO_DIR/scripts/codex-pocket-boot.sh" "$TASK_COMMAND_PATH"

touch "$PROPERTIES_FILE"
if grep -q '^allow-external-apps=' "$PROPERTIES_FILE"; then
    sed -i 's/^allow-external-apps=.*/allow-external-apps=true/' "$PROPERTIES_FILE"
else
    printf '\nallow-external-apps=true\n' >> "$PROPERTIES_FILE"
fi

chmod 700 "$REPO_DIR/scripts/pc-codex-web.sh" "$REPO_DIR/scripts/codex-pocket-boot.sh" "$COMMAND_PATH" "$BOOT_COMMAND_PATH" "$TASK_COMMAND_PATH"
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
printf 'Codex 실행과 미디어 처리는 Linux PC에서만 수행합니다.\n'
printf '스마트폰은 화면, 음성 입력과 암호화된 PC 연결만 담당합니다.\n'
printf 'Google Play Termux에서는 내장 Boot와 15분 자가복구 작업을 사용합니다.\n'
printf 'F-Droid/GitHub판 Termux는 앱 설정에서 “Termux 명령 실행” 권한도 허용하세요.\n'
