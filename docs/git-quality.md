---
title: Git 품질 검사
date: 2026-09-25
---

# Git 품질 검사

Vault 연결 미설정. 이 문서를 Obsidian 프로젝트 노트에서 연결한다.

PR에서 새 커밋의 비밀정보/whitespace 검사와 프로젝트 검사를 실행한다.
과거 전체 이력 감사는 별도이며 PR 통과가 기존 키의 안전을 보증하지 않는다.
공통 workflow는 공개 dotfiles의 검증 가능한 full SHA로 고정한다.
모델 호출·배포·기본 브랜치 병합은 이 검사 범위에 포함하지 않는다.

- [작업 이슈](https://github.com/Jaeman-Lee/codex-pocket-voice/issues/13)
- [공통 기준](https://github.com/Jaeman-Lee/dotfiles/blob/d8e2db63c3acd8507e3f330d983a2f219d4f5855/docs/git-quality.md)

실행 결과는 이 PR의 GitHub Actions 검사에서 확인한다. 기본 브랜치 적용은 검토 후 병합해야 완료된다.
