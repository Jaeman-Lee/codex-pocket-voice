# 스마트폰을 테스트 기기로 사용하는 Git 중심 개발

흐름: **요구사항 이슈 → PC 작업 브랜치 → Draft PR → CI APK → 스마트폰 테스트 이슈 → 승인 → 운영 반영**.
두 기기의 Codex가 GitHub로 작업을 주고받는 기준은 [기기 간 작업 조율](device-coordination.md)에 있다.
PC/GitHub에서 개발·빌드·자동 검사를 수행하고 스마트폰은 설치와 실제 사용 검증에 집중한다.
실행 기록, 테스트 판정, 작업 이슈 상태는 별개다. CI 성공만으로 이슈를 완료하거나 배포하지 않는다.

Obsidian Vault 연결: **미설정**. 프로젝트에 지정된 Vault 경로를 확인하지 못해 이 저장소의
`docs/`를 원본으로 유지한다. Vault 지정 후 프로젝트 노트에서 이 문서를 연결하며 본문을 복제하지 않는다.
요구사항과 진행 상태: [이슈 #10](https://github.com/Jaeman-Lee/codex-pocket-voice/issues/10).

## 현재 단계

2026-09-25: 테스트 도구와 기록 양식을 추가한다. 앱·서버 코드는 바꾸지 않는 개발 도구 변경이므로
APK SemVer/versionCode는 유지한다. 작업 브랜치는 `chore/android-field-testing-20260925`,
기준은 `hotfix/1.8.4-external-writer-clarity`다. 사용자가 알려준 설치 앱 버전은 **1.8.2**다.
패키지·서명 호환성 및 실제 설치 상태는 기기에서 별도 확인한다.
현재 설치본과 rollback APK는 교체하지 않는다. 2.0 후보를 선택하면 해당 브랜치의 추가 검증도 따른다.

## 1. 수정과 빌드

버그/기능 요구사항을 이슈에 쓰고 작업 브랜치에서 수정한다. 앱 변경이면
[버전 결정과 배포 규칙](release-process.md)을 먼저 따른다. PR에는 요구사항 이슈를 연결한다.
기존 `Linux checks`의 Node 20/22와 `Android stable APK`를 사용한다.
새 도구 자체 검사는 `python3 test/phone-test-tool.test.py`로 실행한다.

CI 산출물은 14일 뒤 만료된다. 만료된 파일을 통과 증거로 쓰거나 버전 이름만 보고 다른 빌드를
받지 않는다. 이미 전달한 APK를 변경해 다시 배포할 때는 더 높은 버전이 필요하다.
공개 저장소의 외부 PR을 PC에서 자동 실행하거나 운영 Companion에 자동 배포하지 않는다.

## 2. 후보를 PC에 받기

Python 3, Git, 로그인된 GitHub CLI가 필요하다. 검토한 후보 브랜치에서 Android 워크플로를
`workflow_dispatch`로 실행한다. PR 빌드는 임시 병합 소스를 포함할 수 있어 후보 도구가 받지 않는다.

```sh
gh workflow run android-debug.yml --repo Jaeman-Lee/codex-pocket-voice --ref REVIEWED_BRANCH
```

성공한 수동 Android 빌드의 run ID와
그 빌드의 전체 소스 SHA를 PR/Actions에서 확인한 다음 실행한다.

```sh
python3 scripts/phone-test.py --run RUN_ID --sha FULL_40_CHARACTER_SHA \
  --output "$HOME/Downloads/CodexPocketVoice/candidates/RUN_ID"
```

도구는 저장소·워크플로·성공 여부·SHA를 확인하고 정확한 run의 artifact를 받는다.
APK/SHA256SUMS/SBOM 묶음을 검사하고 APK SHA-256을 대조한다. 기존 폴더를 덮어쓰지 않는다.
압축 파일 안의 경로나 체크섬에 적힌 경로로 임의 파일을 쓰지 않는다.
`-stable.apk` 파일명과 체크섬만으로 서명 인증서의 신뢰를 증명하지는 않는다.
설치 전 Android SDK `apksigner verify --print-certs`로 기존 검증본과 인증서를 비교하고
applicationId/versionCode도 확인한다. 다른 패키지면 별도 앱이며 설정이 자동 이전되지 않는다.

## 3. 휴대폰에서 설치·검증

스마트폰 브라우저로 **해당 Actions 빌드 링크 → Artifacts**를 열어 APK 묶음을 받을 수 있다.
또는 PC에서 확인한 동일 묶음을 기존 파일 전송 경로로 보낸다. 새 터널이나 공개 서버는 필요 없다.
APK 설치 확인은 Android 화면에서 직접 진행한다. 다운로드와 실제 설치 완료를 구분한다.
설정·페어링을 보존하려고 앱을 임의로 삭제하지 않는다. 서명/버전 충돌이면 설치를 중지하고 기록한다.

PC가 만든 `field-test.md`에 관련 PR과 앱/Companion 버전을 채운 뒤 이슈로 올린다.

```sh
gh issue create --repo Jaeman-Lee/codex-pocket-voice \
  --title '[Android 실기기] 후보 버전 — 미실시' \
  --body-file "$HOME/Downloads/CodexPocketVoice/candidates/RUN_ID/field-test.md"
```

스마트폰에서는 이 이슈의 체크리스트에 결과를 남긴다. 음성 중복은 짧은 말하기, 연속 말하기,
중단 후 다시 시작, 의도적인 반복을 나누어 확인한다. 실패하면 재현 순서와 버그 이슈를 연결한다.
새 Issue Form은 기본 브랜치에 들어간 뒤 선택 메뉴에 나타난다. 그 전에도 위 명령으로 만든
이슈는 바로 사용할 수 있다. 저장소는 공개이므로 개인 원문·토큰·페어링 코드를 올리지 않는다.

## 4. 합격 후 반영

자동 검사와 실제 테스트가 모두 통과하면 이슈에 판정과 근거를 남기고 PR에 연결한다.
사용자의 운영 전환 승인 후에만 병합·정식 태그/Release·Companion 교체를 진행한다.
현재 실행 중인 Codex 작업을 중단하지 않는다. 구체적인 순서는 [Release process](release-process.md)를 따른다.

휴대폰에는 current 후보 한 세트와 직전 검증 rollback 한 세트를 유지한다.
APK 다운그레이드는 Android 정책에 막힐 수 있으므로 보관만으로 복구 성공을 주장하지 않는다.
Actions APK, 실제 설치 상태, GitHub Release의 정식 버전을 각각 기록한다.

## 2026-09-25 준비 결과

- 구현: [커밋 8eebc4e](https://github.com/Jaeman-Lee/codex-pocket-voice/commit/8eebc4e),
  [Draft PR #11](https://github.com/Jaeman-Lee/codex-pocket-voice/pull/11).
- 도구 회귀 테스트 4개, YAML 파싱, Node 20/22 및 도구 CI가 통과했다.
- [1.8.4 후보 빌드](https://github.com/Jaeman-Lee/codex-pocket-voice/actions/runs/36138962211)는
  `433a3005166ffdd696da0c2158646dc6c8227f22`에서 성공했다. PC에서 APK 묶음을 실제 다운로드하고
  체크섬을 대조했다. 사용 중인 APK나 Companion은 교체하지 않았다.
- [실기기 테스트 이슈 #12](https://github.com/Jaeman-Lee/codex-pocket-voice/issues/12)에
  후보 식별값과 체크리스트를 기록했다. 설치본 서명 호환성과 실제 스마트폰 검증은 미실시다.
  이후 진행 상태는 이슈를 기준으로 확인한다.

## USB로 실제 설치본 확인하기

PC 도구 준비:

```sh
sh scripts/setup-phone-adb.sh
sh scripts/prepare-phone-test.sh
```

첫 스크립트는 Google의 Linux platform-tools를 사용자 전용 도구 폴더에 받는다.
휴대폰에서 USB 디버깅을 켜고 데이터 케이블로 연결한 뒤 PC의 디버깅 인증을 허용한다.
디버깅 옵션만 켜고 케이블을 연결하지 않은 상태는 PC 연결 완료가 아니다.

두 번째 스크립트는 1.8.4 후보에 맞는 Codex CLI 0.149.0을 별도로 설치하고 빌드·타입·단위·통합·
스키마 검사를 실행한다. 현재 PC의 기본 Codex CLI를 교체하지 않는다.
이번 PC의 기본 0.157.0에서는 기본/통합 검사가 통과했지만 생성 스키마 대조가 실패했으며,
격리된 0.149.0에서는 단위 21개·통합 3개와 스키마 대조까지 통과했다.
이것은 0.157.0 지원 완료나 정식 배포 승인을 의미하지 않는다.

테스트 Companion은 별도 터미널에서 실행한다.

```sh
sh scripts/start-phone-test-companion.sh
```

이 프로세스는 loopback 8792만 사용하며 인증·세션·미디어 상태를 별도 사용자 상태 폴더에 둔다.
운영 서비스를 재시작하거나 운영 페어링을 덮어쓰지 않는다. USB 연결 후 설치 앱의
package/versionCode/인증서를 대조하고, 기존 터널과 충돌하지 않는 휴대폰 로컬 포트를 골라
`adb reverse`로 테스트 Companion에 연결한다. 설치 또는 앱 화면 조작 전에 실행 중인 작업을 확인한다.
휴대폰 고유 ID·인증 상태·APK 원본·전체 로그는 Git에 넣지 않는다.

설치본을 바꾸지 않고 확인하는 명령:

```sh
python3 scripts/check-phone-apk.py --candidate /path/to/candidate.apk \
  --sha256 APK_DIGEST_FROM_CI --certificate CERTIFICATE_DIGEST_FROM_CI_APKSIGNER
```

Ubuntu의 `python3-cryptography`가 필요하다. 이 도구는 USB 기기 한 대에서 지정된 Pocket
패키지의 버전과 base APK를 읽는다. 후보 파일 SHA-256을 확인한 뒤 두 APK의 v1 인증서
지문을 비교한다. 단순 인증서 추출은 서명 검증을 대체하지 않는다. 후보는 CI에서
`apksigner verify`가 성공하고 다운로드 체크섬이 일치한 파일을 사용해야 한다.
v1 인증서가 없는 APK는 이 도구로 판정하지 않고 Android SDK apksigner를 사용한다.
기기 식별자나 개인 파일은 출력하지 않으며, 설치·실행·종료·데이터 초기화를 하지 않는다.

추가 준비 결과: ADB 도구 준비, 테스트 Companion의 `1.8.4`/protocol `2` 응답,
실제 후보 파일의 인증서와 CI 지문 일치, 잘못된 파일 체크섬 거부를 확인했다.
USB 인식이 잠시 승인 대기 상태까지 진행됐으나 이후 장치 열거 오류와 연결 끊김이 관찰됐다.
이 기록은 앱 설치·서명 호환성 확인 완료가 아니며 후속 상태는 실기기 이슈에서 갱신한다.

USB 연결이 불안정하면 Android 11 이상에서 무선 디버깅을 사용할 수 있다.
PC와 같은 네트워크에서 개발자 옵션의 무선 디버깅을 켜고 ‘페어링 코드로 기기 페어링’을 연다.
`adb pair IP:PAIRING_PORT`에서 코드를 입력하고, 필요하면 무선 디버깅 기본 화면에 표시된
별도의 연결 포트로 `adb connect IP:CONNECTION_PORT`를 실행한다. 페어링 포트와 연결 포트는
다를 수 있다. 코드는 PC 터미널에 직접 입력하며 Git/이슈에 기록하지 않는다.
연결 후 위 검사 명령에 `--serial IP:CONNECTION_PORT`를 추가한다.
[Android 공식 ADB 안내](https://developer.android.com/tools/adb#connect-to-a-device-over-wi-fi)를 따른다.

`sh scripts/pair-phone.sh`를 PC 터미널에서 실행하면 주소 입력 → ADB 코드 입력 → 필요시
연결 포트 입력 순으로 진행한다. 페어링 코드를 명령 인자나 파일에 저장하지 않는다.

주소 입력란에 6자리 코드만 넣으면 주소 형식으로 다시 안내한다. 페어링은 성공 메시지까지
확인하며, 연결 완료는 `adb devices`의 실제 `device` 상태로 판단한다. 실패 진단은 Git 밖의
사용자 상태 폴더 `phone-test/last-pairing-result.json`에 기록하며 입력 코드와 대상 주소를 지운다.
`protocol fault`만으로 코드가 틀렸다고 단정하지 않는다. 이번 연결 시도에서는 ADB 데몬 로그에서
기기 주소 접속 시간 초과를 확인했고 PC와 입력된 휴대폰 주소의 사설 네트워크 대역이 달랐다.
PC와 휴대폰이 실제 통신할 수 있는 같은 공유기 네트워크인지 먼저 확인한다.
도구의 오류/잘못된 주소/페어링 성공 후 연결 실패 처리는
`python3 test/phone-pairing.test.py`로 검사한다 (`pexpect==4.9.0` 필요).
