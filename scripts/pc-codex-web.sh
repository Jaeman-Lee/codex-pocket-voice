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
STATE_DIR="${CODEX_POCKET_STATE_DIR:-$HOME/.local/state/codex-pocket-voice}"
PID_FILE="$STATE_DIR/tunnel-supervisor.pid"
LOG_FILE="$STATE_DIR/tunnel-supervisor.log"
SCRIPT_PATH=$(readlink -f "${BASH_SOURCE[0]}")

ssh_options=(
    -q
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
    printf '  open    자동 재연결 서비스를 시작하고 Codex Pocket 열기 (기본값)\n'
    printf '  start   자동 재연결 서비스만 시작\n'
    printf '  stop    자동 재연결 서비스와 SSH 터널 종료\n'
    printf '  status  연결 또는 재연결 상태 확인\n'
    printf '\n필수 환경변수:\n'
    printf '  PC_SSH_TARGET       SSH 설정 별칭 또는 user@host\n'
    printf '  PC_CODEX_WEB_APP    PC에 clone한 저장소의 절대 경로\n'
    printf '\n선택 환경변수: PC_PORT, PC_CODEX_KEY\n'
}

validate_configuration() {
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
}

control_running() {
    ssh "${ssh_options[@]}" -S "$CONTROL" -O check "$TARGET" >/dev/null 2>&1
}

supervisor_running() {
    [ -r "$PID_FILE" ] || return 1
    local pid
    pid=$(sed -n '1p' "$PID_FILE")
    case "$pid" in
        *[!0-9]*|'') return 1 ;;
    esac
    kill -0 "$pid" >/dev/null 2>&1
}

ensure_remote_app() {
    local remote_command
    printf -v remote_command \
        'tmux has-session -t codex-pocket 2>/dev/null || tmux new-session -d -s codex-pocket %q' \
        "env CODEX_WEB_PORT=$REMOTE_PORT $REMOTE_APP/scripts/start-web-pc.sh"
    ssh "${ssh_options[@]}" -S "$CONTROL" "$TARGET" "$remote_command"
}

connect_once() {
    if control_running; then
        return
    fi
    if [ -S "$CONTROL" ]; then
        rm -f -- "$CONTROL"
    fi
    if nc -z -w 1 127.0.0.1 "$LOCAL_PORT" >/dev/null 2>&1; then
        return 1
    fi

    ssh "${ssh_options[@]}" \
        -M -S "$CONTROL" -o ExitOnForwardFailure=yes \
        -fNT -L "$LOCAL_PORT:127.0.0.1:$REMOTE_PORT" "$TARGET"
    ensure_remote_app
}

run_supervisor() {
    validate_configuration
    mkdir -p "$STATE_DIR"
    chmod 700 "$STATE_DIR"

    cleanup_supervisor() {
        if [ -r "$PID_FILE" ] && [ "$(sed -n '1p' "$PID_FILE")" = "$$" ]; then
            rm -f -- "$PID_FILE"
        fi
    }
    trap cleanup_supervisor EXIT INT TERM

    local health_tick=0
    while :; do
        if control_running; then
            health_tick=$((health_tick + 1))
            if [ "$health_tick" -ge 6 ]; then
                ensure_remote_app >/dev/null 2>&1 || true
                health_tick=0
            fi
        else
            health_tick=0
            connect_once >/dev/null 2>&1 || true
        fi
        sleep 10
    done
}

start_supervisor() {
    validate_configuration
    mkdir -p "$STATE_DIR"
    chmod 700 "$STATE_DIR"

    if ! supervisor_running; then
        rm -f -- "$PID_FILE"
        : > "$LOG_FILE"
        nohup "$SCRIPT_PATH" supervise > "$LOG_FILE" 2>&1 < /dev/null &
        printf '%s\n' "$!" > "$PID_FILE"
    fi

    local attempt
    for attempt in 1 2 3 4 5; do
        if control_running && nc -z -w 1 127.0.0.1 "$LOCAL_PORT" >/dev/null 2>&1; then
            printf 'Codex Pocket 연결됨: %s\n' "$URL"
            return
        fi
        sleep 0.2
    done
    printf 'PC 오프라인 · 백그라운드에서 자동 재연결 중\n'
}

stop_supervisor() {
    if supervisor_running; then
        local pid
        pid=$(sed -n '1p' "$PID_FILE")
        kill "$pid" >/dev/null 2>&1 || true
        rm -f -- "$PID_FILE"
    fi
    if control_running; then
        ssh "${ssh_options[@]}" -S "$CONTROL" -O exit "$TARGET" >/dev/null 2>&1 || true
    fi
    printf 'Codex Pocket 자동 재연결 서비스를 종료했습니다.\n'
}

show_status() {
    if control_running && nc -z -w 1 127.0.0.1 "$LOCAL_PORT" >/dev/null 2>&1; then
        printf '연결됨: %s\n' "$URL"
        return
    fi
    if supervisor_running; then
        printf 'PC 오프라인 · 자동 재연결 중\n'
        return
    fi
    printf '연결 안 됨 · pc-codex-web start 필요\n'
    return 1
}

command_name="${1:-open}"
case "$command_name" in
    open)
        start_supervisor
        termux-open-url "$URL"
        ;;
    start)
        start_supervisor
        ;;
    stop)
        stop_supervisor
        ;;
    status)
        show_status
        ;;
    supervise)
        run_supervisor
        ;;
    help|--help|-h)
        usage
        ;;
    *)
        usage >&2
        exit 2
        ;;
esac
