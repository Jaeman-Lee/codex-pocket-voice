# Deployment inventory

Last verified: 2026-08-24 KST

이 문서는 공개 가능한 배포 기준선만 기록한다. 사용자명, 파일 절대 경로, 네트워크 주소,
기기 ID, 인증 토큰, 페어링 코드는 기록하지 않는다.

## Current candidate and deployed baseline

Session scope hotfix decision: 다른 프로젝트의 인계 세션이 현재 프로젝트의 세션 종료·반납 대상으로
보이는 버그이므로 `patch`/`1.8.2`, Android `versionCode 10802`로 분류한다. 대상 브랜치는
`hotfix/1.8.2-session-scope`이다. 1.8.2를 전달하기 전에는 1.8.1 current와 1.7.4 rollback을
그대로 유지한다. 최초 1.8.2 현장 설치 시 1.8.1을 rollback으로 두고 1.7.4는 복구 가능한
archive로 이동한다. Companion 재시작은 활성 Codex turn이 없고 사용자가 확인한 뒤에만 수행한다.

Candidate handoff: 2026-08-24에 커밋 `d76e478`의 서명 APK, SHA256SUMS와 CycloneDX
SBOM을 Android stable APK Actions run `32647238314`에서 내려받아 체크섬을 검증했다.
1.8.2를 current 설치 후보로, 1.8.1을 rollback 세트로 준비했다. Android 설치와 Companion
재시작은 수행하지 않았으며, 1.7.4는 복구 가능한 이전 후보로만 남긴다.

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
| Runtime code baseline | `d76e478` on `hotfix/1.8.2-session-scope` | pushed; PR #4 Linux and Android checks passing |
| Primary development workspace | Linux PC Git clone; v2 worktree active | 1.8.2 hotfix is isolated on its scoped branch |
| Termux workspace | lightweight Git mirror at `f08d9e7` | reproducible dependencies and build output scheduled for removal |
| Pull request | PR #4 into `main` | Linux Node 20/22 and Android checks passing; field test pending |
| Android APK | 1.8.2 signed candidate | current installer set prepared from Actions run `32647238314`; install pending |
| Android rollback APK | 1.8.1 signed candidate | rollback set prepared from Actions run `32645200906`; already field-tested by the user |
| Linux Companion | 1.8.1 | active for the user's other project; restart to 1.8.2 deferred until explicit confirmation |
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

`1.8.2`는 아직 정식 Release가 아니다. 사용자 현장 테스트가 끝난 뒤 PR을 병합하고 같은
병합 커밋에 `v1.8.2` 태그와 GitHub Release를 만들어야 한다. Companion을 1.8.2로 재시작하면
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

1. 현장 테스트 중에는 `v1.8.2` 태그를 만들거나 PR을 병합하지 않는다.
2. 프로젝트 생성, AI 연결 센터 스크롤, 재연결, 음성 입력, 기존 대화 복구와 기기 간 세션 인계를 확인한다.
3. 승인 후 정식 Release를 만들고 APK 체크섬을 Release asset과 다시 대조한다.
4. 정식 Release 확인 후 PC의 0.2.0 rollback snapshot을 제거한다.
5. 실패한 CI 산출물과 superseded candidate APK는 즉시 제거해 설치 혼동을 막는다.
