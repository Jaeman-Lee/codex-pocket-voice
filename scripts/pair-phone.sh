#!/bin/sh
# Pair interactively; do not put the pairing code in arguments, logs, or Git.
set -eu
adb=${XDG_DATA_HOME:-"$HOME/.local/share"}/codex-pocket-voice/test-tools/platform-tools/adb
if [ ! -x "$adb" ]; then
  printf '%s\n' '먼저 sh scripts/setup-phone-adb.sh 를 실행하세요.' >&2
  exit 1
fi
printf '%s\n' 'Android 무선 디버깅 연결' \
  '휴대폰: 개발자 옵션 → 무선 디버깅 → 페어링 코드로 기기 페어링' \
  '이 팝업을 열린 채로 유지하세요. 기본 화면의 주소는 지금 입력하지 마세요.'
read_endpoint() {
  while :; do
    printf '\n%s IP 주소:포트 입력 (6자리 코드 아님): ' "$1" >&2
    IFS= read -r endpoint || return 1
    if python3 -c '
import ipaddress, sys
try:
    host, port = sys.argv[1].strip().rsplit(":", 1)
    ipaddress.ip_address(host.strip("[]"))
    assert port.isascii() and port.isdigit() and 1 <= int(port) <= 65535
except (ValueError, AssertionError):
    sys.exit(1)
' "$endpoint"; then
      printf '%s' "$endpoint"
      return 0
    fi
    printf '%s\n' '주소와 포트를 함께 입력하세요. 예: 192.168.0.10:12345' >&2
  done
}
pairing_endpoint=$(read_endpoint '페어링 팝업의')
if ! python3 - "$adb" "$pairing_endpoint" <<'PY'
import getpass, json, os, re, subprocess, sys
from pathlib import Path
try:
    code = getpass.getpass('휴대폰의 새 6자리 페어링 코드 (입력은 숨김): ')
except (EOFError, KeyboardInterrupt):
    sys.exit(1)
if not re.fullmatch(r'[0-9]{6}', code):
    print('코드는 숫자 6자리여야 합니다.')
    sys.exit(1)
try:
    result = subprocess.run([sys.argv[1], 'pair', sys.argv[2]], input=code+'\n',
                            text=True, capture_output=True, timeout=30)
    message = (result.stdout + result.stderr).replace(code, '[code omitted]')
    ok = result.returncode == 0 and 'Successfully paired' in result.stdout
except subprocess.TimeoutExpired:
    message, ok = '페어링 응답 시간 초과 (30초). 같은 네트워크와 팝업의 새 포트를 확인하세요.', False
if not ok:
    try:
        daemon_log = (Path('/tmp')/f'adb.{os.getuid()}.log').read_text(errors='replace')
        recent = daemon_log.splitlines()[-50:]
        if any(sys.argv[2] in line and 'Connection timed out' in line for line in recent):
            message += '\n기기 주소에 접속하지 못했습니다. PC 유선 랜과 같은 공유기의 Wi-Fi인지 확인하세요.\n'
    except OSError:
        pass
print(message)
state = Path(os.environ.get('XDG_STATE_HOME', str(Path.home()/'.local/state'))) / 'codex-pocket-voice/phone-test'
state.mkdir(parents=True, exist_ok=True, mode=0o700)
safe_message = message.replace(sys.argv[2], '[phone endpoint]')
safe_message = re.sub(r'\b[0-9]{6}\b', '[digits omitted]', safe_message)
with open(state/'last-pairing-result.json', 'w', encoding='utf-8',
          opener=lambda p, f: os.open(p, f, 0o600)) as report:
    json.dump({'paired': ok, 'message': safe_message}, report, ensure_ascii=False)
sys.exit(0 if ok else 1)
PY
then
  printf '\n페어링 실패. 화면의 주소/포트와 유효한 새 코드를 확인하세요. Enter를 누르면 닫힙니다. '
  IFS= read -r ignored
  exit 1
fi
printf '\n페어링 완료. 자동 연결을 확인합니다.\n'
sleep 3
phone_connected() {
  "$adb" devices | awk 'NR > 1 && $2 == "device" { found=1 } END { exit !found }'
}
if ! phone_connected; then
  printf '%s\n' '휴대폰에서 페어링 창을 닫고 무선 디버깅 기본 화면을 보세요.' \
    '기본 화면의 연결 포트는 방금 입력한 페어링 포트와 다를 수 있습니다.'
  connection_endpoint=$(read_endpoint '기본 화면의 연결용')
  "$adb" connect "$connection_endpoint" || true
fi
"$adb" devices -l
if phone_connected; then
  printf '\nADB에 연결된 기기가 확인됐습니다. Enter를 누르면 닫힙니다. '
else
  printf '\n아직 연결되지 않았습니다. 위 오류 문구를 알려주세요 (6자리 코드는 제외). Enter를 누르면 닫힙니다. '
fi
IFS= read -r ignored
