# Linux PocketLink Wi-Fi Direct group owner

`codex-pocket-p2p`는 Android PocketLink가 같은 LAN이나 인터넷 없이 Linux Companion에 도달하도록
한 번의 제한된 Wi-Fi Direct group-owner 세션을 여는 **별도 foreground 관리자 도구**다. Companion 시작
경로에는 포함되지 않으며 자동으로 무선 설정을 바꾸거나 부팅 시 실행되지 않는다. 현재 v2 CI candidate의
source·fake-control 검증 범위이고 실제 Android/Linux group formation은 release gate에 남아 있다.

## 경계와 사전 조건

- Linux Wi-Fi adapter와 driver가 Wi-Fi Direct/P2P GO를 지원해야 한다.
- `wpa_supplicant`, `wpa_cli`, `iproute2`, `dnsmasq`가 system package로 설치되어 있어야 한다.
- P2P control interface는 `wpa_cli -i <interface> ping`에 응답해야 한다.
- NetworkManager가 해당 control interface를 관리하면 도구는 실패한다. 전용 adapter를 unmanaged로 만든
  뒤 사용한다. 현재 PC 접속에 쓰는 유일한 Wi-Fi interface를 전환하면 원격 연결이 끊길 수 있으므로
  사용하지 않는다.
- 기존 PocketLink Companion은 IPv4 wildcard에 bind되어 있어야 한다.
  `CODEX_POCKET_LINK_HOST=0.0.0.0`이 아니면 시작하지 않는다. TLS certificate hostname, Android에 검토된
  SPKI pin, mTLS device binding은 그대로 사용하며 P2P discovery나 DHCP를 신뢰 기준으로 사용하지 않는다.
- 고정 link subnet `192.168.49.0/24`와 겹치는 주소나 route가 하나라도 있으면 시작하지 않는다.
- network namespace와 Wi-Fi control에 필요한 권한 때문에 이 도구만 root foreground process로 실행한다.
  Companion과 Provider runtime은 일반 사용자로 계속 실행하며 이 도구가 재시작하지 않는다.

## 명시적으로 한 세션 열기

Companion이 이미 위 설정으로 실행 중이고 작업 중인 turn이 없음을 확인한 다음, 별도 PC terminal에서
필요한 공개 설정만 전달한다. Provider key, PocketLink private key, pairing code는 이 프로세스에 전달하지
않는다.

```bash
sudo env \
  CODEX_POCKET_P2P_ENABLE=1 \
  CODEX_POCKET_P2P_INTERFACE=wlan1 \
  CODEX_POCKET_LINK_HOST=0.0.0.0 \
  CODEX_POCKET_LINK_PORT=8789 \
  codex-pocket-p2p
```

선택 설정은 다음 두 개뿐이다.

- `CODEX_POCKET_P2P_ACCEPT_SECONDS`: Android PBC 요청 대기 시간, 30–300초, 기본 120초
- `CODEX_POCKET_P2P_SESSION_SECONDS`: group 최대 유지 시간, 60–14400초, 기본 900초

Android에서는 이 대기 시간 안에 연결 센터의 **Wi-Fi Direct에서 찾기**를 누르고 검토한 Linux 후보를
선택한다. Linux는 첫 유효 PBC peer 하나만 `go_intent=15`로 수락한다. 결과가 Linux `GO`가 아니거나
별도 group interface가 생기지 않으면 group을 제거하고 실패한다. peer MAC, SSID, WPS passphrase는
terminal·Gateway·WebView·파일에 출력하거나 저장하지 않는다.

## 제한된 group network

GO가 된 뒤에만 별도 group interface에 `192.168.49.1/24`를 붙이고 `dnsmasq`를 해당 interface에만
bind한다. DHCP pool은 `192.168.49.2`–`192.168.49.9`, 동시 lease는 1개, lease는 메모리에만 두며 routine
DHCP logging을 끈다. DNS 기능은 port 0으로 끄고 DHCP의 DNS server와 default-router option도 비워
Android의 기존 인터넷 경로를 P2P PC로 바꾸지 않는다. 시스템 dnsmasq 설정은 `/dev/null`로 차단한다.

DHCP 시작 뒤 `192.168.49.1:<CODEX_POCKET_LINK_PORT>` TCP listener가 실제로 열려 있는지 확인한 후에만
ready를 표시한다. 이 확인은 transport reachability뿐이다. 실제 Android 요청은 기존 TLS hostname,
Companion SPKI pin, Android client certificate와 binding을 모두 통과해야 하며 실패해도 SSH나 relay로
인증을 우회하지 않는다.

정상 timeout, Android group 제거, `SIGINT` 또는 `SIGTERM`, 오류 모두 같은 역순 cleanup을 수행한다.

1. scoped `dnsmasq` 종료
2. group interface의 고정 주소 제거
3. 정확히 생성된 P2P group 제거
4. P2P listen/find 중단
5. `wpa_cli` event monitor 종료

강제 종료 뒤에는 다음 실행 전 `ip -4 address`, `ip -4 route`, `wpa_cli interface`로 group이 남지 않았는지
확인한다. 다른 P2P 관리자가 동시에 같은 interface를 다루게 하지 말고, JSONL·PocketLink identity나
Android encrypted config를 cleanup 대상으로 삭제하지 않는다.

## Release acceptance

현재 자동 검사는 합성 wpa event로 PBC→GO→DHCP→Companion 확인→역순 cleanup, Linux가 client가 된 결과,
accept timeout, 비밀 metadata 축소와 dnsmasq argv를 검증한다. 다음 항목은 실제 지원 adapter와 Android에서
수동 통과해야 한다.

1. user-triggered discovery에서 의도한 Linux 이름만 검토하고 다른 peer는 수락하지 않음
2. Linux `GO`, Android client, group owner address `192.168.49.1` 확인
3. Android가 기존 hostname/SPKI/mTLS로 Gateway health와 한 번의 무비용 작업을 완료
4. LAN을 끊은 P2P 고정 경로와 LAN→P2P→relay 자동 경로의 transport-only fallback 확인
5. 잘못된 hostname·SPKI·client identity가 다음 경로로 우회하지 않고 즉시 실패
6. screen-off·network transition·Android process kill 뒤 reconnect, CPU·memory·battery 측정
7. timeout·신호·formation 실패 후 IP, route, DHCP process, P2P group이 모두 제거됨

이 acceptance 전에는 v2 APK를 설치·전달하거나 실행 중인 v1.8.3 Companion을 교체하지 않는다. 현재
v1 후보와 검증된 v1.8.1 rollback을 그대로 보존한다.
