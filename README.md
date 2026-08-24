# Codex Pocket Voice

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

현재 정식 배포는 `v1.6.0`이며 `1.8.2`는 current v1 현장 후보, `1.8.4`는 별도 staged hotfix,
`1.8.1`은 검증된 rollback 기준선입니다. `2.0.0` 소스는
`feature/v2-control-plane`에서 개발 중이며 아직 설치용 candidate가 아닙니다. 실제 배포 상태는
[Deployment inventory](docs/deployment-inventory.md), 변경 이력은 [Changelog](CHANGELOG.md),
출시 절차는 [Release process](docs/release-process.md)를 참고하세요.

개발 원본은 페어링된 Linux PC의 Git 작업공간입니다. Android/Termux는 APK 설치, 음성·UI
실기기 테스트, 연결 복구와 롤백 파일 관리를 담당하는 경량 클라이언트로 유지합니다.

스마트폰에서 한국어로 말하고, Linux PC의 Codex CLI가 실제 프로젝트를 수정하게 만드는 React 기반 모바일 인터페이스입니다. Android 앱과 설치형 PWA를 지원하며 별도의 Whisper·Realtime API 비용이 들지 않습니다. 스마트폰은 UI·음성 입력·암호화 연결만 담당하고 Codex 실행과 미디어 처리는 PC에서 수행합니다.

> Codex 모델 사용량은 사용자의 Codex 계정과 플랜 정책을 따릅니다. 이 프로젝트는 OpenAI의 공식 제품이 아닙니다.

## 핵심 기능

- 시스템 언어 기반 Android·웹 받아쓰기, PC·프로젝트별 암호화 음성 용어 사전, 별도 strict 설정 말하기→화면 터치 검토와 한국어/영어 UI
- 여러 Linux PC의 Git 프로젝트·기존 Codex 대화 선택
- 실행할 PC를 골라 새 Git 프로젝트 생성
- 각 PC가 제공하는 Codex 모델과 지원 추론 성능을 실시간 조회·선택
- 실행 중 입력은 기본 Queue로 순차 실행하고, 명시적으로 고른 Codex Steer만 현재 exact turn의 방향을 수정
- Provider 전환은 기본적으로 빈 새 대화를 만들고, 명시적 Fork에서만 전송 범위·제외 항목·예상 token·비용·privacy를 터치 검토한 뒤 bounded 컨텍스트를 승계
- 단말·프로젝트·대화별 로컬 작업 저널과 오프라인 프롬프트 대기열
- 암호화 Companion event journal과 SSE cursor 기반 네트워크·프로세스 재연결 복구, bounded 사용자 보존 정책, 프로젝트별 JSON 내보내기·2단계 기록 삭제
- 최대 8대 Linux Companion의 server-authored count-only 실행·승인·복구 요약을 동시에 확인하고 명시적으로 PC를 전환하는 Fleet, PC·프로젝트·Git branch/worktree별 비용·목표 이름·고정·보관 대시보드와 줄 번호 diff·same-run 수정 의견을 지원하는 만료·터치 전용 승인함
- 프롬프트·경로·응답을 네이티브 계층에 내리지 않는 opt-in Android process-death 완료·승인·오류 알림과 retained 작업 바로 열기
- OpenAI/OpenRouter에서 SHA-256 경쟁 검사를 거친 단일·2~8개 텍스트 교체, 신규 파일 생성·이름변경과 격리된 npm check/test/build
- Codex·Claude Code 등을 독립 어댑터로 확장할 수 있는 AI 제공자 모듈
- 설치 확인·브라우저 로그인·비용 없는 연결 테스트를 모은 AI 연결 센터
- OpenAI/OpenRouter 요청 전 서버 강제 token·비용 hard limit, emergency stop, 월 soft-limit 화면 확인과 실제/추정/unknown 비용 기록
- 이미지 첨부와 영상 업로드, 로컬 Qwen3-VL 4B 대표 장면 분석
- 답변, 명령 실행, 파일 변경 상태를 SSE로 실시간 표시
- 실행 중인 Codex 턴 중단과 최종 diff·명령 요약
- Android 한국어 TTS로 답변 읽기
- React + Capacitor Android 앱과 설치 가능한 PWA
- 앱 실행 시 Termux SSH 터널 자동 시작
- Termux 터미널을 닫아도 유지되는 백그라운드 SSH 터널
- v2 opt-in PocketLink LAN TLS listener, 10분 QR bootstrap, bounded DNS-SD/Android Wi-Fi Direct discovery, 별도 fail-closed Linux P2P group-owner CLI, Android Keystore device-certificate/SPKI-pin mTLS foreground tunnel과 명시적 direct/P2P/opaque outbound relay 및 fail-closed LAN→P2P→relay 자동 경로 (실제 P2P group·실기기 검증 전 CI 전용)
- 선택적으로 사용할 수 있는 안전 범위 MCP 서버
- 만료되는 코드와 Android Keystore를 사용하는 장치 페어링
- 여러 Linux Companion 등록과 앱 내 Linux 도구 진단

v2 저널의 저장 범위, 암호화 키와 재연결 동작은 [Event journal](docs/event-journal.md), API Provider의
변경·검증 경계는 [Approved API tools](docs/approved-tools.md), 비용·token 경계는
[API run policy](docs/run-policy.md), Termux-free TLS 연결의 현재 범위와
제한은 [PocketLink TLS bootstrap](docs/pocket-link.md)에 정리했습니다.
outbound relay의 서버·Companion·Android 범위와 남은 현장 단계는
[PocketLink outbound relay](docs/pocket-relay.md)에 정리했습니다.
Linux Wi-Fi Direct group-owner의 opt-in 실행·권한·cleanup·field gate는
[Linux PocketLink P2P group owner](docs/pocket-link-p2p-linux.md)에 정리했습니다.

## 구조

```text
Android APK / browser PWA
  ├─ React mobile UI
  ├─ Android native / Web speech recognition (ko-KR)
  ├─ Android TTS
  └─ PC 선택 → http://127.0.0.1:8788
                    │ background SSH port forwarding
                    ▼
                 PC 127.0.0.1:8787

Linux PC의 Codex Pocket web gateway
       ├─ ffmpeg → Qwen3-VL 4B (local Ollama, video frames)
       └─ codex app-server (text + selected images)
            └─ 선택하거나 새로 만든 Git workspace
```

웹 서버와 Codex app-server는 PC의 loopback에만 노출되며 스마트폰에서는 SSH 터널을 통해서만 접근합니다.

## 요구 사항

- PC: **Linux 전용**, Node.js 20 이상, Codex CLI, Git, tmux, SSH 서버, ffmpeg/ffprobe
- Android: Termux, OpenSSH, Android Chrome 권장. Codex CLI와 로컬 AI 모델은 설치하지 않습니다.
- 스마트폰에서 PC로 접속 가능한 SSH 경로(Tailscale 같은 사설망 권장)

PC Companion의 공식 지원 대상은 Linux 데스크톱과 서버입니다. Windows와 macOS
네이티브 지원 및 전용 설치 프로그램은 현재와 향후 계획의 범위에 포함하지 않습니다.
WSL·가상 머신·컨테이너는 동작할 수 있지만 공식 지원 및 검증 대상은 아닙니다.

## PC 설치

권장 설치는 Linux 사용자 서비스와 권한 제한 설정을 함께 만드는 설치 스크립트입니다.

```sh
git clone https://github.com/Jaeman-Lee/codex-pocket-voice.git
cd codex-pocket-voice
./scripts/install-linux-companion.sh
```

OpenAI/OpenRouter key는 systemd 256 이상에서 평문 파일 대신 user-scoped encrypted credential로 둘 수
있습니다. 설정·교체·해제와 안전한 재시작 순서는 [Linux Provider credentials](docs/provider-credentials.md)를
참고하세요. 현재 PC가 systemd 256 미만이면 기존 0600 private key 파일 방식이 유지됩니다.

systemd 사용자 서비스를 사용할 수 없는 Linux 환경에서는 스크립트 안내에 따라
`./scripts/start-web-pc.sh`를 실행합니다. Companion 로그에 10분간 유효한 8자리
페어링 코드가 표시되며, 앱에 한 번 입력하면 이후 토큰은 Android Keystore로 보호됩니다.

### 로컬 영상 분석(선택)

영상은 Codex에 원본으로 보내지 않고 PC의 `ffmpeg`로 대표 프레임 4장을 만든 뒤 로컬
[`qwen3-vl:4b`](https://ollama.com/library/qwen3-vl)로 먼저 분석합니다. 분석 요약과 대표 프레임은
Codex 턴에 함께 전달됩니다. RTX 2060 6GB에서는 Q4 모델이 약 5.66GB VRAM을 사용했으므로
영상 분석은 한 번에 하나씩 실행됩니다.

Ollama 0.12.7 이상을 사용자 경로에 설치한 뒤 최초 한 번 모델을 받습니다. 기본 경로가 다르면
환경 변수로 바꿀 수 있으며 사용자 경로나 네트워크 정보는 저장소에 하드코딩하지 않습니다.

```sh
export CODEX_VIDEO_OLLAMA_BIN="$HOME/.local/opt/ollama-vl/bin/ollama"
export CODEX_VIDEO_OLLAMA_URL=http://127.0.0.1:11435
export CODEX_VIDEO_OLLAMA_MODELS="$HOME/.local/share/ollama-vl/models"
export CODEX_VIDEO_MODEL=qwen3-vl:4b

OLLAMA_HOST=127.0.0.1:11435 \
OLLAMA_MODELS="$CODEX_VIDEO_OLLAMA_MODELS" \
"$CODEX_VIDEO_OLLAMA_BIN" pull "$CODEX_VIDEO_MODEL"
```

`start-web-pc.sh`는 설정된 사용자용 Ollama 서버를 자동으로 확인하고 시작합니다. 영상 원본과
대표 프레임은 기본적으로 `~/.local/state/codex-pocket-voice/media`에 비공개로 저장되며 오래된
임시 항목은 정리됩니다. 다음 값도 필요에 따라 변경할 수 있습니다.

```sh
export CODEX_POCKET_MEDIA_DIR=/private/path/codex-pocket-media
export CODEX_MEDIA_MAX_BYTES=209715200
export CODEX_VIDEO_ENABLED=true
```

`start-web-pc.sh`는 기본적으로 `~/workspace` 아래의 Git 저장소를 찾아 허용 프로젝트로 등록하고, 같은 위치에 새 프로젝트를 만들 수 있게 한 뒤 `127.0.0.1:8787`에서 서버를 시작합니다. 직접 지정하려면 다음처럼 실행합니다.

```sh
export CODEX_VOICE_ROOTS=/path/to/project-a:/path/to/project-b
export CODEX_BIN=/path/to/codex
./scripts/start-web.sh
```

## Android PWA 설치

Termux에서 저장소를 clone하거나 `scripts/pc-codex-web.sh`만 복사한 뒤 실행 경로에 연결합니다.

```sh
pkg install openssh
git clone https://github.com/Jaeman-Lee/codex-pocket-voice.git
cd codex-pocket-voice
ln -s "$PWD/scripts/pc-codex-web.sh" "$PREFIX/bin/pc-codex-web"
```

SSH config 별칭을 쓰는 구성이 가장 간단합니다.

```sshconfig
Host my-codex-pc
    HostName 100.x.y.z
    User your-user
    Port 22
    IdentityFile ~/.ssh/id_ed25519
```

PC에 clone한 실제 경로와 SSH 대상을 설정하고 앱을 엽니다. 매번 내보내기 싫다면 같은 값을 `~/.config/codex-pocket-voice/config`에 셸 변수 형식으로 저장할 수 있습니다.

```sh
export PC_SSH_TARGET=my-codex-pc
export PC_CODEX_WEB_APP=/home/your-user/codex-pocket-voice
pc-codex-web open
```

```sh
mkdir -p ~/.config/codex-pocket-voice
chmod 700 ~/.config/codex-pocket-voice
printf '%s\n' \
  'PC_SSH_TARGET=my-codex-pc' \
  'PC_CODEX_WEB_APP=/home/your-user/codex-pocket-voice' \
  > ~/.config/codex-pocket-voice/config
chmod 600 ~/.config/codex-pocket-voice/config
```

브라우저가 `http://127.0.0.1:8788`을 엽니다. 처음 `🎙 한국어` 버튼을 누를 때 마이크 권한을 허용하세요. 브라우저 메뉴에서 홈 화면에 설치하면 일반 앱처럼 사용할 수 있습니다.

터널 관리 명령:

```sh
pc-codex-web start
pc-codex-web status
pc-codex-web stop
```

휴대폰 재부팅 후 자동 연결은 Termux:Boot로 구성할 수 있습니다. Termux:Boot가 없다면 재부팅 후 `pc-codex-web open`을 한 번 실행하면 됩니다.

## Android APK

APK는 React 화면을 앱 안에 포함하고, 실행될 때 Termux에 SSH 터널 시작을 자동 요청합니다. 먼저 Termux에서 한 번 설정합니다.

```sh
./scripts/setup-android-app.sh
```

이 설정은 `pc-codex-web`만 설치합니다. 과거 버전의 `phone-codex-web`이 실행 중이면 중지하고 실행 링크를 제거해 스마트폰에서 Node.js·Codex 프로세스가 자동으로 다시 뜨지 않게 합니다.

Android Studio가 설치된 PC에서 APK 프로젝트를 동기화하고 빌드합니다.

```sh
npm ci
npm run android:sync
# android/ 폴더를 Android Studio에서 열거나
npm run android:debug
```

F-Droid/GitHub판 Termux는 설치 후 Android의 앱 정보 → 권한(또는 추가 권한)에서 **Termux 명령 실행**을 허용합니다. Google Play판 Termux는 이 외부 명령 서비스를 제공하지 않는 대신 Termux:Boot가 본체에 통합되어 있으므로, `setup-android-app.sh`가 `~/.termux/boot` 시작 스크립트와 15분 간격 자가복구 작업을 등록합니다. 두 방식 모두 Termux가 강제로 종료되거나 배터리 최적화로 중지되면 Android 설정에서 Termux의 배터리 제한을 해제해야 할 수 있습니다.

앱의 **실행 단말**에서 연결된 Linux PC를 선택할 수 있습니다. 프로젝트 옆 `＋`는 선택한 PC의 허용된 생성 위치에 폴더를 만들고 `git init --initial-branch=main`을 수행합니다. 모델과 성능 선택지는 PC의 Codex 카탈로그에서 읽으므로, 계정이나 CLI 버전에서 실제 지원하는 항목만 표시됩니다.

상단 `◎` 버튼의 **AI 연결 센터**는 선택한 단말에서 Codex·Claude Code CLI 설치와 로그인 상태를 확인하고, 공식 설치 안내·브라우저 로그인·비용 없는 연결 테스트를 한 화면에 표시합니다. 계정 별명만 선택적으로 이 스마트폰에 저장하며 비밀번호나 API 키는 앱에 입력하거나 저장하지 않습니다. 연결 테스트는 로그인 상태와 모델 카탈로그만 읽고 AI 프롬프트를 전송하지 않습니다.

현재 Codex 어댑터는 실행·대화·모델 조회까지 지원합니다. Claude Code 어댑터는 CLI 설치 및 계정 연결 상태를 감지하지만 실행 어댑터가 완성되기 전에는 대화 제공자로 선택할 수 없게 표시됩니다.

Codex 작업 중에도 입력·음성·첨부를 계속 사용할 수 있습니다. 이때 전송 버튼은 **대기열 +**로 바뀌며, 현재 작업이 끝나면 예약한 요청을 같은 프로젝트와 대화에서 순서대로 실행합니다. 각 예약 항목은 추가 당시의 모델·성능·네트워크 설정을 유지하며 시작 전 취소할 수 있습니다.

v2 개발판의 입력창 아래 **용어** 버튼에서는 선택한 PC·프로젝트에만 적용되는 받아쓰기 사전을 최대
32개까지 편집할 수 있습니다. 예를 들어 `오픈 라우터 → OpenRouter`를 등록하면 새 음성 구간만 보정하고,
직접 입력한 문장은 바꾸지 않습니다. 결과는 전송 전에 입력창에서 다시 수정할 수 있으며 사전 내용과
scope는 암호화·해시 처리된 로컬 작업 저널에 저장됩니다.

v2 개발판의 **설정 말하기**는 일반 요청 받아쓰기와 분리되어 있습니다. 예를 들어
`프로젝트 stock explorer 선택`, `AI 연결 OpenRouter 선택`, `모델 GPT 5.6 선택`처럼 현재 목록의 정확한
이름 한 가지만 말합니다. 비슷하거나 중복된 이름은 추측하지 않으며, 인식이 끝나도 설정은 바뀌지 않습니다.
화면에 표시된 인식문과 현재→대상을 확인하고 **화면 터치로 확정**해야 적용됩니다. 검토 중 PC·프로젝트·
Provider·모델이나 실행 상태가 달라지면 적용하지 않고 다시 확인을 요구합니다.

v2 개발판 승인함의 파일 변경은 파일·hunk·이전/새 줄 번호와 추가·삭제 색으로 표시되며 긴 코드는
스마트폰 폭 안에서 줄바꿈됩니다. 추가·삭제 줄을 터치해 최대 8개의 수정 의견을 작성한 뒤
**거절하고 피드백 전송**을 누르면, 도구를 실행하지 않고 OpenAI Responses 또는 OpenRouter의 같은 run에
의견을 돌려보내 수정안과 새 승인을 요청합니다. 줄 의견을 선택한 상태에서는 실수로 승인할 수 없습니다.

v1.7부터 대화와 예약 프롬프트를 AES-GCM으로 암호화해 버전된 `WorkJournal` 저장소에 기록합니다. Android 암호화 키는 Keystore가 보호하며 기존 v1 평문 기록은 읽을 때 자동으로 암호화 형식으로 이전됩니다. v2 개발판은 암호화 envelope를 앱 전용 SQLite에도 복사하고, 현장 승인 전까지 기존 저장소를 삭제하지 않고 함께 갱신해 1.8.1 rollback 호환을 유지합니다. PC가 오프라인이어도 마지막 대화를 열람하고 요청을 예약할 수 있으며, 요청은 선택한 PC가 다시 연결된 뒤 실행됩니다.

GitHub Actions의 APK는 저장소 비밀값에 보관된 고정 키로 서명됩니다. 1.2 이전 임시 디버그 APK는
실행마다 서명이 달랐고 일부 Android 사용자 영역에 이전 서명이 남을 수 있어, 1.2.1부터 충돌 없는
영구 패키지 ID `io.github.jaemanlee.codexpocketvoice.stable`을 사용합니다. 처음 설치할 때만 별도 앱으로
설치되며
이후 버전은 앱 데이터와 설정을 유지한 채 덮어쓸 수 있습니다. 서명키 파일이나 암호는 저장소에
커밋하지 않습니다.

정식 Release 전의 APK 후보는 GitHub의 **Releases**가 아니라 해당 Draft PR의 성공한
**Android stable APK** Actions 아티팩트에 ZIP으로 올라갑니다. v2 CI 산출물은 APK·체크섬·SBOM과 함께
정규화된 `update-manifest.json`을 만들고, 공식 서명 빌드에는 같은 Android release key로 만든 분리
서명과 공개 인증서도 포함합니다. 오프라인 검증기는 APK와 SBOM의 해시·크기, manifest 서명, APK
서명 인증서와 versionCode 상승을 확인합니다. v2 Android 앱은 이 전체 ZIP을 연결 센터에서 선택해
현재 설치 앱과 같은 signer·package, 더 높은 versionCode인지 native에서 다시 확인하고, 두 번째 터치
뒤 Android 시스템 설치 확인창을 엽니다. URL 자동 검색·다운로드와 무인 설치는 하지 않습니다. 최초
1.8.2→2.0 전환은 1.8.2 앱에 이 기능이 없으므로 기존 방식으로 수동 설치해야 합니다. 자세한 사용법은
[Release process](docs/release-process.md)에 있습니다.

현재 APK는 SSH 키를 앱에 복제하지 않고 기존 Termux SSH 설정을 사용합니다. Termux 없이 동작하는 네이티브 SSH 단계와 보안 설계는 [Android 앱 구조](docs/android-architecture.md)에 정리했습니다.

향후 사용자별 SSH·네트워크·경로 정보를 온보딩 화면에서 설정하는 작업과, Termux·Tailscale이 담당하는 보안 연결 기능을 독립 모듈로 내재화하는 최종 목표는 [로드맵](docs/roadmap.md)에 정리했습니다. 실제 프로젝트와 CLI는 Linux PC에만 두고 스마트폰은 저부하 클라이언트로 유지합니다. 실제 사용자 정보나 비밀키는 공개 저장소에 저장하지 않습니다.

## 보안 모델

- 웹 서버는 `127.0.0.1` 이외의 주소에 바인딩되지 않습니다.
- 모든 API는 페어링된 bearer token을 요구하며, 쓰기 API는 허용된 origin도 함께 검사합니다.
- 페어링 코드는 10분 후 만료되고 잘못된 입력은 속도 제한됩니다.
- 프로젝트 경로는 `CODEX_VOICE_ROOTS` 내부인지 실제 경로 기준으로 검사합니다.
- Codex 턴은 `workspace-write` 샌드박스와 `approvalPolicy: never`로 실행됩니다.
- 추가 권한·샌드박스 탈출 요청은 브리지에서 자동 거절합니다.
- SSH 개인키, `.env`, Codex 인증 정보는 저장소에 포함하지 않습니다.

8787 또는 8788 포트를 공용 네트워크에 직접 개방하지 마십시오.

## MCP 모드

웹 UI 없이 MCP stdio 서버로도 실행할 수 있습니다.

```sh
npm ci
npm run build
export CODEX_VOICE_ROOTS=/path/to/project-a:/path/to/project-b
./scripts/start-mcp.sh
```

제공 도구:

- `codex_health`
- `codex_list_threads`
- `codex_get_thread`
- `codex_run`
- `codex_interrupt`

`scripts/setup-tunnel.sh`는 지원되는 MCP 터널 환경을 위한 선택적 보조 스크립트입니다. 터널 ID나 API 키는 저장소나 채팅에 넣지 마십시오.

## 개발과 검증

```sh
npm ci
npm run check
npm run build
npm test
npm run android:sync
```

실제 로컬 Codex app-server가 설치된 환경에서는 다음 통합 테스트도 실행할 수 있습니다. 이 테스트들은 모델 턴을 시작하지 않습니다.

```sh
npm run test:integration
```

## 기술 스택

- React 19 / Vite / TypeScript
- Capacitor Android와 Java 네이티브 플러그인
- Node.js PC gateway
- Codex app-server JSON-RPC over stdio
- MCP SDK
- Server-Sent Events
- Android RecognizerIntent / Web Speech API / Speech Synthesis API
- PWA Service Worker
- OpenSSH ControlMaster

## 라이선스

[MIT](LICENSE)
