# Durable event journal

v2 Linux Companion은 API Provider의 `store:false` 실행과 모바일 재연결을 위해 operation과 공통
Provider event를 로컬 SQLite에 보존한다. Android의 암호화 conversation/queue snapshot과 역할을
분리하며, Provider 원본 응답이나 Authorization header는 저장하지 않는다.

## 저장 위치와 키

기본 DB는 Gateway 인증 상태와 같은 private 디렉터리의 `event-journal.sqlite3`, 키는
`event-journal.sqlite3.key`이다. 다른 위치가 필요하면 Companion 시작 전에 지정한다.

```sh
export CODEX_POCKET_EVENT_JOURNAL=/private/path/event-journal.sqlite3
export CODEX_POCKET_EVENT_JOURNAL_KEY_FILE=/private/path/event-journal.key
chmod 600 /private/path/event-journal.key
```

DB와 key의 상위 디렉터리는 같은 Companion 사용자 소유이며 group/other 접근이 없는 private directory여야
한다. 키는 32 random byte의 base64url 값이며 같은 사용자 소유의 symlink·hard link가 아닌 일반 파일과
mode `0600`만 허용한다. 기본 키가 없으면 mode `0600`으로 생성한다. operation, prompt, 결과, idempotency record와
공통 SSE payload는 record별 random IV와 AAD를 사용하는 AES-256-GCM envelope로 저장한다. SQLite의
workspace index는 key를 사용하는 HMAC-SHA-256이며 경로 원문을 포함하지 않는다.

DB에는 schema, cursor, 암호화되지 않은 operation status와 timestamp 같은 최소 운영 metadata가
남는다. 이 metadata와 workspace index도 ciphertext의 AAD에 포함해 레코드 간 이동·변조를 감지한다.
key를 잃으면 기존 payload를 복구하지 못하므로 DB와 key는 함께 보존하거나 함께 폐기해야 한다.

## 재연결 계약

- run 시작 operation과 idempotency record는 `/api/runs`가 202를 반환하기 전에 commit한다.
- terminal operation과 UI로 전달하는 sanitized common event를 같은 저널에 순서대로 기록한다.
- SSE frame은 SQLite cursor를 `id:`로 보내고, 앱은 다음 연결의 `Last-Event-ID`로 돌려준다.
- Android/PWA는 적용한 cursor를 선택한 Companion별 보안 저장소에 기록하고 이미 적용한 cursor를 버린다.
- retention gap 또는 새 DB로 cursor가 되돌아가면 Gateway가 `journal/reset`을 보낸 뒤 현재 run snapshot과
  보존된 event를 다시 확인한다.
- Companion 재시작 때 terminal event가 없는 `running` operation은 `unknown`으로 바꾼다. 사용자가 PC
  결과와 Git 상태를 확인하기 전에는 이를 완료·실패로 추정하거나 그 프로젝트 queue를 재개하지 않는다.
- 사용자의 확인 시각은 operation에 암호화해 commit한 뒤 `acknowledged` event로 연결 기기에 전파한다.
  따라서 앱이나 Companion을 다시 열어도 이미 확인한 `unknown` 작업이 queue를 다시 막지 않는다.

기본 retention은 7일, 최대 500 operation과 2,000 event다. 오래된 terminal operation 삭제 시 관련
event도 함께 삭제한다. 실행 중 operation은 retention 정리 대상에서 제외된다. 사용자 설정,
암호화 export와 범위별 delete UI는 아직 비활성화되어 있다.

## 검사 범위

자동 테스트는 private directory와 DB/key/WAL 권한, symlink·hard link 차단, 평문
prompt·workspace·event·idempotency 비노출, ciphertext와 metadata tamper 감지, retention gap과 cursor
reset, 중복 cursor 제거, idempotent retry, `running → unknown` 재시작 복구와 durable acknowledgement를
가짜 Provider로 검증한다. 공개 CI는 실제 Provider 요청이나 사용자 데이터를 사용하지 않는다.
