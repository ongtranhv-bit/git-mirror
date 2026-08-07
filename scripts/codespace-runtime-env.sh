#!/usr/bin/env bash
# Source this file from the Codespace startup shell. It intentionally exports
# only the current day's alias and removes all day-specific source tokens from
# the child process environment.
set -euo pipefail

rotation_timezone="${CODESPACE_ROTATION_TIMEZONE:-Asia/Ho_Chi_Minh}"
day="$(TZ="${rotation_timezone}" date +%d)"
token_var="GH_SOURCE_TOKEN_DAY_${day}"
token_value="${!token_var:-}"
if [[ -z "${token_value}" ]]; then
  echo "codespace-runtime-env: missing required secret name ${token_var}" >&2
  return 2 2>/dev/null || exit 2
fi

export GH_SOURCE_TOKEN_CURRENT="${token_value}"
for index in $(seq -w 1 31); do
  unset "GH_SOURCE_TOKEN_DAY_${index}" || true
done
unset token_value
