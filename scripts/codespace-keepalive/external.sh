#!/usr/bin/env bash
# Keep a GitHub Codespace alive from an ALWAYS-ON machine (home PC, VPS, cloud VM).
#
# The in-codespace variant lives in the app itself: the `run` listener starts a
# keep-alive when `runtime.codespaceKeepalive.enabled` is true, as long as it runs
# inside a codespace with CODESPACE_NAME and the gh CLI. This script is the
# companion for a machine outside the codespace that must stay connected.
#
# Why this works:
#  - An active connection counts as activity, so the idle timer never elapses.
#  - `gh codespace ssh` auto-starts a stopped codespace before connecting, so the
#    codespace comes back even after GitHub stopped it (e.g. after 240min idle).
#
# Usage (one-off, foreground):
#   bash scripts/codespace-keepalive/external.sh [codespace-name]
#
# Scheduling (run every ~5 min, e.g. via cron):
#   5,20,35,50 * * * *  cd /path/to/git-mirror && bash scripts/codespace-keepalive/external.sh super-meme-p7g69p95p46gh66q6 >> keepalive.log 2>&1
set -euo pipefail

CODESPACE="${1:-${CODESPACE_NAME:-}}"
if [ -z "$CODESPACE" ]; then
  CODESPACE="$(gh codespace list --json name -q '.[0].name')"
fi
if [ -z "$CODESPACE" ]; then
  echo "[keepalive] no codespace found" >&2
  exit 1
fi

IDLE_MS="$(gh codespace view -c "$CODESPACE" --json idleTimeoutMinutes -q .idleTimeoutMinutes 2>/dev/null || echo unknown)"
STATE="$(gh codespace list --json name,state -q ".[] | select(.name==\"$CODESPACE\") | .state" 2>/dev/null || echo unknown)"

echo "[keepalive] $(date -u +%FT%TZ) codespace=$CODESPACE state=$STATE idleTimeoutMinutes=$IDLE_MS"

# Keep a persistent SSH connection alive with client keep-alive every 30s.
# On drop (timeout ~2h of no reply) the loop reconnects, which also restarts
# the codespace if GitHub stopped it.
if command -v ssh >/dev/null 2>&1 && gh codespace ssh --config -c "$CODESPACE" >/dev/null 2>&1; then
  CFG="$(mktemp)"
  trap 'rm -f "$CFG"' EXIT
  gh codespace ssh --config -c "$CODESPACE" >"$CFG"
  echo "[keepalive] connecting via persistent ssh tunnel (Ctrl-C to stop)..."
  while true; do
    ssh -F "$CFG" -o ServerAliveInterval=30 -o ServerAliveCountMax=240 -o ConnectTimeout=15 "$CODESPACE" -N 2>/dev/null \
      || ssh -F "$CFG" -o ServerAliveInterval=30 -o ServerAliveCountMax=240 -o ConnectTimeout=15 "$CODESPACE" 'true' 2>/dev/null \
      || true
    echo "[keepalive] $(date -u +%FT%TZ) connection lost, reconnecting in ${INTERVAL:-60}s..."
    sleep "${INTERVAL:-60}"
  done
else
  echo "[keepalive] falling back to connect/check every ${INTERVAL:-300}s (no persistent ssh config available)"
  while true; do
    gh codespace ssh -c "$CODESPACE" -- 'true' >/dev/null 2>&1 || true
    echo "[keepalive] $(date -u +%FT%TZ) pinged codespace"
    sleep "${INTERVAL:-300}"
  done
fi
