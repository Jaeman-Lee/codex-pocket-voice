# Diagnostic support bundle

v2 Linux Companion은 AI 연결 센터에서 현장 진단용 JSON을 내려준다. 이 파일은 로그 archive가 아니라
처음부터 정해진 aggregate field만 조립하는 allowlist-only 문서다. Gateway가
`diagnosticSupportBundle` capability를 광고할 때만 앱에 다운로드 버튼이 나타난다.

## 포함 범위

- schema와 생성 시각
- Codex Pocket 앱 버전
- Gateway minimum/maximum protocol과 boolean capability map
- Linux architecture와 Node 버전
- Codex CLI, Git, tmux, OpenSSH, ffmpeg, Ollama의 required/available 상태
- 알려진 각 도구 출력에서 인식한 bounded version token
- 등록 workspace와 허용된 생성 위치의 개수

도구의 `--version` stdout/stderr 원문은 파일이나 API에 넣지 않는다. 알려진 도구 prefix 뒤의 version
token만 정규식으로 추출하며 인식하지 못한 출력은 도구의 available 상태만 남긴다.

## 제외 범위

- API key, bearer token, pairing code, 환경 변수와 credential 파일
- device/client ID, 이름, IP, hostname, port와 PocketLink/relay 설정
- workspace/생성 위치 절대 경로, Git branch·remote·commit과 파일 이름
- prompt, response, 명령 출력, error text와 Provider 응답
- journal, approval, run artifact와 support 대상 파일의 content

`GET /api/diagnostics/support-bundle`은 기존 bearer 또는 PocketLink mTLS binding 뒤에서만 동작한다.
응답은 JSON attachment이며 `Cache-Control: no-store`와 `X-Content-Type-Options: nosniff`를 적용한다.
파일 생성은 위 도구들의 bounded version probe만 수행하며 Provider 요청, workspace 파일/Git 상태 조회,
프로젝트 명령 또는 외부 network 요청을 실행하지 않는다.

이 묶음은 구조와 도구 가용성 문제를 공유하기 위한 것이다. 실제 연결 실패를 조사할 때 필요한 private
주소나 재현 절차는 사용자가 별도 안전한 채널에서 직접 선택해 전달하며 자동으로 이 파일에 추가되지 않는다.
