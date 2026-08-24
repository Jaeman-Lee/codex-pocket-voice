# Changelog

이 문서는 사용자가 설치할 수 있는 배포판과 개발 중 CI 산출물을 구분한다.

## 2.0.0 development — provider runtime foundation

Update decision: Provider 실행 계약, Gateway 프로토콜과 이후 작업 저널·전송 계층을 확장하는
호환 불가능한 v2 작업이므로 `breaking`으로 분류하고 `2.0.0`/Android `versionCode 20000`으로
올린다. 구현 대상은 `feature/v2-control-plane` 브랜치이다. 아직 2.0 APK를 현장 전달하지 않으며
1.8.2를 current v1 후보, 1.8.1을 검증된 rollback 세트로 유지한다. 최초 2.0 candidate를 설치할
때도 1.8.1 rollback을 보존한다.

- Protected Provider execution gate fix는 `provider-smoke` environment가 실제로 보호되기 전에 저장소
  수준 API key만으로 명시적 dispatch가 실행될 수 있던 release validation 경계를 고치는 internal
  compatibility `patch`다. 아직 전달하지 않은 incompatible v2 범위 안에서 `2.0.0`/Android
  `versionCode 20000`, `feature/v2-control-plane`을 유지하고 이전 CI-only candidate를 대체한다. 실제
  Provider 호출·APK 전달·설치·Companion 재시작은 하지 않으며 current v1 후보 1.8.2, staged v1.8.4,
  검증된 1.8.1 rollback과 배포 중인 v1.8.3 Companion을 보존한다.
- 보호된 실행은 environment reviewer와 branch policy를 먼저 설정한 뒤 environment 전용
  `PROVIDER_SMOKE_ENVIRONMENT_READY=PROTECTED_PROVIDER_SMOKE_V1` variable과 dispatch의 exact
  `RUN_BOUNDED_PROVIDER_SMOKE` 확인문을 모두 요구한다. 하나라도 없으면 checkout·dependency 설치·
  inference 전에 실패한다. 일반 push/PR과 `provider=none` dispatch는 Provider 호출을 실행하지 않고
  reusable Provider job을 `skipped`로 기록한다. `release:check`의 단위 검사 306개와 실제 app-server
  통합 3개, production build·schema 일치·SBOM이 통과했다.
- Pre-merge Provider smoke dispatch bridge는 v2 브랜치에만 있는 standalone `workflow_dispatch`가 GitHub
  default-branch 등록 규칙 때문에 field acceptance 전에 실행될 수 없던 release validation deadlock을
  고치는 internal compatibility `patch`다. 아직 전달하지 않은 incompatible v2 범위 안에서 `2.0.0`/
  Android `versionCode 20000`, `feature/v2-control-plane`을 유지하고 이전 CI-only candidate를 대체한다.
  실제 Provider 호출·APK 전달·설치·Companion 재시작은 하지 않으며 current v1 후보 1.8.2, staged
  v1.8.4, 검증된 1.8.1 rollback과 배포 중인 v1.8.3 Companion을 보존한다.
- default branch에 이미 등록된 Linux checks workflow가 `provider=none`을 기본값으로 유지하고, 명시적
  `openai`/`openrouter` dispatch와 기존 Node 검사 성공 뒤에만 reusable protected smoke를 호출한다.
  일반 push/PR과 `none` dispatch는 API key를 참조하거나 Provider 호출을 실행하지 않고 reusable job을
  `skipped`로 기록한다. 두 Provider job은 동시 유료 실행을 직렬화하고 기존 `provider-smoke`
  environment·exact allowlist·비용 상한을 유지한다.
  `release:check`의 단위 검사 306개와 실제 app-server 통합 3개, production build·schema 일치·SBOM이
  통과했다.
- Exact-head Android candidate fix는 PR artifact가 feature head 대신 GitHub 임시 merge commit을 build하고
  manifest에 기록해 clean feature checkout 기반 field gate와 결합할 수 없던 provenance 오류를 고치는
  internal compatibility `patch`다. 아직 전달하지 않은 incompatible v2 범위 안에서 `2.0.0`/Android
  `versionCode 20000`, `feature/v2-control-plane`을 유지하고 기존 CI-only 2.0 artifact를 대체한다.
  APK 전달·설치, 실제 field·Provider 호출과 Companion 재시작은 하지 않으며 current v1 후보 1.8.2,
  staged v1.8.4, 검증된 1.8.1 rollback과 배포 중인 v1.8.3 Companion을 보존한다.
- Android candidate workflow는 PR의 exact head SHA를 checkout하고 실제 `git rev-parse HEAD`가 예상 SHA와
  같은지 확인한 뒤 signed/unsigned manifest 모두 그 값만 기록한다. `$GITHUB_SHA` 임시 merge commit을
  candidate identity로 사용하는 회귀를 source 계약으로 차단한다. `release:check`의 단위 검사 304개와
  실제 app-server 통합 3개, production build·schema 일치·SBOM이 통과했다.
- Final release evidence gate는 기능 observation과 transport별 저부하 결과를 수동 대조하던 절차를 한
  exact candidate 판정으로 고정하는 developer validation이므로 internal compatibility `patch`다. 아직
  전달하지 않은 incompatible v2 범위 안에서 `2.0.0`/Android `versionCode 20000`,
  `feature/v2-control-plane`을 유지하고 이전 CI-only candidate를 대체한다. 실제 field 실행·서명 암호
  검증·APK 전달·설치·Provider 호출·Companion 재시작은 하지 않으며 current v1 후보 1.8.2, staged
  v1.8.4, 검증된 1.8.1 rollback과 배포 중인 v1.8.3 Companion을 보존한다.
- 기능 observation을 다시 평가하고 direct LAN/P2P/outbound relay schema 2 report의 candidate·slot·
  30일 freshness와 aggregate threshold를 재계산한다. candidate drift, report 위치 교환, extra field,
  편집된 verdict와 wall/monotonic duration 불일치는 출력 없이 거부하고, 완전하지만 실패한 evidence는
  owner-only create-once aggregate에 fail로 남긴다. `release:check`의 단위 검사 303개와 실제 app-server
  통합 3개, production build·schema 일치·SBOM이 통과했다.
- Candidate-bound Android low-load evidence fix는 기존 60분 ADB report가 SemVer만 기록해 같은
  `2.0.0`의 다른 APK build와 direct LAN/P2P/outbound relay를 구분하지 못한 release evidence 결함을
  고치는 internal compatibility `patch`다. 아직 전달하지 않은 incompatible v2 범위 안에서 `2.0.0`/
  Android `versionCode 20000`, `feature/v2-control-plane`을 유지하고 이전 CI-only candidate를 대체한다.
  APK 전달·설치, 실제 측정·Provider 호출과 Companion 재시작은 하지 않으며 current v1 후보 1.8.2,
  staged v1.8.4, 검증된 1.8.1 rollback과 배포 중인 v1.8.3 Companion을 보존한다.
- pre-handoff 저부하 report schema를 2로 교체해 canonical signed manifest의 전체 candidate identity,
  clean source commit, APK digest, exact `direct_lan`/`p2p`/`outbound_relay`와 측정 시작·종료 시각을
  기록한다. manifest·transport 누락, source/설치 package/versionCode drift는 ADB 측정 전에 실패한다.
  `release:check`의 단위 검사 297개와 실제 app-server 통합 3개, production build·schema 일치·SBOM이
  통과했다.
- Functional field acceptance harness는 기존 v2 physical/provider release checklist를 exact candidate에
  묶어 반복 가능하게 검증하는 developer validation이므로 internal compatibility `patch`다. 아직 전달하지
  않은 incompatible v2 범위 안에서 `2.0.0`/Android `versionCode 20000`,
  `feature/v2-control-plane`을 유지하고 이전 CI-only candidate를 대체한다. APK 전달·설치, 실제 Provider
  호출과 실행 중 Companion 재시작은 하지 않으며 current v1 후보 1.8.2, staged v1.8.4, 검증된 1.8.1
  rollback과 배포 중인 v1.8.3 Companion을 보존한다.
- 별도 검증한 signed update manifest의 version/commit·manifest/APK/signer digest와 clean checkout을
  observation에 결합한다. 생성 템플릿은 20개 scenario가 전부 `not_run`인 실패 상태이고, 실제 API 30+
  Android, Companion/client 각 2대, OpenRouter upstream 계열 2개, 여섯 attestation과 모든 scenario가
  통과해야 owner-only create-once report가 pass된다.
- schema는 device/network identifier, credential, prompt/response, 오류 원문과 자유 형식 note를 허용하지
  않으며 후보 drift·누락·중복·미래/30일 초과 결과를 실패-폐쇄로 거부한다. 이 report는 실제 실행을 대신하지
  않는 `operator_attested_structured` 증거로 표시한다. `release:check`의 단위 검사 296개와 실제
  app-server 통합 3개, production build·schema 일치·SBOM이 통과했다.
- Durable Gateway authorization fix는 동시 pairing·revoke·TLS key rotation의 상태 파일 쓰기가 겹쳐
  재시작 뒤 token 권한이나 단말 key가 역행할 수 있던 v2 보안 결함을 고치는 `patch`다. 아직 전달하지
  않은 incompatible v2 범위 안에서 `2.0.0`/Android `versionCode 20000`,
  `feature/v2-control-plane`을 유지하고 이전 CI-only candidate를 대체한다. APK 전달·설치, 실제 Provider
  호출과 실행 중 Companion 재시작은 하지 않으며 current v1 후보 1.8.2, staged v1.8.4, 검증된 1.8.1
  rollback과 배포 중인 v1.8.3 Companion을 보존한다.
- Gateway token claim/revoke와 PocketLink TLS key rotation의 start/inspect/complete/abort/finalize를 한
  durable mutation queue로 직렬화한다. atomic file replace가 성공한 뒤에만 새 인증 상태를 공개하므로
  저장 실패한 pairing은 ghost client를 만들지 않고, 실패한 revoke는 기존 token을 보존하며, 실패한 key
  교체는 이전 TLS identity만 계속 허용한다.
- 지연 writer로 동시 pairing 두 건이 모두 복원되는지, 같은 단말의 동시 rotation은 한 건만 발급되는지,
  claim/revoke/rotation 저장 실패가 live 권한을 바꾸지 않는지를 결정적으로 검사한다. `release:check`의
  단위 검사 291개와 실제 app-server 통합 3개, production build·schema 일치·SBOM이 통과했다.
- Durable session handoff persistence fix는 동시에 들어온 release/claim의 상태 파일 쓰기가 역순으로
  끝나 Companion 재시작 뒤 오래된 handoff가 되살아날 수 있던 v2 결함을 고치는 `patch`다. 아직
  전달하지 않은 incompatible v2 범위 안에서 `2.0.0`/Android `versionCode 20000`,
  `feature/v2-control-plane`을 유지하고 이전 CI-only candidate를 대체한다. APK 전달·설치, 실제 Provider
  호출과 실행 중 Companion 재시작은 하지 않으며 current v1 후보 1.8.2, staged v1.8.4, 검증된 1.8.1
  rollback과 배포 중인 v1.8.3 Companion을 보존한다.
- handoff 저장소의 release/claim은 이제 한 mutation queue에서 호출 순서대로 atomic file replace를
  완료한 뒤에만 메모리 상태를 공개한다. 저장 실패는 해당 변경을 메모리에도 반영하지 않고, 다음 요청은
  마지막으로 저장된 상태에서 안전하게 재시도한다.
- 지연 writer로 동시 쓰기가 겹치지 않고 최신 동일-thread release만 재시작 뒤 복원되는지, 합성 저장
  실패 뒤 ghost handoff가 남지 않는지를 결정적으로 검사한다. `release:check`의 단위 검사 288개와 실제
  app-server 통합 3개, production build·schema 일치·SBOM이 통과했다.
- Atomic session claim fix는 여러 기기가 같은 handoff를 동시에 이어받거나, claim 실패 뒤 모바일만
  해당 대화로 전환될 수 있던 v2 결함을 고치는 `patch`다. 아직 전달하지 않은 incompatible v2 범위
  안에서 `2.0.0`/Android `versionCode 20000`, `feature/v2-control-plane`을 유지하고 이전 CI-only
  candidate를 대체한다. APK 전달·설치, 실제 Provider 호출과 실행 중 Companion 재시작은 하지 않으며
  current v1 후보 1.8.2, staged v1.8.4, 검증된 1.8.1 rollback과 배포 중인 v1.8.3 Companion을 보존한다.
- Gateway의 handoff claim은 경합 시 단 하나만 성공하고 뒤늦은 요청에는 404/409를 반환한다. 모바일은
  exact thread와 남아 있는 operation의 Codex/provider/workspace/conversation 소유권을 먼저 검증한 뒤
  서버 claim을 완료하며, 응답 handoff도 원래 대상과 일치해야만 프로젝트·대화·메시지를 전환한다.
  claim 실패·응답 유실·장치 전환에서는 기존 로컬 세션을 그대로 두고 성공으로 추측하지 않는다.
- Codex handoff는 OpenAI/OpenRouter 화면에 도착한 늦은 조회나 SSE에서 표시하지 않으며 사용자가 Codex를
  명시적으로 선택해야 다시 조회한다. 활성 요청·작업이나 이 기기에만 있는 Queue가 있으면 이어받기를
  차단해 현재 상태를 버리지 않는다.
- exact/malformed/경쟁 claim과 Provider·선택 변경 경계를 단위·Gateway 통합 검사로 고정했고,
  `release:check`의 단위 검사 286개와 실제 app-server 통합 3개를 통과했다. claim 실패 시 기존 선택을
  유지하는 320px production 브라우저 회귀는 PR Chromium CI에서 확인한다.
- Exact project session scope fix는 선택한 프로젝트의 부모 경로가 하위 프로젝트 대화까지 표시·반납할
  수 있던 v2 결함을 고치는 `patch`다. 아직 전달하지 않은 incompatible v2 범위 안에서
  `2.0.0`/Android `versionCode 20000`, `feature/v2-control-plane`을 유지하고 이전 CI-only candidate를
  대체한다. APK 전달·설치, 실제 Provider 호출과 실행 중 Companion 재시작은 하지 않으며 current v1
  후보 1.8.2, staged v1.8.4, 검증된 1.8.1 rollback과 배포 중인 v1.8.3 Companion을 그대로 보존한다.
- 모바일의 Codex 대화 목록과 세션 반납은 이제 선택한 프로젝트의 exact `cwd`만 대상으로 삼는다.
  오래된 로컬 선택이 섞이면 호출 전에 목록을 다시 동기화하고 반납하지 않는다. Gateway도 정규화한
  workspace와 thread `cwd`가 완전히 같은 경우에만 기존 대화 실행·반납·이어받기를 허용하며,
  하위 폴더 또는 같은 이름의 다른 프로젝트는 409로 차단하고 writer를 해제하지 않는다.
- exact/nested/다른 프로젝트 경계와 writer 비호출을 단위·Gateway 통합 검사로 고정했고,
  `release:check`의 단위 검사 281개와 실제 app-server 통합 3개를 통과했다. 320px production
  브라우저 회귀는 로컬 host의 `libatk-1.0.so.0` 부재로 시작하지 못해 PR Chromium CI에서 확인한다.
- Paired-device removal authorization fix는 v2 연결 센터의 기존 삭제 동작이 Companion
  client 권한을 남길 수 있던 보안 결함을 고치는 `patch`다. 아직 전달하지 않은 incompatible
  v2 범위 안에서 `2.0.0`/Android `versionCode 20000`, `feature/v2-control-plane`을 유지하고
  이전 CI-only candidate를 대체한다. APK 전달·설치, 실제 Provider 호출과 실행 중 Companion
  재시작은 하지 않으며 current v1 후보 1.8.2, staged v1.8.4, 검증된 1.8.1 rollback과
  배포 중인 v1.8.3 Companion을 그대로 보존한다.
- Linux PC 등록의 `삭제`는 이제 별도 터치 검토를 열고, 선택한 target token으로
  same-origin `POST /api/pairing/revoke`의 exact `{ revoked: true }`를 확인한 뒤에만 Android
  PocketLink config/A·B identity key와 로컬 등록을 순서대로 제거한다. PC offline,
  malformed 응답, missing token, mTLS identity 불일치에서는 원격 권한과 로컬 key·등록을
  fail-closed로 남겨 다시 시도한다.
- 권한 해제 응답이 유실된 뒤의 exact `INVALID_TOKEN`은 이미 해제된 것으로만 해석해
  target을 먼저 미페어링으로 저장하고 token·event cursor·key-rotation 승인을 지운다.
  네이티브 key 정리가 실패하면 미페어링 등록을 남겨 idempotent retry하며,
  `TLS_DEVICE_MISMATCH`는 bearer token을 삭제하지 않아 회전·해제 복구 가능성을 보존한다.
- Gateway는 revoke body를 빈 object로 고정하고 인증된 exact client만 해제하며 다른 client는
  계속 사용 가능함을 통합 검사로 고정했다. API failure-boundary·순서 단위 검사와 320px
  두 번 터치 브라우저 acceptance를 추가했다.
- Android 저부하 field acceptance harness는 기존 Phase E release 검증을 자동 판정하는 internal
  compatibility `patch`다. 아직 전달하지 않은 incompatible v2 범위 안에서 `2.0.0`/Android
  `versionCode 20000`, `feature/v2-control-plane`을 유지하고 이전 CI-only candidate를 대체한다. APK
  전달·설치, 실제 Provider 호출과 실행 중 Companion 재시작은 하지 않으며 current v1 후보 1.8.2,
  staged v1.8.4와 검증된 v1.8.1 rollback을 그대로 보존한다.
- 읽기 전용 ADB 도구는 설치 versionName/versionCode를 먼저 대조하고 60분 동안 exact app process의 CPU,
  PSS/RSS, unplugged battery 감소와 UID background partial wake delta를 bounded 수집한다. release mode는
  process·metric coverage 95%, CPU p95 5%, PSS max 192 MiB, battery 4%/h, background wake 10% 기준을 모두
  만족해야 통과한다. unknown 형식·충전·counter reset·수집 누락은 fail closed다.
- owner-only create-once JSON에는 aggregate와 기준별 verdict만 남기고 device serial/model/UID, PID,
  주소·SSID·port, 설치 경로와 원본 ADB 출력은 넣지 않는다. fixture 검사는 비밀 표식 비노출과
  `--reset`/`--checkin`/앱·네트워크 변경 명령 부재를 고정한다. 실제 물리 단말 수치는 아직 측정하지 않았고
  direct/P2P/relay별 장시간 결과는 계속 field release gate다.
- Android notification tray deep-link 계측은 기존 v2 알림의 실제 system-UI 경로를 자동 검증하는 internal
  compatibility `patch`다. 아직 현장 전달하지 않은 incompatible v2 범위 안에서 `2.0.0`/Android
  `versionCode 20000`, `feature/v2-control-plane`을 유지하고 이전 CI-only candidate를 대체한다. APK
  전달·설치, 실제 Provider 호출과 실행 중 Companion 재시작은 하지 않으며 current v1 후보 1.8.2,
  staged v1.8.4와 검증된 v1.8.1 rollback을 그대로 보존한다.
- SystemUI를 포함한 API 30 AOSP Managed Device는 안정판 AndroidX UI Automator로 합성 generic 승인 알림을
  게시하고 system tray를 열어 실제 notification을 탭한다. MainActivity가 app-private token에 묶인 exact
  device/operation을 한 번만 소비하는지 확인하고 테스트 알림·화면 상태를 정리한다. SystemUI를 제거한
  ATD는 이 검사를 증명할 수 없어 사용하지 않는다. 물리 단말 잠금화면·process-kill·절전 검증은 현장
  release gate로 유지한다.
- API 30 SystemUI가 거부하던 notification small-icon vector의 잘못된 마지막 arc 좌표를 수정한다. 동일한
  아이콘을 쓰는 work notification, background event service와 PocketLink foreground service가 실제
  system tray에서 렌더링되는지 위 계측 경로로 검증한다.
- Android background network-transition reconnect는 notification SSE가 끊긴 뒤 최대 60초 backoff를
  기다릴 수 있던 기존 v2 native 동작을 고치는 internal compatibility `patch`다. 아직 현장 전달하지 않은
  incompatible v2 범위 안에서 `2.0.0`/Android `versionCode 20000`, `feature/v2-control-plane`을 유지하고
  이전 CI-only candidate를 대체한다. APK 전달·설치, 실제 Provider 호출과 실행 중 Companion 재시작은
  하지 않으며 current v1 후보 1.8.2, staged v1.8.4와 검증된 v1.8.1 rollback을 그대로 보존한다.
- opt-in notification foreground service는 Android default network의 available/lost callback을 한 개만
  등록한다. 전환 시 현재 loopback SSE를 닫고 대기 중인 exponential backoff를 깨워 1초 기준부터 다시
  연결하며, callback 등록이 불가능하면 기존 최대 60초 bounded retry를 유지한다. service 종료 시 callback과
  모든 waiter/HTTP 연결을 해제하고 network·device·token 값은 callback state나 로그에 저장하지 않는다.
- Privacy-safe diagnostic support bundle은 현장 문제를 사용자가 내려받아 전달하는 새 user-visible
  workflow이므로 `feature`로 분류한다. 아직 현장 전달하지 않은 incompatible v2 범위 안에서
  `2.0.0`/Android `versionCode 20000`, `feature/v2-control-plane`을 유지하고 이전 CI-only candidate를
  대체한다. APK 전달·설치, 실제 Provider 호출과 실행 중 Companion 재시작은 하지 않으며 current v1
  후보 1.8.2, staged v1.8.4와 검증된 v1.8.1 rollback을 그대로 보존한다.
- 인증된 `/api/diagnostics/support-bundle`은 앱·Gateway protocol/capability, Linux architecture·Node,
  필수/선택 도구의 가용성과 정규화된 version token, workspace/생성 위치 개수만 allowlist JSON으로
  내려준다. 환경 변수·credential, 장치 ID·주소/port, 프로젝트 경로·Git 정보, prompt/response·명령/
  오류 원문, journal·approval·artifact content는 구조적으로 포함하지 않는다.
- 임의 executable의 `--version` 원문은 더 이상 diagnostics로 전달하지 않고 알려진 도구 prefix 뒤의
  bounded version token만 남긴다. export는 bearer/mTLS 인증, `no-store`/`nosniff` attachment를 사용하고
  Gateway `diagnosticSupportBundle` capability가 없는 구형 Companion에서는 모바일 버튼을 숨긴다.
- Approval diff line feedback은 모바일 승인함에서 변경 줄을 검토하고 Provider에 수정 의견을 돌려보내는
  새 user-visible workflow이므로 `feature`로 분류한다. 아직 현장 전달하지 않은 incompatible v2 범위
  안에서 `2.0.0`/Android `versionCode 20000`, `feature/v2-control-plane`을 유지하고 이전 CI-only
  candidate를 대체한다. APK 전달·설치, 실제 Provider 호출과 실행 중 Companion 재시작은 하지 않으며
  current v1 후보 1.8.2, staged v1.8.4와 검증된 v1.8.1 rollback을 그대로 보존한다.
- 승인함의 unified diff를 파일 header·hunk·이전/새 줄 번호·추가·삭제 색으로 구분하고 긴 줄과 경로를
  내부 wrap/scroll로 제한한다. 최대 24,000자·300줄·줄당 2,000자만 렌더링하며, 서버와 같은 안전한
  500자 이하 프로젝트 상대 경로의 추가·삭제 줄만 피드백 대상으로 선택할 수 있다.
- 사용자는 최대 8개 변경 줄에 줄당 600자 의견을 입력할 수 있다. 선택한 모든 줄의 의견이 있어야
  `거절하고 피드백 전송`이 활성화되고, 선택 중 승인은 비활성화된다. 서버는 12 KiB payload, 경로·
  줄 번호·한 줄 code·중복·추가 필드를 다시 검사하고 same-origin 화면 터치 거절에만 허용한다.
- 거절 결과는 별도 run을 만들지 않고 기존 OpenAI Responses `function_call_output` 또는 OpenRouter
  `tool` message에 전달한다. 두 Provider에는 같은 run에서 제안을 수정하고 fresh approval을 요청하도록
  공통 지시하며, 거절된 도구는 실행하지 않는다. resolution은 기존 암호화 Companion journal에 남고
  native 알림에는 피드백·경로·code를 내리지 않는다. diff header 주입을 막기 위해 workspace 변경 경로의
  제어문자도 승인 생성 전에 거절한다.
- Run artifact review는 완료 작업에서 test/log/image/APK를 검토·다운로드하는 새 user-visible
  workflow이므로 `feature`로 분류한다. 아직 현장 전달하지 않은 incompatible v2 범위 안에서
  `2.0.0`/Android `versionCode 20000`, `feature/v2-control-plane`을 유지하고 이전 CI-only candidate를
  대체한다. APK 전달·설치, 실제 Provider 호출과 실행 중 Companion 재시작은 하지 않으며 current v1
  후보 1.8.2, staged v1.8.4와 검증된 v1.8.1 rollback을 그대로 보존한다.
- OpenAI/OpenRouter의 격리된 `project_verify` stdout/stderr와 Codex command output은 비밀값을 다시
  마스킹한 immutable log snapshot으로 분리한다. run이 변경으로 보고한 프로젝트 내부 regular file 중
  bounded test report, raster image와 APK만 최대 8개·총 256 MiB까지 owner-private 저장소로 복사한다.
  상대 경로 이탈, symlink, 민감 경로, 허용되지 않은 확장자와 변경 중인 파일은 제외한다.
- operation에는 opaque ID, 이름, kind, MIME, 크기, SHA-256과 bounded text preview만 암호화해 남긴다.
  다운로드는 인증된 exact operation/artifact route만 허용하고 원래 workspace 경로나 임의 파일 탐색 API를
  제공하지 않는다. 프로젝트 기록을 명시적으로 삭제하면 연결된 snapshot도 함께 삭제한다. 모바일 카드는
  320px에서 test/log preview와 image/APK 메타데이터·checksum·다운로드를 내부 wrap/scroll로 표시한다.
- Spoken settings touch review는 프로젝트·AI 연결·모델을 음성으로 선택하는 새 user-visible workflow이므로
  `feature`로 분류한다. 아직 현장 전달하지 않은 incompatible v2 범위 안에서 `2.0.0`/Android
  `versionCode 20000`, `feature/v2-control-plane`을 유지하고 이전 CI-only candidate를 대체한다.
  APK 전달·설치, 실제 Provider 호출과 실행 중 Companion 재시작은 하지 않으며 current v1 후보
  1.8.2, staged v1.8.4와 검증된 v1.8.1 rollback을 그대로 보존한다.
- 일반 받아쓰기는 요청문만 편집하고, 별도 `설정 말하기` 단발 모드에서만
  `프로젝트/AI 연결/모델 + 정확한 현재 이름 + 선택·변경·전환` 한 가지를 해석한다. separator만
  정규화한 exact alias가 없거나 둘 이상이면 추측하지 않고 거절하며 최대 transcript·후보·native hint를
  제한한다. 음성 종료는 inert review만 만들고 선택값과 입력 중 prompt를 변경하지 않는다.
- 검토 화면은 인식문과 현재→대상을 320px 내부 scroll sheet에 표시하고 명시적인 화면 터치 뒤에만
  적용한다. 확인 시 exact device·workspace·Provider·model owner, active run/Fork 상태와 최신 selectable
  catalog를 다시 검사한다. Provider 모델 목록은 기존 선택을 바꾸기 전에 먼저 읽어 실패 시 원자적으로
  유지하며, 선택 중 작업 상태가 달라져도 적용하지 않는다.
- Project speech glossary는 PC·프로젝트별 받아쓰기 보정을 추가하는 새 user-visible workflow이므로
  `feature`로 분류한다. 아직 현장 전달하지 않은 incompatible v2 범위 안에서 `2.0.0`/Android
  `versionCode 20000`, `feature/v2-control-plane`을 유지하고 이전 CI-only candidate를 대체한다.
  APK 전달·설치, 실제 Provider 호출과 실행 중 Companion 재시작은 하지 않으며 current v1 후보
  1.8.2, staged v1.8.4와 검증된 v1.8.1 rollback을 그대로 보존한다.
- 사용자가 검토한 `인식되는 말 → 요청에 넣을 표기`를 최대 32개 저장한다. 긴 표현을 먼저 적용하고
  단어 경계를 벗어난 부분·연쇄 치환은 건드리지 않으며, 직접 입력한 문장 대신 새 partial/final
  음성 구간만 보정해 전송 전 textarea에서 다시 편집할 수 있다. Android 13 이상에서는 고유한
  표기만 bounded recognition bias로 보내고 구형 Android·PWA도 동일한 로컬 후처리를 사용한다.
- 사전은 exact device+workspace에 고정하고 기존 WorkJournal AES-GCM key로 암호화한다. IndexedDB,
  localStorage rollback mirror와 Android SQLite에는 domain-separated SHA-256 scope만 남기며 Android
  journal schema 1→2는 기존 conversation·queue row를 유지한 채 전용 table만 추가한다. 브라우저
  IndexedDB version/store 계약은 올리지 않아 1.8.1 rollback reader를 유지하고, 늦게 끝난 다른
  PC·프로젝트 load는 현재 사전에 적용하지 않는다.
- Multi-Companion Fleet는 등록한 여러 Linux PC의 작업 상태를 한 모바일 대시보드에 보여 주는 새
  user-visible workflow이므로 `feature`로 분류한다. 아직 현장 전달하지 않은 incompatible v2 범위
  안에서 `2.0.0`/Android `versionCode 20000`, `feature/v2-control-plane`을 유지하고 이전 CI-only
  candidate를 대체한다. APK 전달·설치, 실제 Provider 호출과 실행 중 Companion 재시작은 하지 않으며
  current v1 후보 1.8.2, staged v1.8.4와 검증된 v1.8.1 rollback을 그대로 보존한다.
- Fleet 조회는 등록된 Linux Companion 최대 8대의 exact loopback target과 각 device token으로 인증된
  server-authored `/api/fleet-summary` 한 건만 사용하며
  활성 PC를 전환하지 않는다. 잘못된 device ID는 첫 PC로 fallback하지 않고 거절하고, 한 PC의 401은
  그 PC token만 제거한다. PC별 카드에는 실행·승인·확인·실패·복구 필요·보존 건수만 남기고 prompt,
  workspace 경로, 승인 상세와 복구 오류는 Fleet 응답 경계를 통과시키거나 state에 저장하지 않는다.
  PWA 보안 정책은 loopback host의 동적 포트 연결과 인증된 GET만 허용하고 다른 loopback port의 쓰기는
  CORS preflight와 server origin 검사에서 계속 차단한다.
- Fleet는 읽기 전용이다. 다른 PC의 승인·정책·파일 변경은 카드에서 수행하지 않으며 `이 PC 작업 열기`로
  명시적으로 전환하고 해당 Companion 초기화가 끝난 뒤 기존 상세 대시보드에서만 실행한다. offline,
  pairing, PocketLink identity review와 구형 Companion의 API 미지원 상태를 서로 구분하고 자동 우회하지 않는다.
- Provider context Fork는 Provider를 바꾸면서 이전 대화 범위를 넘기는 새 user-visible workflow이므로
  `feature`로 분류한다. 아직 현장 전달하지 않은 incompatible v2 범위 안에서 `2.0.0`/Android
  `versionCode 20000`, `feature/v2-control-plane`을 유지하고 이전 CI-only candidate를 대체한다.
  APK 전달·설치, 실제 Provider 호출과 실행 중 Companion 재시작은 하지 않으며 current v1 후보
  1.8.2, staged v1.8.4와 검증된 v1.8.1 rollback을 그대로 보존한다.
- Provider 전환은 기본적으로 빈 새 대화를 만들고, 사용자가 `컨텍스트 Fork 검토`를 누른 경우에만
  종료된 원본 operation의 요청·수락된 Steer·최종 답변과 새 요청을 bounded 미리보기에 넣는다.
  이전 tool state·명령 log·raw diff·자격 증명·원본 첨부는 승계하지 않는다. exact Provider·모델·routing·
  개인정보·비용 정책·새 첨부 수를 화면에서 확인한 10분/1회용 fork만 새 대화로 실행한다.
- Fork preview는 인증 client와 request ID에 묶고 journal에 저장하지 않는다. 서버는 검토된 context와
  첨부 경로를 보관하고 selection/context digest, source workspace와 terminal 상태를 재검사한다. 응답
  유실 시 같은 request ID만 중복 없이 재시도하며 암호화 operation에는 민감한 digest를 제외한 provenance를
  남기고 대시보드에 source→target·token 추정·잘림 여부를 표시한다.
- Queue/Steer 분리는 실행 중 Codex turn의 방향을 바꾸는 새 user-visible workflow이므로 `feature`로
  분류한다. 아직 현장 전달하지 않은 incompatible v2 범위 안에서 `2.0.0`/Android
  `versionCode 20000`, `feature/v2-control-plane`을 유지하고 이전 CI-only candidate를 대체한다.
  APK 전달·설치, 실제 Provider 호출과 실행 중 Companion 재시작은 하지 않으며 current v1 후보
  1.8.2, staged v1.8.4와 검증된 v1.8.1 rollback을 그대로 보존한다.
- 실행 중 입력은 기본적으로 `다음에 실행` Queue에 들어가고, 사용자가 `지금 방향 수정`을 명시적으로
  고른 경우에만 Codex의 exact thread·active turn에 `turn/steer`를 보낸다. Provider·모델·프로젝트는
  서버 소유 operation에서 고정하며, request ID 재시도는 중복 적용하지 않고 서로 다른 동시 steer는
  거절한다. 수락된 수정은 암호화 journal과 모바일 작업 기록에 남는다. OpenAI/OpenRouter는 지원
  capability를 광고하지 않으므로 이 동작을 자동 대체하거나 흉내 내지 않는다.
- Server-authored API cost/token policy는 OpenAI·OpenRouter 실행 전에 새 사용자 보호 workflow를
  추가하므로 `feature`로 분류한다. 아직 현장 전달하지 않은 incompatible v2 범위 안에서
  `2.0.0`/Android `versionCode 20000`, `feature/v2-control-plane`을 유지하고 이전 CI-only candidate를
  대체한다. APK 전달·설치, 실제 API key·유료 inference와 실행 중 Companion 재시작은 하지 않는다.
  current v1 후보 1.8.2, staged v1.8.4와 검증된 v1.8.1 rollback을 그대로 보존한다.
- Companion journal key로 인증한 정책은 API emergency stop, output/total token hard limit, run 비용 hard
  cap, rolling 24시간 token 경고와 UTC 월 비용 soft limit을 제공한다. 가격이 확인된 모델은 OpenRouter의
  모든 승인 route 중 가장 비싼 가격과 최대 9개 Provider 요청을 사용해 상한을 검사하고, 가격이 없으면
  추측하지 않는다. 월 soft limit 이후 실행은 모델·route·설정·현재 집계에 묶인 10분/1회용 화면 승인
  토큰을 요구하며 이 토큰은 모바일 journal에 저장하지 않는다.
- Provider 요청은 서버가 정한 `max_output_tokens`/`max_tokens`와 누적 total token 상한을 강제한다.
  operation에는 실행 시점의 immutable 정책·privacy·가격·사용량 snapshot을 암호화해 남기고 완료 결과에는
  Provider 보고 비용, catalog 추정 또는 unknown을 구분해 기록한다. 모바일은 전송 직전 사전검사,
  touch-only 월 비용 확인, API 전용 긴급 중단과 bounded 정책 편집, 작업별 실제/추정 비용을 표시한다.
- Provider model grade gate는 모델·upstream별 검증 결과를 모바일 권한과 실제 API tool 목록에 연결하는
  새 v2 workflow이므로 `feature`로 분류한다. 아직 현장 전달하지 않은 incompatible v2 범위 안에서
  `2.0.0`/Android `versionCode 20000`, `feature/v2-control-plane`을 유지하고 이전 CI-only candidate를
  대체한다. APK 전달·설치, 실제 API key·유료 inference와 실행 중 Companion 재시작은 하지 않으며
  v1.8.2 current 후보, 별도 staged v1.8.3과 검증된 v1.8.1 rollback을 그대로 보존한다.
- Linux owner-only grade directory의 bounded redacted report만 최대 30일 인정한다. OpenAI는 exact model,
  OpenRouter는 exact model+사용자가 고른 모든 upstream의 contract/project 등급이 일치해야 하며 자동
  routing, 미검사·실패·만료·malformed·symlink·broad-mode report는 프로젝트 도구를 받지 않는다.
  `projectRead` 통과는 observation 도구만, `coding`까지 통과해야 터치 승인 변경·검증 도구를 API 요청에
  넣는다. 적용 등급은 모델 선택 UI와 암호화 operation 결과에 남지만 report 원문은 Gateway로 보내지 않는다.
- Protected project-grade workflow는 실제 API 모델에 합성 프로젝트 읽기·변경 등급을 발급하는 새 v2
  검증 capability이므로 `feature`로 분류한다. 아직 현장 전달하지 않은 incompatible v2 범위 안에서
  `2.0.0`/Android `versionCode 20000`, `feature/v2-control-plane`을 유지하고 이전 CI-only candidate를
  대체한다. APK 전달·설치, 실제 API key·유료 inference와 실행 중 Companion 재시작은 하지 않으며
  current v1 후보 1.8.2, staged v1.8.4와 검증된 v1.8.1 rollback을 그대로 보존한다.
- 수동 `provider-smoke` environment의 same-job fresh smoke 뒤에만 read/coding 평가를 선택할 수 있다.
  매번 새 0700 합성 workspace에 운영 `workspace_read`와 선택적 SHA-bound `workspace_replace_text`만
  노출하고, coding은 exact confirmation 뒤 한 변경만 승인한다. exact model/route, 최대 2/3회 요청,
  token·$0.05 사전/사후 비용과 Provider usage를 fail-closed로 검사한다. 0600 report에는 tool 상태와
  등급·수치만 남기고 prompt·marker·파일 내용·SHA·model output·credential은 넣지 않는다.
- Provider credential activation gate는 교체·해제 후 이전 systemd runtime key로 새 run이 열릴 수 있던
  결함을 고치는 internal compatibility `patch`다. 아직 현장 전달하지 않은 incompatible v2 범위 안에서
  `2.0.0`/Android `versionCode 20000`, `feature/v2-control-plane`을 유지하고 이전 CI-only candidate를
  대체한다. APK 전달·설치, 실제 key 변경과 Companion 재시작은 하지 않으며 v1.8.2 current 후보, 별도
  staged v1.8.3과 검증된 v1.8.1 rollback을 그대로 보존한다.
- 0600 state의 enabled/disabled와 128-bit generation을 unit activation에 묶는다. rotate/set generation이
  달라지는 즉시 이전 process의 새 run은 차단되고, remove는 systemd runtime·환경변수·protected file
  fallback을 즉시 차단한다. 이미 credential을 읽은 활성 turn은 보존하며 새 key는 검토된 재시작 뒤에만
  활성화된다. malformed·symlink·broad-mode state와 enabled 상태의 cipher 누락도 fail-closed다.
- Linux Provider encrypted credential은 새 server credential workflow이므로 `feature`로 분류한다. 아직
  현장 전달하지 않은 incompatible v2 범위 안에서 `2.0.0`/Android `versionCode 20000`,
  `feature/v2-control-plane`을 유지하고 이전 CI-only candidate를 대체한다. APK 전달·설치, 실제 key 설정과
  실행 중 Companion 재시작은 하지 않으며 v1.8.2 current 후보, 별도 staged v1.8.3과 검증된 v1.8.1
  rollback을 그대로 보존한다.
- systemd 256+ user service는 user/machine-bound 암호문을 activation 시 private runtime credential로
  해독한다. Companion은 고정 이름을 환경변수보다 먼저 읽고 no-follow, regular file, owner-only mode,
  8 KiB와 UTF-8/key 형식을 fail-closed로 검사한다. 관리 스크립트는 평문 key 파일 없이 set하고 기존
  암호문을 recoverable archive로 옮겨 rotate/remove하며 서비스를 자동 restart하지 않는다. 구형 systemd는
  기존 환경변수·0600 파일 호환을 유지한다.
- OpenAI protected smoke는 실제 Provider contract를 실행하는 새 검증 workflow이므로 `feature`로 분류한다.
  아직 현장 전달하지 않은 incompatible v2 범위 안에서 `2.0.0`/Android `versionCode 20000`,
  `feature/v2-control-plane`을 유지하고 이전 CI-only candidate를 대체한다. APK 전달·설치와 실행 중
  Companion 재시작은 하지 않으며 v1.8.2 current 후보, 별도 staged v1.8.3과 검증된 v1.8.1 rollback을
  그대로 보존한다.
- 수동 승인된 `provider-smoke` environment에서 exact allowlisted model과 운영자가 확인한 가격을 받아
  `store:false` streamed strict function call 및 encrypted-reasoning stateless replay 두 번만 실행한다.
  호출당 input 4,096/output 256 token과 $0.02 비용 상한을 inference 전·usage 후 검사하고 prompt·marker·
  응답 원문 없는 0600 grade report만 남긴다. 이번 checkpoint는 loopback fixture만 검증했으며 실제 API
  key나 유료 inference는 사용하지 않았다.
- Android notification Intent 계측 강화는 기존 deep-link 경계의 자동 회귀 누락과 malformed 내부 action의
  extra 잔류를 고치는 internal compatibility `patch`다. 아직 현장 전달하지 않은 incompatible v2 범위
  안에서 `2.0.0`/Android `versionCode 20000`, `feature/v2-control-plane`을 유지하고 이전 CI-only candidate를
  대체한다. APK 전달·설치와 실행 중 Companion 재시작은 하지 않으며 v1.8.2 current 후보, 별도 staged
  v1.8.3과 검증된 v1.8.1 rollback을 그대로 보존한다.
- API 30 Managed Device에서 명시적 MainActivity Intent, app-private 256-bit action token, bounded
  device/operation ID, valid action의 one-time consume와 capture 직후 extra 제거를 실행한다. 틀린 token은
  pending action을 만들지 않고, 올바른 token에 malformed ID가 있어도 action을 저장하지 않은 채 extra를
  제거한다. 실제 notification tray tap·process kill·잠금 화면·절전은 계속 실기기 gate다.
- Relay pre-TLS admission hardening은 공개 server의 새 timeout 설정과 운영 검증을 추가하므로
  `feature`로 분류한다. 아직 현장 전달하지 않은 incompatible v2 범위 안에서 `2.0.0`/Android
  `versionCode 20000`, `feature/v2-control-plane`을 유지하고 이전 CI-only candidate를 대체한다.
  APK 전달·설치, 실행 중 Companion 재시작과 실제 공용 relay 노출은 하지 않으며 v1.8.2 current 후보,
  별도 staged v1.8.3과 검증된 v1.8.1 rollback을 그대로 보존한다.
- broker는 TCP accept 시점부터 기본 10초의 TLS handshake deadline을 적용해 ClientHello조차 보내지 않는
  socket을 정리하고, 종료 시 secure callback 이전 socket까지 즉시 닫는다. 합성 burst 검사는 source별
  동시 연결·시작 횟수와 deadline, 반복 shutdown 대기를 검증하며 통계 표면은 식별자 없는 고정 aggregate
  field만 허용한다. 실제 인터넷 용량·분산 DDoS 검증은 여전히 외부 edge release gate다.
- PocketLink Android Wi-Fi Direct 경로는 새 user-visible v2 transport workflow이므로 `feature`로 분류한다.
  아직 현장 전달하지 않은 incompatible v2 범위 안에서 `2.0.0`/Android `versionCode 20000`,
  `feature/v2-control-plane`을 유지하고 이전 CI-only candidate를 대체한다. v2 APK 전달·설치와 실행 중
  Companion 재시작은 하지 않으며 v1.8.2 current 후보, 별도 staged v1.8.3과 검증된 v1.8.1 rollback을
  그대로 보존한다.
- 사용자가 누를 때만 12초 Wi-Fi Direct 검색과 Android 13+ `NEARBY_WIFI_DEVICES` 권한을 시작한다.
  최대 16개 후보의 이름과 2분 opaque ID만 WebView에 보여 주고 MAC 주소는 native 암호화 설정 밖으로
  내보내지 않는다. Android는 group client만 허용하고 Android가 group owner가 되면 group을 제거한다.
- fixed `p2p`와 `LAN → P2P → relay` auto 경로를 추가했다. LAN/P2P transport 실패만 각각 30초/60초
  cooldown 뒤 다음 경로를 허용하며, 어느 경로에서든 Companion TLS hostname·SPKI·mTLS 실패는 fallback
  없이 차단한다. Keystore config schema 4는 schema 1–3을 보존해 읽는다.
- Linux Companion을 Wi-Fi Direct group owner로 광고·수락하는 자동화와 실제 두 기기 group formation은
  아직 남은 Phase E field gate다. 따라서 Android source 완료를 end-to-end P2P 출시 완료로 간주하지 않는다.
- PocketLink LAN 우선·relay fallback은 새 user-visible v2 transport workflow이므로 `feature`로 분류한다.
  아직 현장 전달하지 않은 incompatible v2 범위 안에서 `2.0.0`/Android `versionCode 20000`,
  `feature/v2-control-plane`을 유지하고 이전 CI-only candidate를 대체한다. APK 전달·설치와 실행 중
  Companion 재시작은 하지 않으며 v1.8.2 current 후보, 별도 staged v1.8.3과 검증된 v1.8.1 rollback을
  그대로 보존한다.
- Android 연결 센터에 fixed direct/relay와 별도 `auto`를 제공한다. auto는 LAN TCP connect 자체가
  실패한 경우에만 동일한 end-to-end Companion mTLS를 relay 위에서 다시 열며, LAN TLS hostname·SPKI·
  client-certificate 실패는 relay로 우회하지 않는다. 반복 LAN 불통은 30초 monotonic cooldown으로
  제한하고 마지막 verified direct/relay만 credential 없는 status로 표시한다.
- Keystore-encrypted PocketLink config schema 3은 schema 1 direct와 schema 2 direct/relay를 원래 고정
  경로로 migration한다. 이 기록은 이후 schema 4 P2P checkpoint로 대체됐다.
- Android managed-device 검증 강화는 기존 v2 native 보안 경로의 자동 회귀 누락을 고치는 internal
  compatibility `patch`다. 아직 현장 전달하지 않은 incompatible v2 범위 안에서 `2.0.0`/Android
  `versionCode 20000`, `feature/v2-control-plane`을 유지하고 이전 CI-only candidate를 대체한다. APK
  전달·설치와 실행 중 Companion 재시작은 하지 않으며 v1.8.2 current 후보, 별도 staged v1.8.3과
  검증된 v1.8.1 rollback을 그대로 보존한다.
- Android API 30 Automated Test Device가 PocketLink 설정·relay secret의 Keystore AES-GCM 암호화와
  port AAD binding, 서로 다른 non-exportable P-256 A/B identity, background subscription 암호화·cursor
  지속성·변조 거부를 실제 AndroidKeyStore provider 위에서 검사한다. 앱 ID가 고정값이라고 잘못 가정한
  기본 샘플 계측 테스트는 제거했다.
- Session writer release 재시도는 handoff 완료 뒤 일시적인 app-server 오류가 CLI의 `active writer`를
  남기는 v2 internal compatibility `patch`다. 아직 현장 전달하지 않은 incompatible v2 범위 안에서
  `2.0.0`/Android `versionCode 20000`, `feature/v2-control-plane`을 유지하고 이전 CI-only candidate를
  대체한다. APK 전달·설치와 실행 중 Companion 재시작은 하지 않으며 v1.8.2 current 후보, 별도 staged
  v1.8.3과 검증된 v1.8.1 rollback을 그대로 보존한다.
- 완료·실패한 running handoff는 exact thread writer 해제를 짧고 bounded한 backoff로 재시도하고 같은
  thread의 동시 해제를 하나로 합친다. idle handoff는 세 번 모두 실패하면 handoff를 기록하거나 모바일
  상태를 분리하지 않고 오류로 끝나 사용자가 다시 시도할 수 있다.
- Public relay admission control과 logless aggregate 운영 지표는 새 server 운영 capability이므로
  `feature`로 분류한다. 아직 현장 전달하지 않은 incompatible v2 범위 안에서 `2.0.0`/Android
  `versionCode 20000`, `feature/v2-control-plane`을 유지하고 이전 CI-only candidate를 대체한다.
  APK 전달·설치, 실행 중 Companion 재시작과 실제 공용 relay 노출은 하지 않으며 v1.8.2 current 후보,
  별도 staged v1.8.3과 검증된 v1.8.1 rollback을 그대로 보존한다.
- broker가 IPv4-mapped 주소를 정규화하고 source별 동시 TLS socket, fixed-window 연결 시작·새 ephemeral
  slot과 전체 추적 peer state를 제한한다. 기존 slot 재사용과 이동/NAT를 허용하되 source·slot access
  log는 만들지 않고 `SIGUSR1`에 식별자 없는 현재·누적 counter만 출력한다. 분산 DDoS와 hosting metadata
  정책은 외부 edge·현장 release gate로 남긴다.
- Android PocketLink relay enrollment와 native nested-TLS connector는 새 사용자 연결 workflow이므로
  `feature`로 분류한다. 아직 현장 전달하지 않은 incompatible v2 범위 안에서 `2.0.0`/Android
  `versionCode 20000`, `feature/v2-control-plane`을 유지하고 이전 CI-only candidate를 대체한다.
  APK 전달·설치와 실행 중 Companion 재시작은 수행하지 않으며 v1.8.2 current 후보, 별도 staged
  v1.8.3과 검증된 v1.8.1 rollback을 그대로 보존한다.
- Android 연결 센터에서 직접 LAN 또는 relay를 명시적으로 선택한다. relay endpoint·TLS hostname·
  SPKI pin·opaque slot·256-bit secret은 기존 Keystore AES-GCM PocketLink 설정 안에 저장하고 WebView
  storage, status 응답과 로그로 다시 내보내지 않는다. 기존 schema 1 직접 연결 설정은 schema 2로
  읽어 손실 없이 유지한다.
- native forwarder는 platform CA, HTTPS hostname, 별도 relay SPKI pin으로 바깥 TLS 1.2/1.3을 확인하고
  protocol 1의 2 KiB exact client frame을 교환한 뒤, 그 socket 위에서 기존 Companion hostname·SPKI와
  Android Keystore P-256 client certificate를 사용하는 내부 mTLS를 다시 수행한다. relay 인증 실패는
  slot·secret 존재 여부를 구분하지 않고 direct/SSH로 자동 fallback하지 않는다.
- Companion relay pool은 UI SSE, opt-in background SSE와 API 요청이 겹치는 정상 모바일 동작을 위해
  기존 상한 안에서 기본 4개 waiter를 유지한다.
- PocketLink outbound relay foundation은 새 network transport capability이므로 `feature`로 분류한다.
  아직 현장 전달하지 않은 incompatible v2 범위 안에서 `2.0.0`/Android `versionCode 20000`과
  `feature/v2-control-plane`을 유지하고 이전 CI-only candidate를 대체한다. APK 전달·설치와 실행 중
  Companion 재시작은 수행하지 않으며 v1.8.2 current 후보, 별도 staged v1.8.3과 검증된 v1.8.1
  rollback을 그대로 보존한다.
- TLS 1.2/1.3 `codex-pocket-relay` broker와 Linux Companion outbound connector를 추가했다. 최소
  128-bit opaque slot과 256-bit secret, relay SPKI pin, private secret/key file, bounded frame·socket·
  slot·waiter·timeout을 요구하며 틀린 인증값은 기존 waiter를 소비하지 않는다.
- relay는 outer TLS 안의 opaque PocketLink mTLS bytes만 전달한다. 서로 다른 합성 Android client와
  Companion certificate를 사용한 통합 검사에서 relay 뒤에도 기존 server pin과 client-certificate
  proof가 종단간 유지됨을 검증한다. 외부 edge DDoS·실부하와 현장 network/battery acceptance는 다음
  Phase E 단계로 남긴다.
- 모바일 browser acceptance checkpoint는 production client build와 실제 pairing·Gateway·SSE·run·approval
  경로를 사용하는 새 v2 검증 capability이므로 `feature`로 분류한다. 아직 현장 전달하지 않은 v2 안의
  변경이므로 `2.0.0`/Android `versionCode 20000`과 `feature/v2-control-plane`을 유지하고 기존 CI-only
  candidate를 대체한다. APK 전달·설치와 Companion 재시작은 수행하지 않으며 v1.8.2 current 후보,
  별도 staged v1.8.3과 검증된 v1.8.1 rollback을 그대로 보존한다.
- Playwright Chromium 검사를 추가해 pairing 전 화면과 인증된 production Gateway를 거쳐 320/360/412px,
  150% 글자, 키보드 축소, 가로 회전, 긴 prompt·diff·승인 상세가 화면 안에 머물고 내부 스크롤로
  접근 가능한지 확인한다. 공개 CI는 합성 Codex client와 임시 인증·journal만 사용한다.
- live Codex 및 공통 Provider diff를 진행 패널 상세에 표시해 모바일에서 변경 검토 중인 내용을 바로
  확인할 수 있게 했다.
- Codex 실행·취소·stream event를 Provider 공통 runtime 계약 뒤로 이동했다.
- Provider capability를 streaming, 승인, workspace 읽기·쓰기, 명령 실행과 사용량 기록까지 확장했다.
- Gateway protocol 3을 추가하면서 protocol 2 Companion과 클라이언트가 공존할 수 있는 범위 협상을
  유지했다.
- `RunCoordinator`가 실행 상태, 취소, Provider event 범위와 재시도 request ID를 한 곳에서 관리해
  응답 유실 뒤 같은 프롬프트가 중복 실행되지 않게 했다.
- Codex CLI, OpenAI Responses와 OpenRouter에 같은 성공·부분 stream 실패·취소·timeout runtime
  contract suite를 적용했다. 공통 event gate는 Provider·conversation·run 소유권, 단조 sequence,
  event ID 중복과 단일 terminal을 검사해 이전 run, replay·역순 frame과 terminal 뒤 frame을 새
  operation journal에 붙이지 않는다. Codex event에도 run별 event ID와 sequence를 부여한다.
- OpenAI/OpenRouter transport 오류는 raw 예외를 completion 밖으로 던지는 대신 공통 `failed`
  completion과 redacted terminal event로 끝난다. 401/403/429/5xx, 부분 stream, malformed·truncated·
  empty SSE fixture를 공개 검사에 추가했고, OpenAI Responses의 upstream `sequence_number` replay는
  텍스트·usage·도구 호출을 중복 적용하지 않는다.
- `ToolBroker`와 `ApprovalBroker`의 로컬 정책 계약을 추가했다. 고위험·외부 효과 승인은 터치 확인만
  허용하고, 만료되거나 오프라인인 요청을 자동 승인하지 않는다.
- `App.tsx`의 음성 입력과 미디어 첨부 상태를 각각 순수 reducer로 분리했다. 연속 받아쓰기
  재시작·치명적 오류 transition, 동시 upload batch, 4개 상한과 임시 ID→서버 ID 교체를
  상태 머신 테스트로 고정했다.
- 연결 lifecycle을 단조 증가 attempt ID에 묶인 reducer로 분리했다. 장치 전환·재페어링 뒤
  이전 initialize/SSE/페어링/진단 응답이 새 PC 상태를 덮지 못하고, 새 attempt는 이전
  초기화가 진행 중이어도 독립적으로 시작한다. Android tunnel 전환도 직렬화한다.
- active run과 journal 복원 상태를 generation 기반 reducer로 분리했다. run 생성 응답 전
  request도 active 상태로 취급해 중복 전송·queue 자동 실행을 막고, 이전 장치·run의 늦은
  POST/poll/stream/terminal 응답은 새 run과 poll timer를 바꾸지 못한다. queue journal을 읽는
  동안 만든 프롬프트는 복원본과 ID 기준으로 병합해 덮어쓰지 않는다.
- 세션 인계를 프로젝트·대화별로 격리하고, 다른 프로젝트의 인계 세션이 현재 프로젝트처럼 보이던
  문제를 수정했다. v1 단일 handoff 상태는 손실 없이 다중 상태로 마이그레이션한다.
- Codex 원본 notification과 OpenAI SSE를 `output.delta`, `tool.started`, `workspace.diff`,
  `usage.updated` 등 공통 이벤트로 즉시 정규화하고 기존 Codex 모바일 이벤트 호환은 유지한다.
- 공식 OpenAI JavaScript SDK로 server-only API key, `0600` key 파일, 명시적 모델 허용 목록,
  `store:false` chat-only streaming, 이미지 입력, 사용량·중단·timeout과 오류 redaction을 구현했다.
- OpenAI Responses 함수 호출을 공통 `LocalToolBroker`에 연결하고, 허용 root 안의 파일 목록·읽기·검색과
  고정 Git status/diff만 observation 도구로 제공한다. strict schema, 단일 호출, 8회 상한, stateless
  reasoning replay, 민감 경로·symlink·Git 환경·출력 제한을 적용했다.
- 공개 검사는 실제 유료 AI 요청 없이 가짜 OpenAI stream과 Models 목록만 사용한다. OpenAI API
  모드의 임의 명령은 계속 비활성화한다.
- OpenAI `store:false` 응답 항목과 OpenRouter chat/tool transcript를 Linux Companion의 암호화 journal에만
  보관해 두 API Provider의 다중 턴 대화를 이어갈 수 있게 했다. 재개 상태는 Provider·workspace·model·
  account에 고정하고, 미확인 `unknown` run이 있으면 이어가기를 차단한다. 최신 성공 run 하나만 상태를
  소유하며 클라이언트 API, SSE, workspace JSON export에는 opaque 본문 대신 `resumable` 여부만 보낸다.
  상태는 최대 12턴·900 KiB로 제한하고 오래된 완전한 turn부터 제거한다. 이미지 data URL은 첫 요청에만
  사용하고 로컬 replay에는 제외 안내문만 남긴다. 공개 검사는 가짜 응답만 사용하며 API key나 유료
  inference를 사용하지 않았다.
- OpenRouter의 server-only key와 `0600` key 파일, user/ZDR 모델 catalog 교집합, 명시적 allowlist,
  Chat Completions SSE와 usage·credit 비용 기록을 추가했다. 도구 capability가 확인된 모델만
  공통 ToolBroker를 받고 나머지는 chat-only로 제한한다.
- OpenRouter 요청은 모델 하나와 기본 `allow_fallbacks:false`, `require_parameters:true`,
  `data_collection:deny`, `zdr:true` profile로 고정한다. 실제 upstream은 결과에 기록하고 다른 모델로는
  자동 우회하지 않으며, 공개 검사는 가짜 HTTP/SSE만 사용한다.
- OpenRouter의 인증된 ZDR endpoint catalog에서 exact upstream tag를 모바일에 노출한다. 기본 자동
  routing은 fallback 없이 유지하고, 사용자가 1차와 backup을 직접 고른 경우에만 `order`와 `only`를
  같은 승인 목록으로 고정해 그 안의 fallback을 허용한다. 선택은 offline queue와 암호화 operation에
  보존하고 같은 대화 중 변경을 거부하며, strict profile·요청 순서·실제 upstream을 성공/실패 결과와
  모바일 대시보드에 표시한다.
- OpenRouter model/upstream catalog의 bounded USD/1M token 가격, p50 latency/throughput, 30분 uptime,
  quantization·tool capability와 key의 남은 quota/만료일을 인증된 모바일 화면에 표시한다. catalog
  metadata를 실제 eval 등급과 구분하며, 실제 등급용 수동 `provider-smoke` workflow는 allowlist·exact
  ZDR tag·2회 synthetic tool loop·$0.02 상한을 강제하고 prompt/응답/API key 없는 report만 보존한다.
  Usage cost는 USD 기준 OpenRouter credits로 구분해 기록하고, opt-in router metadata의 exact model,
  1회 attempt와 catalog provider를 검증해 응답을 실제 승인 upstream에 귀속한다.
- Android의 암호화된 `WorkJournal` conversation·queue snapshot을 앱 전용 SQLite로 옮기는
  `PocketJournal` 플러그인을 추가했다. SQLite는 AES-GCM envelope만 받고 원래 workspace/device
  식별자 대신 domain-separated SHA-256 index를 바인딩하며 payload 크기를 제한한다.
- 기존 IndexedDB/localStorage 기록은 읽을 때 SQLite로 복사하되 삭제하지 않고, v2 검증 중 새 저장은
  기존 저장소에도 함께 기록해 v1.8.1 rollback의 로컬 기록 호환을 유지한다.
- Linux Companion의 operation과 공통 run event를 별도 0600 key로 AES-256-GCM 암호화하는 SQLite
  journal을 추가했다. workspace는 keyed HMAC index로만 남기고 prompt, 결과, idempotency key와 SSE
  payload는 평문 DB에 기록하지 않는다.
- SSE `Last-Event-ID` replay, 단말별 cursor 보존·중복 제거와 지수 backoff 재연결을 추가했다.
  Companion 재시작 당시 `running`이던 작업은 성공/실패로 추정하지 않고 `unknown`으로 복구하며,
  사용자가 결과를 확인하기 전에는 해당 프로젝트 대기열을 실행하지 않는다. 확인 결과는 Companion에
  암호화해 보존하고 모든 연결 기기에 동기화해 앱 재시작 뒤 같은 확인을 반복하지 않는다.
- journal DB·키는 같은 사용자 소유의 private directory와 일반 단일-link 파일만 허용하며, 평문으로
  필요한 status·timestamp·workspace index도 ciphertext의 AES-GCM AAD에 묶어 변조를 감지한다.
- 모바일 작업 대시보드가 선택한 Linux Companion의 최근 run을 프로젝트별로 묶고 실행·승인·대기열·
  unknown·완료·실패 수, Provider·모델·경과 시간·token·비용을 표시한다. 작업을 열 때 다른 프로젝트의
  실행을 중단하지 않고 화면 초점만 정확한 workspace·Provider·conversation으로 옮긴다.
- 작업 카드의 목표 이름, 최대 50개 고정과 보관 상태를 Companion 암호화 operation에 저장하고
  `metadata_updated` SSE로 연결된 화면에 동기화한다. 보관한 작업은 기본 대시보드에서 숨기되 다시
  표시·복원할 수 있으며, 실행·승인·미확인 작업은 보관할 수 없다. 고정은 7일/500 operation 보존
  상한을 우회하지 않고, 명시적인 프로젝트 기록 삭제는 고정·보관 작업도 함께 지운다.
- Android에서 사용자가 직접 켠 경우에만 앱이 화면에 없을 때 완료·승인·오류 알림을 표시한다. 잠금
  화면 알림에는 프롬프트·프로젝트 경로·Provider 응답을 넣지 않고 generic 상태만 표시한다. 알림의
  PendingIntent는 앱 전용 random token과 bounded device/operation ID로 검증하며, 누르면 해당 Linux PC의
  현재 retained operation을 다시 조회한 뒤 정확한 작업만 연다. opt-in foreground monitor는 최대 8개의
  loopback Companion에서 인증된 notification-only SSE를 구독하며, 서버는 schema/kind/operation ID/시각과
  승인 만료시각만 보내 prompt·workspace·응답·도구 세부정보를 네이티브 계층에 내리지 않는다. bearer와
  cursor는 Android Keystore AES-GCM 설정에 저장하고 process 회수 뒤 `Last-Event-ID`로 복구한다. 최초
  활성화는 현재 cursor에서 시작하고 replay는 최신 16건으로 제한해 10분보다 오래됐거나 만료된 요청을
  알리지 않으며, WebView가 보일 때에는 native monitor가 cursor만 전진시켜 중복 알림을 만들지 않는다.
- 승인 요청은 run과 workspace가 일치할 때만 승인함에 노출한다. redacted summary/details의 크기와 JSON
  형식을 제한하고, approve/decline 모두 same-origin 화면 터치 API로만 처리한다. 음성 source를 보내도
  서버가 `touch`로 고정하며 만료·거절·재연결 중 자동 승인은 없다.
- SSE replay 끝에 snapshot 동기화 경계를 추가해 Companion 재시작 뒤 복구할 수 없는 과거 in-memory
  승인이 승인함에 남지 않게 했다. replay 중 과거 요청은 알림창을 다시 열지 않는다.
- 세션 반납 버튼과 확인창에 현재 선택한 프로젝트명을 표시해 다른 프로젝트 작업을 대상으로 오해하지
  않게 했다. 실제 operation 연결도 workspace·conversation 범위를 계속 검증한다.
- Codex app-server 생성 타입 기준을 CLI 0.149.0으로 갱신하고 새 project/agent-delivery 계약을 반영했다.
  실제 app-server 연결 검사는 모델 turn 없이 수행한다.
- OpenAI/OpenRouter용 `workspace_replace_text`가 기존 UTF-8 파일 한 개만 바꾼다. 모델은 먼저
  `workspace_read`의 원본 SHA-256을 제시해야 하고 승인 전후 해시가 다르면 덮어쓰지 않는다. 변경 diff는
  승인함에 redacted·bounded 형태로 표시하며 민감 경로, symlink/hardlink, 비밀정보 형태, 생성·삭제·
  이름변경·권한변경은 거부한다. 승인된 교체는 같은 디렉터리에서 fsync 후 atomic rename한다.
- `workspace_replace_text_batch`는 동일한 SHA·경로·내용 정책으로 2~8개 기존 파일, 파일당 12 KiB와
  전체 48 KiB만 한 번의 터치 승인으로 교체한다. 모든 파일을 먼저 검사·fsync 스테이징하고 원본의
  inode/hash를 hard-link backup에서 다시 확인한 뒤 각 파일을 atomic rename한다. 실행 중 하나라도
  바뀌거나 실패하면 이미 설치한 파일을 역순으로 원복한다. 승인 JSON은 이스케이프 후에도 30 KiB
  이하로 제한하며 내부 `.codex-pocket-*` 복구 파일은 API 읽기·검색에서 숨긴다. batch 자체는 새 파일,
  삭제, 이름변경과 chmod를 허용하지 않는다.
- `workspace_create_text`는 기존 디렉터리 아래의 비어 있는 경로에 12 KiB 이하 UTF-8 파일 하나를
  `0644`로 만들고, `workspace_rename_text`는 `workspace_read` SHA와 inode가 일치하는 기존 단일-link
  UTF-8 파일을 비어 있는 경로로만 옮긴다. 두 도구 모두 redacted diff와 터치 승인을 요구하고,
  목적지를 hard-link로 설치해 승인 뒤 생긴 파일을 덮어쓰지 않는다. 디렉터리 생성, 삭제, chmod,
  binary·민감 경로·secret-bearing 파일 이동은 계속 차단한다.
- 모든 workspace 변경은 Companion 전용 `0700` 디렉터리의 `0600` strict manifest에 staging/prepared/
  committed 단계를 fsync한 뒤 수행한다. manifest에는 내용·credential 없이 workspace와 상대 경로,
  hash·inode·mode만 기록한다. 재시작 시 staging은 폐기하고 prepared는 전체 원복하며 committed는 결과를
  유지한 채 backup을 정리한다. 복구 대상이 외부에서 다시 바뀌어 자동 처리가 애매하면 덮어쓰지 않고
  변경 도구 초기화를 실패시킨다.
- 자동 workspace 복구가 애매해도 Companion의 읽기·대시보드 API는 fail-closed degraded mode로 시작하고
  변경 도구만 503으로 차단한다. paired 클라이언트는 최대 32개 transaction·각 16개 상대 경로의 bounded
  상태를 조회하며, journal을 해석하지 못하면 경로를 추측하지 않는다. 모바일 대시보드는 정확한
  workspace/상대 경로와 PC 확인 안내를 보여 주고 두 번째 터치와 same-origin 확인값 뒤 같은 안전 복구만
  재시도한다. journal 폐기, 외부 변경 강제 덮어쓰기와 복구용 파일 삭제 선택지는 제공하지 않는다.
- `project_verify`는 기존 `package.json`의 `check`, `test`, `build` script만 터치 승인 뒤 실행한다.
  package SHA-256으로 검토 후 script 변경을 차단하고, unprivileged user/mount/network namespace,
  일회용 overlay, 빈 환경, 민감 파일 mask, 로컬 loopback만 있는 네트워크, 시간·process·fd·파일·출력
  상한을 모두 probe한 Linux에서만 capability를 노출한다. 격리를 만들 수 없으면 명령 도구를 등록하지
  않으며 임의 command/argument, 외부 network와 실제 workspace 변경은 허용하지 않는다.
- run을 중단하면 대기 중인 도구 승인을 system decline으로 즉시 닫아 만료 때까지 작업이 매달리지 않는다.
- AI 연결 센터는 Provider별 프로젝트 읽기, 터치 승인 파일 변경·명령, 사용량 기록 capability를 표시하고
  승인 카드에는 정확한 프로젝트·Provider와 읽기 쉬운 script/diff를 표시한다.
- Workspace catalog가 현재 Git branch, 12자리 HEAD, dirty 파일 수, upstream ahead/behind와 linked
  worktree 여부를 안전한 read-only Git 환경에서 수집한다. 작업 대시보드와 세션 반납 화면은 branch와
  전체 프로젝트 경로를 함께 표시해 같은 이름의 프로젝트나 다른 worktree를 구분한다. 각 run은 시작
  시점 identity를 암호화 journal에 보존해 나중에 branch가 바뀌어도 작업 카드의 원래 대상을 유지한다.
- Gateway는 Codex run 시작, 세션 반납과 이어받기에서 정규화한 thread의 실제 cwd가 선택한 workspace와
  완전히 같은지 다시 검사한다. 오래된 클라이언트 상태나 잘못된 thread ID가 하위 폴더 또는 다른
  프로젝트의 실행·인계로 연결되면 409로 거절한다.
- 작업 대시보드에 Companion journal의 7일/500 operation/2,000 event 보존 정책을 표시하고,
  현재 workspace의 복호화된 operation·event만 16 MiB 이하 JSON으로 내보내는 기능을 추가했다.
  삭제는 정확한 전체 프로젝트 경로와 영향 범위를 다시 보여 준 뒤 두 번째 터치에서만 수행하며,
  실행·승인 중이거나 미확인 `unknown` 작업이 있으면 409로 차단한다. 프로젝트 파일과 Android의
  암호화 conversation·queue journal은 삭제 대상이 아니다.
- Companion 보존 정책을 1–30일, operation 50–2,000개, event 200–10,000개 범위에서 모바일로
  조정할 수 있게 했다. 저장 전 삭제 가능 범위와 고정·보관도 예외가 아님을 보여 주고 두 번째 터치와
  명시적 same-origin 확인값을 요구한다. 적용은 실행 중 operation을 보존하면서 한도 밖 기록을 즉시
  정리하고 모든 연결 기기에 `policy_updated`를 보낸다. 설정은 SQLite schema 1의 additive table에
  key-HMAC으로 인증해 변조된 값으로 조용히 삭제하지 않으며 Companion 재시작 뒤에도 복원한다.
- Android CI가 APK·SBOM의 파일명, SHA-256·크기, package, SemVer/versionCode, commit을 canonical
  update manifest에 고정한다. 공식 build는 Android release key로 exact manifest를 RSA/ECDSA SHA-256
  서명하고 공개 인증서를 함께 제공한다. 오프라인 검증기는 별도로 고정한 인증서 fingerprint, manifest
  서명, 실제 APK signer, artifact 무결성과 downgrade를 확인하며 unsigned fork는 명시적 override 없이
  거부한다.
- Android 연결 센터에서 signed artifact ZIP을 직접 선택하거나 공식 GitHub 저장소의 최신 정식 Release를
  사용자가 명시적으로 조회·검토·다운로드할 수 있다. 조회는 draft/prerelease를 제외한 hardcoded public
  저장소와 정확한 versioned ZIP asset만 허용하고, 10분 random token, 1 MiB metadata·128 asset·bounded
  ZIP 상한, GitHub-controlled HTTPS redirect와 Release asset SHA-256을 적용한다. GitHub digest는 전송
  검사일 뿐이며 다운로드 뒤에도 기존 native importer가 top-level 6개 파일, 현재 signer·package, exact
  signed manifest/APK/SBOM과 상위 versionCode를 다시 검증한다. 별도 터치 뒤 Android unknown-source와
  package installer 승인을 요구하며 시작 시·주기적·background 조회나 무인 설치는 하지 않는다.
- Android signed CI는 importer가 그대로 읽는 최상위 6개 파일을
  `Codex-Pocket-Voice-vX.Y.Z-update.zip` Release asset으로 함께 패키징하고 native release 정책 단위 테스트를
  실행한다. unsigned fork에는 신뢰 가능한 update ZIP을 만들지 않는다.
- 세션 반납이 workspace와 thread를 server에서 다시 검증한 뒤 idle Codex thread를 app-server에서
  `thread/unsubscribe`한다. 실행 중 handoff는 turn을 중단하지 않고 완료·실패 이벤트 뒤 같은
  workspace/thread handoff가 남아 있을 때 자동 unsubscribe하여 터미널의 `codex resume` writer 충돌을
  해소한다.
- opt-in PocketLink LAN TLS listener를 추가했다. Companion은 `0700` 디렉터리의 `0600` 단일-link
  private key, certificate/key 일치, 유효기간과 advertise host를 검증하고 TLS 1.2/1.3으로만 듣는다.
  Android `connectedDevice` foreground service는 Keystore AES-GCM으로 host·port·기본/교체용 SPKI pin을
  보호하고 `127.0.0.1`에만 bounded forward를 연다. 인증서 유효기간·HTTPS hostname·SPKI pin 중 하나라도
  맞지 않으면 연결을 거부하고 Termux/SSH로 자동 downgrade하지 않는다.
- AndroidKeyStore에 local-port별 non-exportable P-256 device identity를 만들고 TLS client certificate로
  개인키 보유를 증명한다. Companion은 최초 pairing 때 client SPKI pin을 bearer token hash에 결합하고,
  이후 PocketLink 요청에서 인증서 누락·만료·pin 불일치를 거부한다. 기존 v1 auth state는 version을
  바꾸지 않는 선택 필드로 확장하고 TLS binding을 임의로 만들지 않으며, TLS session resume을 꺼 매
  연결에서 새 proof를 요구한다.
- 이 PocketLink checkpoint는 검토형 같은-LAN 주소 bootstrap까지 포함한다. Wi-Fi Direct 등 P2P,
  relay와 background 계측은 남아 있으며 Termux/SSH를 검증된 rollback adapter로 유지한다.
- PocketLink QR bootstrap을 추가했다. TTY Companion은 host·TLS port·server SPKI pin·device ID/name과
  기존 10분 pairing code만 담은 QR을 출력하고 Provider key·프로젝트 경로는 포함하지 않는다. Android는
  Apache-2.0 ZXing embedded scanner를 로컬에서 QR_CODE 전용·이미지 미저장·2분 timeout으로 실행한다.
  앱은 2,048자/고정 field/version/host/port/pin/code/device/만료를 검증하고 등록 전 내용을 다시 보여준다.
  사용자가 host·port·pin을 편집하거나 실제 Companion device ID가 QR과 다르면 QR code를 폐기한다.
- opt-in PocketLink DNS-SD 광고와 Android의 `같은 LAN에서 찾기`를 추가했다. Companion은 PC 이름,
  TLS port와 protocol version만 광고하고 pin·pairing code·device ID·token·workspace는 보내지 않는다.
  Android 검색은 사용자가 누른 전경 8초, 최대 16개, private IPv4/IPv6 ULA와 2분 review로 제한한다.
  후보를 선택해도 pin은 비워 두고 Companion 터미널의 SPKI pin을 직접 대조해야 하며 자동 페어링·연결·
  SSH fallback은 하지 않는다. 광고는 MIT `bonjour-service`, Android 검색은 platform `NsdManager`를
  사용한다.
- `App.tsx`의 PocketLink QR/LAN boolean과 trust hint를 순수 bootstrap reducer로 분리했다. QR scan과
  LAN discovery를 상호 배타적으로 만들고, 새 bootstrap 시 이전 hint를 폐기하며, stale native 결과와
  목록 밖·만료 후보를 무시한다. 이름·host·port 편집도 발견 선택만 즉시 무효화하고 QR의 기존 exact
  host·port·SPKI-pin/target/device 검증은 유지한다.
- 기존 PocketLink 연결에 새 server backup SPKI pin을 준비하는 화면과 staged 인증서 교체를 추가했다.
  새 pin은 실제 HTTPS hostname/pin TLS handshake가 성공해도 자동 승격되지 않는다. 앱은 성공 슬롯과
  시각만 표시하고, 사용자가 2분 안에 대상·폐기 경고를 두 번 확인해야 native 계층이 새 pin을 primary로
  옮기고 이전 pin을 제거한다. 전환 취소 시에는 staged backup pin만 제거할 수 있으며, 실패·시간 만료
  때는 승격하거나 SSH로 우회하지 않는다.
- Android PocketLink client identity를 Keystore A/B 슬롯으로 교체하는 복구 가능 protocol을 추가했다.
  시작은 현재 bearer와 기존 key의 실제 mTLS proof를 모두 요구하고 5분 승인 원문은 Android 보안
  저장소, hash만 Companion `0600` state에 남긴다. 새 key의 TLS proof와 서버 영속화를 확인한 뒤에만
  이전 alias를 삭제하며, 만료 전 중단은 기존 key를 보존하고 응답이 불확실하면 두 key를 모두 유지한다.
  완료된 서버 binding은 중단으로 되돌리거나 Termux/SSH로 자동 우회하지 않는다.
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
