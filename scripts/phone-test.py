#!/usr/bin/env python3
"""Stage one exact CI APK and a field-test issue draft; never install or publish."""
import argparse
import hashlib
import json
import re
import subprocess
import tempfile
import zipfile
from pathlib import Path

REPO = "Jaeman-Lee/codex-pocket-voice"
APK = re.compile(r"Codex-Pocket-Voice-v(\d+\.\d+\.\d+)-stable\.apk")
MAX_SIZE = 512 * 1024 * 1024


def api(path):
    return json.loads(subprocess.check_output(["gh", "api", path], text=True))


def validate_run(run, sha):
    if run.get("event") != "workflow_dispatch":
        raise ValueError("검토한 브랜치의 수동 후보 빌드를 선택하세요. PR 병합 미리보기 빌드는 제외합니다.")
    if run.get("head_sha") != sha:
        raise ValueError("선택한 빌드의 SHA가 요청한 소스 SHA와 다릅니다.")
    if run.get("head_repository", {}).get("full_name") != REPO:
        raise ValueError("이 저장소에서 만든 후보만 받습니다. Fork 빌드는 제외합니다.")
    if run.get("path", "").split("@", 1)[0] != ".github/workflows/android-debug.yml":
        raise ValueError("Android APK 빌드가 아닙니다.")
    if run.get("status") != "completed" or run.get("conclusion") != "success":
        raise ValueError("Android 빌드가 성공으로 완료되지 않았습니다.")


def verify_bundle(archive):
    with zipfile.ZipFile(archive) as bundle:
        entries = bundle.infolist()
        names = [item.filename for item in entries]
        if len(names) != len(set(names)) or sum(i.file_size for i in entries) > MAX_SIZE:
            raise ValueError("중복 파일 또는 과도한 크기의 artifact입니다.")
        apks = [name for name in names if APK.fullmatch(name)]
        if len(apks) != 1 or set(names) != {apks[0], "SHA256SUMS", "codex-pocket-sbom.json"}:
            raise ValueError("서명 후보 APK 하나, SHA256SUMS, SBOM만 들어 있는 묶음이 필요합니다.")
        payload = {name: bundle.read(name) for name in names}
    apk = apks[0]
    expected = payload["SHA256SUMS"].decode("utf-8").strip()
    checksum = re.fullmatch(r"([a-fA-F0-9]{64}) [ *]([^\r\n]+)", expected)
    digest = hashlib.sha256(payload[apk]).hexdigest()
    if not checksum or checksum[2] != apk or checksum[1].lower() != digest:
        raise ValueError("APK 체크섬이 일치하지 않습니다.")
    sbom = json.loads(payload["codex-pocket-sbom.json"])
    if not isinstance(sbom, dict) or sbom.get("bomFormat") != "CycloneDX":
        raise ValueError("CycloneDX SBOM이 아닙니다.")
    return payload, APK.fullmatch(apk)[1], digest


def evidence(run_id, sha, version, digest, artifact_id):
    return f"""## Android 현장 테스트 — 미실시

- 후보 앱: {version}
- 전체 소스 SHA: `{sha}`
- Android 빌드: https://github.com/{REPO}/actions/runs/{run_id}
- Artifact ID: `{artifact_id}`
- APK SHA-256: `{digest}` (PC 다운로드 후 대조 완료)
- 관련 변경 PR: **작성 필요**
- 기존 설치 앱 버전: **작성 필요**
- 테스트 Companion 버전/커밋: **작성 필요**
- Android OS 버전: **작성 필요** (기기 고유 ID는 기록하지 않음)
- Node 20/22 자동 검사 링크: **작성 필요**
- APK 서명 인증서와 기존 설치본 일치 확인: **미확인**

체크섬 확인은 다운로드 무결성 검사이며, 서명 호환성·실기기 합격·배포 승인이 아닙니다.

## 스마트폰에서 확인

- [ ] 기존 앱 위에 업데이트되고 설정·페어링이 유지된다.
- [ ] 앱을 종료했다 다시 열어도 Companion 연결이 유지된다.
- [ ] 한국어 한 문장을 짧게 음성 입력하면 한 번만 표시된다.
- [ ] 길게 눌러 연속 입력하고 멈춘 후 다시 입력해도 중복 누적되지 않는다.
- [ ] 의도적으로 두 번 말한 문장이 임의로 삭제되지 않는다.
- [ ] 전송 한 번에 요청 하나만 생성되고 답변을 받을 수 있다.
- [ ] 화면을 껐다 켜거나 네트워크를 끊었다 복구해도 대화가 복원된다.
- [ ] 작은 화면과 키보드 표시 상태에서 입력·스크롤이 가능하다.
- [ ] 세션 반납·재접속 중 PC의 작업이 유지된다.
- [ ] 사진·영상 첨부 성공 또는 실패 안내를 확인했다.

## 결과

판정: **미실시 / 실패 / 통과** 중 실제 결과로 수정
재현 순서·기대 결과·실제 결과:
연결할 버그 이슈:
직전 검증 APK 버전·체크섬 및 보관 확인:

개인 대화, 토큰, 페어링 코드, 기기 ID, 내부 주소는 첨부하지 마세요.
미체크 항목과 실패가 있으면 Accepted로 처리하지 않습니다. 통과해도 운영 전환은 별도 승인입니다.
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", required=True, type=int, help="Android Actions run ID")
    parser.add_argument("--sha", required=True, help="검토할 전체 40자리 source SHA")
    parser.add_argument("--output", required=True, type=Path, help="Git 밖의 새 후보 디렉터리")
    args = parser.parse_args()
    if args.run <= 0 or not re.fullmatch(r"[a-f0-9]{40}", args.sha):
        parser.error("양수 run ID와 소문자 전체 40자리 SHA가 필요합니다.")
    output = args.output.expanduser().resolve()
    if output.exists():
        parser.error("기존 후보를 덮어쓰지 않습니다. 새 출력 디렉터리를 지정하세요.")
    # Walk up when the requested parent has not been created yet.
    ancestor = output.parent
    while not ancestor.exists():
        ancestor = ancestor.parent
    inside_git = subprocess.run(["git", "-C", str(ancestor), "rev-parse", "--is-inside-work-tree"],
                                capture_output=True, text=True)
    if inside_git.returncode == 0 and inside_git.stdout.strip() == "true":
        parser.error("APK와 현장 기록은 Git 작업공간 밖에 저장하세요.")
    run = api(f"repos/{REPO}/actions/runs/{args.run}")
    validate_run(run, args.sha)
    artifacts = api(f"repos/{REPO}/actions/runs/{args.run}/artifacts?per_page=100")
    candidates = [a for a in artifacts["artifacts"]
                  if re.fullmatch(r"Codex-Pocket-Voice-v\d+\.\d+\.\d+", a["name"])]
    if len(candidates) != 1 or candidates[0]["expired"]:
        raise ValueError("유효한 후보 artifact가 하나 있어야 합니다. 만료된 파일은 받을 수 없습니다.")
    artifact = candidates[0]
    if artifact["size_in_bytes"] > MAX_SIZE:
        raise ValueError("artifact 크기가 제한을 넘습니다.")
    with tempfile.TemporaryDirectory(prefix="pocket-phone-test-") as temp:
        archive = Path(temp) / "candidate.zip"
        with archive.open("wb") as target:
            subprocess.run(["gh", "api", f"repos/{REPO}/actions/artifacts/{artifact['id']}/zip"],
                           stdout=target, check=True)
        payload, version, digest = verify_bundle(archive)
        if artifact["name"] != f"Codex-Pocket-Voice-v{version}":
            raise ValueError("artifact 이름과 APK 버전이 다릅니다.")
        output.mkdir(parents=True, exist_ok=False)
        for name, data in payload.items():
            (output / name).write_bytes(data)
        (output / "field-test.md").write_text(
            evidence(args.run, args.sha, version, digest, artifact["id"]), encoding="utf-8")
    print(f"체크섬 확인 완료: v{version}\n후보와 이슈 초안: {output}")
    print("설치·서명 호환성·실기기 검증·운영 전환은 수행하지 않았습니다.")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, OSError, subprocess.CalledProcessError, zipfile.BadZipFile) as exc:
        raise SystemExit(f"후보 준비 실패: {exc}")
