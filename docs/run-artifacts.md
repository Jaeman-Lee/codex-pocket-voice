# Run artifacts

v2 작업 대시보드는 완료 operation에 귀속된 테스트 결과, 로그, raster image와 Android APK를 검토하고
다운로드한다. 이 기능은 workspace 파일 브라우저가 아니다. Companion이 run 종료 시 만든 immutable
snapshot만 인증된 exact operation route로 제공한다.

## 수집 범위

- OpenAI/OpenRouter `project_verify`의 bounded stdout/stderr는 test log가 된다. verifier의 disposable
  overlay에서 생성된 파일은 원래 설계대로 폐기되며 APK로 승격되지 않는다.
- Codex command output은 최종 operation 저장 전에 별도 log로 분리된다.
- Provider/Codex 결과의 `fileChanges`가 가리킨 파일만 검사한다. 프로젝트 내부 regular file이어야 하며
  PNG, JPEG, WebP, GIF, APK와 `test-results`/`reports`/`logs` 아래의 bounded text report만 허용한다.
- 한 operation은 최대 8개, 합계 256 MiB다. text 512 KiB, image 25 MiB, APK 200 MiB 개별 상한도 적용한다.

## 보안 경계

- 상대 경로 이탈, 절대 경로의 workspace 이탈, control character, symlink와 symlink component,
  민감 경로, hard link, 실행 중 변경된 파일은 snapshot하지 않는다.
- log는 저장 전 credential pattern을 다시 redaction한다. operation에는 원래 경로와 content를 넣지 않고
  opaque UUID, 안전한 표시 이름, kind, MIME, 크기, SHA-256, 생성 시각과 최대 8,000자 preview만 남긴다.
- `/api/runs/:operationId/artifacts/:artifactId`는 기존 Gateway bearer/mTLS 인증 뒤 operation journal의
  artifact descriptor와 private file identity를 모두 확인한다. 응답은 `no-store`, `nosniff`, attachment로
  제공하며 checksum header를 포함한다.
- 사용자가 프로젝트 Companion 기록을 2단계 확인으로 삭제하면 연결된 artifact directory도 즉시
  삭제한다. 접근할 operation이 retention에서 사라진 orphan snapshot은 다음 Companion 초기화 때 정리한다.

기본 저장소는 Gateway 인증 state 옆 owner-only `run-artifacts`이며 필요하면 Linux Companion에서
`CODEX_POCKET_RUN_ARTIFACTS`로 바꿀 수 있다. 이 경로는 Android/Termux checkout이 아니라 Linux PC에 둔다.
