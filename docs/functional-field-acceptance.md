# v2 기능 현장 검증

이 절차는 v2 출시 후보의 실제 Android·Linux Companion·Provider 동작을 하나의 signed APK 후보에 묶어
검토한다. 도구는 단말이나 Companion을 설치·시작·중지·페어링·해제하지 않는다. 운영자가 직접 수행한
결과를 고정 schema로 판정할 뿐이며, 모든 항목이 통과하지 않으면 release gate는 실패한다.

결과는 `operator_attested_structured` 증거다. signed bundle 암호 검증,
[Android 저부하 현장 검증](android-field-acceptance.md), 외부 edge 부하 검증을 대신하지 않는다. 보호된
실제 Provider grade는 schema 4 observation이 exact report SHA-256만 고정하고, 최종 release evidence
단계에서 owner-only 원문 세 건을 다시 검증한다.

## 사전 조건

1. 검증할 APK·SBOM·manifest·서명·인증서를 한 private 작업 디렉터리에 둔다.
2. [Release process](release-process.md)의 `verify-update-manifest.mjs` 절차로 signature, pinned certificate,
   APK signer, artifact hash와 versionCode를 먼저 검증한다.
3. manifest의 `commit`을 checkout하고 Git worktree가 clean인지 확인한다.
4. v1.8.1 APK와 대응 무결성 파일을 rollback 위치에 별도로 보존한다. APK의 package/version,
   SHA-256·byte count와 signer를 먼저 확인하고 observation에 기록한다. final gate가 같은 실제 파일을 다시
   열어 이 identity를 독립적으로 대조한다.
5. 보호된 workflow에서 OpenAI coding grade 한 건과 서로 다른 OpenRouter upstream family의 coding grade
   두 건을 발급받고 검토한다. 세 report 모두 field 시작 시점 기준 30일 이내여야 한다.
6. observation/report와 grade report는 저장소 밖 owner-only private 디렉터리에 둔다. device ID·serial·model, IP·SSID·port,
   사용자명·경로, API key/token, prompt/response, 오류 원문이나 자유 형식 메모를 기록하지 않는다.
   manifest와 observation은 symlink/hardlink가 아닌 single-link regular file이어야 하며, 도구는
   `O_NOFOLLOW` 단일 descriptor에서 owner/mode·크기와 시작·종료 metadata를 확인한다.

## Observation 템플릿

검증된 manifest에서 실패 상태의 owner-only 템플릿을 만든다.

```sh
npm run android:functional-acceptance -- \
  --manifest /private/candidate/update-manifest.json \
  --create-observations /private/field/functional-observations.json
```

도구는 manifest version/commit과 현재 clean source를 대조한다. 템플릿의 모든 scenario는
`outcome: "not_run"`, `attempts: 0`, `observedAt: null`, `reason: "not_run"`이므로 생성만으로 통과할 수 없다.
template 또는 판정 report를 쓰기 직전에도 한 porcelain-v2 snapshot으로 exact commit과 clean 상태를 다시
확인하며, 입력 평가 중 source가 달라지면 출력하지 않는다.

보호된 grade report 원문은 observation에 복사하지 않는다. 별도 신뢰 경로에서 받은 세 파일의 SHA-256을
계산해 schema 4 `providerGradeReports.openaiCodingSha256`과
`providerGradeReports.openRouterCodingSha256` 두 슬롯에 기록한다. OpenRouter 두 digest는 서로 달라야 한다.

```sh
sha256sum \
  /private/provider/openai-coding-grade.json \
  /private/provider/openrouter-family-a-coding-grade.json \
  /private/provider/openrouter-family-b-coding-grade.json
```

현장 검증을 시작·종료한 canonical UTC 시각을 `testWindow`에 기록하고 다음 aggregate만 채운다.

- `physicalAndroidDevice`: 실제 Android 단말에서 수행한 경우만 `true`
- `androidApiLevel`: 검증 단말의 API level; release gate는 30 이상
- `linuxCompanionCount`: 함께 검증한 Linux Companion 수; 최소 2
- `androidClientCount`: 경쟁 pairing/claim에 사용한 Android client 수; 최소 2
- `openRouterUpstreamFamilyCount`: 같은 Tool Broker 계약을 실제 통과한 서로 다른 upstream 계열 수; 최소 2
- `rollback`: 별도 rollback client에서 확인한 exact application ID와 source `1.8.1`/10801, APK
  SHA-256·byte count·candidate와 같은 signing certificate SHA-256, mechanism
  `android_rollback_manager`, data policy `restore`; artifact 값이 null이거나 template의 `not_run`이면 통과하지 않음
- `providerGradeReports`: 위에서 계산한 OpenAI 1개·OpenRouter 2개의 exact SHA-256; 누락 또는 중복이면 실패
- 일곱 attestation은 해당 사실을 직접 확인한 경우만 `true`. 특히
  `rollbackSnapshotAvailableBeforeCandidateRun`은 candidate 기능 시험을 시작하기 전에 exact package의
  available rollback snapshot을 확인한 경우에만 `true`
- 실제 실행한 scenario는 `attempts`를 1–20, `observedAt`을 test window 안의 UTC 시각으로 기록한다.
  통과는 `reason: null`, 실패는 정해진 reason code 하나만 사용한다.

자유 형식 필드나 누락·중복 scenario, test window 밖 시각, 후보 hash 불일치, 30일보다 오래된 결과는
실패-폐쇄로 거부된다.

## 필수 시나리오

| ID | 직접 확인할 결과 |
| --- | --- |
| `candidate_update_install` | 검증된 ZIP/APK가 기존 설치 위에서 명시적 사용자 확인으로 설치되고 versionName/versionCode가 일치한다. |
| `workspace_project_identity` | 프로젝트 생성·선택과 exact path/branch/worktree identity가 다른 프로젝트와 섞이지 않는다. |
| `multi_client_pairing_restart` | 두 Android client의 동시 pairing이 모두 성공하고 Companion 재시작 뒤 각 token이 유지된다. |
| `client_revoke_restart` | exact client만 해제되고 재시작 뒤 해제 token은 거부되며 다른 client는 유지된다. |
| `tls_key_rotation_restart` | 새 TLS identity proof 뒤 이전 key가 거부되고 재시작 뒤에도 새 key만 허용된다. |
| `codex_queue_steer_handoff` | Codex Queue 기본값, exact-turn Steer, 세션 반납과 다른 한 client의 이어받기가 같은 프로젝트에서 동작한다. |
| `openai_project_patch_test` | 실제 OpenAI run 하나에서 조사→diff→터치 승인 patch→test→결과 검토가 완료된다. |
| `openrouter_two_upstream_tool_contract` | 서로 다른 두 OpenRouter upstream 계열이 같은 read/coding Tool Broker 계약을 통과한다. |
| `provider_context_fork` | terminal run의 검토한 bounded context만 다른 Provider의 새 대화로 Fork되고 자동 resume되지 않는다. |
| `approval_decline_expiry_recovery` | 거절·만료 도구가 실행되지 않고 앱 종료/복귀 뒤 exact run 상태와 의견이 복구된다. |
| `provider_failure_no_fallback` | 429/Provider 장애에서 승인하지 않은 모델·Provider·upstream으로 우회하지 않는다. |
| `openrouter_strict_privacy_rejection` | ZDR/endpoint/tool grade 조건이 부족한 model은 chat-only 또는 실행 차단 상태를 유지한다. |
| `multi_project_exit_network_restore` | 여러 프로젝트 run과 Queue가 앱 종료·네트워크 전환 뒤 exact 상태로 복원된다. |
| `notification_locked_process_kill` | 잠금화면·process kill·절전 뒤 generic 알림과 retained operation deep link가 정확히 복구된다. |
| `voice_and_spoken_settings` | 짧게/길게 음성, 중복 방지, 프로젝트 용어와 설정 말하기→별도 터치 적용이 실제 recognizer에서 동작한다. |
| `media_and_artifact_review` | 사진/영상 실패 경계와 run-bound test/log/image/APK 검토·다운로드가 다른 workspace를 노출하지 않는다. |
| `direct_lan_transport` | Termux 없이 direct LAN PocketLink mTLS 핵심 흐름이 동작하고 TLS 실패에서 downgrade하지 않는다. |
| `p2p_transport` | 실제 Wi-Fi Direct group formation과 group-client 연결에서 같은 mTLS 핵심 흐름이 동작한다. |
| `outbound_relay_transport` | outbound relay의 outer TLS와 inner PocketLink mTLS 흐름이 동작하고 다른 transport로 무단 fallback하지 않는다. |
| `rollback_1_8_1_records` | v1.8.1 rollback이 가능하고 보존된 v1 기록을 읽으며 v2 후보/current/rollback 파일이 섞이지 않는다. |

## v1.8.1 현장 rollback 절차

이 절차는 일반 사용자용 downgrade가 아니라 API 30+의 별도 field client에서 실행하는 AOSP shell
검증이다. [AOSP RollbackManager](https://android.googlesource.com/platform/frameworks/base/+/master/services/core/java/com/android/server/rollback/README.md)는
`--enable-rollback` update 시 이전 APK와 package userdata snapshot을 보존하고, 제한된 기간 안의
`pm rollback-app`이 둘을 함께 복원한다고 정의한다. 수동 shell rollback은 testing 용도이므로 production
복구 UI로 설명하지 않는다.

1. 별도 rollback client에 exact signed 1.8.1/10801이 설치되어 있고, 복원 확인용 비민감 v1 기록이
   존재하는지 확인한다. 1.8.1 APK hash·signer도 candidate와 독립적으로 먼저 검증한다.
2. candidate APK hash·signer와 application ID가 signed manifest와 일치하고, 사용자와 rollback 시험을
   명시적으로 합의한 뒤 다음처럼 restore policy `0`으로 update한다.

   ```sh
   adb install --enable-rollback 0 /private/candidate/Codex-Pocket-Voice-v2.0.0-stable.apk
   ```

3. candidate 기능을 실행하기 전에 `adb shell dumpsys rollback`에서 exact application ID의 available
   20000→10801 rollback과 restore data policy를 확인한다. raw dumpsys나 device identifier는 observation에
   복사하지 않고 확인 결과만 `rollbackSnapshotAvailableBeforeCandidateRun: true`로 기록한다.
4. v2 candidate 시나리오를 마친 뒤 다음 exact package만 rollback하고, 설치 identity가 1.8.1/10801인지,
   설치 전에 준비한 v1 기록이 다시 읽히는지 확인한다.

   ```sh
   adb shell pm rollback-app io.github.jaemanlee.codexpocketvoice.stable
   ```

5. 지원되지 않음, available snapshot 누락·만료, 다른 version/package 복원, 기록 복원 실패는
   `rollback_failed`로 남긴다. `adb install -d`, uninstall/keep-data, `retain`/`wipe` policy 또는 다른 APK를
   이 gate의 대체 증거로 사용하지 않는다.

일반 Package Installer로 배포한 production 앱은 이 testing rollback을 사용할 수 있다고 가정하지 않는다.
낮은 versionCode 재설치가 막힌 장애 대응은 앱 데이터 삭제를 유도하지 않고 더 높은 SemVer/versionCode의
검토된 forward fix를 배포한다.

## 판정과 report

관찰 파일을 mode `0600`으로 유지한 뒤 같은 manifest와 clean checkout에서 판정한다.

```sh
npm run android:functional-acceptance -- \
  --manifest /private/candidate/update-manifest.json \
  --observations /private/field/functional-observations.json \
  --report /private/field/functional-report.json
```

report는 기존 파일을 덮어쓰지 않고 mode `0600`으로 생성된다. candidate version/commit, manifest·APK·signer
digest, rollback APK package/version/hash·byte count·signer, Provider grade report digest, API level과
장치/Companion/upstream 수, attestation, scenario별 pass/fail/not-run·횟수·시각·고정
reason, aggregate verdict만 포함한다. private identifier, network 값, credential과 자유 형식 note는 schema에
없다. report는 저장소나 support bundle에 올리지 않고, deployment acceptance에는 candidate commit과
aggregate verdict만 옮긴다.

기능 report 한 건, digest가 고정된 실제 coding grade 세 건과 direct/P2P/relay별 60분 저부하 report가 모두 통과하고 외부 edge 검토까지 끝나야
v2 field acceptance를 주장할 수 있다. CI와 이 도구의 fixture만으로 실제 현장 통과를 기록하면 안 된다.
