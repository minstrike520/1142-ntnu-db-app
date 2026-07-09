#!/usr/bin/env bash
# SessionStart hook: bring up the integration/e2e test database in the
# BACKGROUND so it never blocks the setup script or the cache-build window.
# The whole block is detached with `{ ... } &` and its output is sent to a log.
#
# Test DB matches docker-compose.test.yml (postgres:16, port 5436, db ntnu_test).
# We start a standalone container instead of `docker compose -f
# docker-compose.test.yml` because that compose file expects an external network
# (1142-ntnu-db-app_default) that only exists when the full dev stack is running.
#
# If docker is unavailable, the hook exits cleanly and integration/e2e tests are
# expected to run in a real Docker environment by a reviewer.
{
  command -v docker >/dev/null 2>&1 || { echo "no docker available; skipping test DB"; exit 0; }

  docker start db-test 2>/dev/null || docker run -d --name db-test -p 5436:5432 \
    -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=ntnu_test \
    postgres:16

  # Wait for readiness (max ~60s) before migrating.
  for _ in $(seq 1 30); do
    docker exec db-test pg_isready -U postgres >/dev/null 2>&1 && break
    sleep 2
  done

  cd backend && DATABASE_URL=postgresql://postgres:postgres@localhost:5436/ntnu_test \
    pnpm run migrate:test

  echo "Test DB ready and migrated."
} >/tmp/db-test-setup.log 2>&1 &
