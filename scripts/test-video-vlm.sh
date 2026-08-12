#!/usr/bin/env bash

set -euo pipefail

OLLAMA_URL=${CODEX_VIDEO_OLLAMA_URL:-http://127.0.0.1:11435}
MODEL=${CODEX_VIDEO_MODEL:-qwen3-vl:4b}
TEST_DIR=${CODEX_VIDEO_TEST_DIR:-$HOME/.cache/codex-pocket-vlm-test}

for command_name in ffmpeg curl python3; do
  command -v "$command_name" >/dev/null || {
    printf '필수 명령을 찾을 수 없습니다: %s\n' "$command_name" >&2
    exit 1
  }
done

rm -rf -- "$TEST_DIR"
mkdir -p "$TEST_DIR/frames"

ffmpeg -nostdin -hide_banner -loglevel error \
  -f lavfi -i "color=c=0x101820:s=640x360:r=24:d=12" \
  -vf "drawtext=fontcolor=white:fontsize=42:x=(w-text_w)/2:y=90:text=CODEX_POCKET,drawtext=fontcolor=0x9df2d5:fontsize=54:x=(w-text_w)/2:y=170:text=LOGIN:enable=between(t\,0\,2.99),drawtext=fontcolor=yellow:fontsize=54:x=(w-text_w)/2:y=170:text=LOADING:enable=between(t\,3\,5.99),drawtext=fontcolor=red:fontsize=42:x=(w-text_w)/2:y=170:text=NETWORK_ERROR:enable=between(t\,6\,8.99),drawtext=fontcolor=0x9df2d5:fontsize=54:x=(w-text_w)/2:y=170:text=RETRY:enable=between(t\,9\,12),drawtext=fontcolor=white:fontsize=22:x=20:y=320:text=%{pts\\:hms}" \
  -c:v libx264 -pix_fmt yuv420p "$TEST_DIR/test.mp4"

ffmpeg -nostdin -hide_banner -loglevel error \
  -i "$TEST_DIR/test.mp4" \
  -vf "fps=1/3,scale=640:-2" \
  -frames:v 4 "$TEST_DIR/frames/frame-%02d.jpg"

python3 - "$MODEL" "$TEST_DIR" <<'PY'
import base64
import glob
import json
import os
import sys

model, test_dir = sys.argv[1:]
images = []
for path in sorted(glob.glob(os.path.join(test_dir, "frames", "*.jpg"))):
    with open(path, "rb") as image_file:
        images.append(base64.b64encode(image_file.read()).decode("ascii"))

request = {
    "model": model,
    "messages": [{
        "role": "user",
        "content": "다음 네 장은 3초 간격으로 추출한 영상 프레임입니다. 시간 순서대로 사건을 분석하고 오류가 있다면 원인을 설명하세요. 반드시 JSON으로만 답하세요: {summary:string, events:[{frame:number, screen_text:string, event:string}], issue:string}",
        "images": images,
    }],
    "stream": False,
    "format": "json",
    "keep_alive": "10m",
    "options": {"temperature": 0, "num_ctx": 8192},
}
with open(os.path.join(test_dir, "request.json"), "w", encoding="utf-8") as output:
    json.dump(request, output)
PY

curl -sS --max-time 300 \
  -o "$TEST_DIR/response.json" \
  -w 'http=%{http_code} total=%{time_total}s\n' \
  -H 'Content-Type: application/json' \
  --data-binary @"$TEST_DIR/request.json" \
  "$OLLAMA_URL/api/chat"

python3 - "$TEST_DIR/response.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as response_file:
    response = json.load(response_file)
summary = {
    "message": response.get("message", {}).get("content"),
    "load_seconds": response.get("load_duration", 0) / 1_000_000_000,
    "prompt_tokens": response.get("prompt_eval_count"),
    "prompt_seconds": response.get("prompt_eval_duration", 0) / 1_000_000_000,
    "output_tokens": response.get("eval_count"),
    "output_seconds": response.get("eval_duration", 0) / 1_000_000_000,
}
print(json.dumps(summary, ensure_ascii=False, indent=2))
PY

if [ -x /usr/lib/wsl/lib/nvidia-smi ]; then
  /usr/lib/wsl/lib/nvidia-smi \
    --query-compute-apps=process_name,used_memory \
    --format=csv,noheader 2>/dev/null || true
  /usr/lib/wsl/lib/nvidia-smi \
    --query-gpu=memory.used,memory.free,utilization.gpu \
    --format=csv,noheader 2>/dev/null || true
fi
