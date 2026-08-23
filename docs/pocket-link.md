# PocketLink TLS bootstrap

v2의 첫 PocketLink checkpoint는 Termux 없이 같은 LAN의 Linux Companion에 연결할 수 있는 opt-in
TLS transport다. 기본 `127.0.0.1:8787` Gateway와 Termux/SSH 경로는 rollback adapter로 계속 유지하며,
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
```

`CODEX_POCKET_LINK_HOST`는 listener bind 주소이고 `CODEX_POCKET_LINK_ADVERTISE_HOST`는 Android가 실제로
접속하며 인증서 SAN에 포함된 주소다. private key의 디렉터리·소유자·mode, symlink/hardlink 여부,
certificate/key 일치, 인증서 유효기간과 advertise host를 모두 검증하지 못하면 Companion은 시작하지
않는다. TLS는 1.2 또는 1.3만 사용한다. 방화벽에서는 필요한 신뢰 LAN에서 이 포트만 허용한다.

Companion은 다음 공개 정보만 터미널에 표시한다.

- advertise host와 TLS port
- `sha256/...` SPKI pin
- 기존 10분 유효 8자리 pairing code

private key, bearer token, Provider key와 프로젝트 정보는 출력하지 않는다.

## Android 등록

AI 연결 센터의 `＋ PC`에서 `PocketLink · TLS pin 고정`을 선택하고 Companion이 표시한 host, port와
SPKI pin을 입력한다. 선택적으로 서로 다른 교체용 backup pin도 미리 등록할 수 있다.

- host·port·pin은 WebView/localStorage가 아니라 Android Keystore AES-GCM 설정에 저장한다.
- 암호문은 local port 이름을 AAD로 묶어 다른 등록 항목으로 옮길 수 없다.
- foreground service는 `127.0.0.1:<local-port>`에만 bind하고 최대 8개 연결, 고정 16-thread pool로
  CPU·메모리 폭주를 제한한다.
- remote certificate의 유효기간, HTTPS hostname과 leaf SPKI pin을 모두 확인한다.
- pin 불일치나 설정 손상 때 Termux/SSH로 자동 downgrade하지 않는다.
- Gateway bearer token은 기존처럼 Android 보안 저장소에 두며 Companion에는 hash만 남긴다.

Android target SDK 36에서는 외부 Linux 장치와 지속적인 네트워크 연결이므로 `connectedDevice`
foreground-service type을 사용한다. `dataSync` service는 Android 15+의 시간 제한 대상이라 장시간 SSE
transport에 사용하지 않는다. 관련 기준은 Android 공식 문서의
[foreground service types](https://developer.android.com/develop/background-work/services/fgs/service-types)와
[TLS/SSLSocket 주의사항](https://developer.android.com/privacy-and-security/security-ssl)을 따른다.

## 현재 제한과 다음 단계

이 checkpoint는 수동 LAN bootstrap이며 PocketLink의 최종 완료판이 아니다.

- QR scanning, LAN discovery/P2P와 outbound relay fallback 미구현
- Android 비대칭 device key와 mTLS proof, 기기별 key rotation protocol 미구현
- certificate 교체 UX와 backup pin 승격 미구현
- 부팅 후 자동 복구, Android 계측 기반 CPU·메모리·배터리 release gate 미검증
- 완료·승인·오류 알림 deep link 미구현

따라서 CI에서만 빌드하며 현장 Companion을 재시작하거나 v2 APK를 설치하지 않는다. 위 항목이
완성되고 실제 LAN·네트워크 전환·절전 테스트를 통과할 때까지 Termux/SSH가 검증된 rollback이다.
