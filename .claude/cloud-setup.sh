#!/usr/bin/env bash
# Cloud environment setup script for Claude Code on the web.
# Goal: finish well under the ~5 minute cache-build limit by installing the
# backend and frontend dependencies in parallel. The slow/uncertain test-DB
# bring-up (docker pull of postgres:16) is intentionally NOT here — it runs in
# the background via .claude/hooks/session-start-db.sh so it never blocks the
# environment cache.
set -euo pipefail

# Enable pnpm (base image ships Node LTS; this repo uses pnpm via corepack).
corepack enable && corepack prepare pnpm@latest --activate

pids=()

# openssl is required by the backend image — install in the background.
if command -v apt-get >/dev/null 2>&1; then
  ( sudo apt-get update -y && sudo apt-get install -y openssl ) & pids+=($!)
fi

# backend / frontend dependency installs are independent — run them in parallel.
( cd backend  && pnpm install --no-frozen-lockfile --ignore-scripts ) & pids+=($!)
( cd frontend && pnpm install --no-frozen-lockfile --ignore-scripts ) & pids+=($!)

# Wait for all jobs; fail the setup if any of them failed.
fail=0
for pid in "${pids[@]}"; do
  wait "$pid" || fail=1
done

if [ "$fail" -eq 0 ]; then
  echo "Setup complete."
else
  echo "Setup had failures — check the logs above." >&2
  exit 1
fi
