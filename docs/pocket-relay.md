# PocketLink outbound relay foundation

이 문서는 v2의 **relay broker와 Linux Companion/Android outbound connector checkpoint**를 설명한다.
같은 LAN에 있지 않은 Android와 Companion이 모두 외부 relay로 나가는 연결만 만들 수 있게 하는
기반이다. 현재 v2 APK에는 명시적인 direct/relay 선택과 Keystore-backed 등록 UI가 있지만 실기기·공용
relay acceptance 전이므로 CI와 격리된 개발 환경에서만 사용하고 실행 중인 v1 Companion이나 휴대폰
연결을 교체하지 않는다.

## 데이터 경로

```text
Android local loopback
  └─ PocketLink mTLS client
       └─ pinned TLS connection → relay broker
            └─ opaque inner TLS bytes only
                 └─ outbound Companion connector
                      └─ local PocketLink TLS listener
                           └─ authenticated Gateway
```

relay 바깥쪽 TLS는 slot·secret과 tunnel bytes를 네트워크에서 보호한다. 그 안에서 Android와 Linux
Companion이 기존 PocketLink mTLS handshake를 다시 수행하므로 relay는 Gateway HTTP, bearer token,
prompt, workspace, Provider 응답과 client private key를 복호화할 수 없다. relay가 잘못된 endpoint로
연결해도 Companion server pin과 Android client-certificate proof가 모두 맞지 않으면 Gateway에
접근할 수 없다.

relay 운영자는 outer TLS endpoint이므로 접속 IP, opaque slot, 연결 시각·지속시간과 byte 크기는 볼 수
있다. 이는 애플리케이션 본문 비공개와 별개의 metadata 경계다. broker 자체는 source address, slot,
secret과 tunnel별 시각·크기를 access log로 남기지 않고 집계 counter만 메모리에 유지한다. hosting
provider·방화벽·load balancer의 별도 log와 지역·운영 주체·삭제 정책은 실제 공용 서비스 release gate에서
검토해야 한다.

## Relay broker

`codex-pocket-relay`는 별도 Linux 서비스로 실행한다. 공개 endpoint를 운영하려면 신뢰할 수 있는
TLS certificate와 private key를 준비하고 다음 값을 프로세스 환경에 둔다. 실제 host·파일 경로·pin은
저장소나 이 문서에 기록하지 않는다.

```sh
export CODEX_POCKET_RELAY_LISTEN_HOST=0.0.0.0
export CODEX_POCKET_RELAY_LISTEN_PORT=9443
export CODEX_POCKET_RELAY_CERT_FILE=/private/relay/certificate.pem
export CODEX_POCKET_RELAY_KEY_FILE=/private/relay/private-key.pem

npm run build:server
npm run relay
```

private-key 상위 디렉터리는 `0700`, key는 `0600` 단일-link 일반 파일이어야 한다. broker는 시작할 때
공개 SPKI pin만 출력하고 slot·secret을 설정·저장·로그하지 않는다. protocol 1의 companion/client
등록 frame은 2 KiB로 제한되며 다음 기본 상한을 적용한다.

- TLS 1.2/1.3, session ticket 비활성화, 최대 socket 256개
- ephemeral slot 64개, slot당 대기 Companion socket 4개
- source IP당 동시 socket 16개, 60초 fixed window당 연결 시작 60회·새 slot 8개
- 최대 1,024개 source IP의 현재 window만 메모리에서 추적하고 유휴 window는 제거
- header 10초, 대기 60초, 무활동 tunnel 2분, tunnel lifetime 24시간
- slot은 최소 128-bit, 공유 secret은 최소 256-bit base64url 값
- 틀린 slot과 secret을 같은 `unavailable` 결과로 처리하고 대기 socket을 소비하지 않음

broker 상태는 메모리에만 있으며 재시작하면 모든 대기·활성 tunnel이 닫힌다. Companion과 Android는
bounded backoff로 새 outbound 연결을 만들어야 하며 relay가 실패해도 SSH나 다른 Provider로 자동
전환하지 않는다.

### 공개 endpoint admission control

운영 환경의 정상 NAT 규모와 edge 용량에 맞춰 다음 값을 조정할 수 있다. 모든 값은 양의 정수이고
window는 1초~10분으로 제한된다.

| 환경 변수 | 기본값 | 의미 |
| --- | ---: | --- |
| `CODEX_POCKET_RELAY_RATE_WINDOW_MS` | `60000` | 연결 시작·새 slot fixed window |
| `CODEX_POCKET_RELAY_MAX_CONNECTIONS_PER_IP` | `16` | 한 source IP의 동시 TCP/TLS socket |
| `CODEX_POCKET_RELAY_MAX_CONNECTION_STARTS_PER_IP` | `60` | 한 window의 TCP 연결 시작 횟수 |
| `CODEX_POCKET_RELAY_MAX_NEW_SLOTS_PER_IP` | `8` | 한 window에 처음 만든 opaque slot 수 |
| `CODEX_POCKET_RELAY_MAX_TRACKED_PEERS` | `1024` | 메모리에 유지하는 source IP state 상한 |

IPv4와 IPv4-mapped IPv6는 같은 source로 정규화한다. 기존 slot의 정상 Companion pool과 client attach는
새 slot budget을 소비하지 않으며, slot을 source IP에 영구 결합하지 않아 휴대폰 망 전환과 NAT 변경을
허용한다. 반대로 `X-Forwarded-For`와 PROXY protocol은 신뢰하지 않는다. broker가 직접 outer TLS를
종료해야 하며 TCP proxy 앞에 둘 경우 모든 연결이 proxy IP 하나의 한도를 공유하므로 edge에서도 별도
connection/DDoS 제어가 필요하다. 이 in-process 제한은 단일 source의 socket·handshake·임의 slot 고갈을
줄이는 장치이지 분산 DDoS 방어를 대신하지 않는다.

Linux 운영자는 `SIGUSR1`을 보내 source·slot 식별자가 없는 `slots`, `waiting`, `tunnels`, 현재 연결·추적
peer 수와 누적 accepted/rejected/rate-limited/slot-limited/paired counter를 stderr에서 확인할 수 있다.
counter는 process 재시작 때 초기화되며 broker는 정기적으로 개별 접속 정보를 출력하지 않는다.

### Protocol 1 wire contract

각 outer TLS socket은 LF로 끝나는 exact JSON object 하나로 시작한다. 알 수 없는 field, 2 KiB 초과,
다른 version과 잘못된 base64url 길이는 거부한다.

```json
{"version":1,"role":"companion","slot":"<opaque>","secret":"<shared-secret>"}
{"version":1,"role":"client","slot":"<opaque>","secret":"<shared-secret>"}
```

Companion은 `waiting` 뒤 `paired`를 받고 client는 `paired` 하나를 받는다. `unavailable`과 `rejected`는
모두 연결 종료로 처리하며 credential 존재 여부를 구분하는 사용자 메시지를 만들지 않는다.

```json
{"version":1,"status":"waiting"}
{"version":1,"status":"paired"}
```

양쪽에 `paired`가 기록된 뒤에는 JSON framing을 끝내고 두 TLS socket의 bytes를 그대로 연결한다.
그 첫 payload가 Android가 시작하는 **내부 PocketLink TLS ClientHello**이고, Companion connector는
이를 로컬 PocketLink TLS listener로 전달한다. relay protocol 자체에는 HTTP route, workspace,
operation ID나 bearer token field가 없다.

## Linux Companion connector

slot은 식별용 opaque 값이고 secret은 양 끝만 아는 인증값이다. 예를 들어 private directory에서
다음처럼 생성할 수 있다. 생성된 실제 값과 파일은 Git에 추가하지 않는다.

```sh
install -d -m 700 /private/companion-relay
umask 077
openssl rand -hex 32 > /private/companion-relay/secret
openssl rand -hex 16
```

마지막 명령의 128-bit slot 값을 `CODEX_POCKET_RELAY_SLOT`에 지정하고 secret은 파일 경로로만 전달한다.
Companion의 기존 PocketLink TLS listener도 함께 설정되어 있어야 한다.

```sh
export CODEX_POCKET_RELAY_HOST=relay.example.invalid
export CODEX_POCKET_RELAY_PORT=9443
export CODEX_POCKET_RELAY_SERVER_NAME=relay.example.invalid
export CODEX_POCKET_RELAY_SERVER_PIN='sha256/REVIEWED_RELAY_SPKI_PIN='
export CODEX_POCKET_RELAY_CA_FILE=/private/relay/ca.pem
export CODEX_POCKET_RELAY_SLOT='OPAQUE_128_BIT_SLOT'
export CODEX_POCKET_RELAY_SECRET_FILE=/private/companion-relay/secret
export CODEX_POCKET_RELAY_POOL=4
```

`CA_FILE`은 private CA를 쓸 때만 필요하지만 SPKI pin은 항상 필요하다. Connector는 UI SSE, 선택형
background SSE와 한 번의 API 요청이 겹쳐도 고갈되지 않도록 기본·최대 네 개의 outbound 대기 socket만
유지한다. client가 붙으면 그 socket을 로컬 PocketLink TLS listener에
raw stream으로 연결하고 tunnel이 끝난 뒤 새 대기 socket을 만든다. relay host·slot·secret은 로그에
출력하지 않는다.

## Android enrollment와 nested TLS

Android 연결 센터에서 PocketLink를 고른 뒤 연결 경로를 `직접 LAN`, `Wi-Fi Direct`, `아웃바운드 릴레이`
또는 `자동 · LAN, P2P, 릴레이 순서`로 선택한다. relay 또는 auto 경로에는 다음 두 identity를 별도로
입력·검토한다.

- 내부 Companion: certificate hostname용 host, TLS port, 기본/교체용 Companion SPKI pin
- 외부 relay: 접속 host/port, certificate hostname, relay SPKI pin, opaque slot, 256-bit shared secret

relay host와 certificate hostname은 split DNS나 별도 접속 주소를 지원하기 위해 분리하지만 둘 다
bounded hostname/IP로 검증한다. Android 첫 구현은 platform trust store가 신뢰하는 public CA chain만
허용하고 hostname과 reviewed relay SPKI pin도 함께 요구한다. Node Companion의 선택형 private CA file을
Android UI로 복사하지 않는다.

등록 정보는 기존 AndroidKeyStore AES-GCM key가 보호하는 PocketLink config schema 4에 저장한다. schema
1 direct, schema 2 direct/relay와 schema 3 auto 설정은 기존 의미를 유지한 채 schema 4로 읽힌다.
slot과 secret은 native configuration
call에서만 일시적으로 지나가며 WebView storage, device-target record, status 응답, notification과 로그로
다시 내보내지 않는다. 사용자가 target을 삭제하면 암호문 설정과 해당 P-256 device-key A/B alias를
함께 제거한다.

로컬 browser connection마다 native forwarder는 다음 순서를 지킨다.

1. relay TCP socket에 TLS 1.2/1.3을 열고 platform CA, HTTPS hostname, leaf SPKI pin을 모두 검증한다.
2. 10초 안에 2 KiB 이하의 protocol 1 exact client frame을 보내고 exact `paired` response 하나만 받는다.
   `unavailable`과 `rejected`는 사용자에게 같은 generic 실패로 보이며 내부 TLS 첫 byte는 선행 소비하지
   않는다.
3. paired outer socket 위에 새 `SSLSocket`을 겹쳐 기존 Companion hostname과 primary/backup SPKI pin을
   확인하고 Android Keystore의 non-exportable P-256 client certificate proof를 전송한다.
4. 두 handshake가 모두 성공한 뒤에만 loopback browser bytes를 내부 mTLS로 전달한다. 고정 relay
   경로는 어느 단계든 실패하면 socket을 닫고 direct LAN, SSH 또는 다른 Provider로 전환하지 않는다.

`auto`는 LAN TCP connect가 성립하지 않으면 검토된 P2P peer를, P2P transport도 성립하지 않으면 위 relay
순서를 시도한다. 어느 transport에서든 Companion TLS hostname·SPKI·client certificate 검증이 시작된 뒤
실패하면 다음 경로로 우회하지 않고 즉시 실패한다. LAN/P2P 불통은 각각 30초/60초 cooldown 뒤 다시
우선 확인한다. Android는 P2P group client만 허용하며 Linux group-owner 자동화는 후속 단계다.

Android route status는 configured `direct`/`p2p`/`relay`/`auto`와 마지막으로 mTLS까지 검증된 실제 경로만
반환하고 endpoint·pin·slot·secret은 반환하지 않는다. 서버 pin
승격과 Android client-key A/B rotation은 내부 Companion mTLS 관찰을 기준으로 하므로 relay 경로에서도
기존 복구 순서를 그대로 사용한다.

## 자동 검증과 남은 범위

Node 통합 검사는 서로 다른 relay/Companion/Android test certificate를 만든 뒤 다음을 확인한다.

- private secret·key 파일 권한과 TLS pin 설정이 없으면 시작하지 않음
- 잘못된 secret이 기존 Companion waiter를 소비하지 않음
- IPv4-mapped 주소 정규화, source별 동시 socket·연결 시작·새 slot 상한과 window reset
- 기존 slot 재사용은 새 slot budget을 소비하지 않고 aggregate stats에 제한 결과만 반영됨
- 바깥 relay TLS 안에서 별도의 Android client certificate와 Companion certificate로 mTLS가 성립함
- relay를 통과한 뒤에만 로컬 Companion이 payload를 읽고 응답함
- Android protocol JVM 검사에서 response field 순서/공백 호환, unknown·duplicate·oversize 거부,
  credential 결과 비구분과 내부 TLS ClientHello byte 비소비
- Android source contract에서 public CA+hostname+relay SPKI, inner Companion pin+client identity의 분리,
  Keystore encrypted schema migration과 status credential 비노출

아직 남은 Phase E 범위는 Linux Wi-Fi Direct group-owner advertise/accept 자동화와 실제 두 기기 group
formation, 공용 relay의 외부 edge DDoS·용량·metadata 보존 정책과 실제 부하 검증, Android nested socket의 실기기 네트워크
전환·절전·배터리 acceptance다. 이 항목 전에는 relay를 출시 transport로 간주하지 않고 기존 LAN
PocketLink와 Termux/SSH rollback 경로를 유지한다.
