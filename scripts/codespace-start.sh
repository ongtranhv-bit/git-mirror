#!/usr/bin/env bash
set -euo pipefail

required=(RTDB_URL)
if [[ -z "${GOOGLE_SERVICE_ACCOUNT_B64:-}" && -z "${RTDB_AUTH_SECRET:-}" ]]; then
  echo "codespace-start: missing GOOGLE_SERVICE_ACCOUNT_B64 or RTDB_AUTH_SECRET" >&2
  exit 2
fi
for key in "${required[@]}"; do
  if [[ -z "${!key:-}" ]]; then
    echo "codespace-start: missing required env name: ${key}" >&2
    exit 2
  fi
done

command -v node >/dev/null
command -v git >/dev/null

# Resolve the current daily source token to a single alias, then remove the
# day-specific token set before spawning npm/node. Main AppConfig should use
# ${GH_SOURCE_TOKEN_CURRENT}.
source "$(dirname "$0")/codespace-runtime-env.sh"

export RUNTIME_COMMIT_SHA="$(git rev-parse HEAD)"
export RUNTIME_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
export RUNTIME_SERVICE_VERSION="$(node -p "require('./package.json').version")"

# RUNTIME_REPOSITORY may be supplied as a non-secret environment value.


if [[ ! -f dist/cli.js ]]; then
  npm ci --ignore-scripts
  npm run build
fi
exec node dist/cli.js run
