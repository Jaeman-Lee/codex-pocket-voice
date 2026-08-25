# Approved API tools

OpenAI API와 OpenRouter run은 Provider가 도구 호출을 제안하더라도 Linux Companion의
`LocalToolBroker`를 우회할 수 없다. observation 이외의 도구는 matching run과 tool-call ID로 승인
요청을 만들고 모바일 화면의 직접 approve/decline 응답을 기다린다. 음성·system auto-approve는 없다.

## 검토된 텍스트 파일 변경

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
  남고, 다음 Companion 시작에서 미완료 batch 전체를 이전 상태로 원복한다.
- 내부 `.codex-pocket-*` staging/backup은 API 목록·읽기·검색·Git 관찰·수정에서 숨기고 정상 종료 시 제거한다.

`workspace_create_text`는 기존 regular 디렉터리 아래의 아직 존재하지 않는 경로 하나에 12,000자/12KiB
이하 UTF-8 본문을 `0644`로 만든다. `/dev/null` 기준 bounded/redacted diff, 새 SHA와 mode를 터치 승인에서
보여 준다. 같은 디렉터리에 fsync한 임시 파일을 hard-link하므로 승인 뒤 다른 process가 먼저 만든
목적지를 덮어쓰지 않는다. 디렉터리는 만들지 않는다.

`workspace_rename_text`는 기존 regular UTF-8 single-link 파일 하나를 기존 regular 디렉터리 아래의
비어 있는 경로로만 옮긴다. 원본은 `workspace_read` SHA, inode와 최대 1MiB 제한을 다시 확인하며 source와
destination, hash, 100% rename diff를 터치 승인에서 보여 준다. 목적지 hard-link가 성공하고 같은 inode와
hash임을 확인한 뒤 원래 이름을 제거한다. 다른 filesystem으로의 이동, secret-bearing 본문과 목적지
덮어쓰기는 거부한다.

네 변경 도구는 하나의 Companion 안에서 직렬화된다. 파일을 건드리기 전에 앱 전용 transaction
디렉터리에 strict manifest를 `0600`으로 쓰고 디렉터리는 `0700`으로 고정한다. 기본 위치는 gateway auth
state 옆 `workspace-transactions`이며 `CODEX_POCKET_WORKSPACE_TRANSACTIONS`로 전용 절대 위치를 정할 수
있다. manifest에는 파일 본문·credential이 아니라 workspace, 상대 경로, SHA·inode·mode만 들어간다.

- `staging`: 대상 파일을 아직 바꾸지 않았으므로 재시작 시 내부 stage만 제거한다.
- `prepared`: commit 도중이므로 교체 batch와 rename은 승인 전 상태로 원복하고, 미완료 create는 제거한다.
- `committed`: 승인 결과를 유지하고 내부 backup/stage만 정리한다.
- manifest·내부 파일·대상 중 하나가 외부에서 바뀌어 안전한 판정이 불가능하면 자동 덮어쓰기를 하지
  않고 Companion의 변경 도구 초기화를 실패시킨다. 남은 복구본은 보존한다.

## 수동 안전 복구

자동 복구가 중단되어도 Companion web server는 fail-closed degraded mode로 시작한다. 프로젝트 목록,
파일 읽기와 작업 대시보드는 계속 사용할 수 있지만 네 workspace 변경 도구는 모두 `503`으로 차단된다.
paired 클라이언트만 복구 상태를 읽을 수 있고 재시도 API는 same-origin 요청과 고정 확인값을 요구한다.
응답은 최대 32개 transaction과 transaction당 16개 상대 경로로 제한한다. manifest를 안전하게 해석하지
못하면 workspace나 경로를 추측하지 않는다.

모바일 작업 대시보드의 경고에서 다음 순서로 처리한다.

1. 표시된 Linux PC workspace와 상대 경로를 Git, 편집기 history 또는 별도 backup으로 확인한다.
2. 외부에서 만든 제3의 내용을 유지해야 하면 먼저 transaction 대상 밖의 안전한 위치에 복사한다.
3. 내부 `.codex-pocket-*` 파일과 private transaction journal은 삭제·편집하지 않는다.
4. 대상 파일을 Git/승인 diff로 확인 가능한 원본 또는 승인된 새 본문 상태로 되돌린 뒤
   **안전 복구 재시도 검토**와 **확인하고 안전 복구 재시도**를 차례로 누른다.
5. 계속 차단되거나 journal을 해석할 수 없으면 journal을 보존한 채 운영자 검토를 요청한다.

재시도는 startup과 같은 inode/hash/link/내용 검사를 다시 실행할 뿐 journal을 폐기하거나 외부 변경을
강제로 덮어쓰지 않는다. 안전한 상태가 증명되지 않으면 계속 차단된 상태로 남는다.

삭제, 디렉터리 생성, chmod와 binary 변경은 어떤 API 변경 도구도 허용하지 않는다.

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
