# Deployment inventory

Last verified: 2026-08-24 KST

이 문서는 공개 가능한 배포 기준선만 기록한다. 사용자명, 파일 절대 경로, 네트워크 주소,
기기 ID, 인증 토큰, 페어링 코드는 기록하지 않는다.

## Current candidate and deployed baseline

V2 development decision: Provider 공통 실행 계층, API Provider, 작업 저널과 Gateway protocol을
확장하므로 `breaking`/`2.0.0`으로 분류한다. 대상은 `feature/v2-control-plane` 브랜치이며 첫
단계에서는 Codex 실행을 공통 runtime 뒤로 옮기되 운영 중인 v1.8.1 설치와 Companion을 교체하지
않는다. 2.0 APK는 현장 전달 전까지 CI-only artifact로 취급한다. v1.8.2를 current 설치 후보,
v1.8.1을 검증된 rollback 세트로 유지하고, 첫 2.0 candidate를 설치할 때도 1.8.1을 rollback으로 둔다.

| V2 development component | Version / revision | State |
| --- | --- | --- |
| Source version | `2.0.0` / Android `versionCode 20000` | development only; not field installed |
| Target branch | `feature/v2-control-plane` | approved API tools, encrypted journals, workspace JSON export/protected delete, dashboard, approval inbox and live branch/worktree identity implemented; model eval and broader patch workflow next |
| Gateway protocol | maximum 3, minimum 2 | v1 rollout compatibility retained |
| Codex app-server schema | `codex-cli 0.149.0` | generated bindings and no-model real integration verified |
| Current v1 APK | 1.8.2 candidate | signed APK/checksum/SBOM prepared from hotfix PR #4; install not performed |
| Existing rollback APK | 1.8.1 | user-validated APK and running Companion preserved |
| OpenAI API milestone | official SDK 6.49.0 | fake stateless tool-loop/SSE/Models tests only; no API key configured and no paid request sent |
| OpenRouter milestone | Chat Completions + Models HTTP API | fake strict-routing/tool-loop/SSE tests only; no API key configured and no paid request sent |
| Android journal milestone | app-owned SQLite schema 1 | encrypted snapshot migration and rollback mirror implemented; CI-only, no device migration performed |
| Companion event journal | encrypted SQLite schema 1 | restore/replay/unknown acknowledgement, policy summary, bounded workspace JSON export and protected delete implemented; no field restart performed |
| Operations dashboard | protocol 3 capability | per-project run snapshot, replay reconciliation, touch-only approvals and two-touch history deletion implemented; no field APK handed off |
| Approved API tools | SHA-bound text replace + probed sandbox verifier | existing file only; check/test/build only; arbitrary command, create/delete/rename and network blocked |
| Workspace/session identity | live catalog + per-run Git identity snapshot | dashboard and handoff show exact path; encrypted journal retains run branch; cross-project thread run/release/claim rejected |
| PocketLink TLS bootstrap | opt-in LAN mTLS + Android server/client SPKI binding | manual host/port/pin registration and Keystore P-256 device proof implemented; QR/relay/rotation and field validation pending |

Read-only tool checkpoint decision: 기존 v2 Provider/Gateway 계약에 새 사용자 기능을 추가하는 2.0
범위이므로 분류와 버전은 `breaking`/`2.0.0`, 대상 브랜치는 `feature/v2-control-plane`을 유지한다.
이 checkpoint에서 Android versionCode 20000은 바꾸지 않고 APK를 현장 전달하지 않는다. current
설치 후보 1.8.2와 검증된 rollback 1.8.1 세트를 그대로 보존한다.

OpenRouter checkpoint decision: 새 Provider 실행·모델 catalog·비용 기록을 추가하는 v2 기능이므로
기존 `breaking`/`2.0.0`, Android `versionCode 20000`, `feature/v2-control-plane` 결정을 유지한다.
개발 source와 CI-only Android artifact만 갱신하고 APK를 현장 전달하거나 Companion을 재시작하지
않는다. current v1 APK 1.8.2와 rollback 1.8.1은 변경하지 않는다.

Native SQLite journal checkpoint decision: Android 저장 backend와 v1 journal migration을 추가하는
v2 기능이므로 기존 `breaking`/`2.0.0`, Android `versionCode 20000`,
`feature/v2-control-plane` 결정을 유지한다. 이 checkpoint의 APK는 CI-only이며 기기에 설치하거나
기존 앱 데이터를 migration하지 않는다. current v1 APK 1.8.2와 rollback 1.8.1을 그대로 보존한다.

Companion event replay checkpoint decision: 새 server storage와 재연결 protocol 동작을 추가하는 v2
기능이므로 기존 `breaking`/`2.0.0`, Android `versionCode 20000`,
`feature/v2-control-plane` 결정을 유지한다. 공개 검사는 임시 0600 key/SQLite와 가짜 run만 사용한다.
APK를 현장 전달하거나 실행 중인 Companion을 재시작하지 않으며 current v1 APK 1.8.2와 rollback
1.8.1을 그대로 보존한다.

Operations dashboard checkpoint decision: 프로젝트별 run 추적, approval API와 모바일 검토 흐름을
추가하는 v2 기능이므로 기존 `breaking`/`2.0.0`, Android `versionCode 20000`,
`feature/v2-control-plane` 결정을 유지한다. 이 checkpoint는 source/CI 전용이며 APK를 현장 전달하거나
실행 중인 Companion을 재시작하지 않는다. current v1 후보 1.8.2와 검증된 rollback 1.8.1은 그대로
보존한다.

Approved API tool checkpoint decision: 기존 텍스트 파일 한 개의 검토된 교체와 격리된 npm 검증을
OpenAI/OpenRouter run에 추가하는 v2 기능이므로 `breaking`/`2.0.0`, Android `versionCode 20000`,
`feature/v2-control-plane` 결정을 유지한다. 실제 API key나 유료 inference를 사용하지 않고 fake Provider와
로컬 namespace sandbox로 검증한다. 이 checkpoint도 CI-only이며 APK 전달·설치나 Companion 재시작 없이
current v1 후보 1.8.2와 rollback 1.8.1을 보존한다.

Workspace identity checkpoint decision: 프로젝트·세션의 현재 branch/worktree 정체성과 교차 프로젝트
thread 검증을 추가하는 v2 기능이므로 분류와 버전은 `breaking`/`2.0.0`, Android `versionCode 20000`,
대상 브랜치는 `feature/v2-control-plane`을 유지한다. 이 변경도 CI-only이며 새 APK를 전달·설치하거나
실행 중인 Companion을 재시작하지 않는다. current v1 후보 1.8.2와 rollback 1.8.1을 그대로 보존한다.

Companion journal management checkpoint decision: 프로젝트별 실행 기록 내보내기와 삭제를
추가하는 v2 기능이므로 기존 `breaking`/`2.0.0`, Android `versionCode 20000`,
`feature/v2-control-plane` 결정을 유지한다. 내보내기는 paired 클라이언트에 해당 workspace의
복호화된 기록만 JSON으로 전달하고 16 MiB로 제한한다. 삭제는 두 번의 화면 터치와 정확한 경로 확인
후에만 수행하고 active/미확인 작업을 보호한다. 프로젝트 파일과 Android local journal은 바꾸지 않는다.
이 checkpoint도 CI-only이며 APK를 전달·설치하거나 실행 중인 Companion을 재시작하지 않는다.
current 1.8.2 후보와 rollback 1.8.1을 보존한다.

PocketLink TLS bootstrap checkpoint decision: Termux 없이 연결하는 새 user-visible transport와 선택적
LAN server listener를 추가하는 v2 기능이므로 분류와 버전은 기존 `breaking`/`2.0.0`, Android
`versionCode 20000`, 대상 브랜치는 `feature/v2-control-plane`을 유지한다. 이번 단계는 수동
host/port/SPKI pin bootstrap만 구현하며 QR, 비대칭 device key/mTLS, relay, 자동 key rotation과 실기기
background 계측은 남아 있다. source와 CI-only APK만 갱신하고 현장 APK를 전달·설치하거나 실행 중인
Companion을 재시작·LAN에 노출하지 않는다. current v1 후보 1.8.2와 검증된 rollback 1.8.1,
Termux/SSH transport를 그대로 보존한다.

PocketLink device-proof checkpoint decision: Android non-exportable asymmetric identity와 Companion의
client-certificate/bearer 결합을 추가하지만 v2 전송 계약의 호환 범위 안이므로 분류와 버전은 기존
`breaking`/`2.0.0`, Android `versionCode 20000`, 대상 브랜치는 `feature/v2-control-plane`을 유지한다.
이 identity는 local port별 AndroidKeyStore P-256 key이고 삭제 시 해당 등록과 함께 해제한다. v1 auth
state는 token hash를 보존하고 TLS binding을 만들지 않으며, additive client field를 구버전이 무시할 수
있도록 schema version 1을 유지한다. source와 CI-only APK만 갱신하며 현장 설치·Companion 재시작·LAN
노출은 하지 않는다. current 1.8.2, rollback 1.8.1과 Termux/SSH transport를 그대로 보존한다.

Update decision: `1.8.0`은 새 교차 기기 세션 흐름과 Companion API를 추가하므로
`feature`/minor 변경이다. Draft feature PR에서 유지하고 현장 승인 전에는 `main`에 병합하지
않는다. `1.8.0`은 최초 feature candidate였으며, 아래의 `1.8.1` viewport patch가
이 기준선을 포함해 supersede한다.

Workspace migration decision: Linux PC의 Git clone을 유일한 주 개발 작업공간으로 사용한다.
이 변경은 배포 코드나 APK를 바꾸지 않는 운영 변경이므로 SemVer는 올리지 않으며 current
`1.8.0`과 rollback `1.7.4`도 교체하지 않는다. Termux checkout은 APK 설치·실기기 검증,
터널 복구와 체크섬 확인을 위한 경량 제어 사본으로만 유지한다.

Companion field-test rollout decision: 2026-08-23에 기존 `1.8.0` feature/minor
candidate를 `agent/react-capacitor-android` 브랜치의 Linux PC Git clone에서 실행했다.
이 전환은 이미 기록한 candidate의 운영 배포이므로 SemVer를 올리지 않고,
Android APK는 `1.8.0` current와 `1.7.4` rollback 세트를 그대로 보존한다. 타입
검사, 빌드, 단위 테스트 16개, 실제 app-server 통합 테스트 3개와 페어링
유지를 확인한 뒤 전환했다. 기존 `1.7.4` 실행 폴더는 복구 가능한 휴지통으로
이동했고, Companion rollback snapshot은 별도로 보존했다.

Mobile viewport patch decision: 스마트폰 화면을 넘는 레이아웃은 버그이므로
`patch`로 분류하고 `1.8.1`/Android `versionCode 10801`로 올렸다. 대상은 Draft
PR #1의 `agent/react-capacitor-android` 브랜치이다. `1.8.1`을 current APK
candidate로, `1.7.4`를 유일한 rollback 세트로 유지하고, `1.8.0`은 superseded
candidate로 분류한다. 실행 중인 Codex turn을 끊지 않기 위해 Linux Companion은
`1.8.0`으로 유지하고, 활성 turn이 없을 때만 재시작한다.

| Component | Version / revision | State |
| --- | --- | --- |
| Runtime code baseline | `c5563ec` on `agent/react-capacitor-android` | pushed; local and PR checks passing |
| Primary development workspace | Linux PC Git clone at `c5563ec` | build, 18 tests and 3 real integrations passing |
| Termux workspace | lightweight Git mirror at `f08d9e7` | reproducible dependencies and build output scheduled for removal |
| Pull request | Draft PR #1 into `main` | Linux and Android checks passing; field test pending |
| Android APK | 1.8.1 signed CI candidate | APK, checksum and CycloneDX SBOM retained in Actions for 14 days; field install pending |
| Android rollback APK | 1.7.4 | sole validated rollback set; 1.8.0 is superseded rather than promoted to rollback |
| Linux Companion | 1.8.0 | running from the PC Git clone; restart to 1.8.1 deferred until no Codex turn is active |
| Pairing | one Android client | paired; secrets remain outside Git |
| Previous Companion | 0.2.0 directory snapshot | retained temporarily for rollback |
| Superseded Companion | 1.7.4 working directory | moved to recoverable trash after the 1.8.0 cutover |
| Latest official release | `v1.6.0` | Git tag and GitHub Release |

## Workspace roles

| Workspace | Role | Keeps |
| --- | --- | --- |
| Linux PC Git clone | authoritative development workspace | source, `.git`, dependencies, build/test output, Codex threads |
| Termux Git mirror | lightweight control and recovery | source mirror, tunnel scripts, Git metadata only |
| Android Downloads | field-test artifacts | one current APK set, one rollback APK set, temporary legacy archive |

PC Codex CLI `0.149.0`은 저장소의 app-server schema 기준 `0.148.1`보다 앞서 있다. 일반
타입·단위·실제 app-server 통합 검사는 PC에서 통과했고 schema 일치 검사만 예상대로 실패했다.
모바일 뷰포트 수정과 섞어 자동 갱신하지 않으며, 별도 후속 patch 후보로 분류해 바인딩 재생성, 실제
app-server 통합 검사와 새 APK 판단을 거친다.

`1.8.1`은 아직 정식 Release가 아니다. 사용자 현장 테스트가 끝난 뒤 PR을 병합하고 같은
병합 커밋에 `v1.8.1` 태그와 GitHub Release를 만들어야 한다. Companion을 1.8.1로 재시작하면
실행 중인 기존 run이 중단될 수 있으므로, 활성 작업이 없을 때만 배포한다.

## Artifact classes

- GitHub Release assets: 장기 보존하는 정식 배포 APK, SHA256SUMS, SBOM. 역사적
  `v1.5.0`과 `v1.6.0` Release에는 APK만 있으며, 세 가지 묶음은 `v1.8.1` 정식 배포부터 적용한다.
- GitHub Actions artifacts: PR 검증용이며 14일 후 자동 만료한다.
- Android Downloads: `CodexPocketVoice/current`에 현재 candidate 한 세트,
  `CodexPocketVoice/rollback`에 직전 검증본 한 세트만 보존한다. 과거 느슨한 APK는
  `archive/legacy`로 옮긴 뒤 정식 Release와 대조 후 정리한다.
- PC rollback snapshot: 새 Companion 현장 검증이 끝날 때까지 직전 운영본 한 개만 보존한다.
- Build outputs and caches: `dist`, `client/dist`, Gradle outputs, `node_modules`는 재생성 가능하며 버전 자산이 아니다.

## Cleanup gates

1. 현장 테스트 중에는 `v1.8.1` 태그를 만들거나 Draft PR을 병합하지 않는다.
2. 프로젝트 생성, AI 연결 센터 스크롤, 재연결, 음성 입력, 기존 대화 복구와 기기 간 세션 인계를 확인한다.
3. 승인 후 정식 Release를 만들고 APK 체크섬을 Release asset과 다시 대조한다.
4. 정식 Release 확인 후 PC의 0.2.0 rollback snapshot을 제거한다.
5. 실패한 CI 산출물과 superseded candidate APK는 즉시 제거해 설치 혼동을 막는다.
