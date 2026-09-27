#!/usr/bin/env python3
"""Read the connected phone's Pocket version and compare APK certificate fingerprints.

Does not install, launch, stop, pair, or change the app. Certificate extraction is
not signature verification; the candidate must also pass CI apksigner + checksum.
Requires python3-cryptography, available in this Ubuntu test environment.
"""
import argparse
import hashlib
import json
import os
import re
import subprocess
import tempfile
from pathlib import Path
from zipfile import ZipFile

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.serialization.pkcs7 import load_der_pkcs7_certificates

PACKAGE = "io.github.jaemanlee.codexpocketvoice.stable"


def certificates(apk):
    result = set()
    with ZipFile(apk) as archive:
        for name in archive.namelist():
            if name.startswith("META-INF/") and name.endswith((".RSA", ".DSA", ".EC")):
                for cert in load_der_pkcs7_certificates(archive.read(name)):
                    result.add(cert.fingerprint(hashes.SHA256()).hex())
    if not result:
        raise ValueError("No v1 certificate found; use Android SDK apksigner for this APK.")
    return sorted(result)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidate", type=Path, required=True)
    parser.add_argument("--serial", help="ADB network target, or omit to require one USB device")
    parser.add_argument("--sha256", required=True, help="CI SHA256SUMS APK digest")
    parser.add_argument("--certificate", required=True, help="CI apksigner SHA-256 certificate digest")
    args = parser.parse_args()
    for value in (args.sha256, args.certificate):
        if not re.fullmatch(r"[a-f0-9]{64}", value):
            parser.error("Expected lowercase 64-character SHA-256 digests.")
    candidate = args.candidate.read_bytes()
    if hashlib.sha256(candidate).hexdigest() != args.sha256:
        raise ValueError("Candidate APK does not match the CI checksum.")
    candidate_certs = certificates(args.candidate)
    if candidate_certs != [args.certificate]:
        raise ValueError("Candidate certificate differs from the verified CI certificate.")
    data_home = Path(os.environ.get("XDG_DATA_HOME", str(Path.home() / ".local/share")))
    adb = data_home / "codex-pocket-voice/test-tools/platform-tools/adb"
    device_args = ["-s", args.serial] if args.serial else ["-d"]

    def shell(*command):
        run = subprocess.run([str(adb), *device_args, "shell", *command],
                             capture_output=True, text=True, timeout=15)
        if run.returncode:
            raise ValueError("ADB device unavailable or unauthorized; check the connection and phone approval.")
        return run.stdout.strip()

    package_info = shell("dumpsys", "package", PACKAGE)
    version = re.search(r"^\s*versionName=(\S+)", package_info, re.M)
    code = re.search(r"^\s*versionCode=(\d+)", package_info, re.M)
    if not version or not code:
        raise ValueError("The expected stable Pocket package is not installed.")
    apk_paths = shell("pm", "path", PACKAGE).splitlines()
    bases = [line.removeprefix("package:") for line in apk_paths
             if line.startswith("package:") and line.endswith("/base.apk")]
    if len(bases) != 1:
        raise ValueError("Could not identify exactly one installed base APK.")
    with tempfile.TemporaryDirectory(prefix="pocket-installed-apk-") as temp:
        installed = Path(temp) / "base.apk"
        pulled = subprocess.run([str(adb), *device_args, "pull", bases[0], str(installed)],
                                capture_output=True, timeout=60)
        if pulled.returncode:
            raise ValueError("Unable to read installed APK; phone app data was not changed.")
        installed_certs = certificates(installed)
        installed_sha = hashlib.sha256(installed.read_bytes()).hexdigest()
    report = {
        "package": PACKAGE,
        "installedVersion": version[1],
        "installedVersionCode": int(code[1]),
        "androidVersion": shell("getprop", "ro.build.version.release"),
        "installedApkSha256": installed_sha,
        "candidateApkSha256": args.sha256,
        "candidateCertificateSha256": candidate_certs,
        "installedCertificateSha256": installed_certs,
        "certificateMatch": installed_certs == candidate_certs,
        "candidateSignatureEvidence": "CI apksigner digest supplied by operator; not reverified locally",
        "phoneChanged": False,
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if not report["certificateMatch"]:
        raise SystemExit(2)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.TimeoutExpired) as exc:
        raise SystemExit(str(exc))
