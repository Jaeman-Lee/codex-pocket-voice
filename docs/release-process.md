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
- Android stable APK

Android 산출물에는 서명 APK 또는 fork용 unsigned APK, `SHA256SUMS`, CycloneDX SBOM이
함께 있어야 한다. 서명 키와 암호는 GitHub Secrets 밖으로 복사하지 않는다.

## Field-test checklist

- 기존 설치 위에 APK가 정상 업데이트된다.
- Companion과 페어링되고 앱 재시작 후에도 인증이 유지된다.
- 프로젝트 목록, 새 프로젝트 생성과 `main` 브랜치 초기화가 동작한다.
- AI 연결 센터가 작은 화면과 키보드 표시 상태에서 내부 스크롤된다.
- 음성 짧게 누르기·길게 누르기와 중복 문장 방지가 동작한다.
- 실행 중 프롬프트 대기열, 오프라인 기록 복원과 재연결이 동작한다.
- 실행 중인 세션을 반납해도 PC 작업이 계속되며 다른 페어링 기기에서 같은 대화를 이어받는다.
- 사진·영상 첨부와 로컬 분석 실패 메시지가 확인된다.

## Publish

현장 테스트 승인 후에만 다음 순서로 수행한다.

1. Draft PR을 Ready로 전환하고 `main`에 병합한다.
2. 병합 커밋에서 `npm run release:check`를 다시 실행한다.
3. `vX.Y.Z` annotated tag를 만들고 force push 없이 태그를 push한다.
4. Changelog 내용을 사용해 GitHub Release를 만들고 APK, 체크섬, SBOM을 첨부한다.
5. Release asset의 SHA-256을 CI 산출물과 대조하고 `Latest` 표시를 확인한다.

## Rollback and retention

- Android 로컬 보관 위치:
  - `Download/CodexPocketVoice/current/<version>/`: 설치할 candidate APK, `SHA256SUMS`, SBOM
  - `Download/CodexPocketVoice/rollback/<version>/`: 직전 현장 검증 APK와 대응 무결성 파일 한 세트
  - `Download/CodexPocketVoice/archive/legacy/`: 정리 전 과거 시험 APK의 임시·복구 가능한 보관
- Android: 직전 정식 Release APK로 돌아가려면 Android가 허용하는 versionCode 정책을 따른다.
  다운그레이드가 차단되면 앱 데이터를 보존할지 먼저 결정하고 새 수정 버전을 배포한다.
- Linux Companion: 교체 직전 디렉터리 snapshot 한 개를 유지하고, 새 버전 검증 후 제거한다.
- Actions artifacts는 14일 보존한다. 정식 보존은 Release assets가 담당한다.
- private path, device/network values, credentials, signing material은 커밋하거나 Release에 첨부하지 않는다.
