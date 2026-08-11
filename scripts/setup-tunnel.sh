#!/bin/sh
set -eu

: "${TUNNEL_ID:?Set TUNNEL_ID to the tunnel ID from OpenAI Platform settings}"
: "${CONTROL_PLANE_API_KEY:?Set CONTROL_PLANE_API_KEY locally; do not paste it into chat}"

if ! command -v tunnel-client >/dev/null 2>&1; then
  printf '%s\n' "tunnel-client is not installed." >&2
  printf '%s\n' "Download the latest release from OpenAI Platform tunnel settings or openai/tunnel-client." >&2
  exit 1
fi

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
profile=${TUNNEL_PROFILE:-codex-voice-local}
shell_bin=$(command -v sh)
mcp_command="$shell_bin $repo_dir/scripts/start-mcp.sh"

tunnel-client init \
  --sample sample_mcp_stdio_local \
  --profile "$profile" \
  --tunnel-id "$TUNNEL_ID" \
  --mcp-command "$mcp_command"

tunnel-client doctor --profile "$profile" --explain
printf '%s\n' "Tunnel profile is ready. Keep this running while using it:"
printf 'tunnel-client run --profile %s\n' "$profile"
