# Changelog

이 문서는 사용자가 설치할 수 있는 배포판과 개발 중 CI 산출물을 구분한다.

## 1.8.0 candidate — validation

GitHub Release나 Git tag로 확정하지 않은 현재 시험 기준선이다.

- 현재 기기의 Codex thread를 삭제하지 않고 다른 기기에 반납하는 UX를 추가했다.
- 실행 중인 PC 작업은 반납 후에도 계속되며, 다른 페어링 기기가 같은 run과 thread에 다시 붙는다.
- Companion이 최근 인계 위치를 권한 `0600` 메타데이터로 7일간 보존한다. 프롬프트 본문과 인증정보는 기록하지 않는다.
- 이 기기에만 남은 프롬프트 대기열이 있으면 반납을 차단해 요청 유실을 막는다.
- 앱 재연결 시 선택 중인 thread의 활성 run을 찾아 실시간 상태를 복원한다.
- Codex app-server 생성 바인딩을 `codex-cli 0.148.1` 기준으로 갱신했다.

## 1.7.4 candidate — superseded field baseline

GitHub Release나 Git tag로 확정하지 않은 이전 시험 기준선이다.

- Android를 음성·화면·암호화 연결에 집중한 저부하 Linux 클라이언트로 정리했다.
- 여러 Linux Companion 등록, 일회용 코드 페어링, Android Keystore 토큰 보호를 추가했다.
- 대화와 프롬프트 대기열을 AES-GCM으로 암호화하고 오프라인 복구를 강화했다.
- Codex provider, 모델, 추론 성능, 프로젝트 생성과 실행 중 프롬프트 예약을 모듈화했다.
- ffmpeg와 로컬 Qwen3-VL 4B 영상 분석의 재시작 복구·보존 정책을 추가했다.
- Linux 설치 진단, Node 20/22 CI, Android 서명·체크섬·SBOM 산출물을 추가했다.
- 프로젝트 생성 실패를 대화상자 안에 표시하고 구형 Git에서도 `main` 브랜치를 만든다.
- AI 연결 센터가 작은 Android 화면 안에서 내부 스크롤되도록 수정했다.

Candidate build history:

| Version | Commit | Status | Purpose |
| --- | --- | --- | --- |
| 1.7.0 | `5b6a9a7` | CI only | Linux P0–P2 일반화 기준선 |
| 1.7.1 | `d4de07a` | CI only | Android 저부하 클라이언트 고정 |
| 1.7.2 | `2a3348c` | superseded field build | 프로젝트 생성 오류 표시 |
| 1.7.3 | `c6b0440` | CI only | 연결 센터 모바일 레이아웃 수정 |
| 1.7.4 | `91f27b4` | superseded field build | 구형 Git 프로젝트 생성 호환 |
| 1.8.0 | `5c4d0bb` | current candidate | 교차 기기 세션 인계와 순차 배포 호환 |

## 1.6.0 — 2026-08-16

- 단말·프로젝트·대화별 오프라인 작업 저널과 프롬프트 대기열을 처음 배포했다.
- Git tag와 GitHub Release: `v1.6.0`.

## 1.5.0 — 2026-08-16

- Codex·Claude Code 설치, 로그인 상태와 무료 연결 테스트를 한 화면에 모은 AI 연결 센터를 처음 배포했다.
- Git tag와 GitHub Release: `v1.5.0`.

## Early Android builds — 2026-08-11 to 2026-08-16

- React/Capacitor 앱, 연속 음성 입력, 미디어 첨부, 고정 Android 서명, 단말·모델 선택과 프롬프트 대기열을 순차 개발했다.
- `v1.1`–`v1.4` 이름의 APK는 Actions 시험 산출물이었으며 Git tag나 GitHub Release가 아니다.
- 당시 `package.json`은 계속 `0.1.0`이었으므로 APK 표시 이름을 정식 소프트웨어 버전으로 해석하지 않는다.
