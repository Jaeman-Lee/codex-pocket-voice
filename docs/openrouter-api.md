# OpenRouter provider

OpenRouter provider는 Linux Companion에서만 API key를 읽고
`https://openrouter.ai/api/v1/chat/completions`를 호출한다. Android/PWA bundle, Gateway 응답,
SSE, 로그와 Git에는 key를 넣지 않는다.

## 서버 설정

권장 방식은 Companion 사용자만 읽을 수 있는 key 파일과 명시적인 모델 허용 목록이다.

```sh
chmod 600 /secure/path/openrouter-api-key
export CODEX_POCKET_OPENROUTER_API_KEY_FILE=/secure/path/openrouter-api-key
export CODEX_POCKET_OPENROUTER_MODELS=vendor/model-a,vendor/model-b
export CODEX_POCKET_OPENROUTER_DEFAULT_MODEL=vendor/model-a
```

`OPENROUTER_API_KEY` 환경변수도 지원한다. 모델 이름 패턴으로 기능을 추측하지 않으며 허용 목록이
없으면 실행을 비활성화한다. 설정 변경 뒤 Companion 재시작은 활성 Codex turn이 없고 사용자가
확인한 시점에만 수행한다.

## 모델과 개인정보 경계

Companion은 인증된 `/models/user` 결과와 `/models?zdr=true` 결과의 교집합에서만 허용 목록 모델을
노출한다. catalog의 `supported_parameters`에 `tools`가 있는 모델만 공통 읽기 전용 ToolBroker를
받고, 나머지는 chat-only로 제한한다. 이미지 입력도 catalog의 `image` modality가 확인된 모델에만
보낸다.

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

한 요청에는 모델 ID 하나만 넣고 upstream fallback을 허용하지 않는다. 응답이 보고한 실제 upstream
Provider는 run 결과에 기록하지만, Provider 또는 모델 실패를 다른 유료 경로로 자동 우회하지 않는다.
OpenRouter의 ZDR와 data-collection 설정은 upstream 내용 보존을 제한하는 routing 조건이며 token,
비용, latency 같은 OpenRouter metadata까지 없앤다는 뜻은 아니다.

## 현재 활성 범위

- Chat Completions SSE text streaming, PNG/JPEG/WebP/GIF 이미지 입력, 취소와 timeout
- 자동으로 마지막 SSE chunk에 오는 input/output/cache/reasoning token과 credit 비용 합산
- `workspace_list`, `workspace_read`, `workspace_search`, `git_status`, `git_diff` 읽기 도구
- strict JSON schema, `parallel_tool_calls: false`, 한 run 최대 8회 도구 호출
- API key 확인과 user/ZDR 모델 교집합만 읽는 비과금 연결 테스트
- 원시 OpenRouter chunk와 도구 결과를 제거한 공통 ProviderEvent

아직 대화 재개, 파일 변경, patch, 임의 명령, network 도구, Provider 선택과 fallback opt-in은
비활성화되어 있다. 모델별 실제 저비용 contract/eval과 durable journal이 준비되기 전에는 이 범위를
넓히지 않는다.

공개 CI는 가짜 HTTP/SSE와 모델 catalog만 사용하며 실제 API key나 유료 inference를 사용하지 않는다.

## 공식 기준

- [OpenRouter Chat Completions](https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion)
- [Tool calling](https://openrouter.ai/docs/guides/features/tool-calling)
- [Models API와 supported parameters](https://openrouter.ai/docs/guides/overview/models)
- [Provider routing과 ZDR](https://openrouter.ai/docs/guides/routing/provider-selection)
- [Usage accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting)
- [Data collection](https://openrouter.ai/docs/guides/privacy/data-collection)
