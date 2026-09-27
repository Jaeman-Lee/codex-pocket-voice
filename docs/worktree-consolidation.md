---
title: 기본 프로젝트 폴더로 worktree 통합
date: 2026-09-27
tags: [git, operations, verification]
---

# 기본 폴더 통합

- 사용자 결정: worktree 변경을 기본 github 폴더로 모으고 별도 checkout을 정리한다.
- 작업 상태: https://github.com/Jaeman-Lee/codex-pocket-voice/issues/15
- 작업 브랜치: `chore/consolidate-worktrees-20260927`.
- 시작 HEAD: `1e7152946da40f5fb75f20e7dd6024ec9d5a3a6c`; 시작 브랜치: `setup/ubuntu-pocket-20260925`.
- 실행 위치: pc / Linux. 지정 Obsidian Vault 연결 미설정. 이 Markdown이 결과 원본이다.

## 반영

아래 HEAD를 기본 폴더의 통합 작업 브랜치에 병합했다. 모든 HEAD의 조상 관계와 원래 브랜치 보존을 확인한 뒤
`git worktree remove`로 별도 checkout만 제거했다. main/master 직접 병합이나 원격 force push는 수행하지 않았다.

| 제거한 checkout | 보존·통합한 HEAD |
|---|---|
| `codex-pocket-android-testing` | `86bd3ed0f1ef92bac52f9eb2b30ea2b7c0619d29` |
| `codex-pocket-ux` | `746ae6f960fdcb1abb56cc3a56cb9096c7d74117` |

## 검증

격리 TypeScript check, server/client build, 단위/API/launcher 테스트 22개 통과. 이전 launcher 테스트는 보존한 legacy launcher를 대상으로 한다. 두 기존 preview의 390px 화면 및 브라우저 오류 없음 확인. 새 모델 턴이나 APK 빌드는 실행하지 않았다.

Git에서 제외된 생성 파일은 HDD의 `~/.local/state/worktree-consolidation-20260927/preserved-artifacts/`에 복사하고 SHA256을 확인했다.
재생성 가능한 node_modules를 제외한 파일과 기존 사용자 변경을 보존했다. 개인 원문·환경 값·스크린샷·실행 로그는 Git에 넣지 않았다.

## 충돌 해결 및 실행 버전

현재 React/Android 소스를 기본으로 유지하고, 기존 UX UI를 `legacy/web/`에 보존했다.
프로젝트별 thread/list cwd 필터와 인증된 회귀 검사를 결합했다. 자동 재연결 launcher와 systemd 시작 지원을 함께 보존하며 이전 launcher도 별도 파일에 남겼다.
기존 배포 버전은 HDD의 `~/.local/share/codex-pocket-voice/runtime/`에서 실행한다. 이 디렉터리는 실행 산출물이며 Git checkout/worktree가 아니다.
[로컬 unit 원본](../infra/local/)은 기본 소스 폴더와 기존 runtime을 참조한다. transient unit에는 drop-in이 우선 적용된다.
기본 폴더의 기존 primary gateway는 계속 실행하며, 그 정적 파일 연결은 로컬 Git 제외 web symlink로 유지한다.
phone-test launcher는 `CODEX_POCKET_RUNTIME`을 지원하고 인증/인계 상태 파일 위치는 유지한다.
배포 분류: 내부 경로 호환 정리(patch 성격). 사용자에게 배포하는 APK나 정식 릴리스 변경은 없고 SemVer/versionCode를 올리거나 새 APK를 전달하지 않았다.


## 검토 링크

- Draft PR: https://github.com/Jaeman-Lee/codex-pocket-voice/pull/16
- 기록 커밋: https://github.com/Jaeman-Lee/codex-pocket-voice/commit/08113845353e5775e4bfb9335b5bd08aa22b57ab
