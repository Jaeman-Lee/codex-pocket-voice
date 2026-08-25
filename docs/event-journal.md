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
- 목표 이름, 고정 시각과 보관 시각도 operation ciphertext에 저장하고 `metadata_updated` event로
  연결된 기기에 전파한다. 목표 이름은 한 줄 120자, 고정은 retained operation 중 최대 50개다.

기본 retention은 7일, 최대 500 operation과 2,000 event다. 작업 대시보드에서 1–30일,
operation 50–2,000개, event 200–10,000개 범위로 바꿀 수 있다. 정책 변경은 same-origin PUT과 명시적
확인값, 모바일의 두 번째 터치를 요구한다. 적용 즉시 한도 밖 기록이 삭제될 수 있으므로 필요한
workspace JSON을 먼저 내보내야 한다. 오래된 terminal operation 삭제 시 관련 event도 함께 삭제한다.
실행 중 operation은 retention 정리 대상에서 제외된다. 작업 대시보드는
이 정책을 표시하고, paired 클라이언트가 선택한 workspace의 operation과 event를 최대
16 MiB JSON으로 내보낼 수 있다. 내보낸 파일은 복호화된 평문이며 프로젝트 경로,
prompt와 결과가 포함되므로 사용자가 안전한 위치에 보관해야 한다.

workspace 기록 삭제는 화면에서 정확한 전체 경로와 영향 범위를 다시 본 뒤 두 번째 터치로만
실행된다. 해당 workspace에 실행·승인 중인 operation이나 사용자가 아직 확인하지 않은
`unknown` operation이 있으면 Gateway가 409로 거절한다. 삭제는 Companion의 operation, idempotency
기록과 연관 event만 제거하며 실제 프로젝트 파일, Android의 conversation과 queue journal은 바꾸지
않는다. 보관은 대시보드 기본 목록에서만 숨기며 실행·승인·미확인 `unknown`에는 적용할 수 없다.
고정은 retained 범위 안에서 정렬 우선순위만 높이고 설정한 operation/기간 retention을 우회하지 않는다.
명시적인 workspace 기록 삭제는 고정·보관 operation과 관련 event도 함께 제거한다. retention 사용자
설정은 schema 1의 additive `journal_settings` table에 저장하며 journal key의 HMAC으로 이름과 값을
인증한다. 누락·범위 초과·변조된 정책은 적용하지 않고 Companion 시작을 실패시킨다. 정책 변경은
`policy_updated` SSE로 연결 기기에 알린다.

같은 additive settings table에는 여섯 개의 API run 정책값도 별도 이름과 HMAC으로 완전하게 저장한다.
operation은 실행 시점의 token/cost/privacy/가격/사용량 정책 snapshot과 완료 뒤의 실제·추정·unknown
비용 상태를 암호문에 포함한다. 설정 일부 누락과 snapshot의 Provider·모델·route 불일치는 복원 시
거절한다. 세부 한도와 확인 token 계약은 [API run policy](run-policy.md)를 따른다.

## 검사 범위

자동 테스트는 private directory와 DB/key/WAL 권한, symlink·hard link 차단, 평문
prompt·workspace·event·idempotency 비노출, ciphertext와 metadata tamper 감지, retention gap과 cursor
reset, 중복 cursor 제거, idempotent retry, `running → unknown` 재시작 복구, durable acknowledgement와
목표 이름·고정·보관 복원, bounded 정책 영속화·즉시 정리·tamper detection, workspace 경계
내보내기·응답 크기 상한과 active/unknown 명시 삭제 보호를
가짜 Provider로 검증한다. 공개 CI는 실제 Provider 요청이나 사용자 데이터를 사용하지 않는다.
