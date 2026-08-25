#!/bin/sh
set -eu

if [ "$#" -ne 2 ]; then
  echo "usage: setup-pocket-link-tls.sh <advertise-host> <private-config-directory>" >&2
  exit 2
fi

advertise_host=$1
config_directory=$2
case "$advertise_host" in
  *[!A-Za-z0-9.:-]*|'')
    echo "advertise-host must be an IP address or DNS hostname" >&2
    exit 2
    ;;
esac
if [ "$config_directory" = "/" ]; then
  echo "refusing to use the filesystem root as a key directory" >&2
  exit 2
fi
if ! command -v openssl >/dev/null 2>&1; then
  echo "OpenSSL is required to create the PocketLink TLS identity" >&2
  exit 1
fi

umask 077
mkdir -p -- "$config_directory"
directory_mode=$(stat -c '%a' -- "$config_directory")
if [ "$directory_mode" != "700" ]; then
  echo "PocketLink key directory must have mode 0700: $config_directory" >&2
  exit 1
fi

certificate_file=$config_directory/pocket-link-cert.pem
private_key_file=$config_directory/pocket-link-key.pem
if [ -e "$certificate_file" ] || [ -e "$private_key_file" ]; then
  echo "PocketLink certificate or key already exists; rotate it explicitly instead of overwriting" >&2
  exit 1
fi

temporary_directory=$(mktemp -d "$config_directory/.pocket-link.XXXXXX")
cleanup() {
  rm -f -- "$temporary_directory/cert.pem" "$temporary_directory/key.pem"
  rmdir -- "$temporary_directory" 2>/dev/null || true
}
trap cleanup EXIT HUP INT TERM

case "$advertise_host" in
  *:*) subject_alt_name="IP:$advertise_host" ;;
  *[!0-9.]*) subject_alt_name="DNS:$advertise_host" ;;
  *) subject_alt_name="IP:$advertise_host" ;;
esac

openssl req -x509 -newkey rsa:3072 -sha256 -nodes -days 397 \
  -subj "/CN=$advertise_host" \
  -addext "subjectAltName=$subject_alt_name" \
  -addext "keyUsage=digitalSignature,keyEncipherment" \
  -addext "extendedKeyUsage=serverAuth" \
  -keyout "$temporary_directory/key.pem" \
  -out "$temporary_directory/cert.pem" >/dev/null 2>&1

chmod 600 "$temporary_directory/key.pem"
chmod 644 "$temporary_directory/cert.pem"
mv -- "$temporary_directory/key.pem" "$private_key_file"
mv -- "$temporary_directory/cert.pem" "$certificate_file"

public_key_pin=$(openssl x509 -in "$certificate_file" -pubkey -noout \
  | openssl pkey -pubin -outform DER 2>/dev/null \
  | openssl dgst -sha256 -binary \
  | base64 | tr -d '\n')

echo "PocketLink TLS identity created. Keep the private key on this Linux PC."
echo "CODEX_POCKET_LINK_ADVERTISE_HOST=$advertise_host"
echo "CODEX_POCKET_LINK_CERT_FILE=$certificate_file"
echo "CODEX_POCKET_LINK_KEY_FILE=$private_key_file"
echo "PocketLink SPKI pin: sha256/$public_key_pin"
