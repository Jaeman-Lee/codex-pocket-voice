# Repository workflow

- After a material code change is complete and relevant checks pass, commit the scoped files and push the current feature branch to its configured remote so the open pull request stays current.
- Never commit credentials, private device/network values, signing keys, generated secrets, or unrelated user changes.
- Never force-push. If authentication, connectivity, tests, or an overlapping dirty change prevents a safe update, leave the work intact and report the blocker.
- Small exploratory or documentation-only edits may be grouped into the next material update instead of creating noisy commits.

## Update decision gate

- Before every distributable update, explicitly classify it as `patch`, `feature`, or `breaking`, decide the SemVer change, choose the target branch, and decide what happens to the current and rollback APKs. Record the decision in the changelog or deployment inventory.
- A bug fix or internal compatibility adjustment is a patch. A new user-visible workflow, capability, server API, or module is a feature and increments the minor version. An incompatible protocol, storage, account, or migration change is breaking and requires a major-version plan.
- Develop patches and features on a scoped branch and keep its pull request current. Do not push distributable work directly to `main`. Merge into `main` only after required checks and field-test acceptance; use a dedicated `hotfix/*` branch for an urgent released-version fix.
- Once an APK has been handed to a tester or installed, any changed APK must receive a higher SemVer/versionCode. Pre-handoff rebuilds may keep the version only when the earlier artifact is replaced and never presented as a distinct build.
- Keep one current candidate set and one previously validated rollback set on the Android device. Preserve official releases in GitHub Releases, CI-only artifacts in GitHub Actions, and move superseded local candidates to a recoverable archive or trash instead of mixing them with the current installer.
