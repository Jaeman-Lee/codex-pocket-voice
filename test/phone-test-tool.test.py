import hashlib
import importlib.util
import io
import unittest
import zipfile
from pathlib import Path

spec = importlib.util.spec_from_file_location("phone_test", Path(__file__).parents[1] / "scripts/phone-test.py")
tool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tool)


class PhoneTestTool(unittest.TestCase):
    def bundle(self, *, name="Codex-Pocket-Voice-v1.8.4-stable.apk", corrupt=False, extra=None):
        data = b"fixture APK bytes; not an installable APK"
        digest = hashlib.sha256(data).hexdigest()
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, "w") as target:
            target.writestr(name, data)
            target.writestr("SHA256SUMS", f"{'0' * 64 if corrupt else digest}  {name}\n")
            target.writestr("codex-pocket-sbom.json", '{"bomFormat":"CycloneDX"}')
            if extra:
                target.writestr(extra, b"unexpected")
        archive.seek(0)
        return archive

    def test_valid_bundle(self):
        payload, version, digest = tool.verify_bundle(self.bundle())
        self.assertEqual(version, "1.8.4")
        self.assertEqual(len(payload), 3)
        self.assertEqual(len(digest), 64)

    def test_reject_corrupt_unsigned_and_unsafe_bundles(self):
        for options in [dict(corrupt=True), dict(name="Codex-Pocket-Voice-v1.8.4-unsigned.apk"),
                        dict(extra="../escape.apk"), dict(extra="second.apk")]:
            with self.subTest(options=options), self.assertRaises(ValueError):
                tool.verify_bundle(self.bundle(**options))

    def test_run_must_match_source_workflow_repository_and_success(self):
        run = dict(event="workflow_dispatch", head_sha="a" * 40, head_repository={"full_name": tool.REPO},
                   path=".github/workflows/android-debug.yml", status="completed", conclusion="success")
        tool.validate_run(run, "a" * 40)
        for key, value in [("head_sha", "b" * 40), ("head_repository", {"full_name": "fork/repo"}),
                           ("path", ".github/workflows/ci.yml"), ("status", "in_progress"),
                           ("conclusion", "failure"), ("event", "pull_request")]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                tool.validate_run({**run, key: value}, "a" * 40)

    def test_evidence_never_claims_field_acceptance(self):
        body = tool.evidence(123, "a" * 40, "1.8.4", "b" * 64, 456)
        self.assertIn("미실시", body)
        self.assertIn("서명 인증서와 기존 설치본 일치 확인: **미확인**", body)
        self.assertNotIn("[x]", body)


if __name__ == "__main__":
    unittest.main()
