# Codex Pocket Voice v2 실행 계획

- 상태: 구현 중
- 마지막 검토: 2026-08-24 KST

이 문서는 `1.8.1`을 v1 rollback 기준선으로 두고, v2를 구현하기 위한 제품·아키텍처·보안·검증
계획을 정의한다. 이 문서 자체는 배포 가능한 코드 변경이 아니므로 SemVer와 APK를 변경하지 않는다.

## 1. 업데이트 결정 게이트

| 항목 | 결정 |
| --- | --- |
| 변경 분류 | `breaking` — 제공자 실행 계약, Gateway 프로토콜, 작업 저널과 전송 계층을 함께 확장한다. |
| 목표 버전 | `2.0.0` |
| 구현 브랜치 | `feature/v2-control-plane` |
| v1 정책 | 연결 불능을 고친 `1.8.3` Companion은 별도 runtime으로 운영하고 APK는 staged 후보로 유지하며, 1.8.1을 검증된 rollback으로 보존한다. 보안, 데이터 유실, 연결 불능만 추가 `1.8.x` hotfix로 다룬다. |
| APK 정책 | 2.0 현장 설치 전에는 1.8.2 current와 별도 staged 1.8.3 후보를 섞지 않고, 1.8.1을 rollback으로 유지한다. 2.0 candidate를 설치할 때도 1.8.1 rollback을 보존한다. |
| Companion 정책 | 1.x와 2.x 기능 협상을 지원하고, 2.0 검증 중 1.8.1 Companion 복구 지점을 유지한다. |

### 구현 진행 상황

| 단계 | 상태 | 현재 결과 |
| --- | --- | --- |
| Phase A | 진행 중 | 공통 ProviderEvent·runtime·RunCoordinator, Tool/Approval 계약, 세 Provider 공용 contract·stream failure fixture, protocol 2–3 호환, operation UI와 App connection/run/journal/voice/media/PocketLink bootstrap 상태 머신 모듈 구현; production build·실제 pairing/Gateway/SSE/run/approval 기반 Playwright 모바일 회귀 통과, 실기기 회귀 잔여 |
| Phase B | 진행 중 | OpenAI streaming·이미지·사용량·중단, server-only key, 암호화 durable multi-turn, 읽기 도구, SHA-bound 단일·2~8개 교체·신규 생성·rename, crash recovery·bounded 수동 복구와 격리 npm 검증 구현; 실모델 eval 잔여 |
| Phase C | 진행 중 | strict ZDR model/endpoint catalog, 선택형 routing, 가격·성능·quota UI, router metadata 귀속, chat/tool SSE, 승인형 broker와 보호된 synthetic smoke harness 구현; 실제 model eval 실행·현장 등급 잔여 |
| Phase D | 진행 중 | Android encrypted snapshot/rollback mirror, Companion encrypted event row, cursor replay·unknown 복구, multi-project dashboard·approval inbox와 two-touch workspace 복구, live branch/worktree identity, workspace export/protected delete, 목표 이름·pin/archive, bounded retention 설정, opt-in process-death native 알림·retained run 열기, handoff의 exact idle/완료 thread unsubscribe 구현; 실기기 background/deep-link acceptance 잔여 |
| Phase E | 진행 중 | opt-in LAN TLS listener, 10분 reviewed QR, user-triggered bounded DNS-SD 주소 discovery, Android Keystore P-256 device certificate·server/client SPKI binding, observed server-pin promotion, recoverable A/B client-key rotation, signed update manifest·offline/native ZIP verifier, bounded official Latest discovery/download와 user-confirmed installer 구현; Wi-Fi Direct 등 P2P·relay·background/field release gate 잔여 |

## 2. 제품 정의

v2의 제품 한 문장은 다음과 같다.

> 여러 Linux 개발 작업을 스마트폰에서 음성으로 시작하고, 진행 상황·승인·변경 결과·비용을
> 안전하게 관리하는 사용자 소유의 로컬 우선 개발 운영판.

스마트폰은 계속 저부하 제어면으로 남고, 프로젝트 파일·Git·명령 실행·Provider 자격 증명은
선택한 Linux Companion에 둔다. PC가 오프라인일 때 대기한 요청은 원래 선택한 PC와 Provider에서만
재개한다. 사용자의 명시적인 선택 없이 다른 PC, API Provider, 모델 또는 클라우드 실행기로
우회하지 않는다.

### 지원할 실행 모드

1. **Codex CLI** — 기존 `codex app-server` 기반 기본 모드. Codex 계정, thread, sandbox와
   Codex 고유 이벤트를 최대한 보존한다.
2. **OpenAI API** — Linux Companion이 OpenAI Responses API를 호출하고 공통 Tool Broker를 통해
   프로젝트 읽기·수정·명령 실행을 제공한다.
3. **OpenRouter** — Linux Companion이 OpenRouter의 OpenAI 호환 API를 호출한다. 도구 호출이
   확인된 모델만 코딩 모드에 노출하고, 나머지는 선택적으로 대화 전용 모드로 제한한다.

세 모드는 같은 대화에서 자동 전환하지 않는다. Provider를 바꾸면 새 run 또는 명시적인 fork를
만들고, 전환 전 전송될 컨텍스트와 예상 비용·데이터 경계를 보여준다.

## 3. 목표 아키텍처

```text
Android / PWA
  └─ authenticated Gateway API
       ├─ RunCoordinator
       │    ├─ EventJournal
       │    ├─ ApprovalBroker
       │    └─ CostAndPolicyGuard
       ├─ ToolBroker
       │    ├─ read/search/list
       │    ├─ patch/write
       │    ├─ command/test/git
       │    └─ network tools
       └─ ProviderRuntime
            ├─ CodexAppServerRuntime
            ├─ OpenAIResponsesRuntime
            └─ OpenRouterRuntime
```

현재 `ProviderRegistry`는 설치·로그인·모델 조회 중심이고 실제 run은 Codex app-server에 직접
결합되어 있다. v2에서는 설명용 Provider와 실행용 Provider를 하나의 계약으로 통합한다.

```ts
interface ProviderRuntime {
  describe(): Promise<ProviderDescriptor>;
  listModels(): Promise<ProviderModel[]>;
  startRun(input: ProviderRunInput): Promise<ProviderRun>;
  continueRun(input: ProviderContinuation): Promise<ProviderRun>;
  cancelRun(runId: string): Promise<void>;
  respondToApproval(requestId: string, decision: ApprovalDecision): Promise<void>;
  subscribe(listener: (event: ProviderEvent) => void): () => void;
}
```

Provider별 원시 이벤트는 즉시 공통 이벤트로 변환한다. UI와 작업 저널은 OpenAI 또는 OpenRouter의
응답 JSON에 직접 의존하지 않는다.

### 공통 capability

| capability | 의미 |
| --- | --- |
| `conversationState` | Provider가 원격 상태를 보존하는지, Companion이 로컬에서 재생하는지 표시 |
| `streaming` | 텍스트·도구 호출·사용량 이벤트의 실시간 전달 |
| `toolCalling` | 구조화된 로컬 Tool Broker 호출 가능 여부 |
| `workspaceRead` | 허용 root 내부 파일·Git 상태 읽기 |
| `workspaceWrite` | 승인 정책을 거친 patch·파일 변경 |
| `commandExecution` | Linux sandbox 안의 명령·테스트 실행 |
| `imageInput` | 선택한 이미지 또는 대표 프레임 전송 |
| `reasoningControl` | Provider가 지원하는 추론 수준만 노출 |
| `usageAccounting` | 토큰·요청·Provider 보고 비용 기록 |
| `resumableRun` | 앱·네트워크 단절 뒤 동일 run 복구 가능 여부 |

## 4. OpenAI API 모드

### 전송과 상태

- Linux Companion에서 공식 JavaScript SDK와 `/v1/responses`를 사용한다.
- `stream: true`의 SSE 이벤트를 공통 `ProviderEvent`로 변환한다.
- 함수 도구 호출은 모델이 실행하는 것이 아니라 Companion의 Tool Broker가 검증·실행한다.
- 기본은 `store: false`로 두고 대화·도구 결과·응답 항목은 암호화된 로컬 작업 저널이 관리한다.
- 이어지는 요청은 이전 입력과 응답의 message·reasoning·function-call 항목을 Companion journal에서
  복호화해 다시 보낸다. reasoning 모델은 `reasoning.encrypted_content`를 요청해 응답 항목을 빠뜨리지
  않는다. 클라이언트에는 opaque 상태를 보내지 않는다.
- replay 상태는 Provider·workspace·model·account에 고정하고 최신 성공 run 하나만 소유한다. 최대
  12턴·900 KiB를 넘으면 오래된 완전한 turn부터 제거하며 이미지 data URL은 재생하지 않는다.
- 서버 저장을 켜는 선택지는 기본값으로 제공하지 않는다. 추후 제공할 경우 보존 기간과 전송 범위를
  활성화 전에 명확히 표시한다.
- `store: false`는 Responses application state를 끄는 설정이며 기본 abuse-monitoring 보존까지
  제거한다는 뜻은 아니다. 사용자의 OpenAI project가 별도 ZDR 승인을 받지 않았다면 이를 UI에서
  ZDR로 표시하거나 완전 무보존으로 설명하지 않는다.
- 모델 이름으로 capability를 추측하지 않는다. API 모델 목록과 검증된 capability registry를
  결합하고, 지원 여부가 불명확한 도구는 비활성화한다.

### 단계적 활성화

1. **Chat-only** — 스트리밍 텍스트, 이미지 입력, 사용량 표시. 로컬 도구 없음.
2. **Read-only coding** — 파일 읽기, 검색, Git status/diff만 제공. 쓰기·명령 없음.
3. **Workspace coding** — patch, 제한된 명령, 테스트 실행을 Approval Broker 뒤에 추가.
4. **Durable runs** — 재연결, 중단, Queue/Steer, fork와 이벤트 replay를 활성화.

Chat-only와 read-only가 검증되기 전에는 API 모델에 workspace-write 권한을 주지 않는다.

## 5. OpenRouter 모드

### API 기준

- 초기 구현은 널리 호환되는 `/api/v1/chat/completions`와 명시적인 tool-call loop를 사용한다.
- `/api/v1/models?supported_parameters=tools`에서 모델 목록을 읽고 context length, 가격,
  지원 파라미터와 만료 정보를 UI에 반영한다.
- `tools`, `tool_choice`, 구조화 출력과 reasoning 등 요청에 필요한 기능을 모델이 모두 지원하도록
  `require_parameters: true`를 사용한다.
- 모델 ID, 실제 upstream Provider, fallback 발생 여부와 usage를 가능한 범위에서 run 기록에 남긴다.
- opt-in router metadata의 selected provider를 우선 사용하고, exact model과 attempt가 유효할 때 선택한
  catalog tag로 역매핑해 실제 upstream을 표시한다.
- 한 run 도중 다른 모델 ID로 자동 전환하지 않는다. 모델 변경은 사용자에게 새 run으로 표시한다.

### 기본 개인정보 보호 프로필

코드와 명령 출력은 민감할 수 있으므로 다음을 기본값으로 한다.

```json
{
  "provider": {
    "require_parameters": true,
    "data_collection": "deny",
    "zdr": true,
    "allow_fallbacks": false
  }
}
```

첫 구현은 모델과 upstream의 무단 전환을 막기 위해 fallback을 끈다. 추후 사용자가 특정 upstream
Provider와 fallback 범위를 명시적으로 선택한 경우에만 위 개인정보 조건을 만족하는 endpoint 안에서
허용한다. ZDR 또는 데이터 수집 차단을 완화하면 전송 전에 경고와 적용 범위를 표시하고, 해당 선택을
프로젝트별 정책으로 기록한다.

### 모델 노출 규칙

- **코딩 가능**: tool calling과 필요한 파라미터가 확인되고 계약 테스트를 통과한 모델
- **읽기 전용**: tool calling은 가능하지만 patch·명령 안정성이 검증되지 않은 모델
- **대화 전용**: 텍스트·이미지 응답만 지원하는 모델
- **숨김**: 폐기 예정, capability 불명확, 개인정보 정책과 충돌하거나 응답 형식이 깨지는 모델

모델 수가 많으므로 전체 목록을 기본 표시하지 않는다. 즐겨찾기, 최근 사용, 코딩 검증 완료,
가격 상한, context 길이와 Provider 필터를 제공한다.

## 6. 자격 증명과 개인정보 보호

- `OPENAI_API_KEY`와 `OPENROUTER_API_KEY`는 Linux Companion에만 둔다.
- APK, PWA JavaScript, WebView storage, Android 작업 저널, Gateway 응답과 SSE 이벤트에는 키를
  절대로 전달하지 않는다.
- 첫 단계는 Linux 환경 변수 또는 권한 `0600`의 별도 credential 파일을 지원한다.
- 다음 단계에서 systemd encrypted credentials 또는 동등한 Linux 비밀 저장 경계를 추가한다.
- 스마트폰의 AI 연결 센터는 `설정됨/없음/검증 실패`, 계정 별명과 마지막 검증 시각만 표시한다.
- 연결 테스트는 모델 목록과 인증 상태만 확인하고 유료 모델 요청을 보내지 않는다.
- 로그, 오류, diagnostics와 support bundle에서 Authorization 헤더, 키 형식, 개인 경로와 요청 본문을
  구조적으로 제거한다.
- Provider별 키 교체·해제와 즉시 run 차단을 지원한다.
- 저장소, CI fixture, APK, SBOM과 GitHub Actions 로그에 실제 키를 넣지 않는다.
- OpenRouter strict profile도 요청 metadata까지 저장하지 않는다는 뜻은 아니다. 내용 보존 정책과
  usage·latency 같은 metadata 수집을 구분해 연결 화면에서 설명한다.

## 7. Tool Broker와 승인 정책

API 모델은 로컬 셸이나 파일에 직접 접근하지 않는다. 모든 요청은 구조화된 도구 인자 검증,
허용 root 확인, sandbox와 승인 정책을 순서대로 통과한다.

| 도구 등급 | 예 | 기본 정책 |
| --- | --- | --- |
| 관찰 | 파일 읽기, 검색, Git status/diff | 허용 root 안에서 대화 단위 허용 가능 |
| 변경 | patch, 새 파일, rename | diff 미리보기 후 1회 또는 대화 범위 승인 |
| 실행 | build, test, package manager, Git 명령 | 명령·cwd·환경·네트워크를 표시하고 승인 |
| 고위험 | 삭제, credential 접근, root 밖 경로, 광범위 변경 | 자동 승인 금지, 명시적 재확인 또는 거절 |
| 외부 효과 | network, 배포, push, 메시지·서비스 변경 | 대상과 효과를 별도 표시하고 매번 승인 |

- `PathPolicy`는 실제 경로와 symlink를 검사하고 허용 root 밖 접근을 차단한다.
- 명령 도구는 cwd, 인자, 시간 제한, 출력 제한과 네트워크 여부를 구조화해서 받는다.
- 음성만으로 고위험 작업을 승인할 수 없다. 화면의 터치 확인이 필요하다.
- Provider가 생성한 설명은 참고 정보이며 실제 위험 등급은 Companion 정책이 결정한다.
- 승인 요청은 만료 시간을 가지며, 앱이 오프라인이 되면 자동 승인하지 않는다.

## 8. 비용과 사용량 통제

- run 시작 전에 모델, Provider, 개인정보 프로필과 최대 출력 설정을 보여준다.
- Provider가 반환한 input/output/reasoning/cache token과 요청 횟수를 이벤트 저널에 기록한다.
- 가격을 신뢰할 수 있게 얻을 수 있는 경우 예상치와 실제치를 구분해 표시한다.
- 가격 정보가 없거나 변경됐으면 비용을 추측하지 않고 `가격 확인 필요`로 표시한다.
- run별 최대 토큰, 일일 경고, 월간 소프트 한도와 즉시 중단 스위치를 제공한다.
- 429, quota 부족, 가격 상한 초과를 일반 연결 오류와 구분한다.
- 실패 시 다른 유료 Provider나 더 비싼 모델로 자동 우회하지 않는다.

## 9. 이벤트 저널과 재연결

IndexedDB snapshot 중심 구조를 app-owned SQLite 이벤트 저널로 확장한다.

각 이벤트는 최소한 다음을 가진다.

- `eventId`, `sequence`, `deviceId`, `workspaceId`, `threadId`, `runId`
- Provider와 모델, 공통 이벤트 유형, 생성 시각
- 동기화 상태와 마지막 확인 cursor
- 승인 상태, tool-call ID, redacted tool summary
- 토큰과 비용 정보
- 첨부 참조와 retention 상태

재연결은 `lastEventId` 이후 이벤트만 요청하고 event ID로 중복을 제거한다. Companion 재시작,
SSE 부분 전달, Provider stream 중단과 폰 프로세스 회수 뒤에도 `queued`, `running`,
`waiting_for_approval`, `completed`, `failed`, `unknown`을 구분한다. `unknown` 상태를 임의로 성공 또는
실패로 바꾸지 않는다.

현재 Companion checkpoint는 operation, idempotency record와 UI에 전달 가능한 공통 event payload를
AES-256-GCM으로 암호화한 SQLite에 기록한다. workspace 원문 대신 keyed HMAC index를 쓰고 별도 0600
key 파일을 둔다. SSE는 `Last-Event-ID` 이후 event를 재전송하며 단말은 적용한 cursor를 보안 저장소에
기록하고 중복 cursor를 버린다. retention gap이나 DB 재생성은 snapshot 재조회 신호를 보내며,
Companion 재시작 전에 `running`이던 operation은 `unknown`으로 전환하고 사용자 확인 전 queue를 멈춘다.
확인 결과는 operation에 암호화해 저장하고 `acknowledged` event로 다른 기기에도 전파한다.
paired 클라이언트는 선택한 workspace의 operation·event를 복호화된 JSON으로 내보내되 응답을
16 MiB로 제한하고 캐시하지 않는다. 작업 대시보드는 정확한 전체 경로와 영향을 다시 보여 준 뒤
두 번째 터치에서만 Companion 기록을 삭제한다. active 작업과 미확인 `unknown`은 삭제를 차단하며,
프로젝트 파일과 Android conversation·queue journal은 영향을 받지 않는다.
목표 이름과 pin/archive 시각은 operation ciphertext에 저장하고 `metadata_updated` SSE로 동기화한다.
보관은 기본 대시보드에서 숨기는 가역 상태이며 active·승인·미확인 작업에는 적용하지 않는다. pin은
retained operation 정렬만 바꾸고 설정된 기간/operation 상한을 연장하지 않으며 명시적 기록 삭제도 막지 않는다.
보존 정책은 1–30일, operation 50–2,000개, event 200–10,000개로 제한하고 두 번째 화면 터치와
same-origin 확인값 뒤에만 적용한다. 낮춘 한도는 즉시 정리되며 running operation은 유지한다. 설정값은
기존 journal key로 HMAC 인증해 재시작 시 복원하고, 모든 연결 기기에 `policy_updated`를 전파한다.

## 10. 모바일 운영 경험

### 작업 대시보드

- PC·프로젝트별 실행 중, 대기, 승인 필요, 완료, 실패 작업 수
- branch/worktree, Provider, 모델, 경과 시간과 비용
- Queue와 Steer의 명확한 분리, 기본값은 Queue
- 완료·승인·오류 알림에서 해당 run으로 deep link
- pin, archive, 목표 이름과 최근 결과

### 승인함과 검토 화면

- 명령, 변경 파일, network와 외부 효과를 한 화면에서 검토
- 파일 목록과 syntax-highlighted diff, 긴 줄 wrap
- 테스트 결과, 로그, 이미지와 APK 같은 산출물 다운로드
- 줄 단위 피드백을 같은 run의 follow-up으로 전송

### 음성 v2

- 편집 가능한 partial/final transcript와 프로젝트 용어 사전
- `다음에 실행`과 `지금 방향 수정`을 구분하는 Queue/Steer 확인
- Provider·모델·작업공간을 음성으로 바꿀 때 화면 확인
- 삭제·배포·push·비밀정보 관련 작업은 음성 단독 승인 금지

## 11. 구현 단계와 완료 조건

### Phase A — 기반 분리 (`2.0.0-alpha.1`)

- `RunCoordinator`, `ProviderRuntime`, `ToolBroker`, `ApprovalBroker` 인터페이스 도입
- 기존 Codex app-server 동작을 새 계약 뒤로 이동하고 v1 기능 회귀 방지
- Gateway protocol 3 capability negotiation과 1.x Companion 호환 응답
- `App.tsx`의 연결, run, journal, voice, media 상태를 기능별 모듈과 상태 머신으로 분리
- fake Provider contract suite와 Provider stream failure fixture 추가

PocketLink 연결 bootstrap은 `App.tsx`의 개별 boolean·후보·QR 상태 대신 순수 reducer를 사용한다.
QR scan과 LAN discovery는 상호 배타적이고 새 bootstrap을 시작하면 이전 trust hint를 지운다. 현재 phase와
맞지 않는 늦은 native 응답, 발견 목록에 없거나 만료된 후보를 무시하며, 사용자가 이름·host·port를
편집하면 LAN 선택 신뢰만 즉시 무효화한다. QR pairing code는 기존처럼 exact host·port·SPKI pin과 새
target/실제 Companion device가 모두 일치할 때만 전달한다.
음성 입력은 single-shot/연속 mode와 recognizer active/idle/fatal transition을 `voice-input-state`
reducer가 관리한다. 연속 recognizer의 일시 idle은 mode를 유지하지만 재시작 실패와 비복구 오류는
dictation과 hands-free를 함께 종료해 UI 고착을 막는다. 미디어 composer는 최대 4개 attachment,
동시 upload batch count, progress, 임시 upload ID와 server media ID 교체를 `media-composer-state`
reducer로 직렬화한다.
연결 lifecycle은 `connection-state` reducer의 단조 증가 attempt ID에 device를 묶는다. App은
initialize, model/thread/handoff 추가 조회, SSE event, pairing, notification action과 diagnostics 응답을 적용하기
전에 현재 attempt/device를 다시 확인한다. 새 장치·auth revision은 이전 초기화를 기다리지 않고
독립적으로 시작하며, Android native tunnel start는 직렬화해 최종 선택 장치가 마지막에
적용되게 한다.
active run은 `active-run-state` reducer의 별도 generation에 device, request, operation과 live
message/diff/activity를 묶는다. HTTP run 생성 응답 전 request도 active owner이므로 두 번째 전송과
queue 자동 실행은 대기하고, poll은 generation/device/operation이 모두 일치할 때만 다시 예약한다.
프로젝트·대화·Provider·장치 전환 뒤 늦게 도착한 생성·poll·stream·terminal 응답은 새 run이나
poll timer를 변경하지 않는다. `journal-state` reducer는 conversation key와 queue device별 load
generation을 관리한다. 이전 scope 복원은 무시하고, queue load 중 추가한 prompt는 persisted queue와
ID 기준으로 병합한 뒤 암호화 journal에 다시 저장한다.
Provider event는 `ProviderRunEventGate`에서 exact Provider·conversation·run 소유권을 확인한다. run ID가
없는 run-scoped event, 이전 run frame, 중복 event ID, 역순 sequence와 terminal 뒤 frame은 journal/SSE로
전달하지 않는다. Codex, OpenAI와 OpenRouter는 성공·부분 stream 실패·취소·timeout에서 동일하게 단일
terminal event와 `ProviderRunCompletion`을 만든다. OpenAI/OpenRouter의 401/403/429/5xx와 redaction,
OpenRouter의 malformed·truncated·empty SSE를 fake transport로 재현한다. OpenAI Responses의 같은
`sequence_number`가 replay되면 delta·usage·tool을 두 번 적용하지 않는다.

완료 조건: Codex CLI의 기존 run·queue·handoff가 동일하게 동작하고 새 Provider를 fake runtime으로
끝까지 실행할 수 있다.

### Phase B — OpenAI API (`2.0.0-alpha.2`)

- server-only credential 로딩과 redaction 검사
- Responses API chat-only streaming과 사용량 표시
- read-only Tool Broker 추가
- workspace-write와 command를 승인함 뒤에 단계적으로 활성화
- `store: false` 로컬 상태 복구 및 중단·재연결 테스트

현재 checkpoint에서는 `workspace_list/read/search`와 고정 Git `status/diff`를 observation 등급으로
연결했다. `workspace_replace_text`는 읽기에서 얻은 SHA-256과 승인 직전·실행 직전 파일을 묶어 기존
UTF-8 파일 한 개만 atomic replace한다. `workspace_replace_text_batch`는 같은 규칙으로 기존 파일 2~8개,
전체 48 KiB를 모두 사전검사·fsync 스테이징한 뒤 한 번의 터치 승인으로 교체하고, 정상 runtime 중
후속 파일의 경합·실패가 생기면 이미 설치한 파일을 원복한다. `workspace_create_text`는 비어 있는 경로에
12 KiB 이하 파일 하나를 만들고, `workspace_rename_text`는 읽기 SHA·inode가 고정된 기존 텍스트 파일을
비어 있는 경로로만 옮긴다. 네 도구는 직렬화되며 앱 전용 0700/0600 strict transaction manifest의
staging/prepared/committed 단계를 fsync한다. Companion 재시작 시 staging은 폐기, prepared는 원복,
committed는 roll-forward 정리하고 외부 수정으로 판정이 애매하면 자동 덮어쓰기 없이 초기화를 중단한다.
민감 파일, 외부 link, secret 형태, 삭제·디렉터리 생성·chmod는 막는다. 자동 복구가 애매하면 Companion은
읽기·상태 API를 유지한 degraded mode로 시작하고 변경 도구만 차단한다. 인증된 recovery API는 bounded
transaction과 상대 경로만 반환하며 journal 해석 실패 시 경로를 추측하지 않는다. 모바일 작업 대시보드는
PC 확인 안내와 두 번째 터치를 요구한 뒤 동일한 안전 복구만 재시도하고 journal 폐기·강제 덮어쓰기·복구
파일 삭제는 제공하지 않는다.
`project_verify`는 검토한 package SHA와 check/test/build script만 namespace·network-off·secret-mask·
disposable overlay sandbox에서 실행하고 probe 실패 시 capability 자체를 숨긴다. strict schema, 단일
함수 호출, 8회 상한과 stateless reasoning replay도 유지한다. 이 checkpoint는 개발용 2.0 source
update이며 APK를 새 current 후보로 배포하지 않는다. `store:false` 다중 턴은 이전 입력과 모든 재생 가능한
응답 항목을 암호화 Companion journal에 보존해 이어가며, 모바일은 Provider·workspace별 대화를 명시적으로
선택한다. opaque replay state는 API/SSE/export에 노출하지 않고 이미지 원본을 다음 turn에 보존하지 않는다.

완료 조건: 실제 프로젝트에서 조사 → diff 제안 → 승인된 patch → test → 결과 검토가 키 노출 없이
한 run으로 완료된다.

### Phase C — OpenRouter (`2.0.0-beta.1`)

- 모델·가격·capability 동적 조회와 캐시
- chat-only와 tool-call loop
- strict privacy routing, Provider lock, fallback 표시
- 모델별 contract/eval 결과에 따른 코딩·읽기·대화 등급
- 비용·quota·rate-limit 오류 분류

현재 checkpoint에서는 server-only key, authenticated user/ZDR model과 ZDR endpoint catalog의 교집합,
명시적 allowlist, chat SSE와 동일한 승인형 tool loop를 구현했다. 기본은 `allow_fallbacks: false`,
`require_parameters: true`, `data_collection: deny`, `zdr: true`다. 사용자가 ZDR endpoint의 exact tag를
1차 upstream으로 고르면 `order`/`only`를 그 tag로 고정하고, backup도 직접 고른 경우에만 두 tag 안에서
fallback을 허용한다. 임의 tag, 중복·형식 오류와 대화 중 routing 변경은 실패-폐쇄로 거부한다. 요청
순서·fallback 정책·실제 upstream·token/credit usage는 암호화 operation과 공통 run 결과에 남고 모바일
대시보드에서 보인다. OpenRouter 다중 턴 transcript도 같은 journal·최신 상태 소유권·12턴/900 KiB
상한을 적용하고 모델·account·workspace 변경이나 무단 Provider 전환을 허용하지 않는다. 모델과 ZDR
endpoint의 bounded 가격·p50 latency/throughput·uptime·quantization·tool capability, `/key`의 남은 한도와
만료일을 인증된 모바일 UI에 표시하되 catalog snapshot을 eval 등급으로 부르지 않는다. 수동
`provider-smoke` environment workflow는 allowlisted model과 exact ZDR upstream, 2회 synthetic 호출,
호출당 2,048 input/64 output token의 $0.02 catalog 상한, key remaining limit와 strict routing을
강제한다. 자동 usage의 USD 기준 credit 비용과 opt-in router metadata의 exact model·첫 attempt·선택
provider도 검증하며 원문 prompt/response 없는 grade report만 남긴다. 남은 Phase C 핵심은 보호된
workflow의 실제 모델 실행과 프로젝트 read/coding 현장 등급이다.

완료 조건: 서로 다른 두 upstream 계열의 검증 모델이 같은 Tool Broker 계약을 통과하고,
지원하지 않는 모델은 코딩 권한을 얻지 못한다.

### Phase D — 운영판 (`2.0.0-beta.2`)

- 다중 프로젝트 대시보드와 approval inbox
- Queue/Steer, diff·test·artifact 검토
- SQLite 이벤트 journal, retention/export/delete
- Android 완료·승인·오류 알림과 deep link

현재 checkpoint에서는 Android `PocketJournal` SQLite backend가 AES-GCM envelope 형태의 conversation과
queue snapshot만 저장한다. 원래 key/device 대신 domain-separated SHA-256 index를 바인딩하고 payload
크기를 제한한다. 기존
IndexedDB/localStorage 기록은 읽기 migration 뒤에도 삭제하지 않으며, v2 field acceptance 전에는
새 snapshot을 기존 저장소에도 mirror해 1.8.1 rollback에서 기록을 계속 읽을 수 있게 한다. Companion
쪽에는 암호화 run event row, `Last-Event-ID` replay, 7일/500 operation/2,000 event 기본 retention과
`unknown` 복구·확인 동기화를 구현했다. 모바일 대시보드는 run을 workspace별로 묶고 Provider·모델·
경과 시간·usage/cost와 승인 대기 상태를 표시한다. 승인함은 matching run의 redacted 정보만 노출하고
same-origin 터치 approve/decline, 만료와 replay 완료 뒤 snapshot 재동기화를 적용한다.
현재 workspace catalog는 hook·prompt·optional lock 없이 branch, 12자리 HEAD, dirty 수, upstream
ahead/behind와 linked worktree를 수집한다. 대시보드와 세션 반납 검토 화면은 전체 경로와 이 identity를
표시하고 run 시작 시점 snapshot은 암호화 event journal에 함께 보존한다. Gateway는 run/release/claim의
thread cwd가 선택한 workspace와 다르면 409로 차단한다.
작업 카드는 한 줄 120자 목표 이름, retained 범위 내 최대 50개 pin과 보관·복원을 제공한다. metadata는
Companion 재시작 뒤 복원되고 SSE로 다른 연결 기기에 전파된다. 사용자가 직접 켜는 Android
완료·승인·오류 알림도 구현했다. 잠금 화면에는 generic 상태만 표시하고
app-private random token으로 PendingIntent를 검증한다. 알림을 탭하면 device/operation ID로 선택한
Companion의 retained snapshot을 다시 조회한 뒤 정확한 작업을 연다. 사용자가 켠 Android foreground
monitor는 최대 8개의 paired loopback target만 구독한다. Companion의 별도 notification SSE는 terminal
operation과 새 approval을 schema/kind/operation ID/시각/승인 만료시각으로 축약해 prompt·workspace·응답·
도구 세부정보를 native 계층에 보내지 않는다. bearer·target·cursor는 Android Keystore AES-GCM으로
보호하고 sticky service가 WebView process 회수 뒤 `Last-Event-ID`로 다시 연결한다. 최초 활성화는 현재
cursor에서 시작하며, 최신 16건 replay 중 10분 freshness와 approval 만료를 통과할 때만 generic 알림을 만든다.
실기기 process-kill·절전·네트워크 전환과 deep-link acceptance는 다음 단계다.

완료 조건: 여러 프로젝트 run을 동시에 추적하고 앱 종료·네트워크 전환 후 정확한 상태로 복구한다.

### Phase E — 독립 연결과 출시 강화 (`2.0.0-rc.1`)

- PocketLink QR 페어링, 키 회전·기기 해제와 native reconnect
- Termux/SSH는 rollback 가능한 호환 transport로 유지
- signed update manifest, 1.8.1 rollback 검증
- Android CPU·메모리·배터리·background wake release gate

현재 checkpoint는 Companion의 opt-in TLS 1.2/1.3 LAN listener와 Android native loopback forward를
구현했다. Companion private key는 private directory의 0600 단일-link 파일만 허용하고 certificate/key,
유효기간과 advertise host를 검증한다. Android는 host·port·기본/교체용 SPKI pin을 Keystore AES-GCM으로
보호하며 `connectedDevice` foreground service에서 인증서 유효기간, HTTPS hostname과 leaf SPKI pin을
모두 확인한다. local listener는 127.0.0.1에만 bind하고 연결·thread 수를 제한한다. 오류나 pin 불일치 때
Termux/SSH로 자동 downgrade하지 않는다. Android 비대칭 device key와 mTLS proof도 구현했다.
Android는 local port별 non-exportable P-256 key로 TLS client
certificate proof를 제공하고, Companion은 최초 pairing의 client SPKI pin을 bearer token hash와 결합한다.
PocketLink 요청마다 인증서 유효기간과 binding을 확인하며 TLS session resume을 허용하지 않는다.
Companion TTY는 공개 연결 정보와 기존 10분 pairing code만 담은 QR을 출력하고 Android는 QR_CODE만
로컬 스캔한다. 앱은 QR을 저장하지 않고 등록 전 host·port·pin·device·만료를 검토시키며, 실제 연결의
device ID가 다르면 pairing code를 사용하지 않는다. 서버 인증서는 실제 backup-pin handshake 관찰과
두 번의 화면 확인 뒤에만 이전 pin을 폐기한다. Android client identity는 현재 mTLS proof로 5분 승인을
받고 Keystore A/B 슬롯에 새 non-exportable key를 준비한다. Companion이 새 key의 실제 TLS proof를
영속화하고 이전 binding을 거부한 뒤에만 Android가 이전 alias를 삭제한다. 승인 hash와 pending 슬롯은
각각 Companion `0600` state와 Android 암호화 설정에 남아 재시작·응답 유실을 복구하며, 불확실하면 두
key를 모두 유지하고 자동 downgrade하지 않는다. Companion은 별도 opt-in에서 이름·TLS port·protocol
version만 DNS-SD로 광고한다. Android의 user-triggered 8초 검색은 service/TXT를 exact-match하고 최대
16개의 private IPv4/IPv6 ULA 후보만 2분 동안 검토용으로 유지한다. discovery 결과는 인증이 아니므로
선택 뒤에도 Companion 터미널의 SPKI pin을 직접 입력하며 자동 페어링·연결·SSH fallback은 없다.
Wi-Fi Direct 등 P2P, relay fallback과 실기기 background release gate는 남아 있다.

Android CI는 APK와 SBOM의 SHA-256·크기, package, SemVer/versionCode, commit을 담은 canonical
`update-manifest.json`을 생성한다. official signed build는 APK release key로 manifest 원문에 RSA/ECDSA
SHA-256 분리 서명을 만들고 공개 인증서를 함께 싣는다. 오프라인 검증기는 호출자가 별도 경로로 고정한
인증서 fingerprint, manifest 서명, APK 실제 signer, artifact hash와 anti-downgrade를 모두 확인한다.
포함된 인증서 자체는 신뢰 기준이 아니며 unsigned fork manifest는 명시적 override 없이 거부한다.
Android 앱은 사용자가 받은 전체 artifact ZIP을 document picker로 선택하거나 **공식판 조회**를 누를 때만
hardcoded public GitHub 저장소의 최신 non-draft/non-prerelease Release를 확인한다. metadata는 1 MiB와
128 asset으로 제한하고 정확한 `Codex-Pocket-Voice-vX.Y.Z-update.zip`, uploaded/application-zip 상태,
asset API URL·크기·SHA-256을 요구한다. 조회 결과는 10분 random token으로만 보존하며 두 번째 터치에서
최대 3회 GitHub-controlled HTTPS redirect를 따라 private cache로 다운로드한다. Release digest를 확인한
뒤 top-level 6개 파일·크기·중복, 현재 설치 앱과 같은 signer/package, manifest와 같은 APK signer·
SemVer/versionCode이고 현재보다 높은 versionCode인지 기존 native verifier가 다시 검사한다. 세 번째
화면 터치와 Android unknown-source/package-installer 승인을 거쳐 설치하며 시작 시·주기적·background
조회나 무인 설치는 하지 않는다. 1.8.2에는 importer가 없으므로 최초 2.0 설치와 실제 1.8.1 rollback
현장 검증은 release gate로 남아 있다.

완료 조건: Termux 없이 핵심 흐름이 동작하고, 연결 실패 시 비밀정보를 노출하거나 다른 Provider로
우회하지 않으며 1.8.1로 복구할 수 있다.

## 12. 테스트와 출시 게이트

### 자동 검사

- 모든 Provider에 동일한 성공·부분 stream 실패·취소·timeout contract test 적용 — 자동 검사 구현
- 가짜 HTTP/SSE transport로 정상, 부분 stream, 잘못된 JSON, 중복·역순·terminal 뒤 이벤트, 401, 403,
  429, 5xx와 timeout 재현 — 자동 검사 구현
- malformed tool argument, symlink 탈출, root 밖 경로, 명령 timeout과 출력 폭주 차단
- 로그·journal·SSE·diagnostics에 API key와 Authorization 헤더가 없는지 검사
- OpenRouter model capability 변화와 fallback 정책 fixture
- OpenRouter 가격 단위·endpoint 성능 상한·quota redaction fixture와 수동 smoke harness loopback 검사
- OpenAI `store: false` 요청과 로컬 상태 replay 검사
- API Provider replay 상태의 journal 암호화, API/SSE/export 비노출, 이미지 data URL 제거 검사
- Playwright에서 production client와 실제 pairing·Gateway·SSE·run·approval 경로로 320/360/412px,
  150% 글자, 키보드 축소, 회전과 긴 prompt·diff·승인 상세 검증 — Chromium CI 자동 검사 구현
- Android instrumentation에서 Keystore, 알림 deep link, background reconnect와 음성 확인 검증
- update manifest 서명·APK signer binding, artifact 변조, unsigned 기본 거부와 versionCode downgrade 차단
- Android ZIP importer의 path/duplicate/size 상한, current signer/package binding, 10분 재검토와 설치 전 rehash
- 공식 Release의 잘못된 repo/tag/중복 asset/digest/content-type, oversized JSON/ZIP, HTTP·외부-host redirect와 조회 token 만료 차단
- DNS-SD의 wrong service/TXT, public·loopback 주소, 후보 flood·중복·만료·Unicode control과 pin/TXT smuggling 차단

### 실제 Provider 검사

- 공개 CI는 실제 모델 요청을 보내지 않는다.
- secret이 있는 보호된 수동 workflow에서만 저비용 smoke/eval을 실행한다.
- 모델 목록·인증 확인과 실제 유료 inference를 별도 단계로 나눈다.
- 실제 smoke는 비용 상한, 호출 횟수와 테스트 prompt를 고정하고 결과에서 비밀정보를 제거한다.

### 현장 시나리오

1. Codex CLI, OpenAI API와 OpenRouter에서 같은 read-only 조사 수행
2. 승인된 단일·다중 파일 patch와 test 수행
3. 승인 거절, 만료와 앱 강제 종료 복구
4. 429와 Provider 장애에서 무단 fallback이 없는지 확인
5. OpenRouter strict privacy 조건을 만족하지 못할 때 실행 차단
6. 여러 프로젝트 run, Queue/Steer와 완료 알림 확인
7. APK 업데이트와 1.8.1 rollback 확인

## 13. 마이그레이션과 호환성

- Gateway protocol 3은 `minimum`, `maximum`, capability 집합을 교환한다.
- v1 클라이언트에는 API Provider와 approval 기능을 숨기고 기존 Codex 경로만 제공한다.
- WorkJournal v2 데이터는 읽기 migration 후 새 SQLite journal로 복사하며 원본을 즉시 삭제하지 않는다.
- migration 실패 시 v1 데이터와 1.8.1 APK를 유지하고 사용자에게 복구 선택지를 제공한다.
- API run을 Codex thread처럼 가장하지 않는다. 공통 `conversationId` 아래 Provider별 원격 ID를 분리한다.
- Provider 전환은 자동 resume이 아니라 명시적인 fork와 컨텍스트 미리보기로 처리한다.

## 14. v2 완료 정의

- 한 Android 앱에서 여러 Linux Companion과 프로젝트의 작업 상태를 동시에 관리한다.
- Codex CLI, OpenAI API와 OpenRouter가 공통 run/event/tool/approval 계약을 따른다.
- API key는 Linux Companion 밖으로 나오지 않고 저장소·로그·클라이언트 storage에 남지 않는다.
- Provider나 모델이 달라도 허용 root, sandbox, 승인과 외부 효과 정책은 동일하게 적용된다.
- OpenRouter의 실제 Provider·fallback·개인정보 프로필과 비용이 run 단위로 보인다.
- 앱·네트워크·Companion 재시작 뒤 작업 상태를 중복 없이 복구한다.
- 실제 작은 화면, 큰 글자, 키보드와 긴 diff에서 UI가 viewport를 넘지 않는다.
- 2.0 candidate 현장 검증 중 1.8.1 APK와 Companion으로 복구할 수 있다.

## 15. v2.0에서 제외할 항목

- Windows/macOS Companion 정식 지원
- Android에서 Codex, Node.js, Git, ffmpeg, Ollama 또는 모델 가중치 실행
- Provider API key를 스마트폰에 저장하거나 브라우저 JavaScript에서 직접 API 호출
- 검증되지 않은 모델의 workspace-write 자동 활성화
- 항상 듣는 wake word와 음성만으로 고위험 승인
- 사용자의 선택 없는 모델·Provider·PC 자동 전환
- Claude Code 실행 어댑터 완성 — 공통 Provider 계약이 안정된 뒤 2.1 후보로 다룬다.

## 16. 공식 참고 자료

기준 확인일은 2026-08-24이다. 구현을 시작할 때 API 동작과 개인정보 정책을 다시 확인한다.

- [OpenAI Responses API — response 생성, 함수 도구와 streaming](https://developers.openai.com/api/reference/cli/resources/responses/methods/create)
- [OpenAI conversation state — `store:false` 수동 context와 응답 항목 replay](https://developers.openai.com/api/docs/guides/conversation-state)
- [OpenAI function calling — strict schema와 tool output loop](https://developers.openai.com/api/docs/guides/function-calling)
- [OpenAI API 데이터 보존과 `store` 정책](https://developers.openai.com/api/docs/guides/your-data#default-usage-policies-by-endpoint)
- [OpenAI API key 보안 권고](https://help.openai.com/en/articles/5112595-best-practices-for-api-key-safety)
- [OpenRouter tool/function calling](https://openrouter.ai/docs/guides/features/tool-calling)
- [OpenRouter Models API와 capability metadata](https://openrouter.ai/docs/guides/overview/models)
- [OpenRouter Provider routing, ZDR와 데이터 수집 제어](https://openrouter.ai/docs/guides/routing/provider-selection)
- [OpenRouter ZDR endpoint 목록 API](https://openrouter.ai/docs/api/api-reference/endpoints/list-endpoints-zdr)
- [OpenRouter current API key quota](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-key)
- [OpenRouter usage accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting)
- [OpenRouter router metadata](https://openrouter.ai/docs/guides/features/router-metadata)
- [OpenRouter 데이터 수집 정책](https://openrouter.ai/docs/guides/privacy/data-collection)
