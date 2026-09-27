# Changelog

이 문서는 사용자가 설치할 수 있는 배포판과 개발 중 CI 산출물을 구분한다.

## 1.8.4 hotfix candidate — distinguish Companion and external CLI writers

Update decision: 1.8.3의 세션 반납 화면이 Companion app-server writer와 별도
Codex CLI/TMUX writer의 소유 범위를 구분하지 않아, 사용자가 반납 성공 뒤 터미널에서
같은 thread를 바로 재개할 수 있다고 오인하게 만든 버그이므로 `patch`로 분류한다.
버전은 `1.8.4`/Android `versionCode 10804`, 대상은
`hotfix/1.8.4-external-writer-clarity` 브랜치이다. 검증된 1.8.4 산출물이 생기기 전에는
1.8.3 staged APK를 보존하고, 이후 1.8.4가 이를 대체하면 1.8.3은 복구 가능한 archive로
옮긴다. Android current 1.8.2와 rollback 1.8.1은 그대로 유지한다. 실행 중 Linux
Companion 1.8.3은 재시작하거나 작업 디렉터리를 변경하지 않는다.

- 반납 확인 화면에 선택한 프로젝트의 정확한 경로와 전체 Codex thread ID를 표시한다.
- 기능 이름을 `Companion 연결 반납`으로 좁히고 별도 Codex CLI/TMUX를 종료하지 않는다고 명시한다.
- 서버 응답은 `threadUnsubscribeStatus`와 함께 writer 해제 범위가 Companion뿐이며 외부 CLI
  writer를 관리하지 않는다는 기계 판독 필드를 제공한다.
- 성공 안내는 Companion writer가 실제로 `unsubscribed`됐는지, 실행 완료 뒤 해제 예정인지,
  Companion이 해당 writer를 소유하지 않았는지를 구분한다.
- 새 APK 설치, Companion 재시작, 활성 Codex/TMUX 종료는 이 변경에서 수행하지 않는다.
- 커밋 `814dd10`의 Node 20/22와 Android stable APK CI가 모두 통과했다. Actions run
  `32707398520`은 stable key 서명 APK·SHA256SUMS·SBOM을 CI-only artifact로 만들었으며,
  로컬에 내려받거나 current/rollback/staged 설치 세트를 교체하지 않았다.

## 1.8.3 hotfix candidate — release handed-off thread writers

Update decision: 사용자가 세션을 반납한 뒤에도 Companion의 app-server가 writer lock을
유지해 PC의 `codex resume`를 막는 연결 장애 수정이므로 `patch`로 분류하고
`1.8.3`/Android `versionCode 10803`으로 올린다. 대상은
`hotfix/1.8.3-writer-release` 브랜치이다. 새 APK는 CI 검증 전까지 배포하지 않고,
기존 1.8.2 current 후보와 사용자 검증 1.8.1 rollback APK를 모두 보존한다. 최초
1.8.3 현장 설치 후에는 1.8.2를 rollback으로 두고 1.8.1은 복구 가능한 archive로
이동한다. 실행 중 Companion은 활성 Codex turn이 없고 사용자가 확인한 뒤에만 재시작한다.

- idle 세션 반납 시 정확한 Codex thread에 `thread/unsubscribe`를 호출한 뒤 handoff를 기록한다.
- 실행 중 세션 반납은 turn을 끊지 않고, 완료·실패 후 handoff가 그대로일 때 writer를 반환한다.
- 다른 workspace/thread의 handoff에는 영향을 주지 않으며, 반환 실패 시 기존 handoff와 세션을 보존한다.
- PC Codex CLI `0.149.0` 기준으로 app-server TypeScript 바인딩을 재생성하고 실제
  app-server에서 존재하지 않는 thread의 안전한 unsubscribe 응답을 검증한다.
- 커밋 `e0f6ea1`의 Linux Node 20/22와 Android stable APK CI가 통과했다. Actions run
  `32671707088`의 서명 APK·SHA256SUMS·SBOM을 PC의 별도 1.8.3 candidate 폴더에 내려받아
  SHA-256을 확인했으며, 현재 1.8.2와 rollback 1.8.1 세트는 변경하지 않았다.

## 1.8.2 hotfix candidate — project-scoped session handoff

Update decision: 다른 프로젝트의 인계 세션과 실행이 현재 프로젝트의 세션 종료·반납 대상으로
보이는 버그 수정이므로 `patch`로 분류하고 `1.8.2`/Android `versionCode 10802`로 올린다.
대상은 `hotfix/1.8.2-session-scope` 브랜치이다. 1.8.2를 현장 전달하기 전에는 1.8.1을
current로 유지하고, 전달할 때 1.8.1을 rollback으로 승격하며 1.7.4는 복구 가능한 archive로
옮긴다. 실행 중인 Companion은 명시적 확인 없이 재시작하지 않는다.

- 세션 인계를 프로젝트·대화별로 분리하고 현재 프로젝트와 일치하는 인계만 화면에 표시한다.
- 중단·반납 대상 실행이 현재 workspace와 conversation에 속하는지 다시 검사한다.
- 기존 단일 handoff 상태를 손실 없이 다중 상태로 이전하고, 이어받은 handoff는 서버에서도 정리한다.
- 커밋 `676e1ef`의 서명 APK와 SHA256SUMS, SBOM을 Actions run `32648034017`에서
  다시 내려받아 체크섬을 검증하고 1.8.2 current 설치 후보로 복원했다. APK 바이트는
  기존 `d76e478` 실행의 1.8.2 코드와 같으며, 1.8.1은 rollback 세트로 보존했다.

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
| 1.8.2 | `d76e478` | preserved current candidate | 프로젝트별 세션 인계와 종료 대상 격리 |
| 1.8.3 | `e0f6ea1` | staged install candidate | 반납한 thread의 app-server writer 반환 |
| 1.8.4 | `814dd10` | CI-only signed candidate | Companion writer와 외부 CLI/TMUX writer 범위 구분 |

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
