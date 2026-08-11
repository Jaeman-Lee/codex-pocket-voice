# Codex Pocket Voice

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

스마트폰에서 한국어로 말하고, PC의 Codex CLI가 실제 프로젝트를 수정하게 만드는 모바일 우선 인터페이스입니다. Android 브라우저의 음성 인식과 TTS를 사용하므로 별도의 Whisper·Realtime API 비용이 들지 않습니다.

> Codex 모델 사용량은 사용자의 Codex 계정과 플랜 정책을 따릅니다. 이 프로젝트는 OpenAI의 공식 제품이 아닙니다.

## 핵심 기능

- `ko-KR`로 고정된 앱 내 한국어 음성 입력
- PC의 여러 Git 프로젝트와 기존 Codex 대화 선택
- 답변, 명령 실행, 파일 변경 상태를 SSE로 실시간 표시
- 실행 중인 Codex 턴 중단과 최종 diff·명령 요약
- Android 한국어 TTS로 답변 읽기
- 설치 가능한 모바일 PWA
- Termux 터미널을 닫아도 유지되는 백그라운드 SSH 터널
- 선택적으로 사용할 수 있는 안전 범위 MCP 서버

## 구조

```text
Android browser / PWA
  ├─ Korean speech recognition (ko-KR)
  ├─ Android TTS
  └─ http://127.0.0.1:8788
             │
             │ background SSH port forwarding
             ▼
PC 127.0.0.1:8787
  └─ Codex Pocket web gateway
       └─ codex app-server (stdio)
            └─ selected Git workspace
```

웹 서버와 Codex app-server는 PC의 loopback에만 노출됩니다. 스마트폰은 SSH를 통해서만 접근합니다.

## 요구 사항

- PC: Node.js 20 이상, Codex CLI, Git, tmux, SSH 서버
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

`start-web-pc.sh`는 기본적으로 `~/workspace` 아래의 Git 저장소를 찾아 허용 프로젝트로 등록하고 `127.0.0.1:8787`에서 서버를 시작합니다. 직접 지정하려면 다음처럼 실행합니다.

```sh
export CODEX_VOICE_ROOTS=/path/to/project-a:/path/to/project-b
export CODEX_BIN=/path/to/codex
./scripts/start-web.sh
```

## Android 설치

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
```

실제 로컬 Codex app-server가 설치된 환경에서는 다음 통합 테스트도 실행할 수 있습니다. 이 테스트들은 모델 턴을 시작하지 않습니다.

```sh
npm run test:integration
```

## 기술 스택

- TypeScript / Node.js
- Codex app-server JSON-RPC over stdio
- MCP SDK
- Server-Sent Events
- Web Speech API / Speech Synthesis API
- PWA Service Worker
- OpenSSH ControlMaster

## 라이선스

[MIT](LICENSE)
