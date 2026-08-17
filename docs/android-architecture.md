# Android 앱 구조와 다음 단계

## 현재 구현

Capacitor APK 안에 React 화면을 포함합니다. 앱은 화면을 표시하기 위해 PC나 SSH 연결을 기다리지 않습니다.

앱이 열리면 네이티브 `PocketTunnel` 플러그인이 Termux의 공식 `RUN_COMMAND` 인텐트로 `pc-codex-web start`를 요청합니다. Termux는 기존 SSH 키와 설정을 그대로 사용해 `127.0.0.1:8788`에서 PC의 `127.0.0.1:8787`로 포트 포워딩합니다. 명령은 멱등적이므로 이미 연결된 경우 중복 터널을 만들지 않습니다.

음성 입력은 네이티브 `RecognizerIntent`를 `ko-KR`로 호출합니다. 최종 인식 결과 하나만 React에 반환하므로 브라우저의 누적 중간 결과가 반복되는 문제를 피합니다. 음성 데이터 비용을 부과하는 별도 OpenAI API는 사용하지 않습니다.

```text
Codex Pocket APK
  ├─ React UI (APK 내부 자산)
  ├─ Android 한국어 받아쓰기
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

## 완전 독립형 SSH의 후속 단계

Termux가 전혀 필요 없는 버전은 별도 보안 단계로 진행합니다.

1. 앱 설정 화면에서 호스트, 포트, 사용자, PC 호스트 키 지문을 입력합니다.
2. 개인키는 Android Keystore로 암호화하고 WebView 또는 localStorage에 노출하지 않습니다.
3. SSH 라이브러리를 네이티브 foreground service 안에서 실행하고 로컬 포트 포워딩을 관리합니다.
4. 최초 연결에서 호스트 키 지문을 명시적으로 확인하고 이후 변경을 차단합니다.
5. 네트워크 전환, 절전, 앱 재시작 시 재연결 테스트를 추가합니다.

현재 Termux 연동형은 이미 사용 중인 검증된 SSH 설정과 키를 재사용하므로 첫 APK 버전에 더 안전하고 구현 범위도 작습니다.

## 목표 아키텍처: 연결과 실행의 독립 모듈화

최종 목표는 스마트폰을 PC의 원격 입력기로 축소하는 것이 아니다. PC와 스마트폰이 각각 자기 로컬 프로젝트와 CLI를 실행하며, 앱은 두 실행 대상을 같은 수준으로 선택할 수 있어야 한다.

```text
Codex Pocket UI
  ├─ Local Work Journal (SQLite, offline history and queue)
  ├─ ProviderAdapter
  │    ├─ Codex
  │    └─ Claude Code
  ├─ RuntimeAdapter
  │    ├─ TermuxRuntime             (현재 호환 모듈)
  │    ├─ PocketRuntimeAndroid      (목표: 앱 내 스마트폰 CLI)
  │    └─ PocketCompanionRuntimeLinux (Linux PC CLI)
  └─ TransportAdapter
       ├─ SshTailscaleTransport     (현재 호환 모듈)
       └─ PocketLinkTransport       (목표: 내장 페어링·암호화 연결)
```

`RuntimeAdapter`는 셸·Git·프로세스·CLI·작업공간을 담당하고, `TransportAdapter`는 단말 발견·인증·암호화·재연결만 담당한다. 따라서 Termux 대체 작업과 Tailscale/SSH 대체 작업을 별도 개발·테스트·배포할 수 있다. React UI나 provider 로그인 구현은 특정 런타임 또는 전송 기술에 직접 의존하지 않는다.

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

### PocketRuntimeAndroid 완료 조건

- PC 연결 없이 스마트폰의 실제 프로젝트를 생성·수정·테스트하고 Git 기록을 유지한다.
- 앱이 종료되거나 Android가 백그라운드 프로세스를 회수해도 작업 상태를 복구한다.
- Codex·Claude Code 등 provider CLI의 설치, 계정 연결, 버전 확인과 업데이트를 독립 어댑터로 관리한다.
- 프로젝트 경로와 명령 권한을 제한하며 provider 자격 증명을 WebView나 일반 localStorage에 노출하지 않는다.
- Termux는 필수가 아닌 호환·전환용 런타임으로 남는다.

구현 세부 단계와 최종 완료 기준은 [로드맵](roadmap.md)에 기록한다.
