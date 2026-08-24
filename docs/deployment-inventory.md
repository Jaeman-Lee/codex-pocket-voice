# Deployment inventory

Last verified: 2026-08-25 KST

이 문서는 공개 가능한 배포 기준선만 기록한다. 사용자명, 파일 절대 경로, 네트워크 주소,
기기 ID, 인증 토큰, 페어링 코드는 기록하지 않는다.

## Current candidate and deployed baseline

V2 development decision: Provider 공통 실행 계층, API Provider, 작업 저널과 Gateway protocol을
확장하므로 `breaking`/`2.0.0`으로 분류한다. 대상은 `feature/v2-control-plane` 브랜치이며 첫
단계에서는 Codex 실행을 공통 runtime 뒤로 옮기되 별도 hotfix로 운영 중인 v1.8.3 Companion을 v2로
교체하지 않는다. 2.0 APK는 현장 전달 전까지 CI-only artifact로 취급한다. v1.8.2를 current 설치
후보, v1.8.4 APK를 별도 staged 후보, v1.8.1을 검증된 rollback 세트로 유지하고 첫 2.0 candidate를
설치할 때도 1.8.1을 rollback으로 둔다.

| V2 development component | Version / revision | State |
| --- | --- | --- |
| Source version | `2.0.0` / Android `versionCode 20000` | development only; not field installed |
| Target branch | `feature/v2-control-plane` | common Provider contract/failure suite, fail-closed model/upstream grade gate, user-approved strict-ZDR OpenRouter routing, approved crash-recoverable text change tools, encrypted journals, durable API conversations, workspace management, dashboard, approval inbox, process-death notifications, connection/run/journal/voice/media state machines, encrypted project speech glossary and touch-reviewed spoken settings, live branch/worktree identity, reviewed exact-client revocation, staged PocketLink rotations, reviewed same-LAN/P2P discovery, Android outbound Wi-Fi Direct, fail-closed LAN→P2P→relay policy and standalone Linux P2P group-owner lifecycle implemented; real P2P/mobile field acceptance and protected model eval execution next |
| Gateway protocol | maximum 3, minimum 2 | v1 rollout compatibility retained |
| Codex app-server schema | `codex-cli 0.149.0` | generated bindings and no-model real integration verified |
| Current v1 APK | 1.8.2 candidate | signed APK/checksum/SBOM prepared from hotfix PR #4; install not performed |
| Staged v1 hotfix APK | 1.8.4 candidate | external-writer clarity PR #6 checks and signed artifact verified; kept separate and not installed |
| Existing rollback APK | 1.8.1 | user-validated rollback set preserved |
| Deployed v1 Companion | 1.8.3 at `e0f6ea1` | separate versioned runtime active; completed target writer release verified |
| OpenAI API milestone | official SDK 6.49.0 | encrypted bounded `store:false` multi-turn replay, fake tool-loop/SSE/Models tests and protected 2-call smoke harness; no API key configured and no paid request sent |
| OpenRouter milestone | Chat Completions + user/ZDR model, endpoint and key APIs | encrypted bounded multi-turn replay, exact upstream lock/approved backup, bounded price/performance/quota UI, fake routing/tool-loop/SSE and protected 2-call smoke harness; no API key configured and no paid request sent |
| Provider credential boundary | systemd 256+ encrypted user credential | fixed-name runtime files, generation-bound activation, immediate new-run revoke, no-follow/owner/mode/size validation and recoverable ciphertext rotation/removal implemented; legacy 0600 file retained |
| Provider model grade boundary | owner-only redacted report, maximum age 30 days | OpenAI exact model and OpenRouter exact model+every selected upstream gate read/coding tool exposure; protected fresh-smoke synthetic project grade workflow implemented, but no real API workflow run or grade issued |
| Provider runtime contract | exact run ownership + ordered single-terminal events | Codex/OpenAI/OpenRouter shared success/partial-failure/cancel/timeout suite and fake 401/403/429/5xx/malformed SSE fixtures passing |
| API run policy | authenticated Companion policy + immutable per-run snapshot | emergency stop, token/cost hard limits, rolling-day warning, monthly touch confirmation and actual/estimated/unknown accounting implemented with fake Providers only; no paid request sent |
| Provider context Fork | client/request-bound 10-minute reviewed preview | terminal source request/accepted Steers/final answer plus new request only; exact target policy/selection, new-conversation execution, idempotent ambiguous-response retry and durable redacted provenance implemented with synthetic Providers |
| Android journal milestone | app-owned SQLite schema 2 | encrypted conversation/queue snapshots plus device+workspace-scoped speech glossary, hashed indexes and rollback mirror implemented; schema 1→2 preserves existing rows; CI-only, no device migration performed |
| Companion event journal | encrypted SQLite schema 1 | restore/replay/unknown acknowledgement, HMAC-authenticated bounded user retention, workspace JSON export and protected delete implemented in v2; not field deployed |
| Operations dashboard | protocol 3 capability | per-project run snapshot, replay reconciliation, touch-only approvals, bounded syntax-highlighted old/new-line diff and maximum 8 same-run decline comments, run-bound test/log/image/APK snapshot review/download, durable goal/pin/archive and two-touch history deletion implemented; no field APK handed off |
| Multi-Companion Fleet | maximum 8 exact registered device targets | authenticated server-authored count-only summary, isolated per-device token failures and explicit device handoff implemented; multi-PC device acceptance pending |
| Paired-device removal | exact authenticated client + two-touch review | Companion authorization mutations persist in call order before becoming live; authorization is revoked before Android key/config and local target deletion; offline, malformed, missing-token and mTLS-mismatch results retain retry state, while exact `INVALID_TOKEN` makes response-loss recovery idempotent; physical multi-PC removal pending |
| Codex Queue/Steer | exact active operation + `turn/steer` | Queue remains the mobile default; explicit Steer is bound to the server-owned thread/turn, idempotently journaled and hidden for unsupported API Providers; synthetic acceptance only |
| Project speech glossary | maximum 32 reviewed terms per device+workspace | encrypted hashed-scope storage, bounded non-chaining transcript correction and optional API 33 native recognition hints implemented; production browser/Android CI and physical voice acceptance pending |
| Spoken settings review | one exact project/provider/model command | dedicated one-shot capture, ambiguity rejection, inert current→target review, touch-only apply and stale owner/catalog revalidation implemented; Chromium CI and physical voice acceptance pending |
| Mobile browser acceptance | Playwright Chromium on Node 22 | production build plus real pairing/Gateway/SSE/run/approval path covers 320/360/412px, 150% text, keyboard resize, rotation, long diff and touch decline line-feedback payload; synthetic only, device acceptance still pending |
| Android work notifications | opt-in connectedDevice service | maximum 8 encrypted loopback subscriptions, notification-only authenticated SSE, durable cursor/replay freshness, default-network-triggered bounded reconnect and generic retained-operation navigation implemented; API 30 token/bounds/consume/extra-scrub plus system-tray tap automated, physical locked-screen/process-kill/network-switch acceptance pending |
| Android low-load gate | schema 2 candidate/transport-bound aggregate ADB report | read-only 60-minute CPU/PSS/battery/background-wake collector and fixed fail-closed thresholds bind the canonical signed manifest, clean commit, APK digest and exact direct LAN/P2P/relay path; no physical result recorded yet |
| Functional field gate | schema 1 operator-attested aggregate | signed manifest/version/commit/APK-bound inert template and fixed 20-scenario fail-closed verdict implemented; no physical/provider result recorded yet |
| Final release evidence gate | schema 1 structured aggregate only | re-evaluates functional observations and recomputes direct LAN/P2P/relay schema 2 low-load verdicts for one clean signed candidate with 30-day freshness; no field result recorded yet |
| Approved API tools | SHA-bound replace/create/rename + probed sandbox verifier | 1–8 text files; bounded fail-closed manual recovery; delete/directory/chmod/binary blocked; check/test/build only |
| Run artifact boundary | maximum 8 / 256 MiB per operation | redacted verifier/Codex logs plus allowlisted run-reported test/image/APK regular-file snapshots; authenticated opaque download, symlink/sensitive/path escape rejection and history-delete cleanup implemented; physical Android download acceptance pending |
| Diagnostic support bundle | schema 1 allowlist JSON | authenticated app/protocol/tool/count aggregate download, normalized version tokens and capability-gated 320px UI implemented; no device/network/workspace/request/error content, physical share acceptance pending |
| Workspace/session identity | live catalog + per-run Git identity snapshot | dashboard and handoff show exact path; encrypted journal retains run branch; only exact normalized cwd thread run/release/at-most-once claim is accepted; state-file mutations persist in call order before becoming visible; nested, cross-project, cross-provider and competing claims are rejected |
| PocketLink TLS bootstrap | opt-in LAN/P2P mTLS + Android server/client SPKI binding | pairing/revoke/key-rotation state uses durable serialized commits; reviewed QR, bounded untrusted DNS-SD and opaque Wi-Fi Direct discovery, Android group-client enforcement, standalone Linux GO/PBC + memory-only DHCP cleanup lifecycle, observed backup-pin promotion and recoverable Keystore A/B client identity rotation implemented; actual P2P field validation pending |
| PocketLink outbound relay | protocol 1 broker + Linux/Android connectors | fixed direct/P2P/relay plus LAN→P2P→relay auto mode, Keystore-encrypted peer/endpoint/slot/secret, outer relay TLS and existing end-to-end PocketLink mTLS implemented; public-service/device acceptance pending |
| Android update integrity | canonical schema 1 manifest + detached release-key signature | bounded official Latest discovery/download, same-signer native ZIP importer and user-confirmed installer implemented; field rollback acceptance pending |

Functional field acceptance harness checkpoint decision: 기존 v2 physical/provider release checklist를 exact
candidate에 묶어 반복 가능하게 검증하는 developer validation이므로 internal compatibility `patch`로 분류한다.
아직 전달하지 않은 incompatible v2 범위 안에서 SemVer `2.0.0`/Android `versionCode 20000`, 대상
`feature/v2-control-plane`을 유지하고 이전 CI-only candidate를 대체한다. 별도 암호 검증한 signed update
manifest의 version/commit·manifest/APK/signer digest와 clean checkout을 묶고, inert owner-only template의
20개 고정 scenario와 physical API 30+·Companion/client/upstream 개수, 여섯 attestation이 모두 pass일 때만
create-once aggregate report를 통과시킨다. device/network 값·credential·prompt/response·오류 원문·자유 형식
note는 schema에 없다. 현재는 fixture만 실행하며 실제 단말·Provider·P2P·rollback 통과 결과를 기록하지
않는다. APK 전달·설치, 실제 Provider 호출과 Companion 재시작은 하지 않고 current v1 후보 1.8.2,
staged v1.8.4, 검증된 rollback 1.8.1과 배포 중인 v1.8.3 Companion을 그대로 보존한다. `release:check`의
단위 검사 296개와 실제 app-server 통합 3개, production build·schema 일치·SBOM이 통과했다.

Candidate-bound Android low-load evidence checkpoint decision: 기존 60분 ADB 측정 report가 SemVer만
기록해 같은 `2.0.0`의 서로 다른 APK build와 direct LAN/P2P/outbound relay 경로를 구분하지 못한 release
evidence 결함을 고치는 internal compatibility `patch`다. 아직 전달하지 않은 incompatible v2 범위 안에서
SemVer `2.0.0`/Android `versionCode 20000`, 대상 `feature/v2-control-plane`을 유지하고 이전 CI-only
candidate를 대체한다. pre-handoff report schema를 2로 교체해 별도 암호 검증한 canonical signed manifest의
전체 candidate identity, clean source commit, APK digest, exact transport와 측정 시각을 기록한다. manifest·
transport 누락, source/설치 identity drift는 ADB 측정 전에 실패한다. 실제 측정·APK 전달·설치·Provider
호출·Companion 재시작은 하지 않고 current v1 후보 1.8.2, staged v1.8.4, 검증된 rollback 1.8.1과 배포
중인 v1.8.3 Companion을 그대로 보존한다. `release:check`의 단위 검사 297개와 실제 app-server 통합
3개, production build·schema 일치·SBOM이 통과했다.

Final release evidence gate checkpoint decision: 기능 observation과 transport별 저부하 결과를 사람이
각각 대조하던 절차를 한 exact candidate 판정으로 고정하는 developer validation이므로 internal compatibility
`patch`로 분류한다. 아직 전달하지 않은 incompatible v2 범위 안에서 SemVer `2.0.0`/Android
`versionCode 20000`, 대상 `feature/v2-control-plane`을 유지하고 이전 CI-only candidate를 대체한다.
기능 observation을 다시 평가하고 direct LAN/P2P/outbound relay schema 2 report의 candidate·slot·freshness와
aggregate threshold를 재계산한다. candidate drift, report 위치 교환, extra field, 편집된 verdict와
wall/monotonic duration 불일치는 출력 없이 거부하고 완전하지만 실패한 evidence는 owner-only create-once
aggregate에 fail로 남긴다. 실제 field 실행·서명 암호 검증·APK 전달·설치·Provider 호출·Companion 재시작은
하지 않고 current v1 후보 1.8.2, staged v1.8.4, 검증된 rollback 1.8.1과 배포 중인 v1.8.3 Companion을
그대로 보존한다. `release:check`의 단위 검사 303개와 실제 app-server 통합 3개, production build·schema
일치·SBOM이 통과했다.

Durable Gateway authorization checkpoint decision: 동시 pairing·revoke·TLS key rotation의 atomic rename이
역순 완료되면 재시작 뒤 해제한 token 또는 이전 key가 되살아나거나 새 client가 사라질 수 있던 기존 v2
보안 오류를 고치므로 `patch`로 분류한다. 아직 전달하지 않은 incompatible v2 범위 안에서 SemVer
`2.0.0`/Android `versionCode 20000`, 대상 `feature/v2-control-plane`을 유지하고 이전 CI-only candidate를
대체한다. claim/revoke와 rotation start/inspect/complete/abort/finalize는 단일 mutation queue에서 호출
순서대로 저장하며 성공한 atomic replace 뒤에만 live 인증 상태를 바꾼다. 저장 실패는 기존 token·TLS
identity를 그대로 유지하고 다음 요청이 마지막 durable 상태에서 재시도하게 한다. APK 전달·설치, 실제
Provider 호출과 Companion 재시작은 하지 않고 current v1 후보 1.8.2, staged v1.8.4, 검증된 rollback
1.8.1과 배포 중인 v1.8.3 Companion을 그대로 보존한다. `release:check`의 단위 검사 291개, 실제
app-server 통합 3개, production build·schema 일치·SBOM이 통과했다.

Durable session handoff persistence checkpoint decision: 동시 release/claim의 atomic rename이 역순 완료되면
Companion 재시작 뒤 오래된 handoff가 복원될 수 있던 기존 v2 오류를 고치므로 `patch`로 분류한다. 아직
전달하지 않은 incompatible v2 범위 안에서 SemVer `2.0.0`/Android `versionCode 20000`, 대상
`feature/v2-control-plane`을 유지하고 이전 CI-only candidate를 대체한다. handoff release/claim은 단일
mutation queue에서 호출 순서대로 저장하고, atomic file replace가 성공한 뒤에만 메모리 상태를 교체한다.
저장 실패 시 ghost handoff를 공개하지 않고 다음 요청은 마지막 durable 상태에서 재시도한다. APK 전달·설치,
실제 Provider 호출과 Companion 재시작은 하지 않고 current v1 후보 1.8.2, staged v1.8.4,
검증된 rollback 1.8.1과 배포 중인 v1.8.3 Companion을 그대로 보존한다. `release:check`의 단위 검사
288개, 실제 app-server 통합 3개, production build·schema 일치·SBOM이 통과했다.

Atomic session claim checkpoint decision: 같은 handoff의 경쟁 claim이나 claim 실패 뒤 모바일 상태만 바뀔 수
있던 기존 v2 오류를 고치므로 `patch`로 분류한다. 아직 전달하지 않은 incompatible v2 범위 안에서 SemVer
`2.0.0`/Android `versionCode 20000`, 대상 `feature/v2-control-plane`을 유지하고 이전 CI-only candidate를
대체한다. Gateway는 한 claim만 성공시키고, 모바일은 exact thread/operation과 Codex Provider 소유권을
검증한 뒤 server claim·exact 응답까지 완료해야 로컬 프로젝트·대화·메시지를 원자적으로 전환한다.
404/409·응답 유실·장치/Provider 전환·활성 작업에서는 기존 로컬 상태를 유지한다. APK 전달·설치,
실제 Provider 호출과 Companion 재시작은 하지 않고 current v1 후보 1.8.2, staged v1.8.4,
검증된 rollback 1.8.1과 배포 중인 v1.8.3 Companion을 그대로 보존한다.
`release:check`의 단위 검사 286개, 실제 app-server 통합 3개, production build·schema 일치·SBOM은
통과했다. 경쟁 claim 409 뒤 기존 대화를 유지하는 320px production 회귀는 PR Chromium CI에서 확인한다.

Exact project session scope checkpoint decision: 부모 프로젝트 선택이 하위 폴더의 Codex 대화를 같은
세션으로 표시·반납할 수 있던 기존 v2 오류를 고치므로 `patch`로 분류한다. 아직 전달하지 않은
incompatible v2 범위 안에서 SemVer `2.0.0`/Android `versionCode 20000`, 대상
`feature/v2-control-plane`을 유지하고 이전 CI-only candidate를 대체한다. 모바일은 exact `cwd` 대화만
표시하고 반납 직전 로컬 선택을 재검증한다. Gateway는 정규화한 workspace와 thread `cwd`가 완전히
같아야 run/release/claim을 허용하며 nested/sibling mismatch에는 409를 반환하고 writer를 해제하지 않는다.
APK 전달·설치, 실제 Provider 호출과 Companion 재시작은 하지 않고 current v1 후보 1.8.2,
staged v1.8.4, 검증된 rollback 1.8.1과 배포 중인 v1.8.3 Companion을 그대로 보존한다.
`release:check`의 단위 검사 281개, 실제 app-server 통합 3개, production build·schema 일치·SBOM은
통과했다. exact/nested thread를 함께 반환하는 320px production 브라우저 회귀는 로컬 host의
`libatk-1.0.so.0` 부재로 실행하지 못해 PR Chromium CI를 최종 gate로 사용한다.

Paired-device removal checkpoint decision: v2 연결 센터의 기존 삭제가 Companion 인증 권한을
남길 수 있던 보안 결함을 고치므로 `patch`로 분류한다. 아직 전달하지 않은 incompatible v2
범위 안에서 SemVer `2.0.0`/Android `versionCode 20000`, 대상 `feature/v2-control-plane`을 유지하고
이전 CI-only candidate를 대체한다. 별도 터치 검토 후 exact target token으로 Companion client를 먼저
해제하고, 확인된 성공 또는 exact `INVALID_TOKEN`에서만 target을 미페어링으로 기록한 뒤
Android config/key와 로컬 등록을 제거한다. offline·malformed·missing token·`TLS_DEVICE_MISMATCH`는
재시도 상태를 남긴다. APK 전달·설치, 실제 Provider 호출과 Companion 재시작은 하지 않고
current v1 후보 1.8.2, staged v1.8.4, 검증된 rollback 1.8.1과 배포 중인 v1.8.3 Companion을
그대로 보존한다. `release:check`의 단위 검사 280개, 실제 app-server 통합 3개,
production build·schema 일치·SBOM은 통과했고 320px browser acceptance는 PR CI에서 확인한다.

Android low-load field harness checkpoint decision: 기존 Phase E 장시간 성능·배터리 검증을 반복 가능하게 만드는
developer validation이므로 internal compatibility `patch`로 분류한다. 아직 전달하지 않은 incompatible v2
범위 안에서 SemVer `2.0.0`/Android `versionCode 20000`, 대상 `feature/v2-control-plane`을 유지하고 이전
CI-only candidate를 대체한다. 고정 release 기준은 60분, process/CPU/PSS coverage 95%, CPU p95 5%, PSS
max 192 MiB, unplugged battery 4%/h와 UID background partial wake 10%다. 도구는 `dumpsys` 조회만 실행하고
batterystats reset/write/check-in 소비, 앱 lifecycle·네트워크 변경을 하지 않는다. owner-only report에는
aggregate verdict만 두며 serial/model/UID/PID, device/network/install path와 원본 출력을 넣지 않는다. 현재
PC에는 연결된 물리 ADB 단말이 없어 실제 통과 수치는 기록하지 않는다. APK 전달·설치, 실제 Provider 호출과
Companion 재시작은 하지 않고 current v1 후보 1.8.2, staged v1.8.4, 검증된 rollback 1.8.1과 배포 중인
v1.8.3 Companion을 그대로 보존한다.
`release:check`의 단위 테스트 275개, 실제 app-server 통합 3개, production build·schema 일치와 SBOM
생성은 통과했다. 물리 Android 측정은 이 자동 검증에 포함되지 않는다.

Android notification tray checkpoint decision: 기존 generic work notification의 실제 system-UI deep-link를
검증하는 native test 강화이므로 internal compatibility `patch`로 분류한다. 아직 전달하지 않은 incompatible
v2 안에서 SemVer `2.0.0`/Android `versionCode 20000`, 대상 `feature/v2-control-plane`을 유지하고 이전
CI-only candidate를 대체한다. SystemUI를 포함한 API 30 AOSP Managed Device는 AndroidX UI Automator
2.3.0으로 합성 approval notification을 게시하고 tray를 열어 generic 본문을 탭한 뒤 MainActivity가
app-private token에 묶인 exact
device/operation을 한 번만 소비하는지 검사한다. 테스트 종료 시 알림을 지우고 홈 화면으로 돌아간다.
실제 device/network 값, prompt·workspace·응답은 사용하지 않는다. APK 전달·설치, 실제 Provider 호출과
Companion 재시작은 하지 않고 current v1 후보 1.8.2, staged v1.8.4와 검증된 rollback 1.8.1을 보존한다.
SystemUI를 제거한 ATD는 tray path를 증명할 수 없으므로 사용하지 않는다. 물리 단말 잠금화면·
process-kill·절전·네트워크 전환은 계속 field gate다. 첫 full-SystemUI 실행은 notification small-icon
vector의 마지막 arc에 잘못 붙은 좌표를 발견했으며, Android 11 SystemUI가 실제로 렌더링할 수 있도록
경로를 수정하고 source 계약으로 고정한다.

Android background network-transition checkpoint decision: notification SSE의 최대 60초 retry 지연을 줄이는
기존 v2 native transport 수정이므로 internal compatibility `patch`로 분류한다. 아직 전달하지 않은
incompatible v2 안에서 SemVer `2.0.0`/Android `versionCode 20000`, 대상
`feature/v2-control-plane`을 유지하고 이전 CI-only candidate를 대체한다. opt-in foreground service는
default-network available/lost callback 한 개로 현재 loopback SSE를 닫고 backoff wait를 즉시 해제한 뒤
1초 기준부터 다시 시도한다. callback 등록 실패는 기존 최대 60초 bounded retry로 fail safe하며 service
종료 때 callback·waiter·HTTP 연결을 정리한다. network·endpoint·device·token 값은 callback state나 로그에
추가하지 않는다. APK 전달·설치, 실제 network switch, Provider 호출과 Companion 재시작은 하지 않고
current v1 후보 1.8.2, staged v1.8.4와 검증된 rollback 1.8.1을 그대로 보존한다.
`release:check`의 단위 테스트 268개, 실제 app-server 통합 3개, production build·schema 일치와 SBOM
생성은 통과했고 notification source 계약도 통과했다. Linux host에는 Java/JAVA_HOME이 없어 새 native
JVM retry test와 Android assemble을 로컬 실행하지 못했지만 PR #3 Android CI의 Java 21 release assemble,
native unit test와 API 30 managed-device instrumentation은 통과했다.

Diagnostic support bundle checkpoint decision: AI 연결 센터에서 field diagnostics JSON을 내려받는 기능은 새
user-visible v2 workflow이므로 `feature`로 분류한다. 아직 전달하지 않은 incompatible v2 안에서 SemVer
`2.0.0`/Android `versionCode 20000`, 대상 `feature/v2-control-plane`을 유지하고 이전 CI-only candidate를
대체한다. bundle schema 1은 app/protocol/capability, architecture·Node, 알려진 도구의 availability와
정규화된 version token, workspace/생성 위치 count만 allowlist로 조립한다. credential·환경 변수,
device/network 값, 경로·Git metadata, prompt/response·command/error 원문과 journal/approval/artifact
content는 넣지 않는다. authenticated no-store attachment와 additive capability negotiation을 사용하고
구형 Companion에서는 버튼을 숨긴다. APK 전달·설치, 실제 Provider 호출과 Companion 재시작은 하지 않으며
current v1 후보 1.8.2, staged v1.8.4와 검증된 rollback 1.8.1을 그대로 보존한다. `release:check`의
단위 테스트 268개, 실제 app-server 통합 3개, production build·schema 일치와 SBOM 생성은 통과했다.
production 320px download 회귀는 Chromium CI에 추가했으며 로컬 host의 `libatk-1.0.so.0` 부재 때문에
PR CI를 최종 browser gate로 사용한다.

Approval diff line-feedback checkpoint decision: 모바일 승인함에서 변경 줄별 의견을 같은 Provider run에
돌려보내는 새 user-visible v2 workflow이므로 `feature`로 분류한다. 아직 전달하지 않은 incompatible v2
안에서 SemVer `2.0.0`/Android `versionCode 20000`, 대상 `feature/v2-control-plane`을 유지하고 이전
CI-only candidate를 대체한다. diff 표시는 24,000자·300줄·줄당 2,000자로 제한하고 파일/hunk/이전·새
줄 번호와 추가·삭제를 구분한다. 최대 8개 의견, 줄당 600자, 전체 12 KiB와 500자 이하 안전한 프로젝트
상대 경로를 클라이언트·서버에서 검사하며 same-origin touch decline만 resolution에 기록한다. Local Tool
Broker는 거절된 도구를 실행하지 않고 feedback을 기존 OpenAI Responses function output 또는 OpenRouter
tool message로 돌려보내 같은 run의 수정과 fresh approval을 요구한다. native notification 축약 경계에는
resolution feedback을 전달하지 않는다. `release:check`의 단위 테스트 263개, 실제 app-server 통합 3개와
schema 검사가 통과했고 production 320px/150% Chromium 회귀를 추가했다. 로컬 Chromium은 host의
`libatk-1.0.so.0` 부재로 시작하지 못해 PR CI를 최종 브라우저 gate로 사용한다. 실제 Provider 호출,
APK 전달·설치와 Companion 재시작은 수행하지 않았으며 current v1 후보 1.8.2, staged v1.8.4와 검증된
rollback 1.8.1은 변경·삭제하지 않는다.

Run artifact review checkpoint decision: 완료 작업의 test/log/image/APK 검토·다운로드는 새 user-visible v2
workflow이므로 `feature`로 분류한다. 아직 전달하지 않은 incompatible v2 안에서 SemVer `2.0.0`/Android
`versionCode 20000`, 대상 `feature/v2-control-plane`을 유지하고 이전 CI-only candidate를 대체한다.
Provider verifier와 Codex command output은 redaction 뒤 private immutable snapshot으로 분리하며, run이
변경으로 보고한 프로젝트 내부 allowlisted regular file만 최대 8개·총 256 MiB까지 복사한다. operation에는
opaque ID·MIME·크기·SHA-256과 bounded text preview만 남기고 authenticated exact run route에서만
다운로드한다. symlink·민감 경로·경로 이탈·변경 중 파일은 제외하고 journal workspace 삭제 때 snapshot도
삭제한다. 로컬 Chromium은 host `libatk-1.0.so.0` 부재로 시작하지 못해 PR CI를 browser gate로 사용한다.
`release:check`의 단위 테스트 266개, 실제 app-server 통합 3개, schema 일치와 SBOM 생성은 통과했다.
APK 전달·설치, 실제 Provider 호출과 Companion 재시작은 하지 않았으며 current v1 후보 1.8.2, staged
v1.8.4와 검증된 rollback 1.8.1을 그대로 보존한다.

Spoken settings touch-review checkpoint decision: 프로젝트·AI 연결·모델의 음성 선택은 새 user-visible v2
workflow이므로 `feature`로 분류한다. 아직 전달하지 않은 incompatible v2 안에서 SemVer `2.0.0`/Android
`versionCode 20000`, 대상 `feature/v2-control-plane`을 유지하고 이전 CI-only candidate를 대체한다.
일반 받아쓰기는 selector로 해석하지 않으며 별도 단발 모드의 한 가지 strict command만 exact alias로
검사한다. unknown·duplicate·ambiguous·oversized 명령은 추측하지 않고, 음성 종료 뒤에도 선택값은 그대로
둔다. 화면의 인식문과 현재→대상을 직접 터치한 경우에만 exact device/workspace/provider/model owner,
active run/Fork 상태와 최신 catalog를 다시 검사해 적용한다. Provider model catalog는 현재 선택을 바꾸기
전에 먼저 불러와 실패 시 기존 설정을 원자적으로 유지한다. Node 합성 검사만 수행했고 실제 마이크·Provider
호출, APK 전달·설치와 Companion 재시작은 하지 않았다. current v1 후보 1.8.2, staged v1.8.4와 검증된
rollback 1.8.1은 변경·삭제하지 않는다.

Project speech glossary checkpoint decision: PC·프로젝트별 받아쓰기 보정은 새 user-visible v2 workflow이므로
`feature`로 분류한다. 아직 전달하지 않은 incompatible v2 안에서 SemVer `2.0.0`/Android
`versionCode 20000`, 대상 `feature/v2-control-plane`을 유지하고 이전 CI-only candidate를 대체한다.
사용자가 검토한 최대 32개의 spoken→replacement 항목만 새 음성 구간에 bounded·non-chaining 방식으로
적용하며 typed prompt는 바꾸지 않는다. Android 13+ recognition hint와 모든 플랫폼의 로컬 보정을 함께
사용하고 결과는 전송 전에 계속 편집 가능하다. exact device+workspace 사전은 WorkJournal AES-GCM으로
암호화하고 raw 저장소에는 domain-separated hash index만 남긴다. Android SQLite schema 1→2는 기존 row를
삭제하지 않고 glossary table만 추가하며 browser IndexedDB version/store 계약은 유지한다. 합성 테스트만
수행하고 APK 전달·설치, 실제 Provider 호출과 Companion 재시작은 하지 않았다. current v1 후보 1.8.2,
staged v1.8.4와 검증된 rollback 1.8.1은
변경·삭제하지 않는다.

Protected project-grade checkpoint decision: 실제 API 모델의 공통 Tool Broker read/coding 계약을 합성 프로젝트에서
평가해 설치 가능한 등급을 만드는 새 v2 validation capability이므로 `feature`로 분류한다. 아직 현장 전달하지
않은 incompatible v2 범위 안에서 SemVer `2.0.0`/Android `versionCode 20000`, 대상
`feature/v2-control-plane`을 유지하고 이전 CI-only candidate를 대체한다. workflow는 같은 job의 24시간 이내
owner-only smoke report, exact model/OpenRouter ZDR upstream, 최대 read 2회·coding 3회, 요청당 input
8,192/output 256 token과 $0.05 사전/사후 상한을 요구한다. 새 0700 임시 workspace의 운영 read와 SHA-bound
replace만 사용하고 coding은 environment review와 exact confirmation 뒤 한 번만 승인한다. report에는
prompt·marker·파일 내용·SHA·model output·credential을 남기지 않는다. 공개 검사는 fake adapter와 실제
Tool Broker만 사용했고 실제 API key·유료 inference·등급 발급은 수행하지 않았다. APK 전달·설치와 실행 중
Companion 재시작도 하지 않았으며 current v1 후보 1.8.2, staged v1.8.4와 검증된 rollback 1.8.1을 그대로
보존한다.

Multi-Companion Fleet checkpoint decision: 여러 Linux PC의 작업 요약과 명시적 전환은 새 user-visible v2
workflow이므로 `feature`로 분류한다. 아직 전달하지 않은 incompatible v2 안에서 SemVer `2.0.0`/Android
`versionCode 20000`, 대상 `feature/v2-control-plane`을 유지하고 이전 CI-only candidate를 대체한다.
Fleet는 exact registered device와 token으로 최대 8대의 server-authored `/api/fleet-summary`만 병렬 조회하되
활성 API device를 바꾸지 않는다. 잘못된 ID는 fail closed이고 한 device의 인증 실패는 다른 token을 제거하지
않는다. prompt·workspace·승인 상세·복구 error는 Fleet 응답 경계를 통과하지 않고 실행/승인/unknown/실패/복구/보존
count만 보여 주며 모든 승인·정책·파일 변경은
사용자가 해당 PC를 연 뒤에만 가능하다. offline, pairing, identity review와 API 미지원을 구분하며 다른
PC로 자동 우회하지 않는다. PWA CSP/CORS는 loopback 동적 port의 authenticated GET만 허용하고 cross-port
write는 계속 차단한다. 합성 multi-origin Companion·모바일 fixture만 검사하고 APK 전달·설치, 실제
Provider 호출과 Companion 재시작은 하지 않았다. current v1 후보 1.8.2, staged v1.8.4와 검증된 rollback
1.8.1은 변경·삭제하지 않는다.

Provider context Fork checkpoint decision: Provider 사이에 사용자가 검토한 대화 범위를 넘기는 새 user-visible
v2 workflow이므로 `feature`로 분류한다. 아직 전달하지 않은 incompatible v2 안에서 SemVer
`2.0.0`/Android `versionCode 20000`, 대상 `feature/v2-control-plane`을 유지하고 이전 CI-only candidate를
대체한다. Provider 전환 기본값은 빈 새 대화이며, terminal source operation의 요청·수락된 Steer·최종
답변과 새 요청만 bounded preview에 넣는다. tool state·명령 log·raw diff·자격 증명·이전 첨부 원본은
승계하지 않는다. 10분 preview는 authenticated client, exact target selection/policy와 한 request ID에
묶고 모바일 journal에 저장하지 않는다. 응답 유실은 같은 request ID로만 deduplicate하며 암호화 operation에
redacted provenance를 남긴다. 합성 Provider·Gateway·모바일 fixture만 검사했고 APK 전달·설치, 실제 Provider
호출과 Companion 재시작은 하지 않았다. current v1 후보 1.8.2, staged v1.8.4와 검증된 rollback 1.8.1은
변경·삭제하지 않는다.

Codex Queue/Steer checkpoint decision: 실행 중 turn에 대한 명시적 방향 수정은 새 user-visible v2
workflow이므로 `feature`로 분류한다. 아직 전달하지 않은 incompatible v2 안에서 SemVer
`2.0.0`/Android `versionCode 20000`, 대상 `feature/v2-control-plane`을 유지하고 이전 CI-only
candidate를 대체한다. 모바일 기본값은 Queue이며 명시적 Steer만 서버가 보유한 exact operation의
Codex thread·turn에 전달한다. retry deduplication, 동시 요청 차단과 암호화 journal 복원을 적용하고,
지원하지 않는 OpenAI/OpenRouter에는 Steer를 노출하지 않는다. 합성 Provider·Gateway·모바일 fixture만
검사했으며 APK 전달·설치, 실제 Provider 호출과 Companion 재시작은 하지 않았다. current v1 후보
1.8.2, staged v1.8.4와 검증된 rollback 1.8.1은 변경·삭제하지 않는다.

API run policy checkpoint decision: OpenAI/OpenRouter 실행 전 비용·token·privacy 사전검사와 모바일 설정/확인을
추가하는 user-visible v2 workflow이므로 `feature`로 분류한다. 아직 현장 전달하지 않은 incompatible v2
범위 안에서 SemVer `2.0.0`/Android `versionCode 20000`, 대상 `feature/v2-control-plane`을 유지하고 이전
CI-only candidate를 대체한다. journal key로 인증한 server policy와 1회용 confirmation은 exact
model/routing/config/history에 묶이며, Provider 요청에 output/total token hard limit을 강제한다. operation은
immutable policy snapshot과 provider-reported/catalog-estimate/unknown 비용 상태를 암호화해 보존한다.
공개 검사는 fake catalog·Provider·HTTP와 합성 모바일 fixture만 사용했고 실제 API key·유료 inference·APK
전달/설치·Companion 재시작은 수행하지 않았다. current v1 후보 1.8.2, staged v1.8.4와 검증된 rollback
1.8.1을 그대로 보존한다.

Provider model grade checkpoint decision: protected eval 결과를 실제 API tool 권한과 모바일 표시에 연결하는 새
user-visible v2 workflow이므로 `feature`로 분류한다. 아직 현장 전달하지 않은 incompatible v2 범위 안에서
SemVer `2.0.0`/Android `versionCode 20000`, 대상 `feature/v2-control-plane`을 유지하고 이전 CI-only
candidate를 대체한다. Companion은 owner-only directory의 최대 64개·파일당 64 KiB redacted report를
no-follow로 읽고 30일 뒤 만료한다. OpenAI exact model 또는 OpenRouter exact model+모든 선택 upstream 중
하나라도 미검사·실패·만료·invalid이거나 endpoint가 tool parameter를 지원하지 않으면 실제 inference
요청에서 project tool 정의를 제거한다. `projectRead`는 observation만, `coding`은 touch-approved change와
execution까지 허용한다. 현재 보호된 smoke report는 project 등급을 `not_tested`로 남기므로 실제 등급을
발급하지 않았고 API key·유료 inference·APK 전달/설치·Companion 재시작도 수행하지 않았다. current v1
후보 1.8.2, 별도 staged v1.8.3과 검증된 rollback 1.8.1을 그대로 보존한다.

Provider credential activation checkpoint decision: 이전 systemd runtime credential이 rotate/remove 뒤 새 run에
재사용될 수 있던 결함을 고치는 internal compatibility `patch`다. 아직 현장 전달하지 않은 incompatible v2
범위 안에서 SemVer `2.0.0`/Android `versionCode 20000`, 대상 `feature/v2-control-plane`을 유지하고 이전
CI-only candidate를 대체한다. 0600 state의 enabled/disabled와 128-bit generation을 user unit environment에
묶어 mismatch와 revoke를 모든 Provider source보다 먼저 검사한다. rotate는 이전 activation의 새 run을,
remove는 systemd runtime·환경변수·protected file fallback의 새 run을 즉시 차단하되 이미 시작한 turn을
강제 종료하지 않는다. 실제 key 변경·APK 전달·설치·Companion 재시작은 수행하지 않으며 current v1 후보
1.8.2, 별도 staged v1.8.3과 검증된 rollback 1.8.1은 그대로 보존한다.

Linux Provider credential checkpoint decision: systemd encrypted credential 설정·교체·해제는 새 server credential
workflow이므로 `feature`로 분류한다. 아직 현장 전달하지 않은 incompatible v2 범위 안에서 SemVer
`2.0.0`/Android `versionCode 20000`, 대상 `feature/v2-control-plane`을 유지하고 이전 CI-only candidate를
대체한다. systemd 256+에서만 user/machine-bound `LoadCredentialEncrypted=`를 unit에 넣고, Companion은
private runtime directory의 고정 이름을 환경변수보다 우선한다. invalid runtime file은 legacy source로
우회하지 않고, set/rotate/remove는 평문 파일·자동 service restart 없이 recoverable ciphertext archive를
사용한다. 현재 PC의 systemd 245에서는 source fixture만 검증했고 실제 key 설정·APK 전달·설치·Companion
재시작은 하지 않았다. current v1 후보 1.8.2, 별도 staged v1.8.3과 검증된 rollback 1.8.1은 그대로 보존한다.

OpenAI protected smoke checkpoint decision: 실제 Responses Provider contract를 실행하는 새 검증 workflow이므로
`feature`로 분류한다. 아직 현장 전달하지 않은 incompatible v2 범위 안에서 SemVer `2.0.0`/Android
`versionCode 20000`, 대상 `feature/v2-control-plane`을 유지하고 이전 CI-only candidate를 대체한다.
수동 `provider-smoke` environment는 exact allowlist, 운영자 확인 가격, 2회 synthetic 호출, 호출당 input
4,096/output 256 token 및 $0.02 preflight/usage 상한을 강제한다. 0600 artifact에는 모델·token·추정 비용과
contract grade만 기록하며 prompt·marker·함수 인자·응답 본문은 넣지 않는다. 이 checkpoint에서는 실제
key·유료 inference·APK 전달·설치·Companion 재시작을 수행하지 않는다. current v1 후보 1.8.2, 별도
staged v1.8.3과 검증된 rollback 1.8.1은 그대로 보존한다.

PocketLink Android P2P checkpoint decision: 사용자 동작 기반 Wi-Fi Direct 검색·등록과 native transport는 새
user-visible v2 workflow이므로 `feature`로 분류한다. 아직 현장 전달하지 않은 incompatible v2 범위 안에서
SemVer `2.0.0`/Android `versionCode 20000`, 대상 `feature/v2-control-plane`을 유지하고 이전 CI-only
candidate를 대체한다. config schema 4가 native-only peer address를 기존 AES-GCM envelope에 보관하고,
Android 13+에서는 `NEARBY_WIFI_DEVICES`를 위치 용도 없이 요청하며 구형 Android에서는 maxSdk 32 location
권한을 사용한다. UI에는 최대 16개 이름과 2분 opaque ID만 보인다. fixed P2P와 auto의 LAN→P2P→relay
순서를 제공하되 Android group-owner 결과를 제거하고, transport 실패만 다음 경로로 넘기며 TLS·SPKI·mTLS
실패는 fail closed다. Linux group-owner advertise/accept 자동화와 실제 하드웨어 연결은 남은 field gate다.
APK 전달·설치와 Companion 재시작은 하지 않고 current v1 후보 1.8.2, 별도 staged v1.8.3과 검증된
rollback 1.8.1을 그대로 보존한다.

PocketLink Linux P2P group-owner checkpoint decision: Linux가 한 Android peer를 광고·수락하고 별도 group
network를 여는 새 v2 network capability이므로 `feature`로 분류한다. 아직 현장 전달하지 않은 incompatible
v2 범위 안에서 SemVer `2.0.0`/Android `versionCode 20000`, 대상 `feature/v2-control-plane`을 유지하고
이전 CI-only candidate를 대체한다. `codex-pocket-p2p`는 Companion 자동 시작과 분리된 명시적 root
foreground 명령이며 enable flag, exact unmanaged interface, IPv4 wildcard Companion listener와 고정 subnet
비충돌을 모두 확인한다. 첫 valid PBC peer만 `go_intent=15`로 연결하고 Linux GO와 별도 group interface를
강제한다. DHCP는 그 interface에만 bind하고 lease를 파일에 쓰지 않으며 DNS/default route를 광고하지
않는다. peer MAC·SSID·WPS passphrase는 출력·영속화하지 않고 timeout·signal·오류에서 DHCP→주소→group→
listen→monitor 순서로 정리한다. 현재 PC에는 wpa_cli/dnsmasq가 없어 fake-control·source 검증만 수행하며
실제 adapter group formation은 field gate다. APK 전달·설치와 실행 중 Companion 재시작은 하지 않고
current v1 후보 1.8.2, 별도 staged v1.8.3과 검증된 rollback 1.8.1을 그대로 보존한다.

PocketLink automatic route checkpoint decision: LAN 우선·relay fallback을 선택하는 새 user-visible v2 transport
workflow이므로 `feature`로 분류한다. 아직 현장 전달하지 않은 incompatible v2 범위 안에서 SemVer
`2.0.0`/Android `versionCode 20000`, 대상 `feature/v2-control-plane`을 유지하고 이전 CI-only candidate를
대체한다. encrypted config schema 3은 schema 1 direct와 schema 2 direct/relay의 고정 경로를 유지하며,
새 auto만 relay credential을 요구한다. LAN TCP connect 실패만 relay 전환 조건으로 인정하고 TLS hostname·
SPKI·mTLS 실패는 fail closed이며 30초 monotonic cooldown으로 반복 LAN timeout을 제한한다. status에는
configured mode와 마지막 verified direct/relay만 포함하고 endpoint·slot·secret은 내보내지 않는다. APK
전달·설치와 실행 중 Companion 재시작은 하지 않고 current v1 후보 1.8.2, 별도 staged v1.8.3과 검증된
rollback 1.8.1을 그대로 보존한다. 이 기록은 이후 Android P2P checkpoint에서 확장됐다.

Android managed-device checkpoint decision: 기존 v2 native 보안 경로의 실제 AndroidKeyStore 자동 회귀가
비어 있던 문제를 수정하는 internal compatibility `patch`다. 아직 현장 전달하지 않은 incompatible v2
범위 안에서 SemVer `2.0.0`/Android `versionCode 20000`, 대상 `feature/v2-control-plane`을 유지하고 이전
CI-only candidate를 대체한다. API 30 managed device에서 합성 host·pin·relay secret·device/token만 사용해 설정과
background state의 AES-GCM 비노출·변조 거부, port AAD binding과 P-256 A/B private key 비추출성을 검사한다.
APK 전달·설치와 실행 중 Companion 재시작은 하지 않고 current v1 후보 1.8.2, 별도 staged v1.8.3과
검증된 rollback 1.8.1을 그대로 보존한다. 실제 알림 tray tap·background reconnect·음성은 실기기 gate에
남긴다.

Android notification Intent checkpoint decision: 기존 deep-link의 token·bounded identifier 처리와 extra
정리 경계를 API 30에서 실행하고 malformed action의 잔류 extra를 제거하는 internal compatibility
`patch`다. 아직 현장 전달하지 않은 incompatible v2 범위 안에서 SemVer `2.0.0`/Android
`versionCode 20000`, 대상 `feature/v2-control-plane`을 유지하고 이전 CI-only candidate를 대체한다.
합성 device/operation ID만 사용하며 실제 알림 게시·tray tap·process kill, APK 전달·설치와 실행 중
Companion 재시작은 수행하지 않는다. current v1 후보 1.8.2, 별도 staged v1.8.3과 검증된 rollback
1.8.1을 그대로 보존한다.

PocketLink relay foundation checkpoint decision: 외부 relay로 나가는 Companion tunnel과 별도 broker는 새 v2
network capability이므로 `feature`로 분류한다. 아직 현장 전달하지 않은 incompatible v2 범위 안이어서
SemVer `2.0.0`/Android `versionCode 20000`, 대상 `feature/v2-control-plane`을 유지하고 이전 CI-only
candidate를 대체한다. relay는 TLS-pinned outer transport 안에서 기존 PocketLink mTLS bytes만 전달하고
slot·secret은 broker에 영속화하거나 로그로 남기지 않는다. 공개 검사는 임시 certificate와 secret만
사용하며 실제 relay endpoint·개인 network 값·Provider key·유료 inference를 사용하지 않는다. APK
전달·설치와 실행 중 Companion 재시작은 하지 않고 current v1 후보 1.8.2, 별도 staged 1.8.3과 검증된
rollback 1.8.1을 그대로 보존한다.

Android relay connector checkpoint decision: Android relay 등록과 nested-TLS는 새 v2 network workflow라
`feature`로 분류한다. 아직 현장 전달하지 않은 incompatible v2 범위이므로 SemVer `2.0.0`/Android
`versionCode 20000`, 대상 `feature/v2-control-plane`을 유지하고 이전 CI-only candidate를 대체한다.
기존 direct 설정은 encrypted schema 1에서 2로 migration하고, 새 relay endpoint·hostname·pin·slot·secret은
같은 Keystore AES-GCM envelope에만 저장한다. Android는 relay의 public CA/hostname/SPKI와 내부 Companion
hostname/SPKI/client certificate를 별도로 검증하며 direct/SSH 자동 fallback은 하지 않는다. 공개 검사는
합성 값만 사용하고 APK 전달·설치, Companion 재시작과 실제 공용 relay 접속은 수행하지 않는다. current
v1 후보 1.8.2, staged 1.8.3과 검증된 rollback 1.8.1은 그대로 보존한다.

Mobile browser acceptance checkpoint decision: production build·pairing·Gateway·SSE·run·approval를 함께 검증하고
live diff를 모바일 진행 패널에 노출하는 새 v2 capability이므로 `feature`로 분류한다. 아직 현장 전달하지
않은 incompatible v2 범위 안이어서 SemVer `2.0.0`/Android `versionCode 20000`, 대상
`feature/v2-control-plane`을 유지하고 이전 CI-only candidate를 대체한다. 공개 검사는 합성 Codex client와
임시 인증·journal만 사용하며 실제 Provider, API key와 유료 inference를 호출하지 않는다. APK 전달·설치와
실행 중 Companion 재시작은 하지 않고 current v1 후보 1.8.2, 별도 staged 1.8.3과 검증된 rollback
1.8.1을 그대로 보존한다.

Provider contract checkpoint decision: 기존 v2 실행 계층의 run event 오귀속·중복과 Provider별 transport
failure 차이를 수정하는 internal compatibility `patch`다. 아직 전달하지 않은 v2 candidate 안의 변경이므로
기존 `breaking`/`2.0.0`, Android `versionCode 20000`, 대상 `feature/v2-control-plane`을 유지하고 이전
CI-only v2 artifact를 대체한다. Gateway protocol과 journal schema는 바꾸지 않는다. 공개 검사는 fake
runtime/HTTP/SSE만 사용하며 실제 API key·유료 inference·APK 설치·전달·Companion 재시작을 수행하지
않는다. current v1 후보 1.8.2, 별도 staged 1.8.3과 검증된 rollback 1.8.1을 변경하지 않는다.

OpenRouter selectable routing checkpoint decision: ZDR endpoint 기반 upstream lock과 사용자가 승인한 backup
선택은 새 user-visible v2 기능이므로 `feature`로 분류한다. 이미 진행 중인 incompatible v2 범위 안의
변경이어서 SemVer `2.0.0`/Android `versionCode 20000`, 대상 `feature/v2-control-plane`을 유지하고 이전
CI-only v2 artifact를 대체한다. Gateway protocol과 journal schema는 그대로 두고 encrypted operation
payload에 additive routing field만 기록한다. 실제 API key·유료 inference·APK 설치·전달·Companion
재시작은 수행하지 않는다. current v1 후보 1.8.2, 별도 staged 1.8.3과 검증된 rollback 1.8.1은 변경하거나
삭제하지 않는다.

OpenRouter catalog and smoke-readiness checkpoint decision: 모델/upstream 가격·성능·quota 표시는 새
user-visible v2 capability이고 보호된 실제 model grade workflow도 추가하므로 `feature`로 분류한다. 아직
현장 전달하지 않은 incompatible v2 범위 안이어서 SemVer `2.0.0`/Android `versionCode 20000`, 대상
`feature/v2-control-plane`을 유지하며 이전 CI-only v2 artifact를 대체한다. 수동 workflow는 GitHub
`provider-smoke` environment, model allowlist, exact ZDR tag, 2회 synthetic 호출과 $0.02 상한 없이는
실행되지 않는다. 호출당 2,048 input/64 output token ceiling, 자동 usage의 USD 기준 credit 비용과
opt-in router metadata의 exact model·첫 attempt·선택 provider도 fail-closed로 검사한다. 이
checkpoint에서는 실제 key·유료 inference·APK 설치·전달·Companion 재시작을 수행하지 않는다.
current v1 후보 1.8.2, 별도 staged 1.8.3과 검증된 rollback 1.8.1은 그대로 보존한다.

App run/journal state checkpoint decision: App 내부 경합과 복원 데이터 유실을 막는 v2 internal
compatibility 조정이므로 기존 `breaking`/`2.0.0`, Android `versionCode 20000`, 대상
`feature/v2-control-plane`을 유지한다. active run generation은 device/request/operation과
poll·stream·terminal 적용 범위를 묶고, journal generation은 conversation key와 queue device를
묶는다. Gateway API·저장 envelope·protocol은 바꾸지 않는다. 이 checkpoint는 source와 CI-only
APK만 갱신하고 현장 설치·Companion 재시작은 하지 않는다. current v1 후보 1.8.2, 별도 staged
1.8.3과 검증된 rollback 1.8.1을 변경하지 않는다.

App connection state checkpoint decision: 장치 전환·재연결 경합을 막는 v2 internal compatibility
조정이므로 기존 `breaking`/`2.0.0`, Android `versionCode 20000`, 대상
`feature/v2-control-plane`을 유지한다. 단조 증가 attempt ID에 device를 묶여 이전
initialize/SSE/pairing/diagnostics 응답을 무시하고, 새 attempt 초기화와 Android tunnel start를
순서 보장한다. API·저장·Gateway protocol은 바꾸지 않는다. 이 checkpoint는 source와
CI-only APK만 갱신하고 현장 설치·Companion 재시작은 하지 않는다. current v1 후보 1.8.2,
별도 staged 1.8.3과 검증된 rollback 1.8.1을 변경하지 않는다.

App voice/media state checkpoint decision: v2 내부의 구조 분리와 복구 안정성을 높이는 internal
compatibility 조정이므로 기존 `breaking`/`2.0.0`, Android `versionCode 20000`, 대상
`feature/v2-control-plane`을 유지한다. voice reducer는 single-shot/연속 recognizer transition과 fatal
종료를, media reducer는 최대 4개 attachment·동시 upload batch·progress·임시 ID 교체를
담당하며 기존 API·저장 format을 바꾸지 않는다. 이 checkpoint는 source와 CI-only APK만
갱신하고 현장 설치·Companion 재시작은 하지 않는다. current v1 후보 1.8.2, 별도 staged
1.8.3과 검증된 rollback 1.8.1을 변경하지 않는다.

Process-death notification checkpoint decision: WebView 회수 뒤에도 완료·승인·오류를 받는 새 user-visible v2
기능이므로 기존 `breaking`/`2.0.0`, Android `versionCode 20000`, 대상
`feature/v2-control-plane`을 유지한다. Companion은 paired bearer가 필요한 별도 SSE에서 schema/kind/
operation ID/시각/승인 만료시각만 보내고 prompt·workspace·응답·도구 세부정보는 내보내지 않는다. Android는
사용자가 켠 경우에만 최대 8개의 loopback target과 cursor/bearer를 별도 Keystore AES-GCM state에 저장하고
`connectedDevice` foreground service로 복구한다. 최초 구독은 현재 cursor에서 시작하고 10분 초과·만료
replay를 최신 16건으로 제한하며 foreground UI 중복을 억제한다. 이 checkpoint는 source와 CI-only APK만 갱신하며 현장 설치·
Companion 재시작은 하지 않는다. current v1 후보 1.8.2, 별도 staged 1.8.3과 검증된 rollback 1.8.1을
변경하지 않는다.

Official release discovery checkpoint decision: 공식 GitHub 정식판 조회·다운로드는 새 v2 user workflow이므로
기존 `breaking`/`2.0.0`, Android `versionCode 20000`, 대상 `feature/v2-control-plane`을 유지한다. Android가
hardcoded public 저장소의 Latest를 사용자가 누를 때만 조회하고, 두 번째 터치에서 정확한 versioned ZIP을
private cache로 내려받아 Release digest와 기존 signed-manifest/signer verifier를 모두 통과시킨다. 자동·주기적·
background 조회와 무인 설치는 추가하지 않는다. signed CI-only artifact에는 6-file update ZIP을 추가하지만
APK를 현장 전달·설치하거나 Companion을 재시작하지 않는다. 별도 staged 1.8.3 hotfix와 current v1 후보
1.8.2를 변경하지 않고, 검증된 1.8.1 rollback 세트를 계속 보존한다.

Session writer release checkpoint decision: 기존 handoff가 UI 상태만 떼고 app-server writer를 남기는 결함을
수정하는 internal compatibility `patch`다. 아직 전달하지 않은 v2 candidate를 교체하므로 SemVer
`2.0.0`/Android `versionCode 20000`과 대상 `feature/v2-control-plane`을 유지한다. idle handoff는 exact
workspace/thread 검증 후 즉시 `thread/unsubscribe`하고, running handoff는 작업을 보존한 채 완료·실패 후
해제한다. 이 checkpoint는 source와 CI-only candidate만 갱신하며 현재 v1 후보 1.8.2 및 rollback 1.8.1
APK를 변경·삭제하지 않고 실행 중 Companion도 재시작하지 않는다.

Session writer release retry checkpoint decision: 완료 handoff의 exact `thread/unsubscribe`가 일시 실패할 때
bounded backoff로 재시도하고 같은 thread의 동시 release를 deduplicate하는 internal compatibility
`patch`다. idle release는 모든 시도가 실패하면 handoff를 저장하지 않는 fail-closed 동작을 유지한다.
아직 현장 전달하지 않은 v2 candidate 안의 변경이므로 SemVer `2.0.0`/Android `versionCode 20000`, 대상
`feature/v2-control-plane`을 유지하고 이전 CI-only candidate를 대체한다. APK 전달·설치와 실행 중
Companion 재시작은 하지 않으며 current v1 후보 1.8.2, 별도 staged v1.8.3과 검증된 rollback 1.8.1을
그대로 보존한다.

Native signed update checkpoint decision: signed ZIP 선택·검토·설치 확인은 새 v2 user workflow이므로 기존
`breaking`/`2.0.0`, Android `versionCode 20000`, 대상 `feature/v2-control-plane`을 유지한다. importer는
current app signer/package와 exact manifest/APK/SBOM, 더 높은 versionCode를 요구하고 10분 private-cache
token과 설치 직전 rehash 뒤 Android system approval만 연다. URL 자동 download/background/무인 설치는
포함하지 않는다. 이 checkpoint는 source와 CI-only APK만 갱신하며 현장 설치나 Companion 재시작을
수행하지 않는다. current v1 후보 1.8.2와 검증된 rollback 1.8.1을 그대로 보존한다.

Signed update manifest checkpoint decision: APK 공급망 metadata와 offline 검증은 v2의 새 release capability이므로
기존 `breaking`/`2.0.0`, Android `versionCode 20000`, 대상 `feature/v2-control-plane`을 유지한다. 공식
CI build는 기존 Android signing secret으로 exact canonical manifest만 서명하고 private key를 artifact나
로그에 내보내지 않는다. 검증 시 caller가 별도로 보관한 certificate fingerprint와 APK 실제 signer를
함께 요구하며 변조·downgrade·기본 unsigned를 거부한다. 이 checkpoint는 source와 CI-only APK만
갱신하고 현장 APK 전달·설치나 Companion 재시작은 수행하지 않는다. current v1 후보 1.8.2와 검증된
rollback 1.8.1을 그대로 보존한다.

Read-only tool checkpoint decision: 기존 v2 Provider/Gateway 계약에 새 사용자 기능을 추가하는 2.0
범위이므로 분류와 버전은 `breaking`/`2.0.0`, 대상 브랜치는 `feature/v2-control-plane`을 유지한다.
이 checkpoint에서 Android versionCode 20000은 바꾸지 않고 APK를 현장 전달하지 않는다. current
설치 후보 1.8.2와 검증된 rollback 1.8.1 세트를 그대로 보존한다.

OpenRouter checkpoint decision: 새 Provider 실행·모델 catalog·비용 기록을 추가하는 v2 기능이므로
기존 `breaking`/`2.0.0`, Android `versionCode 20000`, `feature/v2-control-plane` 결정을 유지한다.
개발 source와 CI-only Android artifact만 갱신하고 APK를 현장 전달하거나 Companion을 재시작하지
않는다. current v1 APK 1.8.2와 rollback 1.8.1은 변경하지 않는다.

API conversation replay checkpoint decision: OpenAI/OpenRouter 다중 턴 대화 선택과 Companion 암호화
replay state를 추가하는 user-visible v2 기능이므로 기존 `breaking`/`2.0.0`, Android
`versionCode 20000`, 대상 `feature/v2-control-plane`을 유지한다. 상태는 Provider·workspace·model·account에
고정하고 최대 12턴·900 KiB로 제한하며 API/SSE/export에는 내보내지 않는다. 공개 검사는 fake Provider와
임시 암호화 journal만 사용하고 실제 API key·유료 inference·APK 설치·Companion 재시작을 수행하지
않는다. 이번 CI-only APK가 갱신되어도 current v1 후보 1.8.2와 검증된 rollback 1.8.1은 그대로 보존한다.

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

Operation organization checkpoint decision: 목표 이름·고정·보관과 이를 동기화하는 Gateway API/SSE를
추가하는 user-visible v2 기능이므로 기존 `breaking`/`2.0.0`, Android `versionCode 20000`, 대상
`feature/v2-control-plane`을 유지한다. metadata는 기존 operation 암호문 안에 저장해 journal schema를
바꾸지 않는다. pin은 7일/500 operation retention을 연장하지 않고 명시적 workspace 기록 삭제도
차단하지 않는다. 이번 변경은 source와 CI-only APK만 갱신하며 APK 전달·설치, 실행 중 Companion 재시작,
실제 Provider 호출을 수행하지 않는다. current v1 후보 1.8.2와 검증된 rollback 1.8.1을 그대로 보존한다.

Android notification checkpoint decision: opt-in native 완료·승인·오류 알림과 retained operation 이동을
추가하는 user-visible v2 기능이므로 기존 `breaking`/`2.0.0`, Android `versionCode 20000`, 대상
`feature/v2-control-plane`을 유지한다. 알림에는 prompt·workspace·응답을 넣지 않고 app-private random
token과 bounded device/operation ID만 전달한다. 이 checkpoint도 source와 CI-only APK만 갱신하며 APK
전달·설치, Companion 재시작과 실기기 권한·deep-link acceptance는 수행하지 않는다. current v1 후보
1.8.2와 검증된 rollback 1.8.1을 그대로 보존한다.

User retention checkpoint decision: Companion journal의 기간·operation·event 상한을 사용자가 bounded
범위에서 조정하고 즉시 정리하는 v2 기능이므로 기존 `breaking`/`2.0.0`, Android `versionCode 20000`,
대상 `feature/v2-control-plane`을 유지한다. 설정은 schema 1 additive table에 key-HMAC으로 인증하고,
same-origin API 확인값과 모바일 두 번째 터치를 요구한다. 이 checkpoint도 source와 CI-only APK만
갱신하며 APK 전달·설치, Companion 재시작과 실제 사용자 기록 migration을 수행하지 않는다. current
v1 후보 1.8.2와 검증된 rollback 1.8.1을 그대로 보존한다.

Approved API tool checkpoint decision: 기존 텍스트 파일 한 개의 검토된 교체와 격리된 npm 검증을
OpenAI/OpenRouter run에 추가하는 v2 기능이므로 `breaking`/`2.0.0`, Android `versionCode 20000`,
`feature/v2-control-plane` 결정을 유지한다. 실제 API key나 유료 inference를 사용하지 않고 fake Provider와
로컬 namespace sandbox로 검증한다. 이 checkpoint도 CI-only이며 APK 전달·설치나 Companion 재시작 없이
current v1 후보 1.8.2와 rollback 1.8.1을 보존한다.

Multi-file patch checkpoint decision: 2~8개 기존 파일을 하나의 검토·승인 단위로 교체하고 정상 runtime
실패를 원복하는 새 workspace workflow이므로 기존 `breaking`/`2.0.0`, Android `versionCode 20000`,
`feature/v2-control-plane` 결정을 유지한다. 파일당 12 KiB/전체 48 KiB, SHA·inode 재검사, 30 KiB 승인
본문 상한을 적용하며 생성·삭제·rename과 batch process-crash atomicity는 아직 활성화하지 않는다.
이번 변경도 source 및 CI-only APK만 갱신하고 실제 API key·유료 inference·APK 설치·Companion 재시작은
수행하지 않는다. current v1 후보 1.8.2와 검증된 rollback 1.8.1은 그대로 보존한다.

Crash-recoverable workspace change checkpoint decision: 검토된 새 텍스트 파일 생성·이름변경과 Companion
재시작 복구를 추가하는 user-visible workflow이므로 기존 `breaking`/`2.0.0`, Android
`versionCode 20000`, 대상 `feature/v2-control-plane`을 유지한다. 앱 전용 0700/0600 transaction journal은
본문·credential 없이 경로·hash·inode·mode와 staging/prepared/committed 상태만 보존한다. 불완전 작업은
재시작 시 원복하고 committed 결과는 유지하며, 외부 변경 때문에 모호하면 덮어쓰지 않고 초기화를
실패시킨다. 삭제·디렉터리 생성·chmod·binary는 활성화하지 않는다. 이번 변경도 source와 CI-only APK만
갱신하고 실제 API key·유료 inference·APK 전달·설치·Companion 재시작은 수행하지 않는다. current v1
후보 1.8.2와 검증된 rollback 1.8.1 세트는 그대로 보존한다.

Manual workspace recovery checkpoint decision: 자동 복구가 애매할 때도 읽기·운영 화면을 유지하고
변경 도구만 차단하는 새 v2 user workflow이므로 기존 `breaking`/`2.0.0`, Android
`versionCode 20000`, 대상 `feature/v2-control-plane`을 유지한다. 상태 API는 paired client에 최대
32개 transaction·각 16개 상대 경로만 제공하고 malformed journal이면 경로를 추측하지 않는다.
재시도는 same-origin 고정 확인값과 모바일 두 번째 터치를 요구하며 journal discard, force overwrite,
복구 artifact 삭제 경로를 추가하지 않는다. 이 checkpoint는 source와 CI-only APK만 갱신하고 실제
API key·유료 inference·APK 전달·설치·Companion 재시작을 수행하지 않는다. 별도 1.8.3 hotfix APK는
staged 상태로 보존하고, current v1 후보 1.8.2와 검증된 rollback 1.8.1 세트도 변경·삭제하지 않는다.

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

PocketLink QR checkpoint decision: camera-based reviewed bootstrap은 새 v2 user workflow이지만 이미 정한
전송계층 breaking 범위 안이므로 분류와 버전은 `breaking`/`2.0.0`, Android `versionCode 20000`, 대상
브랜치는 `feature/v2-control-plane`을 유지한다. QR은 기존 10분 pairing code와 공개 TLS/장치 정보만
담고 Provider key·token·프로젝트 경로를 포함하지 않는다. Android scanner는 QR 전용, 이미지 미저장,
2분 timeout이며 카메라 없는 단말에서는 기존 수동 입력을 유지한다. source와 CI-only APK만 갱신하고
현장 설치·Companion 재시작·LAN 노출은 하지 않는다. current 1.8.2, rollback 1.8.1과 Termux/SSH를 보존한다.

PocketLink device-proof checkpoint decision: Android non-exportable asymmetric identity와 Companion의
client-certificate/bearer 결합을 추가하지만 v2 전송 계약의 호환 범위 안이므로 분류와 버전은 기존
`breaking`/`2.0.0`, Android `versionCode 20000`, 대상 브랜치는 `feature/v2-control-plane`을 유지한다.
이 identity는 local port별 AndroidKeyStore P-256 key이고 삭제 시 해당 등록과 함께 해제한다. v1 auth
state는 token hash를 보존하고 TLS binding을 만들지 않으며, additive client field를 구버전이 무시할 수
있도록 schema version 1을 유지한다. source와 CI-only APK만 갱신하며 현장 설치·Companion 재시작·LAN
노출은 하지 않는다. current 1.8.2, rollback 1.8.1과 Termux/SSH transport를 그대로 보존한다.

PocketLink server-pin rotation checkpoint decision: 기존 연결에 새 backup SPKI pin을 준비하고 실제
backup pin TLS 성공을 관찰한 뒤 사용자가 두 번 확인해 새 primary로 승격·이전 pin 폐기하는 v2 기능이다.
이미 정한 전송계층 범위이므로 분류와 버전은 `breaking`/`2.0.0`, Android `versionCode 20000`, 대상
브랜치는 `feature/v2-control-plane`을 유지한다. 자동 승격·SSH downgrade는 없고 Android native가 최근
2분 관찰을 다시 검증한다. 이 checkpoint도 source/CI-only이며 APK 전달·설치, Companion 인증서 교체나
재시작, LAN 노출은 하지 않는다. current 1.8.2와 rollback 1.8.1 세트를 그대로 보존한다.

PocketLink client-identity rotation checkpoint decision: 기존 Android mTLS identity를 새 non-exportable
Keystore key로 교체하는 user-visible v2 workflow이므로 기존 `breaking`/`2.0.0`, Android
`versionCode 20000`, `feature/v2-control-plane` 결정을 유지한다. 현재 key의 TLS proof와 bearer로만
5분 승인을 시작하고, A/B pending slot과 승인 hash를 영속화해 응답 유실·process 회수를 복구한다.
Companion이 새 key proof를 확인하고 이전 binding을 거부한 뒤에만 Android가 이전 alias를 폐기하며,
불확실하면 두 key를 보존하고 자동 rollback/downgrade하지 않는다. 이 checkpoint도 source/CI-only이며
APK 전달·설치, Companion 재시작 또는 LAN 노출은 하지 않는다. current 1.8.2 후보와 rollback 1.8.1은
변경하지 않는다.

PocketLink LAN discovery checkpoint decision: 같은 LAN의 Companion 주소 후보를 찾는 새 user-visible
workflow이므로 이미 정한 `breaking`/`2.0.0`, Android `versionCode 20000`, 대상
`feature/v2-control-plane`을 유지한다. Companion 광고는 정확히 `CODEX_POCKET_LINK_DISCOVERY=1`일 때만
PC 이름·TLS port·protocol version을 내보내고 신뢰 pin·pairing code·device ID·token·프로젝트 정보는
내보내지 않는다. Android는 user-triggered 8초/16후보/private-address/2분 review만 제공하고 pin 수동
대조 전에는 연결·페어링하지 않으며 SSH로 fallback하지 않는다. 이 변경은 source와 CI-only APK만
갱신하며 아직 전달하지 않은 이전 v2 CI artifact를 같은 pre-handoff `2.0.0` candidate로 대체한다.
APK를 현장 전달·설치하거나 Companion을 재시작·LAN에 노출하지 않고, current v1 후보 1.8.2와 별도
staged 1.8.3, 검증된 rollback 1.8.1을 그대로 보존한다.

PocketLink public relay admission checkpoint decision: source별 동시 연결·fixed-window 연결 시작/new-slot
제한과 식별자 없는 aggregate 운영 지표를 추가하는 새 server 운영 capability이므로 `feature`로 분류한다.
아직 현장 전달하지 않은 incompatible v2 범위 안에서 SemVer `2.0.0`/Android `versionCode 20000`, 대상
`feature/v2-control-plane`을 유지하고 이전 CI-only candidate를 대체한다. broker는 source·slot access log를
만들지 않으며 실제 공용 endpoint 노출과 edge DDoS·실부하 검증은 release gate 전까지 수행하지 않는다.
APK 전달·설치와 실행 중 Companion 재시작도 하지 않고 current v1 후보 1.8.2, 별도 staged v1.8.3과
검증된 rollback 1.8.1을 그대로 보존한다.

PocketLink relay pre-TLS admission checkpoint decision: TCP accept부터 handshake deadline, pre-handshake
socket의 bounded shutdown과 합성 burst 검증을 추가하는 새 public server 운영 capability이므로
`feature`로 분류한다. 아직 현장 전달하지 않은 incompatible v2 범위 안에서 SemVer `2.0.0`/Android
`versionCode 20000`, 대상 `feature/v2-control-plane`을 유지하고 이전 CI-only candidate를 대체한다.
실제 공용 endpoint 노출·외부 부하/DDoS 시험, APK 전달·설치와 실행 중 Companion 재시작은 하지 않는다.
current v1 후보 1.8.2, 별도 staged 1.8.3과 검증된 rollback 1.8.1을 그대로 보존한다.

PocketLink bootstrap state checkpoint decision: QR/LAN bootstrap의 분산 UI 상태를 순수 reducer로
분리하고 stale·동시 전이를 fail-closed로 바꾸는 internal compatibility `patch`다. 아직 전달하지 않은
v2 안의 변경이므로 SemVer `2.0.0`/Android `versionCode 20000`과 대상
`feature/v2-control-plane`을 유지하고 이전 CI-only v2 artifact를 대체한다. APK 설치·전달이나 Companion
재시작은 하지 않으며 current v1 후보 1.8.2, 별도 staged 1.8.3과 rollback 1.8.1을 그대로 보존한다.

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

- GitHub Release assets: 장기 보존하는 정식 배포 APK, SHA256SUMS, SBOM, signed update manifest·서명·
  인증서와 `Codex-Pocket-Voice-vX.Y.Z-update.zip`. 역사적 `v1.5.0`과 `v1.6.0` Release에는 APK만
  있으므로 Android 공식판 조회 설치 대상이 아니다.
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
