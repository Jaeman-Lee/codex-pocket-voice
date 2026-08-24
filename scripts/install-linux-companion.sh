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
encrypted_credential_dir=$config_dir/credentials.encrypted
provider_grade_dir=$config_dir/provider-grades
openai_credential_file=$encrypted_credential_dir/openai-api-key.cred
openrouter_credential_file=$encrypted_credential_dir/openrouter-api-key.cred
openai_state_file=$encrypted_credential_dir/openai-api-key.state
openrouter_state_file=$encrypted_credential_dir/openrouter-api-key.state
projects_home=${CODEX_PROJECTS_HOME:-"$HOME/workspace"}

if LC_ALL=C printf '%s' "$repo_dir$config_dir$systemd_dir$projects_home$provider_grade_dir" | grep -q '[[:cntrl:]]'; then
  printf '%s\n' 'Installation paths must not contain control characters.' >&2
  exit 1
fi

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

mkdir -p "$config_dir" "$systemd_dir" "$projects_home" "$provider_grade_dir"
chmod 700 "$config_dir"
chmod 700 "$provider_grade_dir"
if [ ! -f "$environment_file" ]; then
  umask 077
  {
    printf 'CODEX_PROJECTS_HOME=%s\n' "$projects_home"
    printf 'CODEX_WEB_PORT=%s\n' "${CODEX_WEB_PORT:-8787}"
    printf 'CODEX_DEVICE_NAME=%s\n' "${CODEX_DEVICE_NAME:-Linux PC}"
  } > "$environment_file"
fi

read_credential_state() {
  state_file=$1
  state_label=$2
  if [ ! -e "$state_file" ] && [ ! -L "$state_file" ]; then
    return
  fi
  if [ -L "$state_file" ] || [ ! -f "$state_file" ]; then
    printf '%s credential state must be a regular non-symlink file.\n' "$state_label" >&2
    exit 1
  fi
  state_mode=$(stat -c '%a' "$state_file")
  state_owner=$(stat -c '%u' "$state_file")
  state_size=$(stat -c '%s' "$state_file")
  if [ "$state_owner" != "$(id -u)" ] || [ $((0$state_mode & 077)) -ne 0 ]; then
    printf '%s credential state must be owned by this user with 0600 or 0400 permissions.\n' "$state_label" >&2
    exit 1
  fi
  if [ "$state_size" -le 0 ] || [ "$state_size" -gt 128 ]; then
    printf '%s credential state is empty or oversized.\n' "$state_label" >&2
    exit 1
  fi
  state_value=$(LC_ALL=C cat -- "$state_file")
  state_text_size=${#state_value}
  if [ "$state_size" -ne "$state_text_size" ] && [ "$state_size" -ne $((state_text_size + 1)) ]; then
    printf '%s credential state contains extra data.\n' "$state_label" >&2
    exit 1
  fi
  state_status=${state_value%%:*}
  state_generation=${state_value#*:}
  if [ "${#state_generation}" -ne 32 ]; then
    printf '%s credential state has an invalid generation.\n' "$state_label" >&2
    exit 1
  fi
  case "$state_status:$state_generation" in
    enabled:*|disabled:*) ;;
    *) printf '%s credential state has an invalid status.\n' "$state_label" >&2; exit 1 ;;
  esac
  case "$state_generation" in
    *[!0-9a-f]*) printf '%s credential state has an invalid generation.\n' "$state_label" >&2; exit 1 ;;
  esac
  if [ "$state_value" != "$state_status:$state_generation" ]; then
    printf '%s credential state contains invalid data.\n' "$state_label" >&2
    exit 1
  fi
  printf '%s\n' "$state_status:$state_generation"
}

openai_state=$(read_credential_state "$openai_state_file" OpenAI)
openrouter_state=$(read_credential_state "$openrouter_state_file" OpenRouter)
openai_load=false
openrouter_load=false
for credential_file in "$openai_credential_file" "$openrouter_credential_file"; do
  if [ -e "$credential_file" ] || [ -L "$credential_file" ]; then
    if [ -L "$credential_file" ] || [ ! -f "$credential_file" ]; then
      printf 'Encrypted credential must be a regular non-symlink file: %s\n' "$credential_file" >&2
      exit 1
    fi
    credential_mode=$(stat -c '%a' "$credential_file")
    credential_owner=$(stat -c '%u' "$credential_file")
    credential_size=$(stat -c '%s' "$credential_file")
    if [ "$credential_owner" != "$(id -u)" ] || [ $((0$credential_mode & 077)) -ne 0 ]; then
      printf 'Encrypted credential must be owned by this user with 0600 or 0400 permissions: %s\n' "$credential_file" >&2
      exit 1
    fi
    if [ "$credential_size" -le 0 ] || [ "$credential_size" -gt 1048576 ]; then
      printf 'Encrypted credential must be between 1 byte and 1 MiB: %s\n' "$credential_file" >&2
      exit 1
    fi
  fi
done

if [ -f "$openai_credential_file" ]; then openai_load=true; fi
if [ -f "$openrouter_credential_file" ]; then openrouter_load=true; fi
case "$openai_state" in
  enabled:*)
    if [ "$openai_load" != true ]; then
      printf '%s\n' 'OpenAI credential state is enabled but its encrypted credential is missing.' >&2
      exit 1
    fi
    ;;
  disabled:*) openai_load=false ;;
esac
case "$openrouter_state" in
  enabled:*)
    if [ "$openrouter_load" != true ]; then
      printf '%s\n' 'OpenRouter credential state is enabled but its encrypted credential is missing.' >&2
      exit 1
    fi
    ;;
  disabled:*) openrouter_load=false ;;
esac

if [ "$openai_load" = true ] || [ "$openrouter_load" = true ]; then
  if ! command -v systemd-creds >/dev/null 2>&1; then
    printf '%s\n' 'Encrypted Provider credentials require systemd-creds 256 or newer.' >&2
    exit 1
  fi
  systemd_major=$(systemd --version | awk 'NR == 1 { print $2; exit }')
  case "$systemd_major" in
    ''|*[!0-9]*)
      printf '%s\n' 'Could not determine the installed systemd version.' >&2
      exit 1
      ;;
  esac
  if [ "$systemd_major" -lt 256 ]; then
    printf 'Encrypted user-service credentials require systemd 256 or newer; found %s.\n' "$systemd_major" >&2
    exit 1
  fi
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
  printf 'Environment=CODEX_POCKET_PROVIDER_CREDENTIAL_STATE_DIR=%s\n' "$encrypted_credential_dir"
  printf 'Environment=CODEX_POCKET_PROVIDER_GRADE_DIR=%s\n' "$provider_grade_dir"
  if [ -n "$openai_state" ]; then
    printf 'Environment=CODEX_POCKET_OPENAI_CREDENTIAL_GENERATION=%s\n' "${openai_state#*:}"
  fi
  if [ -n "$openrouter_state" ]; then
    printf 'Environment=CODEX_POCKET_OPENROUTER_CREDENTIAL_GENERATION=%s\n' "${openrouter_state#*:}"
  fi
  if [ "$openai_load" = true ]; then
    printf 'LoadCredentialEncrypted=openai-api-key:%s\n' "$openai_credential_file"
  fi
  if [ "$openrouter_load" = true ]; then
    printf 'LoadCredentialEncrypted=openrouter-api-key:%s\n' "$openrouter_credential_file"
  fi
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
