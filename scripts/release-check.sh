#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo_dir"

version=$(node -p "JSON.parse(require('node:fs').readFileSync('package.json', 'utf8')).version")
node -e "if (!/^\\d+\\.\\d+\\.\\d+$/.test(process.argv[1])) process.exit(1)" "$version"

if [ "$(node -p "require('./package-lock.json').version")" != "$version" ]; then
  printf '%s\n' 'package-lock.json version does not match package.json.' >&2
  exit 1
fi

printf 'Release candidate v%s\n' "$version"
npm run check
npm test
npm run test:integration
npm run check:app-server-schema
npm sbom --sbom-format cyclonedx >/dev/null
printf 'Release checks passed for v%s\n' "$version"
