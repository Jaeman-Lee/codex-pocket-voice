# Release process

## Version authority

`package.json`의 SemVer가 유일한 버전 원본이다. `src/version.ts`, Android `versionName`,
Android `versionCode`, APK 이름과 Git tag는 이 값과 일치해야 한다. `npm test`의 버전 검사가
불일치를 차단한다.

## Lifecycle

1. **Development** — feature branch에서 구현하고 버전을 올린다.
2. **Candidate** — Linux Node 20/22와 Android CI가 통과한 서명 APK를 현장 테스트한다.
3. **Accepted** — 실제 Android와 Linux Companion에서 핵심 시나리오를 확인한다.
4. **Released** — PR 병합 후 병합 커밋에 `vX.Y.Z` annotated tag와 GitHub Release를 만든다.

Candidate 단계에서는 Draft PR을 유지하고 `Latest` Release를 바꾸지 않는다.
PR의 Android candidate는 GitHub 임시 merge ref가 아니라 exact feature head SHA를 checkout해 build하고,
manifest의 commit도 실제 checkout의 `git rev-parse HEAD`와 같아야 한다. merge compatibility는 별도 PR
checks가 담당하며 field evidence는 이 재현 가능한 feature commit에만 결합한다.

## Update decision gate

배포 가능한 변경을 시작할 때마다 코드 수정 전에 다음 네 항목을 판단하고 Changelog 또는
Deployment inventory에 기록한다.

| Decision | Rule |
| --- | --- |
| Change class | 버그·내부 호환은 `patch`, 새 사용자 흐름·기능·서버 API는 `feature`, 호환 불가능한 프로토콜·저장소·계정 변경은 `breaking` |
| Version | patch는 `x.y.Z`, feature는 `x.Y.0`, breaking은 별도 마이그레이션 계획과 `X.0.0` |
| Git target | scoped feature/fix branch와 PR에서 검증하고, 현장 승인 전에는 `main`에 병합하지 않음 |
| APK retention | 현재 candidate 한 세트, 직전 검증 rollback 한 세트, 정식판은 GitHub Release에 장기 보존 |

테스터에게 전달하거나 설치한 APK의 코드가 바뀌면 반드시 더 높은 SemVer와 Android
`versionCode`를 사용한다. 아직 전달하지 않은 동일 버전의 CI 재빌드는 이전 산출물을 완전히
대체하는 경우에만 허용한다.

## Required checks

```sh
npm ci
npm run release:check
```

추가로 GitHub Actions의 다음 작업이 모두 성공해야 한다.

- Node 20 on Linux
- Node 22 on Linux
- Mobile browser acceptance on Chromium
- Android stable APK

Android 산출물에는 서명 APK 또는 fork용 unsigned APK, `SHA256SUMS`, CycloneDX SBOM과
`update-manifest.json`이 함께 있어야 한다. 공식 서명 빌드에는 `update-manifest.sig`와 공개
`update-manifest-cert.pem`도 있어야 한다. manifest는 APK와 SBOM의 정확한 파일명·SHA-256·크기,
package ID, SemVer/versionCode, channel, commit을 고정한다. 서명 키와 암호는 GitHub Secrets 밖으로
복사하지 않는다. 공식 서명 CI는 이 6개 파일을 최상위에만 둔
`Codex-Pocket-Voice-vX.Y.Z-update.zip`도 만든다. unsigned fork는 이 ZIP을 만들지 않는다.

공식 signed candidate는 다음 순서로 오프라인 검증한다. `EXPECTED_CERT_SHA256`은 함께 받은 인증서에서
새로 계산하면 안 되며, 이미 신뢰하는 설치본·이전 Release APK 또는 별도 신뢰 경로에서 확인한 Android
서명 인증서 fingerprint여야 한다.

```sh
node scripts/verify-update-manifest.mjs \
  --manifest update-manifest.json \
  --signature update-manifest.sig \
  --certificate update-manifest-cert.pem \
  --expected-certificate-sha256 "$EXPECTED_CERT_SHA256" \
  --artifact-dir . \
  --apksigner /trusted/android-sdk/build-tools/36.0.0/apksigner \
  --current-version-code 10802
```

검증기는 manifest 분리 서명과 고정 fingerprint뿐 아니라 실제 APK의 signer도 같은 인증서인지 확인하고,
낮은 versionCode와 기본 상태의 동일 versionCode를 거부한다. 동일 버전의 CI 재빌드를 이전 미전달
산출물로 완전히 교체할 때만 `--allow-same-version`을 사용한다. Fork의 unsigned 산출물은 자동 업데이트
신뢰 대상이 아니며 수동 검토자가 의도적으로 `--allow-unsigned`를 준 경우에만 검증된다.
manifest·signature·certificate·APK·SBOM은 symlink/hardlink가 아닌 regular file이어야 한다. 검증기는
각 파일을 `O_NOFOLLOW` file descriptor로 한 번만 열어 크기·link count와 시작/종료 metadata를 확인하고
상한까지만 읽으므로 metadata 검사 뒤 경로 교체나 읽는 중 변경도 거부한다. 특히 APK descriptor는
hash·byte-count 검사 뒤에도 닫지 않고 Linux 자식 `apksigner`에 직접 상속해 signer 검사까지 같은
inode의 bytes에 고정한다.
최종 field evidence 명령은 verifier의 `--json` 결과에 포함된 exact manifest SHA-256과 평가 시점에 읽은
bytes를 다시 대조하므로, 두 단계 사이 manifest 경로 교체도 실패-폐쇄로 차단한다. 또한 한
`git status --porcelain=v2 --branch` snapshot으로 평가 전·후 exact commit과 clean 상태를 확인해 중간
source drift가 있으면 report를 쓰지 않는다.

v2 Android 앱에서는 연결 센터의 **Android 앱 업데이트 → ZIP 선택**으로 동일한 signed artifact ZIP을
고르거나 **공식판 조회**로 hardcoded public GitHub 저장소의 Latest 정식판을 명시적으로 확인할 수 있다.
공식판은 조회 결과를 본 뒤 **다운로드·서명 검증**을 다시 눌러야 private cache로 내려받는다. GitHub
asset digest를 전송 무결성으로 확인한 뒤에도 앱은 top-level 6개 파일만 풀고 현재 설치 앱과 같은 signer와
package, 정확한 manifest 서명·APK/SBOM hash와 더 높은 versionCode를 검증한다. 검토 결과는 10분 뒤
폐기되며 **검증된 APK 설치 확인**을 다시 터치해야 Android package installer가 열린다. unknown-source
허용과 최종 설치는 Android 시스템 화면에서 사용자가 직접 승인한다. 시작 시·주기적·background 조회,
자동 다운로드와 무인 설치는 없으며, 1.8.2 앱에는 importer가 없으므로 최초 2.0 candidate는 기존 수동
설치가 필요하다.

## Field-test checklist

- 기존 설치 위에 APK가 정상 업데이트된다.
- signed ZIP importer가 변조·동일/낮은 versionCode·다른 package/signer를 거부하고 Android 설치 확인창만 연다.
- Companion과 두 단말이 동시에 페어링되어도 재시작 후 각 인증이 유지된다.
- 보조 Companion의 `삭제` 첫 터치는 검토만 열고 권한·key·등록을 바꾸지 않는다.
  두 번째 터치는 exact Companion client 권한을 먼저 해제한 뒤 Android key와 등록을
  삭제하며, PC offline·mTLS 불일치에서는 아무것도 지우지 않고 재시도할 수 있다. 성공한 해제 또는
  TLS key 교체 뒤 Companion을 재시작해도 이전 token·identity가 다시 허용되지 않는다.
- 프로젝트 목록, 새 프로젝트 생성과 `main` 브랜치 초기화가 동작한다.
- AI 연결 센터가 작은 화면과 키보드 표시 상태에서 내부 스크롤된다.
- 음성 짧게 누르기·길게 누르기와 중복 문장 방지가 동작한다.
- 실행 중 프롬프트 대기열, 오프라인 기록 복원과 재연결이 동작한다.
- 실행 중인 세션을 반납해도 PC 작업이 계속되며 다른 페어링 기기 한 대만 같은 대화를 이어받는다.
  경쟁 claim이나 응답 실패는 기존 모바일 프로젝트·Provider·대화를 바꾸지 않고, claim 뒤 Companion을
  재시작해도 소비된 handoff가 다시 나타나지 않는다.
- 사진·영상 첨부와 로컬 분석 실패 메시지가 확인된다.
- [v2 기능 현장 검증](functional-field-acceptance.md)의 exact signed candidate·clean commit에 묶인 20개
  scenario가 모두 통과하고 schema 2가 OpenAI coding grade 1개와 서로 다른 OpenRouter family coding grade
  2개의 SHA-256을 고정한 owner-only aggregate report를 검토한다.
- [Android 저부하 현장 검증](android-field-acceptance.md)의 60분 release gate를 direct LAN, 실제 P2P와
  outbound relay 지원 경로별로 통과하고, 설치 APK digest를 시작·종료에 검증한 세 schema 3 report의
  manifest/commit/APK digest가 기능 field report와 같은 exact signed candidate인지 검토한다.
- [v2 릴리스 evidence 최종 판정](release-evidence.md)을 clean candidate checkout에서 실행해 pinned
  certificate·manifest signature·APK signer·artifact hash 선행 검증, 세 protected coding grade 원문과 기능
  관찰, 세 transport report의 재계산된 gate·candidate binding·30일 freshness가 모두 pass인지 확인한다.

## Publish

현장 테스트 승인 후에만 다음 순서로 수행한다.

1. Draft PR을 Ready로 전환하고 `main`에 병합한다.
2. 병합 커밋에서 `npm run release:check`를 다시 실행한다.
3. `vX.Y.Z` annotated tag를 만들고 force push 없이 태그를 push한다.
4. Changelog 내용을 사용해 GitHub Release를 만들고 APK, 체크섬, SBOM, update manifest와
   signed build의 manifest 서명·공개 인증서 및 정확한 이름의 `Codex-Pocket-Voice-vX.Y.Z-update.zip`을
   첨부한다. ZIP은 draft/prerelease가 아닌 정식 Release에서만 Android 공식판 조회 대상으로 삼는다.
5. Release asset의 SHA-256을 CI 산출물과 대조하고 `Latest` 표시를 확인한다.

## Rollback and retention

- Android 로컬 보관 위치:
  - `Download/CodexPocketVoice/current/<version>/`: 설치할 candidate APK, `SHA256SUMS`, SBOM, update manifest 묶음
  - `Download/CodexPocketVoice/rollback/<version>/`: 직전 현장 검증 APK와 대응 무결성·manifest 파일 한 세트
  - `Download/CodexPocketVoice/archive/legacy/`: 정리 전 과거 시험 APK의 임시·복구 가능한 보관
- Android field gate: 별도 API 30+ test client에서 v1.8.1 위에 candidate를
  `adb install --enable-rollback 0`으로 설치하고, candidate 실행 전 available snapshot을 확인한 뒤
  `pm rollback-app`으로 이전 APK와 install 시점 userdata가 함께 복원되는지 검증한다. exact 절차와
  금지된 대체 방식은 [기능 현장 검증](functional-field-acceptance.md)을 따른다.
- Android production: 일반 Package Installer가 낮은 versionCode를 허용하거나 AOSP testing rollback을
  제공한다고 가정하지 않는다. 장애 시 데이터 삭제·`install -d`를 안내하지 않고, 더 높은
  SemVer/versionCode의 검토된 forward fix를 배포한다.
- Linux Companion: 교체 직전 디렉터리 snapshot 한 개를 유지하고, 새 버전 검증 후 제거한다.
- Actions artifacts는 14일 보존한다. 정식 보존은 Release assets가 담당한다.
- private path, device/network values, credentials, signing material은 커밋하거나 Release에 첨부하지 않는다.
