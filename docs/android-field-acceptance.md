# Android 저부하 현장 검증

이 절차는 v2 Android 앱이 장시간 background 연결 중에도 저부하 클라이언트 경계를 지키는지 물리
단말에서 확인한다. 측정 도구는 이미 연결된 ADB 장치의 진단 정보만 읽는다. 앱·네트워크·배터리 통계를
초기화하거나 앱을 시작·중지하지 않으며, 원본 `dumpsys` 출력은 파일이나 표준 출력에 남기지 않는다.

Android 공식 문서의 [`dumpsys`](https://developer.android.com/tools/dumpsys) 진단 계약과 package manager의
read-only `pm path`, Android toybox의 `sha256sum`을 사용한다. 측정 시작·종료에 단일 설치 `base.apk`의
SHA-256을 signed manifest와 대조하고 설치 경로·UID가 바뀌면 결과를 만들지 않는다.
메모리는 앱 `meminfo`의 KiB 단위 PSS/RSS, CPU는 `cpuinfo`의 exact package process 합계, 배터리는 현재
level/scale과 충전 상태를 읽는다. background wake는 AOSP가 UID별 누적 partial/background partial
duration으로 정의한 [`awl` check-in row](https://android.googlesource.com/platform/frameworks/base/+/master/core/java/android/os/BatteryStats.java)를
시작·종료 시 비교한다. `--checkin`은 이전 complete check-in을 소비할 수 있으므로 사용하지 않고 현재 값을
machine-friendly 형식으로 쓰는 `-c`만 사용한다. `--reset`, `--write`, `am force-stop`, 네트워크 변경과
package 변경 명령은 실행하지 않는다.

## 고정 release 기준

`--release-gate`는 코드에 고정된 다음 기준을 모두 만족해야 통과한다. 하나라도 수집할 수 없거나 형식이
낯설거나 누적 counter가 감소하면 추정하지 않고 실패한다.

| 항목 | 기준 |
| --- | ---: |
| 실제 측정 시간 | 60분 이상 |
| 앱 process 존재 표본 | 95% 이상 |
| CPU·PSS 유효 표본 | 각각 95% 이상 |
| 앱 process CPU p95 | 5% 이하 |
| 앱 PSS 최대값 | 192 MiB 이하 |
| 배터리 감소율 | 4%/시간 이하 |
| background partial wake | 측정 시간의 10% 이하 |

배터리 판정은 시작과 종료가 모두 unplugged/discharging일 때만 가능하다. USB ADB가 단말을 충전한다면 미리
승인·연결해 둔 wireless debugging을 사용한다. 이 도구는 wireless debugging을 켜거나 주소를 저장하지
않는다. 배터리 level의 해상도가 낮으므로 60분보다 짧은 실행은 정식 판정에 사용할 수 없다.

## 실행 절차

1. Linux PC에서 update artifact ZIP을 기존 오프라인 검증기로 검증하고, 그 canonical signed
   `update-manifest.json`과 정확히 같은 clean Git commit을 checkout한다. 이 측정 도구는 단말의 설치
   `base.apk` bytes를 manifest digest와 시작·종료에 대조하지만, 로컬 bundle의 manifest 서명이나 인증서
   trust path는 별도 오프라인 검증 결과를 사용한다.
2. 앱에서 측정할 PocketLink 경로 하나(direct LAN, 실제 P2P 또는 outbound relay)와 background 알림 연결을
   사용자가 직접 켜고, 앱을 background로 보낸다. `--transport`는 실제 선택한 경로와 같아야 한다.
3. 단말을 전원에서 분리하고 `adb devices`에서 정확히 한 대가 `device` 상태인지 확인한다. 여러 대라면
   아래 명령에 `--serial`을 추가한다.
4. 저장소 밖의 private directory에 새 report 경로를 정하고 실행한다.

manifest는 symlink/hardlink가 아닌 단일 regular file이어야 한다. 도구는 `O_NOFOLLOW`로 한 번 연 file
descriptor에서 크기와 시작·종료 metadata를 확인하므로 읽는 중 경로 교체·변경은 ADB 조회 전에 거부한다.
Git commit과 dirty 상태는 한 porcelain-v2 snapshot으로 측정 직전과 직후에 각각 확인한다. 종료 시 source가
manifest의 exact commit이 아니거나 worktree에 tracked/untracked 변경이 있으면 측정값이 통과해도 report를
만들지 않는다.

```sh
npm run android:field-acceptance -- \
  --manifest /private/update-bundle/update-manifest.json \
  --transport direct-lan \
  --duration-minutes 60 \
  --interval-seconds 15 \
  --release-gate \
  --report /private/report-directory/android-field.json
```

짧은 배선·파서 점검은 `--release-gate` 없이 최소 1분 동안 실행할 수 있지만 결과는
`observation_only`이며 release 증거가 아니다. report 경로는 기존 파일을 덮어쓰지 않고 mode `0600`으로
새로 만든다. `--transport`는 `direct-lan`, `p2p`, `outbound-relay` 중 하나이며 생략하거나 임의 값을
사용하면 ADB 조회 전에 실패한다. report schema 3에는 다음 aggregate만 포함한다. 이전 schema 2 report는
설치 APK bytes의 시작·종료 검증을 증명하지 못하므로 최종 release evidence에서 거부한다.

- canonical manifest의 application/version/versionCode/channel, commit·manifest/APK/signer SHA-256과
  실제 사용 transport, 측정 시작·종료 시각
- 설치 앱 package/version, manifest와 일치한 APK SHA-256 및 시작·종료 digest 확인, 요청·실제 측정 시간과 표본 수
- process/CPU/PSS 표본 coverage와 CPU·PSS/RSS mean/p95/max
- 배터리 감소율, background wake delta/비율, 고정 기준별 pass/fail
- device serial/model/UID, 주소·SSID·port, 설치 경로, PID, 원본 명령 출력은 포함하지 않음

report는 공개 저장소나 support bundle에 올리지 않는다. 필요한 경우 기준별 수치만 deployment acceptance에
옮긴다. 장치 단절, 앱 미설치·버전 불일치, 여러 ready 장치, report 경로 재사용은 원본 값을 출력하지 않고
실패한다.

## 출시 증거 범위

한 번의 통과는 해당 APK·단말·transport 조건만 증명한다. 출시 후보에서는 최소 direct LAN, 실제 P2P와
outbound relay의 지원 경로별로 별도 측정하고, 세 report의 commit·manifest/APK digest가 기능 field
report와 모두 같은지 확인한 뒤 잠금화면·process kill·절전·네트워크 전환 복구 결과와 함께 검토한다.
시작 전 digest 불일치, 측정 중 package path·UID·APK bytes 변경이나 clean source drift는 report 없이 실패한다.
이 저장소의 fixture 테스트와 CI 통과는 물리 단말의 배터리 또는 wake 결과를 대신하지 않는다.
