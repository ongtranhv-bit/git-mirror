#!/usr/bin/env bash
# Check codespace status / idle timeout. Use to verify a keep-alive is working.
#
# Usage:
#   bash scripts/codespace-keepalive/check.sh [codespace-name]
set -euo pipefail

CODESPACE="${1:-${CODESPACE_NAME:-}}"
if [ -z "$CODESPACE" ]; then
  CODESPACE="$(gh codespace list --json name -q '.[0].name')"
fi

gh codespace view -c "$CODESPACE" 2>&1
echo "---"
gh codespace list 2>&1
