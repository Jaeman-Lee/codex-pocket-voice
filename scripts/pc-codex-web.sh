#!/usr/bin/env bash

set -eu

CONFIG_FILE="${CODEX_POCKET_CONFIG:-$HOME/.config/codex-pocket-voice/config}"
if [ -r "$CONFIG_FILE" ]; then
    # shellcheck source=/dev/null
    . "$CONFIG_FILE"
fi

PC_SSH_TARGET="${PC_SSH_TARGET:-}"
PC_PORT="${PC_PORT:-}"
LOCAL_PORT="${CODEX_POCKET_LOCAL_PORT:-8788}"
REMOTE_PORT="${CODEX_POCKET_REMOTE_PORT:-8787}"
KEY="${PC_CODEX_KEY:-}"
CONTROL="${PC_CODEX_WEB_CONTROL:-$HOME/.ssh/pc-codex-web-control}"
REMOTE_APP="${PC_CODEX_WEB_APP:-}"
TARGET="$PC_SSH_TARGET"
URL="http://127.0.0.1:$LOCAL_PORT"

ssh_options=(
    -o BatchMode=yes
    -o ServerAliveInterval=30
    -o ServerAliveCountMax=3
    -o ConnectTimeout=10
)

if [ -n "$KEY" ]; then
    ssh_options+=(-i "$KEY" -o IdentitiesOnly=yes)
fi
if [ -n "$PC_PORT" ]; then
    ssh_options+=(-p "$PC_PORT")
fi

usage() {
    printf '사용법: pc-codex-web [open|start|stop|status]\n'
    printf '  open    백그라운드 연결을 확인하고 Codex Pocket 열기 (기본값)\n'
    printf '  start   백그라운드 연결만 시작\n'
    printf '  stop    백그라운드 연결 종료\n'
    printf '  status  연결 상태 확인\n'
    printf '\n필수 환경변수:\n'
    printf '  PC_SSH_TARGET       SSH 설정 별칭 또는 user@host\n'
    printf '  PC_CODEX_WEB_APP    PC에 clone한 저장소의 절대 경로\n'
    printf '\n선택 환경변수: PC_PORT, PC_CODEX_KEY\n'
}

control_running() {
    ssh "${ssh_options[@]}" -S "$CONTROL" -O check "$TARGET" >/dev/null 2>&1
}

ensure_remote_app() {
    local remote_command
    printf -v remote_command \
        'tmux has-session -t codex-pocket 2>/dev/null || tmux new-session -d -s codex-pocket %q' \
        "env CODEX_WEB_PORT=$REMOTE_PORT $REMOTE_APP/scripts/start-web-pc.sh"
    ssh "${ssh_options[@]}" -S "$CONTROL" "$TARGET" "$remote_command"
}

start_tunnel() {
    if [ -z "$TARGET" ] || [ -z "$REMOTE_APP" ]; then
        printf 'PC_SSH_TARGET과 PC_CODEX_WEB_APP을 설정하세요. --help를 참고하십시오.\n' >&2
        return 1
    fi
    if [ -n "$KEY" ] && [ ! -s "$KEY" ]; then
        printf 'SSH 키가 없습니다: %s\n' "$KEY" >&2
        return 1
    fi
    chmod 700 "$HOME/.ssh"
    if [ -n "$KEY" ]; then
        chmod 600 "$KEY"
    fi

    if control_running; then
        ensure_remote_app
        return
    fi

    # 이전 비정상 종료로 남은 이 서비스 전용 제어 소켓만 정리합니다.
    if [ -S "$CONTROL" ]; then
        rm -f -- "$CONTROL"
    fi
    if nc -z -w 1 127.0.0.1 "$LOCAL_PORT" >/dev/null 2>&1; then
        printf '로컬 포트 %s를 다른 프로세스가 사용 중입니다.\n' "$LOCAL_PORT" >&2
        return 1
    fi

    ssh "${ssh_options[@]}" \
        -M -S "$CONTROL" -o ExitOnForwardFailure=yes \
        -fNT -L "$LOCAL_PORT:127.0.0.1:$REMOTE_PORT" "$TARGET"
    ensure_remote_app

    local attempt
    for attempt in 1 2 3 4 5 6 7 8 9 10; do
        if nc -z -w 1 127.0.0.1 "$LOCAL_PORT" >/dev/null 2>&1; then
            printf 'Codex Pocket 백그라운드 연결됨: %s\n' "$URL"
            return
        fi
        sleep 0.2
    done
    printf 'SSH 연결은 시작됐지만 웹 포트를 확인할 수 없습니다.\n' >&2
    return 1
}

stop_tunnel() {
    if control_running; then
        ssh "${ssh_options[@]}" -S "$CONTROL" -O exit "$TARGET" >/dev/null
        printf 'Codex Pocket 백그라운드 연결을 종료했습니다.\n'
    else
        printf 'Codex Pocket 백그라운드 연결이 실행 중이 아닙니다.\n'
    fi
}

show_status() {
    if control_running && nc -z -w 1 127.0.0.1 "$LOCAL_PORT" >/dev/null 2>&1; then
        printf '연결됨: %s\n' "$URL"
        return
    fi
    printf '연결 안 됨\n'
    return 1
}

command_name="${1:-open}"
case "$command_name" in
    open)
        start_tunnel
        termux-open-url "$URL"
        ;;
    start)
        start_tunnel
        ;;
    stop)
        stop_tunnel
        ;;
    status)
        show_status
        ;;
    help|--help|-h)
        usage
        ;;
    *)
        usage >&2
        exit 2
        ;;
esac
