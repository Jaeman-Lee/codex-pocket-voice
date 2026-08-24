# Provider model grade reports

Codex Pocket Voice는 model catalog의 이름이나 `tools` metadata만으로 프로젝트 읽기·변경 권한을 주지
않는다. Linux Companion이 보호된 eval report를 확인한 경우에만 해당 모델의 API 요청에 로컬 tool
정의를 포함한다.

## 저장 경계

기본 위치는 `${XDG_CONFIG_HOME:-$HOME/.config}/codex-pocket-voice/provider-grades`이며
`install-linux-companion.sh`가 0700 디렉터리를 만들고 systemd unit에
`CODEX_POCKET_PROVIDER_GRADE_DIR`을 고정한다. 다른 경로를 직접 실행 환경에서 쓸 때도 절대 경로만
허용한다.

디렉터리는 Companion 사용자 소유 0700/0500, report는 0600/0400 regular non-symlink 파일이어야 한다.
파일명은 소문자·숫자·점·밑줄·하이픈과 `.json`만 사용하며 최대 64개, 각 64 KiB다. 하나라도 권한,
소유자, UTF-8, JSON 또는 schema 검사를 통과하지 못하면 해당 Provider의 모든 project tool을
fail-closed로 차단한다. report 원문과 비용·usage는 Gateway, SSE와 journal export에 보내지 않는다.

보호된 workflow artifact를 검토한 뒤 설치하는 예시는 다음과 같다.

```sh
grade_dir=${XDG_CONFIG_HOME:-"$HOME/.config"}/codex-pocket-voice/provider-grades
install -d -m 700 "$grade_dir"
install -m 600 /reviewed/path/openai-smoke-report.json "$grade_dir/openai-reviewed.json"
```

활성 run은 시작 시 고정한 권한을 유지한다. report 추가·교체·제거는 진행 중인 turn을 중단하지 않고
다음 run부터 다시 평가된다. 별도 Companion 재시작은 필요하지 않다.

## 등급 해석

- report는 `checkedAt`부터 최대 30일만 유효하고 5분을 넘는 미래 시각은 거절한다.
- `conversation`과 Provider별 contract 항목이 모두 `pass`여야 project 등급을 검토한다.
- `projectRead: pass`는 observation 도구만 허용한다.
- `coding: pass`는 `projectRead: pass`를 전제로 touch-approved change/execution 도구까지 허용한다.
- `not_tested`, `fail`, `expired`, `invalid`는 권한을 올리지 않는다.
- OpenAI는 `requestedModel`과 허용된 actual snapshot을 exact model 등급에 묶는다.
- OpenRouter는 exact model과 `requestedUpstream` tag에 묶는다. 사용자가 고른 primary/backup이 모두
  등급과 현재 endpoint `tools` 지원을 통과해야 그 교집합을 허용한다. 자동 routing은 chat-only다.

현재 `openai-smoke.mjs`와 `openrouter-smoke.mjs`의 synthetic 2-call report는 conversation/tool contract만
검증하고 `projectRead`와 `coding`을 `not_tested`로 기록한다. 따라서 이 artifact를 설치해도 project
권한이 생기지 않는다. 실제 project read/coding grade는 승인형 현장 eval이 끝난 뒤에만 발급한다.

## 보호된 합성 프로젝트 등급

두 protected smoke workflow의 `project_scope`을 `read` 또는 `coding`으로 고르면 smoke가 통과한 같은
job에서 `provider-project-eval.ts`를 실행한다. 이 단계는 smoke report를 24시간 이내의 owner-only
regular file로 다시 검증하고 exact model, OpenRouter exact ZDR upstream과 실제 upstream 이름을
그 report에 고정한다. OpenAI 가격은 실행자가 다시 입력한 값, OpenRouter 가격은 현재 exact endpoint
catalog를 사용하며 최대 2회(read) 또는 3회(coding), 요청당 input 8,192/output 256 token과 총 $0.05
상한을 inference 전과 usage 후 모두 검사한다.

평가 작업공간은 매번 새로 만드는 권한 `0700` 임시 디렉터리다. 실제 프로젝트, Git checkout,
Companion journal과 Android 기록을 읽거나 바꾸지 않는다.

- `read`는 운영 `workspace_read` 하나만 모델에 주고, 모델이 파일에서 처음 본 random marker를 정확히
  반환했을 때만 `projectRead: pass`를 기록한다.
- `coding`은 운영 `workspace_read`와 `workspace_replace_text`만 주고, 읽기에서 받은 SHA로 임시 파일을
  정확히 한 번 바꾼 경우에만 `coding: pass`를 기록한다. 수동 workflow 선택 외에도
  `APPROVE_SYNTHETIC_CODING_EVAL` 확인 문구가 exact-match되어야 단 한 번의 touch-equivalent 승인을
  하네스가 발급한다.
- 읽기는 성공하고 변경이 실패하면 `projectRead: pass`, `coding: fail`을 남겨 read-only 단계만
  활성화할 수 있다. 실행·routing·usage 증거가 불완전하면 pass로 승격하지 않는다.
- report에는 tool 이름·상태, token/cost 숫자와 등급만 남긴다. prompt, random marker, 파일 내용,
  SHA, model output, API key와 credential source는 넣지 않는다.

이 report는 실제 Provider와 공통 Tool Broker의 기술 등급 증거다. 실제 사용자 프로젝트의 조사 →
변경 → 검증, 앱 승인·복구와 비용 확인은 별도 현장 출시 gate로 계속 남는다. workflow는 자동 실행되지
않으며 environment reviewer와 실행자의 명시적 선택 없이는 유료 요청을 보내지 않는다.

v2 release에서는 기능 observation schema 2가 field에 사용한 OpenAI coding report 한 건과 서로 다른
OpenRouter upstream family coding report 두 건의 SHA-256을 고정한다. 최종 evidence CLI가 owner-only 원문을
다시 읽어 exact protected coding evaluation·freshness·upstream/provider-family 분리를 확인하므로, smoke-only,
read-only, 실패·만료 또는 observation과 digest가 다른 report는 release 권한을 주지 않는다.
