# Linux Provider credentials

OpenAI와 OpenRouter API key는 Linux Companion만 읽는다. Android/PWA, Gateway API·SSE, 작업 저널,
진단과 Git에는 key 또는 credential 경로를 넣지 않는다.

## 권장: systemd encrypted credential

systemd 256 이상에서 실행하는 사용자 서비스는 user-scoped encrypted credential을 권장한다. 설정
스크립트는 `systemd-ask-password`로 key를 읽어 pipe로 `systemd-creds encrypt --user`에 전달하므로
평문 key 파일을 만들지 않는다.

```sh
./scripts/manage-provider-credential.sh set openai
./scripts/manage-provider-credential.sh set openrouter
```

암호문은 사용자 설정 아래 `credentials.encrypted`에 0600으로 저장된다. systemd 기본 정책에 따라
TPM2와 host key 중 사용 가능한 경계에 인증·암호화되고, credential 이름과 사용자·machine identity에
묶인다. 설치 스크립트를 다시 실행하면 존재하는 고정 이름만 user unit의
`LoadCredentialEncrypted=`에 추가한다.

```sh
./scripts/install-linux-companion.sh
```

스크립트는 서비스를 직접 restart하지 않는다. 새 credential은 systemd가 다음 서비스 activation에서
해독해 private runtime directory에 0400/0600 파일로 전달한다. 실행 중인 Codex turn이 모두 끝나고
사용자가 확인한 뒤에만 다음을 실행한다.

```sh
systemctl --user restart codex-pocket-companion.service
```

Companion은 `$CREDENTIALS_DIRECTORY/openai-api-key`와 `openrouter-api-key`만 읽는다. systemd credential이
있으면 환경변수보다 우선하며, 이름이 없을 때만 기존 환경변수·명시적 파일로 fallback한다. credential
파일이 symlink이거나 일반 파일이 아니거나, 소유자가 다르거나, group/other 권한·8 KiB 상한·UTF-8/key
형식을 위반하면 다른 source로 우회하지 않고 Provider를 차단한다.

## 교체와 해제

`set`을 다시 실행하면 이전 암호문을 local 0700 archive로 옮긴 뒤 새 암호문을 atomic하게 설치한다.
해제도 삭제 대신 같은 recoverable archive로 옮긴다.

```sh
./scripts/manage-provider-credential.sh set openai
./scripts/manage-provider-credential.sh remove openai
```

그 뒤 설치 스크립트로 unit binding을 갱신하고, 활성 turn이 없는 것을 확인한 뒤 서비스를 재시작한다.
해제 시 재시작 전까지 현재 service activation의 runtime credential은 계속 유효하므로, 즉시 차단이
필요하면 먼저 새 run을 중지하고 서비스를 명시적으로 stop한다. archive는 새 key와 rollback이 검증된
뒤 사용자가 직접 정리하며 자동 삭제하지 않는다.

## 구형 systemd와 직접 실행

현재 설치된 systemd가 256 미만이거나 사용자 service manager가 없으면 encrypted user credential을
활성화하지 않는다. 기존 0600 key 파일 경로는 계속 지원한다.

```sh
chmod 600 /secure/path/openai-api-key /secure/path/openrouter-api-key
export CODEX_POCKET_OPENAI_API_KEY_FILE=/secure/path/openai-api-key
export CODEX_POCKET_OPENROUTER_API_KEY_FILE=/secure/path/openrouter-api-key
```

호환성을 위해 `OPENAI_API_KEY`와 `OPENROUTER_API_KEY` 환경변수도 남겨 두지만 process environment보다
systemd credential 또는 별도 private 파일을 권장한다. source 우선순위는 systemd credential → 기존
환경변수 → 명시적 protected file이다.

## 공식 기준

- [systemd credentials](https://systemd.io/CREDENTIALS/)
- [systemd-creds](https://www.freedesktop.org/software/systemd/man/latest/systemd-creds.html)
- [systemd.exec credential directives](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html#Credentials)
