# Changelog

이 문서는 사용자가 설치할 수 있는 배포판과 개발 중 CI 산출물을 구분한다.

## 2.0.0 development — provider runtime foundation

Update decision: Provider 실행 계약, Gateway 프로토콜과 이후 작업 저널·전송 계층을 확장하는
호환 불가능한 v2 작업이므로 `breaking`으로 분류하고 `2.0.0`/Android `versionCode 20000`으로
올린다. 구현 대상은 `feature/v2-control-plane` 브랜치이다. 아직 2.0 APK를 현장 전달하지 않으며
1.8.2를 current v1 후보, 1.8.1을 검증된 rollback 세트로 유지한다. 최초 2.0 candidate를 설치할
때도 1.8.1 rollback을 보존한다.

- Codex 실행·취소·stream event를 Provider 공통 runtime 계약 뒤로 이동했다.
- Provider capability를 streaming, 승인, workspace 읽기·쓰기, 명령 실행과 사용량 기록까지 확장했다.
- Gateway protocol 3을 추가하면서 protocol 2 Companion과 클라이언트가 공존할 수 있는 범위 협상을
  유지했다.
- `RunCoordinator`가 실행 상태, 취소, Provider event 범위와 재시도 request ID를 한 곳에서 관리해
  응답 유실 뒤 같은 프롬프트가 중복 실행되지 않게 했다.
- `ToolBroker`와 `ApprovalBroker`의 로컬 정책 계약을 추가했다. 고위험·외부 효과 승인은 터치 확인만
  허용하고, 만료되거나 오프라인인 요청을 자동 승인하지 않는다.
- 세션 인계를 프로젝트·대화별로 격리하고, 다른 프로젝트의 인계 세션이 현재 프로젝트처럼 보이던
  문제를 수정했다. v1 단일 handoff 상태는 손실 없이 다중 상태로 마이그레이션한다.
- Codex 원본 notification과 OpenAI SSE를 `output.delta`, `tool.started`, `workspace.diff`,
  `usage.updated` 등 공통 이벤트로 즉시 정규화하고 기존 Codex 모바일 이벤트 호환은 유지한다.
- 공식 OpenAI JavaScript SDK로 server-only API key, `0600` key 파일, 명시적 모델 허용 목록,
  `store:false` chat-only streaming, 이미지 입력, 사용량·중단·timeout과 오류 redaction을 구현했다.
- 공개 검사는 실제 유료 AI 요청 없이 가짜 OpenAI stream과 Models 목록만 사용한다. OpenAI API
  모드의 workspace 읽기·쓰기·명령·대화 재개는 Tool Broker와 durable journal 전까지 비활성화한다.
- 이 기준선은 CI·개발용이며 v1.8.1 설치본이나 실행 중인 Companion을 교체하지 않는다.

## 1.8.2 hotfix candidate — project-scoped session handoff

Update decision: 다른 프로젝트의 인계 세션과 실행이 현재 프로젝트의 세션 종료·반납 대상으로
보이는 버그 수정이므로 `patch`/`1.8.2`, Android `versionCode 10802`로 분류했다. 서명 APK는
hotfix PR #4의 Actions 후보로 준비했으며, 1.8.1을 rollback으로 보존한다. 설치와 Companion
재시작은 사용자 확인 전에는 수행하지 않는다.

## 1.8.1 patch candidate — mobile viewport containment

Update decision: 스마트폰 화면을 넘는 레이아웃을 고치는 버그 수정이므로
`patch`로 분류하고 `1.8.1`/Android `versionCode 10801`로 올린다. 현재 Draft PR의
`agent/react-capacitor-android` 브랜치에서 검증한다. `1.8.1`을 새 current APK
candidate로 두고, 검증된 `1.7.4`를 rollback 세트로 유지하며, `1.8.0` candidate는
설치 혼동이 없도록 superseded 보관 대상으로 전환한다.

- 앱 셸·상단·대화·입력 영역이 스마트폰 뷰포트보다 커지지 않도록 폭과 높이를 제한했다.
- 좁은 화면과 큰 글자 설정에서 하단 도구가 줄바꿈되고 입력 영역이 내부 스크롤되도록 수정했다.
- Android 키보드가 열리면 WebView가 남은 화면에 맞게 조절되며, 필요할 때 핀치 줌으로 축소·확대할 수 있다.
- Node 20/22와 Android 서명 APK CI가 커밋 `c5563ec`에서 통과했다.

## 1.8.0 candidate — superseded feature baseline

GitHub Release나 Git tag로 확정하지 않았으며, `1.8.1` candidate에 포함된 기능 기준선이다.

- 현재 기기의 Codex thread를 삭제하지 않고 다른 기기에 반납하는 UX를 추가했다.
- 실행 중인 PC 작업은 반납 후에도 계속되며, 다른 페어링 기기가 같은 run과 thread에 다시 붙는다.
- Companion이 최근 인계 위치를 권한 `0600` 메타데이터로 7일간 보존한다. 프롬프트 본문과 인증정보는 기록하지 않는다.
- 이 기기에만 남은 프롬프트 대기열이 있으면 반납을 차단해 요청 유실을 막는다.
- 앱 재연결 시 선택 중인 thread의 활성 run을 찾아 실시간 상태를 복원한다.
- Codex app-server 생성 바인딩을 `codex-cli 0.148.1` 기준으로 갱신했다.

## 1.7.4 candidate — superseded field baseline

GitHub Release나 Git tag로 확정하지 않은 이전 시험 기준선이다.

- Android를 음성·화면·암호화 연결에 집중한 저부하 Linux 클라이언트로 정리했다.
- 여러 Linux Companion 등록, 일회용 코드 페어링, Android Keystore 토큰 보호를 추가했다.
- 대화와 프롬프트 대기열을 AES-GCM으로 암호화하고 오프라인 복구를 강화했다.
- Codex provider, 모델, 추론 성능, 프로젝트 생성과 실행 중 프롬프트 예약을 모듈화했다.
- ffmpeg와 로컬 Qwen3-VL 4B 영상 분석의 재시작 복구·보존 정책을 추가했다.
- Linux 설치 진단, Node 20/22 CI, Android 서명·체크섬·SBOM 산출물을 추가했다.
- 프로젝트 생성 실패를 대화상자 안에 표시하고 구형 Git에서도 `main` 브랜치를 만든다.
- AI 연결 센터가 작은 Android 화면 안에서 내부 스크롤되도록 수정했다.

Candidate build history:

| Version | Commit | Status | Purpose |
| --- | --- | --- | --- |
| 1.7.0 | `5b6a9a7` | CI only | Linux P0–P2 일반화 기준선 |
| 1.7.1 | `d4de07a` | CI only | Android 저부하 클라이언트 고정 |
| 1.7.2 | `2a3348c` | superseded field build | 프로젝트 생성 오류 표시 |
| 1.7.3 | `c6b0440` | CI only | 연결 센터 모바일 레이아웃 수정 |
| 1.7.4 | `91f27b4` | superseded field build | 구형 Git 프로젝트 생성 호환 |
| 1.8.0 | `5c4d0bb` | superseded candidate | 교차 기기 세션 인계와 순차 배포 호환 |
| 1.8.1 | `c5563ec` | rollback candidate | 스마트폰 뷰포트 수용과 조절 가능한 WebView |
| 1.8.2 | `d76e478` | current install candidate | 프로젝트별 세션 인계와 종료 대상 격리 |

## 1.6.0 — 2026-08-16

- 단말·프로젝트·대화별 오프라인 작업 저널과 프롬프트 대기열을 처음 배포했다.
- Git tag와 GitHub Release: `v1.6.0`.

## 1.5.0 — 2026-08-16

- Codex·Claude Code 설치, 로그인 상태와 무료 연결 테스트를 한 화면에 모은 AI 연결 센터를 처음 배포했다.
- Git tag와 GitHub Release: `v1.5.0`.

## Early Android builds — 2026-08-11 to 2026-08-16

- React/Capacitor 앱, 연속 음성 입력, 미디어 첨부, 고정 Android 서명, 단말·모델 선택과 프롬프트 대기열을 순차 개발했다.
- `v1.1`–`v1.4` 이름의 APK는 Actions 시험 산출물이었으며 Git tag나 GitHub Release가 아니다.
- 당시 `package.json`은 계속 `0.1.0`이었으므로 APK 표시 이름을 정식 소프트웨어 버전으로 해석하지 않는다.
