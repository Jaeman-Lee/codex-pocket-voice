# Android 앱 구조와 다음 단계

## 현재 구현

Capacitor APK 안에 React 화면을 포함합니다. 앱은 화면을 표시하기 위해 PC나 SSH 연결을 기다리지 않습니다.

앱이 열리면 네이티브 `PocketTunnel` 플러그인이 Termux의 공식 `RUN_COMMAND` 인텐트로 `pc-codex-web start`를 요청합니다. Termux는 기존 SSH 키와 설정을 그대로 사용해 `127.0.0.1:8788`에서 PC의 `127.0.0.1:8787`로 포트 포워딩합니다. 명령은 멱등적이므로 이미 연결된 경우 중복 터널을 만들지 않습니다.

음성 입력은 네이티브 `RecognizerIntent`를 `ko-KR`로 호출합니다. 최종 인식 결과 하나만 React에 반환하므로 브라우저의 누적 중간 결과가 반복되는 문제를 피합니다. 음성 데이터 비용을 부과하는 별도 OpenAI API는 사용하지 않습니다.

v2 개발판의 `PocketJournal` 플러그인은 Keystore가 보호하는 키로 WebView에서 먼저 AES-GCM 암호화한
conversation·queue envelope만 앱 전용 SQLite에 저장합니다. workspace/device 원문은 SQLite index에
넣지 않고 domain-separated SHA-256 값으로 바꿉니다. 기존 IndexedDB/localStorage 자료는 삭제하지 않고
읽을 때 복사하며, v2 현장 승인 전에는 롤백 호환 사본도 함께 갱신합니다.

```text
Codex Pocket APK
  ├─ React UI (APK 내부 자산)
  ├─ Android 한국어 받아쓰기
  ├─ 암호화 WorkJournal SQLite
  └─ Termux RUN_COMMAND (최초 1회 권한)
        └─ pc-codex-web start
             └─ SSH local forward 127.0.0.1:8788 → PC 127.0.0.1:8787
                  └─ Codex app-server
```

## 보안 경계

- Android 앱은 임의 셸 문자열을 전달하지 않고 고정된 `pc-codex-web start`만 실행합니다.
- Termux 외부 명령 실행은 Termux 설정과 Android의 앱별 권한이 모두 허용되어야 합니다.
- API 서버와 SSH 포워딩은 loopback에만 바인딩됩니다.
- APK origin만 읽기 CORS와 쓰기 origin 검사를 통과합니다.
- SSH 개인키와 Codex 인증 정보는 APK나 웹 저장소로 복사하지 않습니다.

## 서명된 앱 업데이트

v2의 `PocketUpdate` 플러그인은 사용자가 Actions 또는 Release에서 받은 전체 ZIP을 Android document
picker로 직접 선택할 때만 동작한다. ZIP은 최상위 6개 파일과 APK 1 GiB·SBOM 64 MiB 등 항목별/전체
상한을 적용해 app-private cache에 새 파일로 푼다. path traversal, 디렉터리, 중복·추가 항목과 unsigned
manifest를 거부한다.

native 검증기는 canonical manifest에 고정된 APK·SBOM SHA-256/크기, `SHA256SUMS`, RSA/ECDSA 분리
서명과 인증서 유효기간을 확인한다. 그 인증서는 현재 설치 앱의 실제 signer와 같아야 하며, ZIP의 APK도
같은 package/signer, manifest와 같은 SemVer/versionCode이고 현재 설치본보다 높은 versionCode여야 한다.
검증된 APK와 random install token은 10분간 app-private cache에만 남고 설치 직전에 APK hash를 다시
계산한다. 사용자가 화면에서 다시 터치해야 `FileProvider` read grant로 Android package installer를
열며, unknown-source 권한과 최종 설치도 시스템 화면에서 별도 승인한다. Activity/process가 회수되면
token과 cache를 폐기하고 다시 조회하거나 ZIP을 선택한다.

공식판 경로도 자동 updater가 아니다. 사용자가 **공식판 조회**를 눌러야 hardcoded public GitHub
저장소의 최신 정식 Release를 한 번 조회하고, 화면에서 version·게시 시각·ZIP 이름·크기·digest를 본 뒤
**다운로드·서명 검증**을 다시 눌러야 전송을 시작한다. native 계층은 1 MiB Release JSON, asset 128개,
정확한 저장소/tag/versioned ZIP/API URL, uploaded/application-zip, bounded 크기와 `sha256:` digest를
요구한다. asset API의 200 stream 또는 최대 3회 302만 처리하고 redirect는 HTTPS
`*.githubusercontent.com`으로 제한한다. 파일은 public Downloads가 아닌 app-private cache에 저장하며
Release digest를 검사한 뒤 위의 signed ZIP verifier로 다시 검증한다. API token·GitHub credential을
사용하거나 저장하지 않으며 앱 시작·주기적·background 조회, 자동 다운로드와 무인 설치는 없다.

## v2 PocketLink TLS bootstrap

v2 개발판은 명시적으로 설정한 경우 Android native foreground service가
`127.0.0.1:<local-port>`를 Companion의 TLS 1.2/1.3 LAN listener로 전달한다. Companion terminal에
표시된 SPKI pin과 host를 사용자가 화면에서 확인하며, 설정은 Android Keystore AES-GCM으로 보호한다.
인증서 유효기간, hostname 또는 기본/교체용 pin 검증이 실패하면 SSH로 자동 우회하지 않는다.

local port별 non-exportable P-256 identity도 AndroidKeyStore에서 만들고 TLS client certificate로
Companion에 개인키 보유를 증명한다. 최초 Gateway pairing은 client SPKI pin과 bearer token hash를
결합하며 이후 PocketLink 요청은 둘이 모두 일치해야 한다. 10분 QR bootstrap도 구현되어 Android의
로컬 QR scanner가 host·port·server pin·device ID와 pairing code를 읽고 검토 후 등록한다. 서버
인증서 교체는 새 backup pin을 먼저 저장하고 실제 backup handshake 성공을 관찰한 뒤에만 두 번의
화면 확인으로 이전 pin을 폐기한다. client-device key 교체는 현재 key의 mTLS proof로 받은 5분 승인을
Keystore-backed 보안 저장소에 두고, 현재 alias를 보존한 채 반대 A/B 슬롯에 새 non-exportable key를
만든다. 새 key의 실제 TLS proof를 Companion이 영속화하고 이전 binding을 거부한 뒤에만 native 계층이
이전 alias를 삭제한다. 암호화 pending 슬롯은 앱 process 회수와 응답 유실 뒤 복구되며, 불확실하면 두
key를 유지하고 SSH로 자동 우회하지 않는다.
같은 LAN 주소 discovery는 사용자가 누를 때만 Android `NsdManager`로 8초 동안 실행한다. native policy가
service type과 TXT version을 exact-match하고 후보를 16개, private IPv4/IPv6 ULA로 제한한 뒤 2분짜리
검토 hint만 WebView에 보낸다. 선택해도 pin은 비워 두므로 Companion 터미널의 SPKI pin을 수동으로
대조해야 하며 자동 페어링·연결·SSH fallback은 없다. 연결 센터에서 direct LAN 또는 outbound relay를
명시 선택할 수 있다. relay endpoint·certificate hostname·SPKI pin·slot·secret은 같은 Keystore
AES-GCM 설정에만 저장한다. native forwarder는 platform CA+hostname+relay pin으로 outer TLS 1.2/1.3을
확인하고 bounded protocol 1 attach 뒤, 그 socket 위에서 Companion pin과 Android client certificate를
다시 검증하는 inner PocketLink mTLS를 연다. status와 로그에는 relay endpoint·slot·secret을 내보내지
않고 실패해도 direct나 SSH로 자동 전환하지 않는다. Wi-Fi Direct 같은 P2P와 실기기 relay acceptance는
아직 구현·검증하지 않았다.
사용자가 연결 센터에서 명시적으로 켜고 Android runtime 권한을 허용하면 `connectedDevice` foreground
service가 최대 8개의 paired loopback Companion에서 notification-only SSE를 구독한다. Companion은 완료·
실패·새 승인에 대해 schema/kind/operation ID/시각과 승인 만료시각만 보내며 프롬프트·경로·응답·도구
세부정보는 native 계층에 전달하지 않는다. bearer token, local port와 cursor는 별도 Android Keystore
AES-GCM state로 보호한다. service는 `START_STICKY`와 `Last-Event-ID`로 WebView process 회수 뒤 복구하되
boot receiver는 등록하지 않는다. 첫 opt-in은 저널의 현재 cursor에서 시작하고 10분보다 오래됐거나 만료된
승인은 최신 16건의 bounded replay 알림에서 제외한다. 앱 화면이 보일 때에는 cursor만 전진해 WebView와 중복 알림을 만들지
않는다. 잠금 화면에는 generic private notification만 표시하며 앱 전용 random action token과 bounded
device/operation ID로 PendingIntent를 검증한다. 탭하면 등록된 Linux PC에서 retained operation을 다시
조회해 일치하는 작업만 연다.
자세한 설정과 보안 경계는
[PocketLink TLS bootstrap](pocket-link.md)에 있다.

## 완전 독립형 SSH의 호환 후속 단계

Termux가 전혀 필요 없는 버전은 별도 보안 단계로 진행합니다.

1. 앱 설정 화면에서 호스트, 포트, 사용자, PC 호스트 키 지문을 입력합니다.
2. 개인키는 Android Keystore로 암호화하고 WebView 또는 localStorage에 노출하지 않습니다.
3. SSH 라이브러리를 네이티브 foreground service 안에서 실행하고 로컬 포트 포워딩을 관리합니다.
4. 최초 연결에서 호스트 키 지문을 명시적으로 확인하고 이후 변경을 차단합니다.
5. 네트워크 전환, 절전, 앱 재시작 시 재연결 테스트를 추가합니다.

현재 Termux 연동형은 이미 사용 중인 검증된 SSH 설정과 키를 재사용하므로 PocketLink field acceptance가
끝날 때까지 rollback adapter로 유지한다. 내장 SSH는 PocketLink와 별개의 고급 호환 transport 후보다.

## 목표 아키텍처: 스마트폰은 저부하 클라이언트

스마트폰의 응답성과 배터리를 보호하기 위해 실제 프로젝트, CLI, 빌드, 테스트와 미디어 분석은 Linux PC에서만 실행합니다. 스마트폰은 화면, 음성 인식, 암호화된 작업 저널과 전송만 담당합니다.

```text
Codex Pocket UI
  ├─ Local Work Journal (SQLite, offline history and queue)
  ├─ ProviderAdapter
  │    ├─ Codex
  │    └─ Claude Code
  ├─ RuntimeAdapter
  │    └─ PocketCompanionRuntimeLinux (Linux PC CLI)
  └─ TransportAdapter
       ├─ SshTailscaleTransport     (현재 호환 모듈)
       └─ PocketLinkTransport       (목표: 내장 페어링·암호화 연결)
```

`RuntimeAdapter`는 Linux PC의 셸·Git·프로세스·CLI·작업공간을 담당하고, `TransportAdapter`는 단말 발견·인증·암호화·재연결만 담당합니다. Termux는 현재 SSH 전송을 시작하는 데만 쓰며 Android에서 Codex나 Node.js 게이트웨이를 실행하지 않습니다.

PC Companion의 공식 실행 환경은 Linux로 한정한다. Windows/macOS용 런타임,
설치 패키지, 프로세스 관리 및 플랫폼별 테스트는 구현하지 않는다. 다만 현재의
`RuntimeAdapter` 경계는 유지한다. 이 경계 자체의 비용은 작고 Linux 구현의 테스트와
교체도 쉬워지기 때문에, 다중 운영체제 지원을 약속하지 않으면서도 구조적 결합을 막는다.

### PocketLinkTransport 완료 조건

- QR 또는 일회용 코드로 PC와 스마트폰을 페어링한다.
- 양쪽 장치가 만든 키로 종단 간 암호화하고 개인키는 Android Keystore와 PC 운영체제 보안 저장소에 둔다.
- 가능한 경우 LAN/P2P 직결을 사용하고, 불가능할 때만 외부로 나가는 암호화 릴레이 연결을 사용한다.
- 장치 해제, 키 교체, 장치 이름 확인, 재연결, 중간자 공격 방지 테스트를 제공한다.
- 사용자는 Tailscale, IP, SSH 키, 포트를 입력하지 않아도 된다.

### Android 저부하 완료 조건

- Android에서 Codex, Node.js 웹 게이트웨이, Git 작업, ffmpeg, Ollama와 모델 가중치를 실행하지 않는다.
- PC가 오프라인이면 요청을 암호화된 대기열에 두고 폰에서 대체 실행하지 않는다.
- 앱이 종료되거나 Android가 백그라운드 프로세스를 회수해도 작업 상태를 복구한다.
- 장시간 연결에서 CPU·메모리·배터리 사용량을 측정하고 회귀 테스트한다.
- Termux는 네이티브 전송 모듈이 완성될 때까지만 SSH 호환 계층으로 남는다.

구현 세부 단계와 최종 완료 기준은 [로드맵](roadmap.md)에 기록한다.
