# Approved API tools

OpenAI API와 OpenRouter run은 Provider가 도구 호출을 제안하더라도 Linux Companion의
`LocalToolBroker`를 우회할 수 없다. observation 이외의 도구는 matching run과 tool-call ID로 승인
요청을 만들고 모바일 화면의 직접 approve/decline 응답을 기다린다. 음성·system auto-approve는 없다.

## 기존 텍스트 파일 교체

`workspace_replace_text`는 다음 조건을 모두 만족할 때만 등록된 파일 하나를 교체한다.

- 허용 workspace 안의 기존 regular UTF-8 파일이며 symlink/hardlink 또는 민감 경로가 아니다.
- 전체 새 내용은 12,000자/12KiB 이하고 credential/private-key 형태를 포함하지 않는다.
- 모델이 `workspace_read`에서 받은 원본 SHA-256을 제출한다.
- 승인 diff 생성 시점과 실제 실행 시점 모두 파일 inode와 SHA-256이 그대로다.
- 사용자가 redacted/bounded diff, 이전·새 hash와 프로젝트를 보고 화면에서 승인한다.

승인 뒤에는 같은 디렉터리의 `0600` 임시 파일을 fsync하고 원래 mode를 복원한다. 원본 inode를 같은
디렉터리의 내부 hard-link backup으로 고정해 hash를 마지막으로 확인한 다음 atomic rename과 directory
fsync를 수행한다.

`workspace_replace_text_batch`는 같은 규칙으로 서로 다른 기존 파일 2~8개를 한 번에 교체한다.

- 파일당 12,000자/12KiB, 전체 48,000자/48KiB를 넘지 않는다.
- 모든 경로·inode·SHA·UTF-8·민감정보 조건을 먼저 확인하고 새 내용을 모두 fsync한 뒤 commit한다.
- 승인함에는 파일별 이전/새 hash, 변경 줄 수와 합친 diff를 표시한다. JSON escape 이후에도 검토 본문은
  30KiB 이하이며 넘는 diff는 잘라 표시한다.
- 각 원본의 hard-link backup을 확인하고 새 파일을 atomic rename한다. 정상 runtime에서 이후 파일의
  경합·취소·오류가 발생하면 이미 설치한 파일도 역순으로 원복한다.
- process 또는 OS가 commit 도중 강제 종료되더라도 개별 대상 경로에는 완전한 이전본 또는 새 본문만
  남는다. 다만 batch 전체의 crash-atomicity는 아직 제공하지 않으므로 CI/개발 checkpoint로 유지한다.
- 내부 `.codex-pocket-*` staging/backup은 API 목록·읽기·검색·Git 관찰·수정에서 숨기고 정상 종료 시 제거한다.

새 파일 생성, 삭제, 이름변경, chmod와 binary 변경은 두 교체 도구 모두 허용하지 않는다.

## npm 검증 sandbox

`project_verify`는 `package.json`에 이미 정의된 `check`, `test`, `build` 중 하나만 받는다. 임의 command,
인자와 script 본문을 API 입력으로 받지 않으며 package SHA-256이 검토 뒤 바뀌면 실행하지 않는다.

Linux 시작 probe가 아래 경계를 실제로 만들고 overlay 변경이 host workspace에 남지 않는 것을 확인한
경우에만 도구가 Provider descriptor에 나타난다.

- unprivileged user, mount, PID와 별도 network namespace
- 현재 workspace를 lower layer로 쓰는 일회용 overlay
- 외부 interface가 없고 필요 시 loopback만 활성화된 network
- `.git`, `.env*`, key/keystore와 기타 민감 경로 mask
- API key와 사용자 환경을 상속하지 않는 빈 process environment
- Node runtime과 system binaries의 read-only bind
- 180초 wall/CPU, process·FD·파일 크기와 512KiB 수집/80,000자 반환 상한

검증 process가 만든 파일은 전부 overlay와 함께 폐기한다. 격리 probe가 실패하는 Linux, Android,
macOS와 Windows에서는 `commandExecution` capability가 false이고 이 도구를 모델에 보내지 않는다.
run interrupt는 아직 대기 중인 승인을 system decline으로 닫으며 승인 만료도 자동 실행으로 바뀌지 않는다.
