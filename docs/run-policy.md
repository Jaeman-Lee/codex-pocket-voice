# API run cost and token policy

v2 Linux Companion은 OpenAI와 OpenRouter 요청을 Provider로 보내기 전에 서버가 작성한 정책으로
모델·route·첨부·최근 사용량을 검사한다. Android/PWA 표시는 검토 화면이며 최종 권한 판단과 한도 적용은
항상 Companion에서 수행한다. Codex CLI 실행은 이 API 전용 정책의 emergency stop이나 비용 한도에
영향받지 않는다.

## 기본 정책과 저장

기본값은 output 4,096 token, run 전체 50,000 token, run 비용 hard cap $1, rolling 24시간
200,000 token 경고, UTC 월 비용 $10 soft limit이며 API emergency stop은 꺼져 있다. 작업 대시보드에서
서버가 공개한 bounded 범위 안에서만 바꿀 수 있고, 두 번째 화면 터치와 exact same-origin 확인값이
필요하다.

여섯 설정값은 event journal의 additive `journal_settings` row에 저장하고 기존 256-bit journal key로
이름과 값을 HMAC 인증한다. 일부 값만 있거나 범위를 벗어나거나 인증이 맞지 않으면 기본값으로 조용히
돌아가지 않고 Companion 시작을 실패시킨다. 설정 변경은 연결된 앱에 `run_policy/updated` SSE를 보낸다.

## 사전검사와 승인

`POST /api/run-policy/preflight`는 paired client와 same-origin JSON을 요구하며 다음을 반환한다.

- exact Provider, 모델, OpenRouter upstream 순서와 fallback 선택
- privacy profile: OpenAI `store:false`, OpenRouter strict ZDR, 또는 Codex 관리 연결
- output/total token과 run 비용 hard limit
- catalog 가격 snapshot 또는 명시적인 `unknown`
- rolling 24시간 token과 현재 UTC 월 비용 집계
- 경고, 월 soft-limit 확인 필요 여부와 필요한 경우 10분짜리 1회용 token

가격이 있는 모델은 input/output 중 비싼 단가, fixed request/image 비용, 실제 첨부 수와 한 run 최대
9개 Provider 요청을 사용해 보수적인 상한을 계산한다. OpenRouter에서 upstream을 골랐다면 승인한 모든
route 중 가장 비싼 값을 사용한다. 필요한 단가가 없으면 비용을 추측하거나 0으로 취급하지 않고
`가격 확인 필요`를 표시한다. 확인된 최악 상한이 run hard cap보다 크면 inference 전에 차단한다.

월 soft limit은 hard budget이 아니라 명시적인 재확인 경계다. 확인 token은 random opaque 값이며 exact
model, routing, attachment count, 설정 revision과 현재 history digest에 묶이고 한 번 사용하면 삭제된다.
모바일은 token을 대화·queue journal이나 local storage에 저장하지 않는다. 만료되거나 설정·사용량이
달라지면 Companion이 실행을 거절하고 새 사전검사를 요구한다. API emergency stop은 새 OpenAI/OpenRouter
run을 즉시 차단하지만 실행 중인 작업을 강제 종료하지 않는다.

## Provider 요청과 완료 집계

Companion은 승인된 snapshot의 output 한도를 OpenAI `max_output_tokens`, OpenRouter `max_tokens`에 넣는다.
각 tool continuation 뒤 누적 usage가 total token hard limit을 넘으면 다음 Provider 요청 전에 실패한다.
모바일 입력이나 Provider 응답은 이 값을 늘릴 수 없다.

operation ciphertext에는 실행 시점의 정책 revision, 모델·route·privacy, 실제 첨부 수, token/cost 한도,
가격과 사용량 window를 immutable snapshot으로 저장한다. 완료 결과의 `policyUsage`는 다음을 구분한다.

- `provider-reported`: OpenRouter 응답이 보고한 USD 기준 credit 비용
- `catalog-estimate`: token, 요청, 이미지 수와 실행 시점 catalog 단가로 계산한 추정 USD
- `unknown`: 필요한 실제 usage 또는 가격이 없어 비용을 계산하지 않음

추정값을 Provider 청구액으로 표시하지 않는다. 다음 사전검사의 월 집계는 먼저 `policyUsage`를 사용하고,
구형 OpenRouter operation에만 기존 `usage.costCredits`를 호환 입력으로 사용한다.

## 공개 검사와 운영 경계

자동 테스트는 fake catalog, fake Provider, 합성 HTTP/SSE와 모바일 fixture만 사용한다. emergency stop,
unknown 가격, 가장 비싼 route, hard cap, rolling window, one-time/digest-bound token, 설정 인증·변조,
Provider request token parameter, tool-loop 누적 한도, operation 복원과 모바일 token 비영속화를 검증한다.
공개 CI는 실제 API key나 유료 inference를 사용하지 않는다.

정책은 과금액을 보증하는 회계 시스템이 아니다. Provider catalog나 usage가 없으면 unknown으로 남으며,
실제 청구·quota는 Provider 계정에서도 확인해야 한다. 현장 배포 전에는 보호된 smoke와 실제 계정에서
소액 상한을 사용해 별도로 검증한다.
