#!/usr/bin/env bash
# SessionStart hook (repo-attached). Runs AFTER Claude Code launches, inside the
# checked-out repo, on every cloud session. This is where repo-dependent setup
# belongs, because the environment setup script runs before the repo exists.
#
# Responsibilities:
#   1. Install backend + frontend dependencies (in parallel).
#   2. Start the integration/e2e test DB and migrate it (in the background).
#
# Skips local machines entirely via CLAUDE_CODE_REMOTE so it never touches your
# laptop when you open this repo in a local Claude Code session.
set -u

# Cloud sessions only.
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0

ROOT="${CLAUDE_PROJECT_DIR:-$(pwd)}"

# --- Dependencies: backend + frontend in parallel, skip if already installed ---
install_deps() {
  dir="$1"
  if [ -d "$ROOT/$dir/node_modules" ]; then
    echo "$dir: node_modules present, skipping install"
    return 0
  fi
  ( cd "$ROOT/$dir" && corepack enable && pnpm install --no-frozen-lockfile --ignore-scripts )
}

install_deps backend & bpid=$!
install_deps frontend & fpid=$!
wait "$bpid" || echo "WARN: backend dependency install failed" >&2
wait "$fpid" || echo "WARN: frontend dependency install failed" >&2

# --- Test DB: start + migrate in the background so it never blocks startup ---
# Uses a standalone postgres:16 container (matches docker-compose.test.yml) rather
# than that compose file, which requires an external network that only exists when
# the full dev stack is running. Logs go to /tmp/db-test-setup.log.
{
  command -v docker >/dev/null 2>&1 || { echo "no docker available; skipping test DB"; exit 0; }

  docker start db-test 2>/dev/null || docker run -d --name db-test -p 5436:5432 \
    -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=ntnu_test \
    postgres:16

  for _ in $(seq 1 30); do
    docker exec db-test pg_isready -U postgres >/dev/null 2>&1 && break
    sleep 2
  done

  cd "$ROOT/backend" && DATABASE_URL=postgresql://postgres:postgres@localhost:5436/ntnu_test \
    pnpm run migrate:test

  echo "Test DB ready and migrated."
} >/tmp/db-test-setup.log 2>&1 &

# Never block session startup on setup outcomes; failures are logged above.
exit 0
