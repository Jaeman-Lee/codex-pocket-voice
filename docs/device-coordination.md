# PC와 스마트폰의 GitHub 작업 조율

2026-09-25 사용자 결정: GitHub를 두 기기 Codex의 작업 인계 기준으로 사용한다.
USB/무선 ADB가 연결되지 않아도 요구사항 공유, 소스 검토, APK 전달과 테스트 결과 기록을 계속한다.

Obsidian Vault 연결: **미설정**. 이 Markdown을 저장소의 문서 원본으로 유지하며,
Vault가 지정되면 프로젝트 노트에서 이 원본에 표준 링크를 건다.

## 바로 확인할 곳

| 기준 | 위치 |
| --- | --- |
| 요구사항·담당·다음 작업 | [이슈 #10](https://github.com/Jaeman-Lee/codex-pocket-voice/issues/10) |
| 스마트폰 테스트·장애·재현 결과 | [이슈 #12](https://github.com/Jaeman-Lee/codex-pocket-voice/issues/12) |
| 개발 변경·검사·리뷰 | [Draft PR #11](https://github.com/Jaeman-Lee/codex-pocket-voice/pull/11) |
| APK 후보·전체 SHA·체크섬·빌드 링크 | [이슈 #12의 후보 식별](https://github.com/Jaeman-Lee/codex-pocket-voice/issues/12) |
| 설치·테스트 방법 | [스마트폰 테스트](smartphone-testing.md) |

현재 상태는 위 이슈의 최신 담당/상태 댓글을 기준으로 읽는다. 문서나 이전 실행 로그의 성공을
현재 실기기 통과 상태로 복사하지 않는다. 채팅을 다른 기기에 매번 옮겨 적는 대신 이슈 링크를 전달한다.

## 역할과 충돌 방지

- **PC Codex**: 저장소의 소스 작성 담당. 요구사항 확인 → 작업 브랜치 수정 → 검증 → 커밋/push → Draft PR 갱신.
- **스마트폰 Codex**: 경량 Git 사본 또는 GitHub 웹에서 인계 내용을 읽고, 설치본 확인·APK 전달/설치 준비·UI/음성/네트워크 실기기 결과를 #12에 기록.
- 같은 저장소의 소스 작성자는 한 번에 하나다. 휴대폰에서 발견한 수정 요구는 이슈로 전달하고 PC가 구현한다.
  담당을 바꿀 때는 이슈에 인계할 커밋과 남은 변경을 먼저 기록한다.
- 휴대폰에는 빌드 캐시, 서버 실행 환경, Gradle 의존성을 새로 복제하지 않는다.
- GitHub 댓글을 임의 셸 명령으로 자동 실행하지 않는다. 요구사항을 읽고 해당 기기의 권한과 사용자 지시 범위에서 수행한다.

## 스마트폰에서 인계 읽기

GitHub 브라우저로 #10과 #12를 열어도 된다. 기존 Git 사본이 있으면 작업 내용을 덮어쓰지 않고 읽는다.

```sh
git fetch origin
git show origin/chore/android-field-testing-20260925:docs/device-coordination.md
```

로그인된 GitHub CLI가 있으면 최신 진행 기록도 확인한다.

```sh
gh issue view 10 --repo Jaeman-Lee/codex-pocket-voice --comments
gh issue view 12 --repo Jaeman-Lee/codex-pocket-voice --comments
gh pr view 11 --repo Jaeman-Lee/codex-pocket-voice
```

`main`에는 아직 이 작업이 병합되지 않았다. 현재 PR의 작업 브랜치를 확인하며, 기존 로컬 변경이
있는 사본을 강제 reset하거나 덮어쓰지 않는다. 다른 브랜치로 작업 범위가 바뀌면 이슈에서 먼저 인계한다.

## 결과 보고

실기기 결과는 #12에 다음 형식으로 댓글을 남긴다. 다른 기기의 본문이나 체크리스트를
통째로 덮어쓰지 않고, PC 담당이 최신 결과를 읽어 전체 진행 상태에 반영한다.

```text
담당: 스마트폰 Codex
확인한 기준: 관련 PR / 전체 커밋 SHA / APK 버전·SHA-256
수행한 작업:
확인된 결과:
미확인·실패한 항목:
다음 작업 담당: PC Codex 또는 스마트폰 Codex
운영 변경 여부: 없음 / 실제 수행한 변경
```

PC도 구현 결과와 다음 확인 요청을 같은 방식으로 남긴다. 토큰·페어링 코드·실제 IP/포트·기기 ID·
개인 대화·전체 로그는 공개 이슈나 Git에 넣지 않는다. 네트워크 진단은 결과와 오류 종류만 요약한다.

## 후보 전달과 배포

PC push → GitHub Actions 빌드 → 정확한 run의 APK/체크섬 → 스마트폰 검증 → #12 결과 → PR 검토 순서다.
GitHub가 APK 전달과 기록을 맡으며, 설치·음성 입력 등 실제 기기 작업은 스마트폰에서 수행한다.
파일 다운로드, 설치 완료, 자동 검사 성공, 실기기 통과, 운영 배포 승인은 각각 구분한다.

기존 설치본의 패키지/서명·버전 호환성을 확인하고 현재 앱과 검증된 복구본을 보존한다.
필요한 네트워크 값과 인증은 기기에만 둔다. GitHub에 연결했다고 앱의 Companion 연결도 복구된 것으로
판정하지 않는다. 실제 연결이 필요한 검증이 막히면 해당 항목을 미실시로 남기고 독립적으로 가능한 검증을 진행한다.
main 병합·정식 릴리스·운영 전환은 사용자 승인과 [배포 규칙](release-process.md)을 따른다.
