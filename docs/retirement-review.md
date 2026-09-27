---
title: Codex Pocket Voice 폐기 검토
date: 2026-09-27
vault: 미설정
---

# Codex Pocket Voice 폐기 검토

요구사항·진행 상태는 [이슈 #17](https://github.com/Jaeman-Lee/codex-pocket-voice/issues/17)을 기준으로 한다.
이 문서는 검토 근거와 제안을 보존하는 원본이며, 프로젝트 Obsidian Vault는 미설정이다.

## 검토 의견

**현재 사용 목적에는 원격 웹 데스크톱을 우선 사용하고, Pocket의 신규 기능 확장은 보류한 뒤 보관형 종료를 검토하는 것을 권고한다.**
사용자는 스마트폰에서 Ubuntu의 현재 Codex 화면에 직접 입력·전송하고 입력칸이 자동으로 비워지는 것까지 확인했다.
따라서 이 목적을 위해 별도 APK·Companion·앱 서버·세션 인계 흐름을 계속 유지할 필요성은 낮아졌다.
다만 앱 삭제나 서비스 중지, 저장소 archive는 아직 결정·실행하지 않았다.

검토 대상은 `codex-pocket-voice`다. `codex-android-control` 등 다른 프로젝트의 폐기 여부를 함께 결정하지 않는다.

## 확인한 사실

- 원격 웹 데스크톱의 스마트폰 입력·전송·자동 비우기는 사용자 실사용으로 확인했다.
  [대체 기능 이슈](https://github.com/Jaeman-Lee/dotfiles/issues/14),
  [변경 PR](https://github.com/Jaeman-Lee/dotfiles/pull/19),
  [자동 비우기 커밋](https://github.com/Jaeman-Lee/dotfiles/commit/13b8f2d).
- Pocket의 [README](../README.md), [로드맵](roadmap.md), [v2 계획](v2-plan.md),
  [기기 조율 문서](device-coordination.md)를 검토했다. 문서에 있는 기능 설명과 출시 계획을 실기기 검증 완료로 간주하지 않는다.
- [이슈 #10](https://github.com/Jaeman-Lee/codex-pocket-voice/issues/10)과
  [실기기 이슈 #12](https://github.com/Jaeman-Lee/codex-pocket-voice/issues/12)의 최근 기록은
  설치본 1.8.2, 후보 1.8.4의 현장 검증 미실시를 구분한다. 이번 검토는 그 판정을 바꾸지 않는다.
- 검토 시점에 `codex-pocket.service`는 `active/running`이었다. 실제 작업·세션·대기열이 비어 있다고 확인한 것은 아니다.

## 기능 비교

| 목적 | 원격 웹 데스크톱에서 확인한 범위 | Pocket에 남는 가치 또는 차이 |
| --- | --- | --- |
| 현재 PC의 Codex 입력과 응답 확인 | 동일 PC 화면에서 스마트폰 실사용 확인 | 기본 목적이 중복됨 |
| 현재 세션을 PC와 휴대폰에서 이어 사용 | 동일 화면을 조작하므로 이 흐름에는 앱 서버 세션 인계가 필요하지 않음 | 다른 PC·별도 앱 서버 세션의 인계는 다른 요구사항 |
| 프로젝트·파일·터미널 조작 | PC의 기존 프로그램을 원격 조작 | Pocket은 전용 프로젝트·대화 선택 UI를 제공하도록 설계됨 |
| 음성 입력과 읽어주기 | 휴대폰 키보드 음성 입력까지 이번에 검증한 것은 아님 | 앱 전용 받아쓰기·연속 음성·TTS 요구가 남는지 확인 필요 |
| 오프라인 열람과 대기열 | PC와 연결되어 있어야 실시간 조작 가능 | Pocket의 로컬 저널·오프라인 대기열과 동등하지 않음 |
| 이미지·영상 처리 | 기존 PC 앱을 조작할 수 있으나 전용 업로드 흐름은 동등 검증하지 않음 | Pocket의 미디어 첨부·로컬 영상 분석 경로 |
| 작은 화면과 여러 기기 | 스마트폰 입력 성공 확인; iPad 전체 사용성은 별도 확인 | 전용 모바일 UI와 여러 Companion 선택의 필요성 검토 |

원격 데스크톱이 모든 Pocket 기능을 대체했다고 판단하지 않는다. 위 고유 기능을 실제로 계속 사용할 필요가 없다면
앱 전체를 유지할 이유가 줄어든다는 판단이다. 잠금·로그아웃·재부팅 이후 원격 접속의 제약은
[원격 데스크톱 운영 문서](https://github.com/Jaeman-Lee/dotfiles/blob/chore/consolidate-worktrees-20260927/docs/ubuntu-web-desktop.md)를 따른다.

## 유지 비용과 종료 조건

Pocket은 Android 서명·APK 전달·Termux 터널·기기 페어링·Companion·Codex app-server 버전 호환성과
세션 writer 인계를 관리한다. 기존 이슈에는 CLI 바인딩 호환성과 후보 APK 현장 검증이 남아 있다.
v2의 Provider·승인·비용 관리 계획은 별도 가치가 있을 수 있지만 현재 원격 조작 요구보다 범위가 크다.
자원 절감량은 측정하지 않았으므로 종료하면 확보되는 메모리·CPU 수치를 추정하지 않는다.

최종 종료 판단에 필요한 항목은 다음과 같다. 실행 상태와 체크 여부는 이슈 #17에서 관리한다.

1. 전용 음성/TTS, 오프라인 저널·대기열, 미디어 흐름을 계속 사용할 필요가 있는지 결정한다.
2. 휴대폰의 필요한 기록과 첨부, 미전송 대기열, 진행 중인 Companion/Codex 작업의 보존 범위를 확인한다.
3. 종료 범위를 정한다: 신규 개발 중단, 서비스 자동 시작 해제, 앱 제거, 저장소 archive는 각각 구분한다.
4. 종료 시 소스·커밋·정식 Release와 필요한 복구 자료를 보존한다. 비밀값과 개인 기록은 Git에 올리지 않는다.
5. 활성 작업을 끝낸 뒤 Pocket 전용 서비스와 터널만 정리한다. 공유 Tailscale·SSH·Codex 환경은 의존성을 확인한다.

권고안은 **소스와 이력을 보존한 종료**다. 종료 후 필요성이 다시 생기면 전체 로드맵을 재개하기 전에
음성 또는 오프라인 기능만 분리해 유지할 수 있는지 먼저 검토한다.

## 이번 작업의 변경 범위와 검증

이 작업은 검토 문서와 문서 링크만 바꾼다. 배포 가능한 변경이 아니므로 SemVer/versionCode를 올리지 않고,
현재/rollback APK와 실행 중인 Companion을 교체하지 않는다. 로컬 문서 링크와 Git diff를 확인한다.
APK 빌드, 모델 실행, 기기 설치, 서비스 중지, 데이터 삭제, 기존 이슈 일괄 종료는 수행하지 않는다.
