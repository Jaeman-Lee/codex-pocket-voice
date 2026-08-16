# Codex Pocket Voice

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

스마트폰에서 한국어로 말하고, PC 또는 스마트폰의 Codex CLI가 실제 프로젝트를 수정하게 만드는 React 기반 모바일 인터페이스입니다. Android 앱과 설치형 PWA를 지원하며 별도의 Whisper·Realtime API 비용이 들지 않습니다.

> Codex 모델 사용량은 사용자의 Codex 계정과 플랜 정책을 따릅니다. 이 프로젝트는 OpenAI의 공식 제품이 아닙니다.

## 핵심 기능

- Android 네이티브 `ko-KR` 받아쓰기와 웹 한국어 음성 입력
- PC와 스마트폰의 여러 Git 프로젝트·기존 Codex 대화 선택
- 실행 단말을 골라 새 Git 프로젝트 생성
- 각 단말이 제공하는 Codex 모델과 지원 추론 성능을 실시간 조회·선택
- 이미지 첨부와 영상 업로드, 로컬 Qwen3-VL 4B 대표 장면 분석
- 답변, 명령 실행, 파일 변경 상태를 SSE로 실시간 표시
- 실행 중인 Codex 턴 중단과 최종 diff·명령 요약
- Android 한국어 TTS로 답변 읽기
- React + Capacitor Android 앱과 설치 가능한 PWA
- 앱 실행 시 Termux SSH 터널 자동 시작
- Termux 터미널을 닫아도 유지되는 백그라운드 SSH 터널
- 선택적으로 사용할 수 있는 안전 범위 MCP 서버

## 구조

```text
Android APK / browser PWA
  ├─ React mobile UI
  ├─ Android native / Web speech recognition (ko-KR)
  ├─ Android TTS
  ├─ PC 선택 → http://127.0.0.1:8788
  │                 │ background SSH port forwarding
  │                 ▼
  │              PC 127.0.0.1:8787
  └─ 스마트폰 선택 → Termux 127.0.0.1:8789

각 단말의 Codex Pocket web gateway
       ├─ ffmpeg → Qwen3-VL 4B (local Ollama, video frames)
       └─ codex app-server (text + selected images)
            └─ 선택하거나 새로 만든 Git workspace
```

두 웹 서버와 Codex app-server는 각 단말의 loopback에만 노출됩니다. PC 서버는 스마트폰에서 SSH 터널을 통해서만 접근합니다.

## 요구 사항

- PC: Node.js 20 이상, Codex CLI, Git, tmux, SSH 서버, ffmpeg/ffprobe
- Android: Termux, OpenSSH, Android Chrome 권장
- 스마트폰에서 PC로 접속 가능한 SSH 경로(Tailscale 같은 사설망 권장)

## PC 설치

```sh
git clone https://github.com/Jaeman-Lee/codex-pocket-voice.git
cd codex-pocket-voice
npm ci
npm run build
./scripts/start-web-pc.sh
```

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

이 설정은 `pc-codex-web`과 `phone-codex-web`을 함께 설치합니다. 스마트폰 쪽은 기본적으로
`~/codex` 아래 Git 저장소를 찾아 `127.0.0.1:8789`에서 실행하며 다음 값으로 바꿀 수 있습니다.

```sh
export PHONE_PROJECTS_HOME=/private/phone/projects
export PHONE_CODEX_ROOTS=/project/a:/project/b
export CODEX_PHONE_WEB_PORT=8789
```

Android Studio가 설치된 PC에서 APK 프로젝트를 동기화하고 빌드합니다.

```sh
npm ci
npm run android:sync
# android/ 폴더를 Android Studio에서 열거나
npm run android:debug
```

설치 후 Android의 앱 정보 → 권한(또는 추가 권한)에서 **Termux 명령 실행**을 허용합니다. 이후에는 `pc-codex-web`이나 `phone-codex-web`을 사용자가 따로 열 필요 없이 Codex Pocket Voice 앱이 양쪽 연결을 요청합니다. Termux가 강제로 종료되거나 배터리 최적화로 중지되면 Android 설정에서 Termux의 배터리 제한을 해제해야 할 수 있습니다.

앱의 **실행 단말**에서 `내 PC` 또는 `이 스마트폰`을 선택할 수 있습니다. 프로젝트 옆 `＋`는 선택한 단말의 허용된 생성 위치에 폴더를 만들고 `git init --initial-branch=main`을 수행합니다. 모델과 성능 선택지는 단말의 Codex 카탈로그에서 읽으므로, 계정이나 CLI 버전에서 실제 지원하는 항목만 표시됩니다.

GitHub Actions의 APK는 저장소 비밀값에 보관된 고정 키로 서명됩니다. 1.2 이전 임시 디버그 APK는
실행마다 서명이 달랐고 일부 Android 사용자 영역에 이전 서명이 남을 수 있어, 1.2.1부터 충돌 없는
영구 패키지 ID `io.github.jaemanlee.codexpocketvoice.stable`을 사용합니다. 처음 설치할 때만 별도 앱으로
설치되며
이후 버전은 앱 데이터와 설정을 유지한 채 덮어쓸 수 있습니다. 서명키 파일이나 암호는 저장소에
커밋하지 않습니다.

현재 APK는 SSH 키를 앱에 복제하지 않고 기존 Termux SSH 설정을 사용합니다. Termux 없이 동작하는 네이티브 SSH 단계와 보안 설계는 [Android 앱 구조](docs/android-architecture.md)에 정리했습니다.

향후 사용자별 SSH·네트워크·경로 정보를 온보딩 화면에서 설정하는 작업은 [로드맵](docs/roadmap.md)에 정리했습니다. 실제 사용자 정보나 비밀키는 공개 저장소에 저장하지 않습니다.

## 보안 모델

- 웹 서버는 `127.0.0.1` 이외의 주소에 바인딩되지 않습니다.
- 모든 쓰기 API는 same-origin JSON 요청만 받습니다.
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
