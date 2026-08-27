#!/usr/bin/env bash
# Wait for a CI-started application process to become healthy.
#
# Polls readiness *and* liveness: waiting on the URL alone would spend the full
# timeout on a process that already exited, so a startup failure has to fail
# fast instead of surfacing as a Playwright timeout minutes later. On any
# failure the process log is printed, which is the only diagnostic a caller
# gets for a server that never came up.
#
# Usage: wait-for-service.sh <label> <pid-file> <health-url> <log-file>
set -uo pipefail

label="$1"
pid="$(cat "$2")"
url="$3"
log="$4"

for _ in $(seq 1 60); do
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "::error::${label} exited during startup"
    cat "$log"
    exit 1
  fi
  if curl -fsS "$url" >/dev/null 2>&1; then
    echo "${label} is up"
    exit 0
  fi
  sleep 2
done

echo "::error::${label} did not become healthy within 120s"
cat "$log"
exit 1
