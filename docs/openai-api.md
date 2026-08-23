# OpenAI API provider

OpenAI API provider는 Linux Companion에서만 자격 증명을 읽고 공식 JavaScript SDK의 Responses
API를 호출한다. Android/PWA bundle, Gateway 응답, 로그와 Git에는 API key를 넣지 않는다.

## 서버 설정

권장 방식은 Companion 사용자만 읽을 수 있는 key 파일이다.

```sh
chmod 600 /secure/path/openai-api-key
export CODEX_POCKET_OPENAI_API_KEY_FILE=/secure/path/openai-api-key
export CODEX_POCKET_OPENAI_MODELS=gpt-example-verified
export CODEX_POCKET_OPENAI_DEFAULT_MODEL=gpt-example-verified
```

`OPENAI_API_KEY` 환경변수도 지원하지만 프로세스 실행 환경과 셸 기록 관리가 가능한 경우에만 쓴다.
`CODEX_POCKET_OPENAI_MODELS`는 쉼표로 구분한 명시적 허용 목록이다. Companion은 이름 패턴만 보고
Responses·이미지·도구 capability를 추정하지 않으며, 허용 목록이 없으면 API 실행을 비활성화한다.

설정을 바꾼 뒤에는 실행 중인 Codex turn이 없고 사용자가 확인한 시점에만 Companion을 재시작한다.

## 현재 활성 범위

- `stream: true`, `store: false` 텍스트 응답과 PNG/JPEG/WebP/GIF 이미지 입력
- 공통 `ProviderEvent`를 통한 텍스트 delta, 완료, 오류와 token usage 전달
- Gateway operation 단위 중단과 timeout
- Models API 인증·목록 확인만 수행하는 무료 연결 테스트
- 공급자 원본 JSON과 Authorization 값을 제거한 오류 분류

아직 대화 재개, 로컬 파일 읽기, 명령 실행, patch와 함수 도구는 비활성화되어 있다. 따라서 현재
OpenAI API 모드는 chat-only이며 프로젝트 workspace를 읽거나 변경할 권한이 없다. 다음 단계에서
read-only Tool Broker를 먼저 연결하고, 쓰기와 명령은 터치 승인 뒤에만 활성화한다.

`store: false`는 Responses 객체 저장을 끄지만 일반적인 API abuse-monitoring 보존까지 없앤다는
뜻은 아니다. 자세한 동작은 [Responses API reference](https://developers.openai.com/api/reference/cli/resources/responses/methods/create)와
[OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data)를 기준으로 확인한다.

공개 CI는 가짜 stream만 사용하며 실제 유료 inference를 보내지 않는다. 실제 key smoke test는 별도
보호 workflow, 고정된 저비용 prompt와 호출 상한이 준비된 뒤에만 추가한다.
