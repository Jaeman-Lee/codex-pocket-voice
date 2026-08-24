# OpenAI API provider

OpenAI API provider는 Linux Companion에서만 자격 증명을 읽고 공식 JavaScript SDK의 Responses
API를 호출한다. Android/PWA bundle, Gateway 응답, 로그와 Git에는 API key를 넣지 않는다.

## 서버 설정

systemd 256 이상에서는 user-scoped encrypted credential이 권장 방식이다.

```sh
./scripts/manage-provider-credential.sh set openai
./scripts/install-linux-companion.sh
```

구형 systemd 또는 직접 실행 환경에서는 Companion 사용자만 읽을 수 있는 key 파일을 사용한다.

```sh
chmod 600 /secure/path/openai-api-key
export CODEX_POCKET_OPENAI_API_KEY_FILE=/secure/path/openai-api-key
export CODEX_POCKET_OPENAI_MODELS=gpt-example-verified
export CODEX_POCKET_OPENAI_DEFAULT_MODEL=gpt-example-verified
```

`OPENAI_API_KEY` 환경변수도 지원하지만 프로세스 실행 환경과 셸 기록 관리가 가능한 경우에만 쓴다.
`CODEX_POCKET_OPENAI_MODELS`는 쉼표로 구분한 명시적 허용 목록이다. Companion은 이름 패턴만 보고
Responses·이미지·도구 capability를 추정하지 않으며, 허용 목록이 없으면 API 실행을 비활성화한다.
허용 목록은 chat 실행 후보일 뿐 project 권한이 아니다. tool 권한은
[Provider model grade reports](provider-model-grades.md)의 별도 protected report가 결정한다.

설정을 바꾼 뒤에는 실행 중인 Codex turn이 없고 사용자가 확인한 시점에만 Companion을 재시작한다.
암호문 교체·recoverable 해제, source 우선순위와 fail-closed 검사는
[Linux Provider credentials](provider-credentials.md)를 따른다.

## 현재 활성 범위

- `stream: true`, `store: false` 텍스트 응답과 PNG/JPEG/WebP/GIF 이미지 입력
- 공통 `ProviderEvent`를 통한 텍스트 delta, 완료, 오류와 token usage 전달
- strict JSON schema와 `parallel_tool_calls: false`를 사용하는 stateless 함수 호출 반복
- 허용 root 내부의 `workspace_list`, `workspace_read`, `workspace_search`, `git_status`, `git_diff`
- Gateway operation 단위 중단과 timeout
- Models API 인증·목록 확인만 수행하는 무료 연결 테스트
- 공급자 원본 JSON과 Authorization 값을 제거한 오류 분류
- Companion이 강제하는 `max_output_tokens`, 누적 total token과 run 비용 상한

유효한 `projectRead` 등급의 관찰 도구는 읽기 전용으로 자동 실행되고, `coding` 등급까지 통과한
파일 교체·생성·rename과 격리 npm 검증은 SHA-bound diff와
터치 승인을 통과한 경우에만 실행된다. 프로젝트 밖 경로와 외부 symlink, `.git`, `.env`, 개인 키·keystore,
credential 계열 파일을 거절하고 파일·검색·diff 결과에 크기와 시간 상한을 적용한다. Git 호출은 고정된
`status`, `diff`, `rev-parse` 인자만 사용하며 외부 diff, textconv, fsmonitor와 외부 Git 환경 override를
비활성화한다. 검색은 `rg`를 우선 사용하고 설치되지 않은 Companion에서는 같은 경로·파일 수·byte
상한을 적용한 내장 검색으로 전환한다. 도구 원문 결과는 Gateway SSE로 보내지 않고 redacted
summary만 전달한다.

대화 재개와 등급을 통과한 승인형 bounded 파일 변경·검증은 durable journal과 공통 Tool Broker로 활성화된다.
삭제·chmod·binary, 임의 명령과 network 도구는 비활성화되어 있다.

`store: false` 함수 호출은 각 응답의 message·function call·reasoning 항목과
`function_call_output`을 Companion이 다음 요청에 다시 전달한다. reasoning 모델을 위해
`reasoning.encrypted_content`도 요청하지만, 원시 reasoning이나 Provider 응답 객체를 Android로
전달하지 않는다. 한 run의 함수 호출은 최대 8회이며 병렬 호출은 비활성화한다.

`store: false`는 Responses 객체 저장을 끄지만 일반적인 API abuse-monitoring 보존까지 없앤다는
뜻은 아니다. 자세한 동작은 [Responses API reference](https://developers.openai.com/api/reference/cli/resources/responses/methods/create)와
[OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data)를 기준으로 확인한다.

공개 CI는 가짜 stream만 사용하며 실제 유료 inference를 보내지 않는다.
사전 비용검사, 월 soft-limit 확인, emergency stop과 완료 비용 분류는
[API run policy](run-policy.md)를 따른다.

## 보호된 실제 모델 smoke

`.github/workflows/openai-smoke.yml`은 자동 실행되지 않는 수동 `workflow_dispatch`다. GitHub
`provider-smoke` environment에 승인자를 지정하고, 그 environment에 `OPENAI_API_KEY` secret과
쉼표로 구분한 exact `OPENAI_SMOKE_MODELS` variable을 설정한 뒤에만 실행한다. environment의 배포
브랜치 제한도 `main`과 검토된 기능 브랜치로 좁힌다.

실행자는 모델 ID와 실행 시점의 공식 가격표에서 직접 확인한 input/output USD per million token을
입력한다. 하네스는 모델을 exact allowlist 및 Models API로 먼저 확인하고 다음 두 Responses 호출만
허용한다.

1. `store:false`, streaming, strict 강제 함수 호출로 무작위 synthetic marker를 왕복한다.
2. 첫 응답 항목과 `function_call_output`을 수동 replay하고 marker-only 최종 응답을 확인한다.

두 호출 모두 `service_tier: default`, 호출당 input 4,096/output 256 token 상한을 사용한다. 입력한
가격으로 계산한 최악 비용이 $0.02를 넘으면 inference 전에 실패하고, 실제 usage 추정 비용도 같은
상한을 넘으면 보고서를 만들지 않는다. 결과 artifact는 token 수, 비용 추정, 모델과 contract pass만
포함하는 0600 JSON이며 API key, prompt, marker, 함수 인자와 응답 본문은 포함하지 않는다. 이 smoke는
streaming·대화·함수 호출·stateless replay만 평가하고 실제 프로젝트 읽기나 코딩 등급을 부여하지 않는다.

현재 checkpoint에서는 loopback fixture만 실행했으며 실제 key나 유료 요청은 사용하지 않았다.
따라서 현재 smoke report만으로는 project tool이 활성화되지 않는다.
