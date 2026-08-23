# PocketLink TLS bootstrap

v2 PocketLink checkpoint는 Termux 없이 같은 LAN의 Linux Companion에 연결할 수 있는 opt-in
mTLS transport다. 기본 `127.0.0.1:8787` Gateway와 Termux/SSH 경로는 rollback adapter로 계속 유지하며,
PocketLink listener는 인증서와 환경 변수를 명시적으로 준비한 경우에만 시작한다.

## Linux Companion 설정

실제 LAN 주소나 내부 DNS 이름을 `<companion-host>` 자리에 사용한다. 개인 네트워크 값과 생성된 key는
저장소, 문서, 이슈 또는 채팅에 올리지 않는다.

```sh
scripts/setup-pocket-link-tls.sh <companion-host> "$HOME/.config/codex-pocket-voice/pocket-link"
```

스크립트는 기존 파일을 덮어쓰지 않고 mode `0700` 디렉터리에 `0600` private key와 `0644` certificate를
만든 뒤 Android에 입력할 `sha256/...` SPKI pin을 출력한다. 출력된 경로를 사용해 Companion 시작 환경에
다음을 추가한다.

```sh
export CODEX_POCKET_LINK_HOST=0.0.0.0
export CODEX_POCKET_LINK_PORT=8789
export CODEX_POCKET_LINK_ADVERTISE_HOST=<companion-host>
export CODEX_POCKET_LINK_CERT_FILE=<private-config-directory>/pocket-link-cert.pem
export CODEX_POCKET_LINK_KEY_FILE=<private-config-directory>/pocket-link-key.pem
# 선택 사항: 같은 LAN에서 주소 검색 허용
export CODEX_POCKET_LINK_DISCOVERY=1
```

`CODEX_POCKET_LINK_HOST`는 listener bind 주소이고 `CODEX_POCKET_LINK_ADVERTISE_HOST`는 Android가 실제로
접속하며 인증서 SAN에 포함된 주소다. private key의 디렉터리·소유자·mode, symlink/hardlink 여부,
certificate/key 일치, 인증서 유효기간과 advertise host를 모두 검증하지 못하면 Companion은 시작하지
않는다. TLS는 1.2 또는 1.3만 사용한다. 방화벽에서는 필요한 신뢰 LAN에서 이 포트만 허용한다.
`CODEX_POCKET_LINK_DISCOVERY`는 생략하거나 `0`이면 꺼지고 정확히 `1`일 때만 DNS-SD 광고를 연다.
광고는 `CODEX_DEVICE_NAME`으로 정한 PC 이름, TLS port와 discovery protocol version `1`만 담는다.
SPKI pin, pairing code, device ID, token, Provider credential과 workspace·project 정보는 광고하지 않는다.

Companion은 다음 공개 정보만 터미널에 표시한다.

- advertise host와 TLS port
- `sha256/...` SPKI pin
- 기존 10분 유효 8자리 pairing code

private key, bearer token, Provider key와 프로젝트 정보는 출력하지 않는다.

대화형 TTY에서는 같은 공개 연결 정보와 기존 10분 pairing code를 `codex-pocket://pair?...` QR로도
표시한다. systemd/log 환경에서는 기본적으로 QR을 출력하지 않는다. 정말 필요한 제어 터미널에서만
`CODEX_POCKET_LINK_SHOW_QR=1`로 강제할 수 있고, `0`은 TTY에서도 QR을 끈다. QR에는 다음 필드만 있다.
QR matrix는 터미널 theme과 무관하도록 ANSI black/white contrast를 명시한다.

- bundle version, advertise host, TLS port와 server SPKI pin
- Companion device ID/name
- 기존 8자리 pairing code와 동일한 만료 시각

Provider credential, Gateway bearer token, Android device private key, workspace·thread·prompt는 QR에
들어가지 않는다. QR도 pairing code와 같은 단기 비밀이므로 사진·로그·이슈에 보관하지 않는다.

## Android 등록

AI 연결 센터의 `＋ PC`에서 `PocketLink QR 스캔`을 누르고 Companion의 QR을 읽는다. 앱은 camera에서
QR_CODE만 읽고 barcode 이미지를 저장하지 않으며 2분 뒤 scanner를 닫는다. QR은 앱 메모리에서만
2,048자로 제한해 파싱하고 version, 중복·알 수 없는 field, host, port, pin, 8자리 code, device와
10분 이내 만료를 모두 검증한다. 등록 전 PC 이름·device ID·만료 시각과 host·port·pin을 다시 보여준다.

카메라가 없거나 QR을 쓰지 않을 때는 `PocketLink · TLS pin 고정`을 선택하고 Companion이 표시한 host,
port와 SPKI pin을 직접 입력할 수 있다. 선택적으로 서로 다른 교체용 backup pin도 미리 등록할 수 있다.

Companion에서 discovery를 켰다면 Android의 `같은 LAN에서 찾기`를 사용해 주소 입력만 줄일 수 있다.
검색은 사용자가 누른 동안 전경에서 8초만 실행되고 최대 16개 후보와 private IPv4 또는 IPv6 ULA만
받는다. 후보는 2분 뒤 만료되며, Android는 광고된 PC 이름·주소·port를 신뢰정보로 저장하지 않는다.
후보를 골라도 pin 입력란은 비워 두고 Companion 터미널에 표시된 `sha256/...` SPKI pin을 별도 경로로
직접 대조·입력해야 한다. 따라서 악성 LAN 광고가 있어도 자동 페어링·연결·SSH fallback은 일어나지
않는다. 발견된 IP가 Companion 인증서 SAN에 없다면 QR 또는 수동 입력으로 인증서의 canonical host를
사용한다.

- host·port·pin은 WebView/localStorage가 아니라 Android Keystore AES-GCM 설정에 저장한다.
- 암호문은 local port 이름을 AAD로 묶어 다른 등록 항목으로 옮길 수 없다.
- 등록 local port별 non-exportable P-256 private key와 self-signed client certificate를
  AndroidKeyStore에 만든다. private key bytes는 Java·WebView·저장소로 내보내지 않는다.
- foreground service는 `127.0.0.1:<local-port>`에만 bind하고 최대 8개 연결, 고정 16-thread pool로
  CPU·메모리 폭주를 제한한다.
- remote certificate의 유효기간, HTTPS hostname과 leaf SPKI pin을 모두 확인한다.
- Companion은 모든 PocketLink TLS 연결에서 client certificate를 요구한다. 최초 Gateway pairing 때
  그 client SPKI pin을 bearer token hash에 결합하고 이후 두 proof가 모두 일치해야 API를 허용한다.
- client certificate 누락·만료·pin 불일치는 401로 거부한다. TLS ticket/session resume을 끄고 매
  연결에서 private-key proof를 새로 확인한다.
- pin 불일치나 설정 손상 때 Termux/SSH로 자동 downgrade하지 않는다.
- Gateway bearer token은 기존처럼 Android 보안 저장소에 두며 Companion에는 hash만 남긴다.
- PocketLink 등록을 삭제하면 암호화 연결 설정과 해당 local-port의 현재·교체 대기 device identity를
  함께 삭제한다.
- QR에서 읽은 host·port·server pin 중 하나를 사용자가 편집하면 QR pairing code를 폐기한다. 연결 후
  `/api/pairing/status`의 실제 Companion device ID가 QR과 달라도 code를 채우지 않는다.

Gateway auth state는 1.8.1 rollback reader가 계속 열 수 있도록 schema version 1을 유지하고 client에
선택적인 TLS pin field만 추가한다. 기존 token hash는 보존하지만 근거 없는 TLS binding을 만들지
않으므로, 이전 토큰을 PocketLink에서 사용하려면 같은 Android device certificate를 제시한 상태로
pairing code를 다시 입력해야 한다. 기존 loopback/SSH rollback 경로에서는 종전 token 동작을 유지한다.

## 서버 인증서 교체

서버 인증서는 기존 pin을 자동으로 바꾸지 않는 단계식 절차로 교체한다. 실제 배포 전 별도 시험
Companion과 Android 기기에서 먼저 검증한다.

1. 현재 certificate/key를 덮어쓰지 말고 새 private directory에 새 certificate/key를 만든다. 출력된 새
   SPKI pin을 PC 화면에서 직접 대조한다.
2. Android AI 연결 센터에서 대상의 `교체 pin 준비`를 열어 새 pin을 저장한다. 이 시점에는 현재 primary
   pin이 계속 기본이고 새 값은 backup으로만 Keystore 암호화 설정에 보관된다. 전환을 취소한다면 같은
   화면의 `준비한 pin 제거`로 backup만 지우고 현재 primary를 유지한다.
3. 통제된 점검 시간에 Companion을 새 certificate/key로 전환한다. Android에서 해당 대상을 실제로
   연결해 HTTPS hostname과 새 backup pin을 포함한 TLS handshake를 성공시킨다. 실패하면 승격하지 않고
   Companion을 이전 certificate/key로 되돌릴 수 있다.
4. 앱이 `새 인증서 확인됨`을 표시한 뒤 2분 안에 `새 pin 교체 검토`를 누르고, 대상·관찰 시각·폐기
   경고를 다시 확인한 다음 `새 pin 확정 · 이전 pin 폐기`를 누른다.
5. native 계층은 같은 local port에서 최근 2분 이내 backup pin TLS 성공을 다시 확인한다. 조건이 맞을
   뿐 아니라 그 뒤 연결 오류가 없을 때만 backup을 primary로 옮기고 backup field와 이전 primary를
   제거한 뒤 forwarder를 다시 시작한다.

승격 전에는 기존/신규 인증서를 모두 pin으로 제한해 받아들이지만, 승격 후에는 이전 인증서가 다시
연결할 수 없다. 성공 기록은 pin 값이 아니라 `primary`/`backup` 슬롯과 관찰 시각만 메모리에 남고 앱
process가 끝나면 사라진다. 시간 만료·hostname 실패·pin 불일치·설정 오류 때 자동 승격하거나
Termux/SSH로 downgrade하지 않는다.

## Android 단말 identity key 교체

Android client identity도 기존 key를 자동으로 덮어쓰지 않는 A/B 슬롯 절차로 교체한다. AI 연결
센터에서 현재 선택되고 이미 페어링된 정확한 PocketLink 대상을 `단말 key 교체`로 검토한 뒤 두 번째
터치에서만 시작한다. 서버 인증서 pin 교체가 진행 중이면 두 절차를 동시에 시작하지 않는다.

1. 현재 bearer token과 현재 Android identity의 실제 mTLS proof가 모두 일치할 때만 Companion이
   5분 유효 1회용 교체 승인을 만든다. 원문 승인은 Android의 Keystore-backed 보안 저장소에만 두고,
   Companion의 mode `0600` auth state에는 SHA-256 hash, 이전 공개 SPKI pin과 만료 시각만 기록한다.
2. Android는 현재 슬롯을 보존한 채 반대 슬롯에 새 non-exportable P-256 key/certificate를 만들고,
   암호화 PocketLink 설정에 pending 슬롯을 기록한 뒤 forwarder를 새 슬롯으로 다시 연다. pending
   상태는 WebView나 앱 process가 종료돼도 남고 private key bytes는 Java·WebView 밖으로 나오지 않는다.
3. 앱은 1회용 승인과 새 certificate의 실제 TLS proof로 Companion 상태를 조회한다. 아직 pending이면
   Companion이 새 SPKI pin을 영속화하고 즉시 이전 certificate를 거부한 뒤 `completed`를 반환한다.
4. 앱은 Companion의 completed metadata 정리를 확인한 다음에만 Android의 이전 Keystore alias를
   삭제하고 pending 슬롯을 현재 슬롯으로 확정한다. 이 순서 때문에 서버 응답 전에는 기존 private
   key를 잃지 않는다.

완료 응답이나 metadata 정리 응답이 유실되면 새 pending key로 상태 조회와 인증된 health 요청을 다시
수행한다. Companion이 이미 새 key만 허용하면 Android가 새 슬롯을 확정하고, 완료 전 5분 승인이
만료됐거나 사용자가 중단하면 Companion의 기존 binding을 확인한 뒤 pending key만 삭제한다. 네트워크
결과가 불확실하면 어느 key도 자동 폐기하지 않고 `단말 key 교체 확인 필요` 상태를 유지한다. 이미
완료된 교체는 중단 요청으로 되돌릴 수 없으며 Termux/SSH나 다른 Provider로 자동 downgrade하지 않는다.

Android target SDK 36에서는 외부 Linux 장치와 지속적인 네트워크 연결이므로 `connectedDevice`
foreground-service type을 사용한다. `dataSync` service는 Android 15+의 시간 제한 대상이라 장시간 SSE
transport에 사용하지 않는다. 관련 기준은 Android 공식 문서의
[foreground service types](https://developer.android.com/develop/background-work/services/fgs/service-types)와
[TLS/SSLSocket 주의사항](https://developer.android.com/privacy-and-security/security-ssl)을 따른다. QR
camera는 Apache-2.0 [ZXing Android Embedded](https://github.com/journeyapps/zxing-android-embedded)의
QR-only capture activity를 사용하며 barcode image output을 끈다.

LAN 광고는 MIT `bonjour-service`를 사용하고 Android 검색은 platform `NsdManager`를 사용한다. 구형
Android에서 mDNS 수신을 위해 `CHANGE_WIFI_MULTICAST_STATE`와 검색 시간에만 유지하는 multicast lock을
사용한다. 현재 target SDK 36은 `INTERNET` 권한으로 같은 LAN 접근이 가능하다. target SDK를 37 이상으로
올릴 때에는 Android의 local-network runtime permission과 system picker 경로를 다시 검토해야 한다.

## 현재 제한과 다음 단계

이 checkpoint는 검토형 같은-LAN 주소 discovery까지 포함하지만 PocketLink의 최종 완료판이 아니다.

- DNS-SD 주소 discovery는 구현됐지만 Wi-Fi Direct 등 P2P와 outbound relay fallback은 미구현
- 서버 인증서 staged pin 교체와 Android client identity A/B 교체는 구현됐지만 실기기·실제 LAN 전환
  acceptance 미검증
- 부팅 후 자동 복구, Android 계측 기반 CPU·메모리·배터리 release gate 미검증
- opt-in 완료·승인·오류 native 알림과 retained operation 열기는 구현됐지만, WebView process 종료 뒤
  독립 background event 수신과 실기기 deep-link acceptance 미검증

따라서 CI에서만 빌드하며 현장 Companion을 재시작하거나 v2 APK를 설치하지 않는다. 위 항목이
완성되고 실제 LAN·네트워크 전환·절전 테스트를 통과할 때까지 Termux/SSH가 검증된 rollback이다.
