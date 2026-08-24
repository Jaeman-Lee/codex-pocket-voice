#!/bin/sh
set -eu

usage() {
  printf '%s\n' 'Usage: manage-provider-credential.sh set|remove openai|openrouter' >&2
  exit 2
}

[ "$#" -eq 2 ] || usage
action=$1
provider=$2

case "$provider" in
  openai)
    credential_name=openai-api-key
    provider_label=OpenAI
    ;;
  openrouter)
    credential_name=openrouter-api-key
    provider_label=OpenRouter
    ;;
  *) usage ;;
esac
case "$action" in
  set|remove) ;;
  *) usage ;;
esac

config_dir=${XDG_CONFIG_HOME:-"$HOME/.config"}/codex-pocket-voice
credential_dir=$config_dir/credentials.encrypted
archive_dir=$credential_dir/archive
credential_file=$credential_dir/$credential_name.cred
state_file=$credential_dir/$credential_name.state

if LC_ALL=C printf '%s' "$config_dir" | grep -q '[[:cntrl:]]'; then
  printf '%s\n' 'Credential path must not contain control characters.' >&2
  exit 1
fi

for protected_directory in "$credential_dir" "$archive_dir"; do
  if [ -L "$protected_directory" ]; then
    printf '%s\n' 'Credential directories must not be symlinks.' >&2
    exit 1
  fi
done
mkdir -p -- "$credential_dir" "$archive_dir"
for protected_directory in "$credential_dir" "$archive_dir"; do
  if [ -L "$protected_directory" ] || [ ! -d "$protected_directory" ]; then
    printf '%s\n' 'Credential directories must be private regular directories.' >&2
    exit 1
  fi
done
chmod 700 "$config_dir" "$credential_dir" "$archive_dir"

if [ -L "$state_file" ] || { [ -e "$state_file" ] && [ ! -f "$state_file" ]; }; then
  printf '%s\n' 'Existing credential state is not a regular non-symlink file.' >&2
  exit 1
fi

write_state() {
  state_status=$1
  state_generation=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
  case "$state_generation" in
    ????????????????????????????????) ;;
    *) printf '%s\n' 'Could not generate a credential activation ID.' >&2; exit 1 ;;
  esac
  case "$state_generation" in
    *[!0-9a-f]*) printf '%s\n' 'Credential activation ID has an invalid format.' >&2; exit 1 ;;
  esac
  temporary_state=$(mktemp "$credential_dir/.state.XXXXXX")
  printf '%s:%s\n' "$state_status" "$state_generation" > "$temporary_state"
  chmod 600 "$temporary_state"
  mv -- "$temporary_state" "$state_file"
}

archive_existing() {
  if [ ! -e "$credential_file" ] && [ ! -L "$credential_file" ]; then
    return
  fi
  if [ -L "$credential_file" ] || [ ! -f "$credential_file" ]; then
    printf '%s\n' 'Existing encrypted credential is not a regular non-symlink file.' >&2
    exit 1
  fi
  timestamp=$(date -u +%Y%m%dT%H%M%SZ)
  archived_file=$archive_dir/$credential_name.$timestamp.$$.cred
  if [ -e "$archived_file" ] || [ -L "$archived_file" ]; then
    printf '%s\n' 'Could not allocate a unique credential archive name.' >&2
    exit 1
  fi
  mv -- "$credential_file" "$archived_file"
  chmod 600 "$archived_file"
}

if [ "$action" = remove ]; then
  write_state disabled
  if [ ! -e "$credential_file" ] && [ ! -L "$credential_file" ]; then
    printf '%s\n' "$provider_label credential is disabled for new runs; no encrypted file was present."
    printf '%s\n' 'Rerun install-linux-companion.sh before the next service activation.'
    exit 0
  fi
  archive_existing
  printf '%s\n' "$provider_label credential is disabled for new runs and its ciphertext was archived."
  printf '%s\n' 'Rerun install-linux-companion.sh, then restart only after active turns have finished.'
  exit 0
fi

for command in systemd systemd-creds systemd-ask-password; do
  if ! command -v "$command" >/dev/null 2>&1; then
    printf 'Required command is missing: %s\n' "$command" >&2
    exit 1
  fi
done
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

provider_secret=$(systemd-ask-password -n "$provider_label API key")
if [ -z "$provider_secret" ] || [ "${#provider_secret}" -gt 8192 ] \
    || LC_ALL=C printf '%s' "$provider_secret" | grep -q '[[:space:][:cntrl:]]'; then
  provider_secret=
  printf '%s\n' 'API key is empty, too large, or contains whitespace/control characters.' >&2
  exit 1
fi

temporary_dir=$(mktemp -d "$credential_dir/.credential.XXXXXX")
temporary_file=$temporary_dir/$credential_name.cred
cleanup() {
  provider_secret=
  rm -f -- "$temporary_file"
  rmdir -- "$temporary_dir" 2>/dev/null || true
}
trap cleanup EXIT HUP INT TERM

printf '%s' "$provider_secret" \
  | systemd-creds encrypt --user --name="$credential_name" - "$temporary_file"
provider_secret=
chmod 600 "$temporary_file"
encrypted_size=$(stat -c '%s' "$temporary_file")
if [ "$encrypted_size" -le 0 ] || [ "$encrypted_size" -gt 1048576 ]; then
  printf '%s\n' 'systemd-creds returned an empty or oversized encrypted credential.' >&2
  exit 1
fi
systemd-creds decrypt --user --name="$credential_name" "$temporary_file" /dev/null

archived_file=
archive_existing
if ! mv -- "$temporary_file" "$credential_file"; then
  if [ -n "$archived_file" ] && [ -f "$archived_file" ]; then
    mv -- "$archived_file" "$credential_file"
  fi
  printf '%s\n' 'Could not install the encrypted credential; the previous file was restored.' >&2
  exit 1
fi
chmod 600 "$credential_file"
write_state enabled
trap - EXIT HUP INT TERM
rmdir -- "$temporary_dir"

printf '%s\n' "$provider_label encrypted credential was installed and stale activations are blocked."
printf '%s\n' 'Rerun install-linux-companion.sh, then restart only after active turns have finished.'
