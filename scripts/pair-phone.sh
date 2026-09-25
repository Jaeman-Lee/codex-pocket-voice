#!/bin/sh
# Pair interactively; do not put the pairing code in arguments, logs, or Git.
set -eu
adb=${XDG_DATA_HOME:-"$HOME/.local/share"}/codex-pocket-voice/test-tools/platform-tools/adb
if [ ! -x "$adb" ]; then
  printf '%s\n' '먼저 sh scripts/setup-phone-adb.sh 를 실행하세요.' >&2
  exit 1
fi
printf '%s\n' 'Android 무선 디버깅 연결' \
  '휴대폰의 페어링 코드 화면을 열린 채로 유지하세요.'
printf '\n페어링 화면의 IP 주소:포트 입력: '
IFS= read -r pairing_endpoint
if [ -z "$pairing_endpoint" ]; then exit 1; fi
if ! "$adb" pair "$pairing_endpoint"; then
  printf '\n페어링 실패. 화면의 주소/포트와 유효한 새 코드를 확인하세요. Enter를 누르면 닫힙니다. '
  IFS= read -r ignored
  exit 1
fi
printf '\n페어링 완료. 자동 연결을 확인합니다.\n'
sleep 3
if ! "$adb" get-state >/dev/null 2>&1; then
  printf '%s\n' '휴대폰에서 페어링 창을 닫고 무선 디버깅 기본 화면을 보세요.' \
    '기본 화면의 연결 포트는 방금 입력한 페어링 포트와 다를 수 있습니다.'
  printf '기본 화면의 IP 주소:포트 입력: '
  IFS= read -r connection_endpoint
  if [ -n "$connection_endpoint" ]; then
    "$adb" connect "$connection_endpoint" || true
  fi
fi
"$adb" devices -l
printf '\n연결 창은 완료됐습니다. Enter를 누르면 닫힙니다. '
IFS= read -r ignored
