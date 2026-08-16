# Repository workflow

- After a material code change is complete and relevant checks pass, commit the scoped files and push the current feature branch to its configured remote so the open pull request stays current.
- Never commit credentials, private device/network values, signing keys, generated secrets, or unrelated user changes.
- Never force-push. If authentication, connectivity, tests, or an overlapping dirty change prevents a safe update, leave the work intact and report the blocker.
- Small exploratory or documentation-only edits may be grouped into the next material update instead of creating noisy commits.
