#!/bin/sh
set -eu

if [ "$(uname -s)" != "Linux" ]; then
  printf '%s\n' 'Codex Pocket Companion supports Linux only.' >&2
  exit 1
fi

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
config_dir=${XDG_CONFIG_HOME:-"$HOME/.config"}/codex-pocket-voice
systemd_dir=${XDG_CONFIG_HOME:-"$HOME/.config"}/systemd/user
environment_file=$config_dir/companion.env
service_file=$systemd_dir/codex-pocket-companion.service
projects_home=${CODEX_PROJECTS_HOME:-"$HOME/workspace"}

missing=
for command in node npm git tmux ssh; do
  if ! command -v "$command" >/dev/null 2>&1; then
    missing="$missing $command"
  fi
done
if [ -n "$missing" ]; then
  printf 'Required Linux commands are missing:%s\n' "$missing" >&2
  exit 1
fi

node_major=$(node -p 'Number(process.versions.node.split(".")[0])')
if [ "$node_major" -lt 20 ]; then
  printf 'Node.js 20 or newer is required; found %s\n' "$(node --version)" >&2
  exit 1
fi
if ! command -v codex >/dev/null 2>&1 && [ ! -x "${CODEX_BIN:-}" ]; then
  printf '%s\n' 'Codex CLI is not installed. Install and sign in before starting the companion.' >&2
  exit 1
fi

mkdir -p "$config_dir" "$systemd_dir" "$projects_home"
chmod 700 "$config_dir"
if [ ! -f "$environment_file" ]; then
  umask 077
  {
    printf 'CODEX_PROJECTS_HOME=%s\n' "$projects_home"
    printf 'CODEX_WEB_PORT=%s\n' "${CODEX_WEB_PORT:-8787}"
    printf 'CODEX_DEVICE_NAME=%s\n' "${CODEX_DEVICE_NAME:-Linux PC}"
  } > "$environment_file"
fi

npm --prefix "$repo_dir" ci
npm --prefix "$repo_dir" run build

umask 077
{
  printf '%s\n' '[Unit]'
  printf '%s\n' 'Description=Codex Pocket Linux Companion'
  printf '%s\n' 'After=network-online.target'
  printf '%s\n' '' '[Service]'
  printf 'WorkingDirectory=%s\n' "$repo_dir"
  printf 'EnvironmentFile=%s\n' "$environment_file"
  printf 'ExecStart=%s/scripts/start-web-pc.sh\n' "$repo_dir"
  printf '%s\n' 'Restart=on-failure' 'RestartSec=3'
  printf '%s\n' '' '[Install]' 'WantedBy=default.target'
} > "$service_file"

if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  systemctl --user daemon-reload
  systemctl --user enable --now codex-pocket-companion.service
  printf '%s\n' 'Linux Companion installed and started.'
  printf '%s\n' 'View the pairing code: journalctl --user -u codex-pocket-companion -n 30'
else
  printf '%s\n' 'Linux Companion built. This session has no systemd user manager.'
  printf 'Start it with: %s/scripts/start-web-pc.sh\n' "$repo_dir"
fi
