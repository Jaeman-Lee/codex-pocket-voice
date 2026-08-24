# v2 릴리스 evidence 최종 판정

이 절차는 한 v2 후보의 기능 현장 관찰과 direct LAN·실제 P2P·outbound relay 저부하 측정을 하나의
실패-폐쇄 판정으로 묶는다. 서로 다른 `2.0.0` APK, 오래된 결과, transport 이름을 바꾼 report 또는
측정 aggregate와 맞지 않는 pass 판정을 섞어 릴리스하는 것을 막는다.

이 도구는 field evidence를 평가하기 전에 `verify-update-manifest.mjs`를 실패-폐쇄 선행 gate로 실행해
고정 인증서 fingerprint, manifest 분리 서명, APK signer와 APK/SBOM 실제 hash·byte count를 검증한다.
검증기는 성공한 exact manifest bytes의 SHA-256을 strict JSON receipt로 넘기며, 최종 gate가 field 입력과
함께 다시 읽은 manifest digest와 같을 때만 평가를 시작한다. verifier 종료와 field 평가 사이에 같은
경로의 manifest가 교체되면 최종 report를 만들지 않는다.
Git commit과 dirty 상태도 한 porcelain-v2 snapshot으로 입력 평가 전·후에 확인한다. 두 시점 모두 signed
candidate의 exact commit이고 clean일 때만 최종 report를 만든다.
고정 fingerprint는 함께 받은 인증서에서 계산하면 안 되며 이전 신뢰 설치본·Release APK 또는 별도
신뢰 경로에서 확인해야 한다. 최종 report의 `structured_aggregate_only`는 암호 검증과 운영자 관찰을
구조화한 증거이며 실제 Provider·물리 단말 실행을 대신하지 않는다.

모든 입력 파일은 `O_NOFOLLOW`로 한 번만 열고 같은 file descriptor에서 regular/single-link, 필요 시
owner-only mode, 시작·종료 metadata와 byte 상한을 확인한다. symlink·hardlink, 읽는 중 교체·변경과
상한 초과는 원본 경로나 내용을 출력하지 않고 실패한다. APK는 hash·byte count를 계산한 바로 그 열린
descriptor를 Linux 자식 `apksigner`에도 전달하므로, 두 검사 사이 artifact 경로를 교체해 signer가 다른
APK를 보게 만들 수 없다.

## 입력 조건

- symlink/hardlink가 아닌 canonical signed `update-manifest.json`, detached signature, 인증서, APK와 SBOM이
  있는 artifact directory
- 별도 신뢰 경로에서 확인한 signing certificate SHA-256 fingerprint와 신뢰할 수 있는 `apksigner`
- manifest와 정확히 같은 clean Git commit
- 같은 manifest/commit/APK digest에 묶인 20개
  [기능 현장 관찰](functional-field-acceptance.md)
- 각각 `direct_lan`, `p2p`, `outbound_relay`로 기록되고 설치 APK digest를 시작·종료에 확인한 schema 3
  [Android 저부하 report](android-field-acceptance.md) 세 개
- 기능 관찰과 Android report는 owner-only regular single-link 파일이며 30일 이내 결과

Android report는 parser가 exact allowlist schema로 다시 읽는다. 설치 package/versionCode, candidate의
manifest/commit/APK/signer digest, transport, 측정 시각을 재검증하고 CPU/PSS·배터리·background wake
aggregate에서 고정 release threshold를 다시 계산한다. report에 field를 추가하거나 pass 판정만 편집하거나
wall clock과 monotonic 측정 시간이 10분 넘게 어긋나면 최종 report를 만들지 않는다.

## 실행

저장소 밖의 private directory에 입력과 아직 존재하지 않는 출력 경로를 준비한다.

```sh
npm run android:release-evidence -- \
  --manifest /private/update-bundle/update-manifest.json \
  --signature /private/update-bundle/update-manifest.sig \
  --certificate /trusted/update-manifest-cert.pem \
  --expected-certificate-sha256 "$EXPECTED_CERT_SHA256" \
  --artifact-dir /private/update-bundle \
  --apksigner /trusted/android-sdk/build-tools/36.0.0/apksigner \
  --observations /private/field/functional-observations.json \
  --direct-lan-report /private/field/direct-lan.json \
  --p2p-report /private/field/p2p.json \
  --relay-report /private/field/outbound-relay.json \
  --report /private/field/release-evidence.json
```

다음 조건이 전부 참일 때만 exit code 0과 `gate.passed: true`를 반환한다.

- pinned certificate·detached signature·APK signer·APK/SBOM hash와 byte count가 모두 유효하고, APK
  hash와 signer가 같은 열린 descriptor의 bytes에 귀속되며 verifier receipt의 manifest digest와 field
  평가에 사용한 exact bytes가 일치
- 기능 환경·여섯 attestation·20개 scenario와 30일 freshness가 모두 pass
- 세 Android report가 정확한 transport slot에 있고 모두 `release_gate` pass
- 세 report가 같은 signed candidate이고 설치 package/version/versionCode도 일치
- 세 report가 30일 이내이며 미래 시각이 아님

암호 검증을 통과한 뒤 실패 가능한 구조의 field 입력이 완전하고 안전하면 create-once mode `0600` 최종
report를 남기고 exit code 1을 반환한다. 서명·artifact 검증 실패, schema 변조, candidate drift, report
위치 교환처럼 입력 자체를 신뢰할 수 없으면 출력 없이 실패한다. 최종 report에는 candidate digest,
각 gate의 시각·기간·판정만 남으며 device/network 값,
credential, 원본 ADB 진단, prompt/response는 포함하지 않는다. 이 명령은 ADB 조회, 설치, 앱 시작·종료,
네트워크 전환, Provider 호출 또는 Companion 재시작을 수행하지 않는다.
