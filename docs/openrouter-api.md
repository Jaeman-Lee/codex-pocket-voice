# OpenRouter provider

OpenRouter provider는 Linux Companion에서만 API key를 읽고
`https://openrouter.ai/api/v1/chat/completions`를 호출한다. Android/PWA bundle, Gateway 응답,
SSE, 로그와 Git에는 key를 넣지 않는다.

## 서버 설정

systemd 256 이상에서는 user-scoped encrypted credential과 명시적인 모델 허용 목록이 권장 방식이다.

```sh
./scripts/manage-provider-credential.sh set openrouter
./scripts/install-linux-companion.sh
```

구형 systemd 또는 직접 실행 환경에서는 Companion 사용자만 읽을 수 있는 key 파일을 사용한다.

```sh
chmod 600 /secure/path/openrouter-api-key
export CODEX_POCKET_OPENROUTER_API_KEY_FILE=/secure/path/openrouter-api-key
export CODEX_POCKET_OPENROUTER_MODELS=vendor/model-a,vendor/model-b
export CODEX_POCKET_OPENROUTER_DEFAULT_MODEL=vendor/model-a
```

`OPENROUTER_API_KEY` 환경변수도 지원한다. 모델 이름 패턴으로 기능을 추측하지 않으며 허용 목록이
없으면 실행을 비활성화한다. 설정 변경 뒤 Companion 재시작은 활성 Codex turn이 없고 사용자가
확인한 시점에만 수행한다.
암호문 교체·recoverable 해제, source 우선순위와 fail-closed 검사는
[Linux Provider credentials](provider-credentials.md)를 따른다.

## 모델과 개인정보 경계

Companion은 인증된 `/models/user`, `/models?zdr=true`와 `/endpoints/zdr` 결과의 교집합에서만 허용
목록 모델을 노출한다. ZDR endpoint가 보고한 exact `tag`만 모바일 upstream 선택지로 사용하며 임의로
입력한 tag는 실행 직전에 최신 cache와 다시 대조한다. catalog의 `supported_parameters`에 `tools`가
있는 것은 필요조건일 뿐 권한 등급이 아니다. [Provider model grade reports](provider-model-grades.md)의
exact model+upstream 등급을 함께 통과한 선택지만 공통 ToolBroker를 받고, 나머지는 chat-only로 제한한다. 이미지 입력도 catalog의
`image` modality가 확인된 모델에만 보낸다.

모델 catalog의 lowest prompt/completion 가격은 USD/1M token으로 변환하고, ZDR endpoint가 제공하는
upstream별 가격, p50 latency/throughput, 30분 uptime, quantization과 tool parameter 지원을 함께
표시한다. 값은 유한한 상한 안에서만 받아들이며 catalog snapshot이라는 점을 UI에 명시한다. 이 값은
실제 run의 `usage.cost`와 별개이고, 품질 또는 코딩 등급으로 해석하지 않는다. 연결 테스트는 `/key`의
남은 credit 한도와 만료일만 인증된 화면에 보여 주며 key label이나 원문 key는 반환하지 않는다.
OpenRouter는 usage를 자동으로 응답에 포함하며 `usage.cost`는 credits 단위다. Credit 기준 통화와 catalog
API 가격은 USD이지만 보호된 smoke report에서는 `actualCostCredits`와 `estimatedMaximumUsd`를 별도 필드로
유지한다. Companion operation도 원본 호환 필드 `usage.costCredits`를 남기되, 월 정책 집계용
`policyUsage`에는 provider-reported USD micro 단위로 정규화해 catalog 추정값과 출처를 구분한다.

모든 inference 요청은 다음 profile을 강제한다.

```json
{
  "provider": {
    "allow_fallbacks": false,
    "require_parameters": true,
    "data_collection": "deny",
    "zdr": true
  }
}
```

한 요청에는 모델 ID 하나만 넣는다. 기본은 OpenRouter가 ZDR endpoint 하나를 고르되 fallback을
허용하지 않는다. 사용자가 모바일에서 1차 upstream을 고르면 `order`와 `only`를 같은 단일 tag로
고정한다. 백업도 직접 고른 경우에만 두 tag를 같은 순서로 `order`와 `only`에 넣고
`allow_fallbacks:true`를 사용한다. 따라서 선택하지 않은 Provider 또는 다른 모델로는 우회하지 않는다.
선택은 offline queue와 Companion 암호화 operation에 보존하며, 같은 대화를 이어가는 중에는 바꿀 수
없다. 응답이 보고한 실제 upstream, 요청한 순서, fallback 허용 여부와 strict privacy profile은 성공과
실패 run 결과에 기록한다.
OpenRouter의 ZDR와 data-collection 설정은 upstream 내용 보존을 제한하는 routing 조건이며 token,
비용, latency 같은 OpenRouter metadata까지 없앤다는 뜻은 아니다.

## 현재 활성 범위

- Chat Completions SSE text streaming, PNG/JPEG/WebP/GIF 이미지 입력, 취소와 timeout
- 자동으로 마지막 SSE chunk에 오는 input/output/cache/reasoning token과 credit 비용 합산
- `workspace_list`, `workspace_read`, `workspace_search`, `git_status`, `git_diff` 읽기 도구
- strict JSON schema, `parallel_tool_calls: false`, 한 run 최대 8회 도구 호출
- API key 확인과 user/ZDR 모델 교집합만 읽는 비과금 연결 테스트
- ZDR endpoint 기반 1차 upstream 고정과 사용자가 승인한 단일 backup 범위
- 모델/upstream 가격·성능 snapshot, key quota·만료 가시성
- 원시 OpenRouter chunk와 도구 결과를 제거한 공통 ProviderEvent
- Companion이 강제하는 `max_tokens`, 누적 total token과 가장 비싼 승인 route 기준 run 비용 상한

대화 재개와 등급을 통과한 승인형 파일 변경·검증 도구는 공통 암호화 journal/ToolBroker 계약으로 활성화된다.
임의 명령, network 도구, 개인정보 조건 완화와 모델 fallback은 비활성화되어 있다. 모델별 실제 저비용
contract/eval과 현장 검증 전에는 이 범위를 넓히지 않는다.

공개 CI는 가짜 HTTP/SSE와 모델 catalog만 사용하며 실제 API key나 유료 inference를 사용하지 않는다.
사전 비용검사, 월 soft-limit 확인, emergency stop과 완료 비용 분류는
[API run policy](run-policy.md)를 따른다.

## 보호된 실제 smoke/eval

실제 모델 contract는 catalog metadata로 추정하지 않는다. GitHub의 `provider-smoke` environment에
승인 규칙을 설정하고 `OPENROUTER_API_KEY` secret과 쉼표로 구분한 `OPENROUTER_SMOKE_MODELS` variable을
넣은 뒤에만 protected smoke를 수동 실행한다. v2 merge 전에는 이미 default branch에 등록된 `Linux
checks` workflow를 `feature/v2-control-plane` ref와 `provider=openrouter`로 dispatch하고, merge 뒤에는
standalone workflow도 직접 실행할 수 있다. environment reviewer와 검토된 branch policy를 먼저 저장한
다음에만 같은 environment에 `PROVIDER_SMOKE_ENVIRONMENT_READY=PROTECTED_PROVIDER_SMOKE_V1` variable을
추가한다. 실행자는 exact model과 ZDR upstream tag를 직접 입력한다.

```sh
gh workflow run ci.yml --ref feature/v2-control-plane \
  -f provider=openrouter \
  -f model=EXACT_ALLOWLISTED_MODEL \
  -f upstream=EXACT_ZDR_UPSTREAM_TAG \
  -f project_scope=none \
  -f execution_confirmation=RUN_BOUNDED_PROVIDER_SMOKE
```

dispatcher 기본값 `provider=none`과 일반 push/PR은 Provider 호출을 실행하지 않고 reusable Provider job을
`skipped`로 기록한다. 보호 environment 준비 표식·exact 실행 확인문·key·allowlist·upstream이 없거나
잘못되면 checkout 또는 inference 전에 실패한다.

Harness는 synthetic token만 사용해 강제 tool call과 그 결과를 잇는 대화 2회만 호출한다. endpoint
가격과 호출당 2,048 input/64 output token ceiling으로 $0.02 상한을 사전 검사하고 key remaining
credit도 확인하며, `order`/`only`, fallback 차단, ZDR와 data collection 거부를 유지한다. 각 응답의
자동 usage accounting과 `X-OpenRouter-Metadata: enabled` 결과에서 exact model, 첫 attempt와 catalog
provider가 일치해야 통과한다. 결과 artifact에는 모델·upstream, USD catalog estimate, USD 기준 credit
비용, token과 통과/미검사 등급만 남기고 prompt, 응답 text, tool token과 API key는 남기지 않는다.
`projectRead`와 `coding`은 실제 승인형 프로젝트 현장 시나리오 전까지 `not_tested`로 유지한다.
OpenRouter는 자동 routing에 project tool을 주지 않는다. 사용자가 고른 primary와 backup 각각의 report가
모두 통과하고 현재 ZDR endpoint가 tools parameter를 지원할 때만 공통 최소 권한을 API 요청에 넣는다.

`project_scope=read|coding`을 명시하면 같은 protected job에서 smoke가 증명한 exact model+ZDR upstream을
새 0700 합성 프로젝트의 운영 `workspace_read`/`workspace_replace_text` 계약으로 평가할 수 있다. read는
최대 2회, coding은 최대 3회 요청과 요청당 input 8,192/output 256 token을 허용한다. 현재 endpoint
catalog의 최악 가격과 Provider가 보고한 USD 기준 credit 비용이 각각 $0.05를 넘으면 grade를 통과시키지
않는다. coding은 `APPROVE_SYNTHETIC_CODING_EVAL` exact confirmation이 필요하다. report에는 routing,
tool 상태, token/cost와 등급만 남고 prompt, marker, 파일 내용·SHA와 모델 출력은 없다.

이 checkpoint에서는 project-grade workflow를 fake adapter와 운영 Tool Broker fixture로만 실행했다.
실제 API key·유료 inference 또는 실제 model/upstream grade 발급은 수행하지 않았다.

## 공식 기준

- [OpenRouter Chat Completions](https://openrouter.ai/docs/api/api-reference/chat/send-chat-completion-request)
- [Tool calling](https://openrouter.ai/docs/guides/features/tool-calling)
- [Models API와 supported parameters](https://openrouter.ai/docs/guides/overview/models)
- [Provider routing과 ZDR](https://openrouter.ai/docs/guides/routing/provider-selection)
- [ZDR endpoint 목록 API](https://openrouter.ai/docs/api/api-reference/endpoints/list-endpoints-zdr)
- [Usage accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting)
- [Router metadata](https://openrouter.ai/docs/guides/features/router-metadata)
- [Current API key quota](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-key)
- [Data collection](https://openrouter.ai/docs/guides/privacy/data-collection)
