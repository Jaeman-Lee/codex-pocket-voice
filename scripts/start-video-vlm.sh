#!/bin/sh
set -eu

ollama_url=${CODEX_VIDEO_OLLAMA_URL:-http://127.0.0.1:11435}
ollama_host=${ollama_url#http://}
ollama_host=${ollama_host#https://}
ollama_host=${ollama_host%/}
ollama_bin=${CODEX_VIDEO_OLLAMA_BIN:-"$HOME/.local/opt/ollama-vl/bin/ollama"}
ollama_models=${CODEX_VIDEO_OLLAMA_MODELS:-"$HOME/.local/share/ollama-vl/models"}
state_dir=${CODEX_VIDEO_OLLAMA_STATE:-"$HOME/.local/state/ollama-vl"}
model=${CODEX_VIDEO_MODEL:-qwen3-vl:4b}

if [ "${CODEX_VIDEO_ENABLED:-true}" = "false" ]; then
  exit 0
fi

if curl -fsS --max-time 2 "$ollama_url/api/version" >/dev/null 2>&1; then
  exit 0
fi

if [ ! -x "$ollama_bin" ]; then
  printf '%s\n' "[video-vlm] Ollama 실행 파일이 없어 영상 분석을 건너뜁니다: $ollama_bin" >&2
  exit 0
fi

mkdir -p "$ollama_models" "$state_dir"
nohup env \
  OLLAMA_HOST="$ollama_host" \
  OLLAMA_MODELS="$ollama_models" \
  "$ollama_bin" serve \
  </dev/null >"$state_dir/server.log" 2>&1 &
printf '%s\n' "$!" >"$state_dir/server.pid"

attempt=0
while [ "$attempt" -lt 15 ]; do
  if curl -fsS --max-time 2 "$ollama_url/api/version" >/dev/null 2>&1; then
    if ! env OLLAMA_HOST="$ollama_host" OLLAMA_MODELS="$ollama_models" "$ollama_bin" show "$model" >/dev/null 2>&1; then
      printf '%s\n' "[video-vlm] $model 모델이 없습니다. 최초 한 번 다음 명령을 실행하세요:" >&2
      printf '%s\n' "OLLAMA_HOST=$ollama_host OLLAMA_MODELS=$ollama_models $ollama_bin pull $model" >&2
    fi
    exit 0
  fi
  attempt=$((attempt + 1))
  sleep 1
done

printf '%s\n' "[video-vlm] Ollama가 시작되지 않았습니다. $state_dir/server.log 를 확인하세요." >&2
exit 0
