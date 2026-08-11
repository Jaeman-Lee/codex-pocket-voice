# Android 앱 구조와 다음 단계

## 현재 구현

Capacitor APK 안에 React 화면을 포함합니다. 앱은 화면을 표시하기 위해 PC나 SSH 연결을 기다리지 않습니다.

앱이 열리면 네이티브 `PocketTunnel` 플러그인이 Termux의 공식 `RUN_COMMAND` 인텐트로 `pc-codex-web start`를 요청합니다. Termux는 기존 SSH 키와 설정을 그대로 사용해 `127.0.0.1:8788`에서 PC의 `127.0.0.1:8787`로 포트 포워딩합니다. 명령은 멱등적이므로 이미 연결된 경우 중복 터널을 만들지 않습니다.

음성 입력은 네이티브 `RecognizerIntent`를 `ko-KR`로 호출합니다. 최종 인식 결과 하나만 React에 반환하므로 브라우저의 누적 중간 결과가 반복되는 문제를 피합니다. 음성 데이터 비용을 부과하는 별도 OpenAI API는 사용하지 않습니다.

```text
Codex Pocket APK
  ├─ React UI (APK 내부 자산)
  ├─ Android 한국어 받아쓰기
  └─ Termux RUN_COMMAND (최초 1회 권한)
        └─ pc-codex-web start
             └─ SSH local forward 127.0.0.1:8788 → PC 127.0.0.1:8787
                  └─ Codex app-server
```

## 보안 경계

- Android 앱은 임의 셸 문자열을 전달하지 않고 고정된 `pc-codex-web start`만 실행합니다.
- Termux 외부 명령 실행은 Termux 설정과 Android의 앱별 권한이 모두 허용되어야 합니다.
- API 서버와 SSH 포워딩은 loopback에만 바인딩됩니다.
- APK origin만 읽기 CORS와 쓰기 origin 검사를 통과합니다.
- SSH 개인키와 Codex 인증 정보는 APK나 웹 저장소로 복사하지 않습니다.

## 완전 독립형 SSH의 후속 단계

Termux가 전혀 필요 없는 버전은 별도 보안 단계로 진행합니다.

1. 앱 설정 화면에서 호스트, 포트, 사용자, PC 호스트 키 지문을 입력합니다.
2. 개인키는 Android Keystore로 암호화하고 WebView 또는 localStorage에 노출하지 않습니다.
3. SSH 라이브러리를 네이티브 foreground service 안에서 실행하고 로컬 포트 포워딩을 관리합니다.
4. 최초 연결에서 호스트 키 지문을 명시적으로 확인하고 이후 변경을 차단합니다.
5. 네트워크 전환, 절전, 앱 재시작 시 재연결 테스트를 추가합니다.

현재 Termux 연동형은 이미 사용 중인 검증된 SSH 설정과 키를 재사용하므로 첫 APK 버전에 더 안전하고 구현 범위도 작습니다.
