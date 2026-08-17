#!/data/data/com.termux/files/usr/bin/bash

set -eu

CONFIG_FILE="${CODEX_POCKET_CONFIG:-$HOME/.config/codex-pocket-voice/config}"
if [ -r "$CONFIG_FILE" ]; then
    # shellcheck source=/dev/null
    . "$CONFIG_FILE"
fi

SCRIPT_PATH=${BASH_SOURCE[0]}
if command -v readlink >/dev/null 2>&1; then
    SCRIPT_PATH=$(readlink -f -- "$SCRIPT_PATH")
fi
SCRIPT_DIR=$(cd -- "$(dirname -- "$SCRIPT_PATH")" && pwd)
DEFAULT_REPO=$(cd -- "$SCRIPT_DIR/.." && pwd)
REPO_DIR=${PHONE_CODEX_WEB_APP:-$DEFAULT_REPO}
PROJECTS_HOME=${PHONE_PROJECTS_HOME:-$HOME/codex}
PORT=${CODEX_PHONE_WEB_PORT:-8789}
STATE_DIR=${CODEX_PHONE_STATE_DIR:-$HOME/.local/state/codex-pocket-phone}
SUPERVISOR_PID_FILE="$STATE_DIR/supervisor.pid"
SERVER_PID_FILE="$STATE_DIR/server.pid"
LOG_FILE="$STATE_DIR/server.log"
URL="http://127.0.0.1:$PORT"

server_running() {
    curl -fsS --max-time 2 "$URL/api/status" >/dev/null 2>&1
}

saved_pid_running() {
    local pid_file=$1
    [ -r "$pid_file" ] || return 1
    local pid
    pid=$(sed -n '1p' "$pid_file")
    case "$pid" in
        *[!0-9]*|'') return 1 ;;
    esac
    kill -0 "$pid" >/dev/null 2>&1
}

discover_roots() {
    local roots
    roots=${PHONE_CODEX_ROOTS:-}
    if [ -z "$roots" ] && [ -d "$PROJECTS_HOME" ]; then
        roots=$(find "$PROJECTS_HOME" -maxdepth 6 -type d -name .git -printf '%h\n' 2>/dev/null | sort -u | paste -sd ':' -)
    fi
    if [ -z "$roots" ]; then
        roots=$REPO_DIR
    fi
    printf '%s' "$roots"
}

launch_server() {
    if saved_pid_running "$SERVER_PID_FILE"; then
        kill "$(sed -n '1p' "$SERVER_PID_FILE")" >/dev/null 2>&1 || true
    fi
    mkdir -p "$STATE_DIR" "$PROJECTS_HOME"
    chmod 700 "$STATE_DIR" "$PROJECTS_HOME"
    roots=$(discover_roots)
    env \
        CODEX_BIN="${PHONE_CODEX_BIN:-$(command -v codex)}" \
        CODEX_WEB_PORT="$PORT" \
        CODEX_DEVICE_ID=phone \
        CODEX_DEVICE_NAME='이 스마트폰' \
        CODEX_VOICE_ROOTS="$roots" \
        CODEX_PROJECT_CREATION_ROOTS="$PROJECTS_HOME" \
        "$REPO_DIR/scripts/start-web.sh" \
        >>"$LOG_FILE" 2>&1 </dev/null &
    printf '%s\n' "$!" > "$SERVER_PID_FILE"
}

run_supervisor() {
    mkdir -p "$STATE_DIR" "$PROJECTS_HOME"
    chmod 700 "$STATE_DIR" "$PROJECTS_HOME"
    cleanup_supervisor() {
        if [ -r "$SUPERVISOR_PID_FILE" ] && [ "$(sed -n '1p' "$SUPERVISOR_PID_FILE")" = "$$" ]; then
            rm -f -- "$SUPERVISOR_PID_FILE"
        fi
    }
    trap cleanup_supervisor EXIT INT TERM
    while :; do
        if ! server_running; then
            printf '[phone-supervisor] %s 서버 재시작\n' "$(date -Iseconds)" >> "$LOG_FILE"
            launch_server
        fi
        sleep 5
    done
}

start_server() {
    mkdir -p "$STATE_DIR" "$PROJECTS_HOME"
    chmod 700 "$STATE_DIR" "$PROJECTS_HOME"
    if ! saved_pid_running "$SUPERVISOR_PID_FILE"; then
        rm -f -- "$SUPERVISOR_PID_FILE"
        : > "$LOG_FILE"
        nohup "$SCRIPT_PATH" supervise >>"$LOG_FILE" 2>&1 </dev/null &
        printf '%s\n' "$!" > "$SUPERVISOR_PID_FILE"
    fi

    attempt=0
    while [ "$attempt" -lt 20 ]; do
        if server_running; then
            printf '스마트폰 Codex 연결됨: %s\n' "$URL"
            return
        fi
        attempt=$((attempt + 1))
        sleep 0.5
    done
    printf '스마트폰 Codex 서버를 시작하지 못했습니다: %s\n' "$LOG_FILE" >&2
    return 1
}

stop_server() {
    if saved_pid_running "$SUPERVISOR_PID_FILE"; then
        kill "$(sed -n '1p' "$SUPERVISOR_PID_FILE")" >/dev/null 2>&1 || true
        rm -f -- "$SUPERVISOR_PID_FILE"
    fi
    if saved_pid_running "$SERVER_PID_FILE"; then
        kill "$(sed -n '1p' "$SERVER_PID_FILE")" >/dev/null 2>&1 || true
        rm -f -- "$SERVER_PID_FILE"
    fi
    printf '스마트폰 Codex 서버를 종료했습니다.\n'
}

show_status() {
    if server_running; then
        printf '연결됨: %s\n' "$URL"
        return
    fi
    if saved_pid_running "$SUPERVISOR_PID_FILE"; then
        printf '스마트폰 Codex 재시작 중\n'
        return
    fi
    printf '연결 안 됨 · phone-codex-web start 필요\n'
    return 1
}

case "${1:-start}" in
    start) start_server ;;
    stop) stop_server ;;
    status) show_status ;;
    supervise) run_supervisor ;;
    *) printf '사용법: phone-codex-web [start|stop|status]\n' >&2; exit 2 ;;
esac
