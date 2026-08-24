# Developer & Testing Guide

This document provides setup instructions, development workflows, testing guidelines, and test data descriptions for the application.

---

## 1. Quick Start

### Step 1: Prepare Environment Variables
Copy the `.env.example` file from the project root and rename it to `.env`:

```bash
cp .env.example .env
```

*Note: The `.env` file is listed in `.gitignore` and should not be committed to the Git repository.*

### Step 2: Start the Containers
Use Docker Compose to start all services:

```bash
# Rebuild after the first setup or after changing a Dockerfile
docker compose build

# Start the services in detached mode
docker compose up -d
```

Uploaded files are stored in whatever source is mounted to `/workspace/backend/uploads` for the backend container. By default, this is the Docker named volume `app_uploads`. Attachments live under `/workspace/backend/uploads/attachments/` and avatars use `/workspace/backend/uploads/avatars/`.

> **Upgrading from an older checkout**: the dev containers now lay the repo out
> as a pnpm workspace at `/workspace`, so the backend moved from `/app` to
> `/workspace/backend`. Rebuild with:
>
> ```bash
> docker compose up -d --build --renew-anon-volumes
> ```
>
> **Do not use `docker compose down -v`.** `-v` removes the named `pgdata` and
> `app_uploads` volumes, which would wipe your dev database and every uploaded
> file. It is not required here: the old anonymous `node_modules` volume was
> mounted at `/app/node_modules` and the new one is at
> `/workspace/backend/node_modules`, so the two cannot shadow each other — the
> old volume is simply left orphaned (clear it later with `docker volume prune`
> if you like).
>
> One known consequence, accepted deliberately rather than papered over with a
> compatibility shim: attachments uploaded *before* this change stored an
> absolute `/app/uploads/...` path, and `attachmentRoutes.ts` streams a stored
> absolute path verbatim without relocating it. Those rows will 404 after the
> move. The files themselves are still in the `app_uploads` volume under the new
> path. This affects local dev data only — production is unchanged, since
> `docker-compose.prod.yml` still runs with `/app` as the working directory. Just
> re-upload anything you still need.

If you want uploads to go to a custom folder on the host instead of the default named volume, set `UPLOADS_MOUNT_SOURCE` in `.env` before running Docker Compose:

```env
UPLOADS_MOUNT_SOURCE=C:/chat-uploads
```

### Step 3: Check Container Status

```bash
# View container status
docker compose ps

# View backend logs
docker compose logs -f backend
```

---

## 2. Environment Variables & Port Access

### Local Service Ports

Docker Compose exposes different host ports from the container-internal ports:

| Service | Host URL / port | Container port | Description |
|---------|------------------|----------------|-------------|
| **Frontend** | [http://localhost:3005](http://localhost:3005) | 3000 | Next.js frontend web app |
| **Backend API** | [http://localhost:4005](http://localhost:4005) | 4000 | Bun + Hono API & Socket.IO server |
| **Database** | `localhost:5435` | 5432 | PostgreSQL 18 instance |
| **Redis** | `localhost:6385` | 6379 | Redis 8 instance for realtime state. Bound to `127.0.0.1` only — it runs without a password. Not read by the backend until #472 |

For browser-facing frontend requests, set the API environment variable to:
```env
NEXT_PUBLIC_API_URL=http://localhost:4005
```

### Realtime runtime and smoke checks

The backend production listener is a single `Bun.serve` instance. Hono handles
REST requests and `@socket.io/bun-engine` handles `/socket.io/`; the old Node
HTTP adapter is used only by the supertest compatibility harness. Socket.IO
uses a 25-second ping interval and a 20-second ping timeout, so Bun's
`idleTimeout` must stay above that window.

Durable message commands use REST and require an `Idempotency-Key`; edit and
recall also require `If-Match`. After connecting, clients call `/api/v1/sync`
with their last cursor.

`backend/scripts/smoke.ts` (`pnpm --filter near-chat-backend run smoke`, or
`bun run smoke` from `backend/`) is the automated realtime smoke test against
a running stack. It registers a throwaway user and exercises health, socket
connect (`realtime_ready`), a reliably-sent message (retried `Idempotency-Key`
resolves to one message), sync-cursor repair after a disconnect, and
over-limit auth requests (`429`/`TOO_MANY_REQUESTS`). It reads the target from
`SMOKE_API_URL` (default `http://localhost:4005`) and exits non-zero with a
per-check diagnostic on the first failure.

The last check needs the rate limiter actually running, and `.env.example`
ships `RATE_LIMIT_DISABLED=true` for everyday development — so override it for
the smoke stack rather than running the default one:

```bash
RATE_LIMIT_DISABLED=false docker compose up -d --wait --force-recreate backend
SMOKE_API_URL=http://localhost:4005 pnpm --filter near-chat-backend run smoke
```

`--force-recreate backend` is what makes the override take effect: Compose does
not restart an already-running container just because an interpolated
environment variable changed.

Set `SMOKE_STATE_FILE` to a path to additionally verify that durable state
survives a restart. The first run writes its token, room and message id there;
a later run against the same file re-syncs with that saved token and asserts
the pre-restart message is still returned, so a restart that dropped data fails
rather than passing on freshly created state.

CI runs this same script against both the development image
(`docker-compose.yml`) and the production image (`docker-compose.release.yml`)
in `ci-backend.yml`, once before and once after gracefully restarting the
backend container, sharing one `SMOKE_STATE_FILE` across the pair — so a broken
image, or a restart that loses committed state, fails the build.

`MAX_SESSIONS_PER_USER`, `PRESENCE_GRACE_MS`, and `TYPING_TTL_MS` control local
session, presence-reconnect, and typing-indication limits. Multi-node presence,
global rate limits, and cross-node change fan-out remain outside this service.

### Production Ingress & Proxy Trust

`docker-compose.prod.yml` publishes every host port on `127.0.0.1`, so the local
walkthrough (`http://localhost:3005`) still works while the only route in from the
network is the Cloudflare Tunnel. `cloudflared` reaches `frontend:3000` and
`backend:4000` over the compose network, which does not involve published ports at
all.

Rate limiting buckets callers by IP, so it needs to know the caller's real address.
Through a tunnel the peer address is always the `cloudflared` container, which
would put every external user in one bucket — ten failed logins from anyone would
lock out the whole service for 15 minutes. `TRUST_PROXY_HOPS` closes that:

| Value | Meaning |
|-------|---------|
| unset / `0` | Trust nothing; use the TCP peer address. Correct for the dev stack and any deployment reached directly. |
| `n` | `n` reverse proxies you operate sit in front. The client IP is read `n` entries from the **right** of `X-Forwarded-For`. |

Reading from the right matters. `X-Forwarded-For` is append-only, so entries a
caller sends arrive on the left and only the rightmost `n` were written by
infrastructure you control. Trusting the leftmost entry instead lets any caller
name its own bucket — dodging its own limit, or spending someone else's.

`docker-compose.prod.yml` sets `TRUST_PROXY_HOPS=1` literally rather than through
`${...}`, because Compose interpolates from the project `.env` and a value copied
from `.env.example` would otherwise silently override it. Add a hop for each extra
proxy you place in front, editing the compose file where the topology is declared.

To verify a deployment buckets on real client addresses:

```bash
# 1. Nothing but the tunnel may reach the backend. From another machine:
curl -sS --max-time 5 http://<host>:4005/api/v1/auth/login   # must fail to connect
curl -sS --max-time 5 http://<host>:5435                     # must fail to connect

# 2. Through the tunnel, exhaust the auth limiter from one client.
for i in $(seq 1 11); do
  curl -s -o /dev/null -w '%{http_code}\n' -X POST https://<tunnel-host>/api/v1/auth/login \
    -H 'Content-Type: application/json' -d '{"email":"nobody@example.com","password":"wrong"}'
done
# Expect 401s, then 429 once the window is spent.

# 3. A second client (different network, e.g. phone on cellular) must still get
#    401 rather than 429 — separate buckets.

# 4. A forged header must not create a new bucket. From the already-limited
#    client, still 429:
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://<tunnel-host>/api/v1/auth/login \
  -H 'X-Forwarded-For: 203.0.113.7' \
  -H 'Content-Type: application/json' -d '{"email":"nobody@example.com","password":"wrong"}'
```

If step 3 returns 429, the hop count is too low; if step 4 returns 401, it is too
high. Note that `RATE_LIMIT_DISABLED=true` skips the limiter entirely, so unset it
before testing.

### Environment Rules
1. **Frontend prefix**: Any environment variable that must be readable on the browser-side of Next.js must be prefixed with `NEXT_PUBLIC_`.
2. **Production injection**: Production should not depend on a checked-in `.env` file. Inject settings through your hosting platform configuration instead (e.g. Vercel, AWS Secrets Manager).
3. **Template maintenance**: When adding new environment variables, update `.env.example` to document them, leaving values blank or using placeholders.

---

## 3. Database Management & Seeding

### Initialization Flow
When setting up the project for the first time, you must initialize the database schema. Ensure your Docker containers are running, then apply the migrations:

```bash
docker compose exec backend bun run migrate:up
```

To seed the database with mock data:
```bash
docker compose exec backend bun run db:seed
```

### Common Commands
- **Create a new migration**: `docker compose exec backend bun run migrate:create <name>`
- **Run migrations**: `docker compose exec backend bun run migrate:up`
- **Rollback migrations**: `docker compose exec backend bun run migrate:down` (rolls back the single most recent migration; pass a count to undo more, e.g. `migrate:down 3`)
- **Seed database**: `docker compose exec backend bun run db:seed`

### Granting Admin Access

`/api/v1/admin/*` is gated by the `users.is_admin` column. Every account starts
with `is_admin = false`, including seeded ones, and there is deliberately **no
HTTP endpoint that sets the flag** — `is_admin` is absent from the repository's
`update` allow-list, so it cannot be reached through `PATCH /api/v1/users/me`.

Promote an account with a direct database write:

```bash
docker compose exec db psql -U chatuser -d chatdb \
  -c "UPDATE users SET is_admin = true WHERE email = 'alice@test.com';"
```

Verify the gate (a non-admin gets 403, an admin gets 200):

```bash
curl -i -s http://localhost:4005/api/v1/admin/health -H "Authorization: Bearer <token>" | head -1
```

Revoke by setting the column back to `false`; it takes effect on the caller's
next request, because the flag is read from the database per request rather than
carried in the JWT.

There is intentionally no `SYSTEM_ADMIN_EMAILS`-style environment allow-list.
`PATCH /api/v1/users/me` lets any authenticated user change their own email with
only a uniqueness check — no current-password confirmation, unlike a password
change — and `users.email` is a plain case-sensitive `UNIQUE` column, so
`Ops@company.com` can be inserted alongside `ops@company.com`. Matching admins by
email would therefore be self-service privilege escalation.

### About the Migration Runner
Migrations are applied by `backend/src/models/migrate.ts`, a small runner built on
`Bun.SQL`. It replaced `node-pg-migrate` in #421 so the backend depends on Bun
alone — no Node runtime, no `pg` driver.

What it does:

- Applies every `.sql` file in `backend/migrations/`, ordered by the numeric
  prefix in the file name, and records each one by name in the `pgmigrations`
  table. A file already recorded there is never re-applied.
- Splits each file on its `-- Up Migration` and `-- Down Migration` headers.
- Runs a whole invocation in **one transaction**. If any migration fails,
  nothing from that run is committed and the error names the file that failed.
- Takes a PostgreSQL advisory lock first, so two containers starting at once
  cannot migrate concurrently — the second exits with
  `Another migration is already running.`
- Refuses to start if `backend/migrations/` contains a non-`.sql` file, rather
  than skipping it silently.
- Stops with `Not run migration … is preceding already run migration …` when a
  branch merge leaves a new migration ordered before one already applied. Rename
  the file with a higher prefix so it sorts last.

The `pgmigrations` table, the recorded names, the ordering rules and the
advisory lock id are all unchanged from `node-pg-migrate`, so databases migrated
by the old tool continue from exactly where they left off.

Migrations are SQL only. `migrate:create <name>` writes a new file under
`backend/migrations/` containing both section headers, with a numeric prefix
chosen so it always sorts after the existing migrations.

### Repairing a Broken Dev Database
If you encounter `relation ... already exists` errors during migration, or migration state goes out of sync:

```bash
# 1. Stop containers and wipe the database volume
docker compose down -v

# 2. Restart containers
docker compose up -d

# 3. Wait for the database to be ready, then run migrations again
docker compose exec backend bun run migrate:up
```

---

## 4. Default Seed Test Data

Running `db:seed` populates the development database with the following reproducible test data. **The default password for all test users is: `password123`.**

### Seed Users
| Name | Email | User ID | Role / Note |
| --- | --- | --- | --- |
| **Alice** | `alice@test.com` | `11111111-1111-4111-a111-111111111111` | Default Group Owner |
| **Bob** | `bob@test.com` | `22222222-2222-4222-a222-222222222222` | Default Group Admin |
| **Charlie** | `charlie@test.com` | `33333333-3333-4333-a333-333333333333` | Member |
| **Dave** | `dave@test.com` | `44444444-4444-4444-a444-444444444444` | Out-of-group |
| **Eve** | `eve@test.com` | `55555555-5555-4555-a555-555555555555` | Out-of-group |
| **Frank** | `frank@test.com` | `66666666-6666-4666-a666-666666666666` | Member |

### Relationships & Groups
* **Friendships**:
  - Alice & Bob (Accepted)
  - Alice & Charlie (Accepted)
  - Dave → Alice (Pending request)
* **Blocks**:
  - Eve blocks Alice.
* **Study Group Room**:
  - **Room ID**: `77777777-7777-4777-a777-777777777777`
  - **Invite Code**: `STUDY123`
  - **Members**: Alice (Owner), Bob (Admin), Charlie (Member), Frank (Member)
  - **Initial messages**:
    1. *Alice*: "Hello everyone! Welcome to the study group."
    2. *Bob*: "Hi Alice, thanks for inviting me!"

---

## 5. Testing Guide

### Testing Architecture
The development environment runs entirely within Docker. There is no `node_modules` on the host machine. All Bun test suites must be executed inside the backend container using `docker compose exec`.

Testing database setup: Integration tests run against an ephemeral Postgres test database instance (`db-test`) defined in `docker-compose.test.yml`, separating development data from tests.

### Installing Dependencies
This repository is a **single-lockfile pnpm workspace**. There is exactly one
`pnpm-lock.yaml`, at the repo root, covering the root, `frontend/` and `backend/`.

```bash
# Always install from the repository root
pnpm install
```

**Never run `pnpm install` inside `frontend/` or `backend/`.** Doing so creates a
nested `frontend/pnpm-lock.yaml` or `backend/pnpm-lock.yaml` that drifts away
from the root one — which is exactly the failure issue #420 documented. CI
rejects any committed nested lockfile.

The pnpm version is pinned by `"packageManager"` in the root `package.json`;
`corepack enable` is enough to pick it up. Target a single package with a
workspace filter, using the **package name** rather than the directory name:

```bash
pnpm --filter near-chat-frontend <script>
pnpm --filter near-chat-backend <script>
```

> **After changing dependencies, rebuild with `--renew-anon-volumes`:**
>
> ```bash
> docker compose up -d --build --renew-anon-volumes
> ```
>
> Each service keeps an anonymous volume on its `node_modules` so the source bind
> mount does not hide it. Under a pnpm workspace that directory is only a farm of
> symlinks into the real store at `/workspace/node_modules/.pnpm`, which lives in
> the **image**. `docker compose up --build` reuses the existing anonymous volume
> rather than re-seeding it from the new image, so after a version change the
> persisted links can point at store paths the new image no longer has — and the
> dev server or a migration fails on a module it cannot resolve.
> `--renew-anon-volumes` recreates only those anonymous volumes; the named
> `pgdata` and `app_uploads` volumes are untouched.

### Running TypeScript Type Checks
```bash
# Backend Check
pnpm --filter near-chat-backend exec tsc --noEmit

# Frontend Check
pnpm --filter near-chat-frontend exec tsc --noEmit
```

### Running ESLint Checks
Before committing code or during development, run the linter to verify code formatting, style guidelines, and React best practices (e.g. Hooks compliance):

```bash
# Run linting check in the frontend directory
pnpm --filter near-chat-frontend lint

# Or run it inside the frontend Docker container
docker compose exec frontend pnpm run lint
```

### Running Frontend Browser Tests (Playwright)
These run on the host, not in Docker, and are separate from the Vitest suite in `frontend/tests/`. They exercise a real Chromium against a production build of the frontend; every `/api/v1` call is mocked in the browser, so no backend and no database are needed.

Chromium is not bundled with the npm package. Install it once per machine:

```bash
pnpm --filter near-chat-frontend exec playwright install chromium
```

Then run the suite. `playwright.config.ts` builds and starts Next.js itself, so no server needs to be running first:

```bash
pnpm --filter near-chat-frontend test:browser
```

On failure, the HTML report, traces and screenshots land in `frontend/playwright-report/` and `frontend/test-results/`:

```bash
pnpm --filter near-chat-frontend exec playwright show-report
```

Specs live in `frontend/tests-browser/`, and the shared REST mock is `frontend/tests-browser/support/api-mock.ts`. Full-stack browser E2E against a real backend and Postgres is tracked separately in issue #544 and will get its own lane rather than extending this one.

### Running Unit Tests
Unit tests do not require a database connection.
```bash
docker compose exec backend bun run test:unit
```

### Running Integration Tests
Integration tests require starting the ephemeral test database (which automatically applies migrations via `test:db:up`):

```bash
# 1. Start the ephemeral test database & automatically apply migrations
pnpm --filter near-chat-backend test:db:up

# 2. Run the integration test suite
docker compose exec backend bun run test:integration

# 3. Stop the test database
pnpm --filter near-chat-backend test:db:down
```

### Running All Tests
```bash
pnpm --filter near-chat-backend test:db:up
docker compose exec backend bun run test
pnpm --filter near-chat-backend test:db:down
```

---

## 6. Writing Tests

### Unit Tests
* **Path**: `backend/tests/unit/**/*.test.ts`
* **Guidelines**: Mock database repositories using `mock.module()` to test business logic in isolation without making real database connections.

> **`mock.module()` is process-global.** Every suite now runs as a single
> `bun test <dir>` process, so a `mock.module()` call in one file replaces that
> module for *every* file in the same run — and it takes effect at load time, so
> it can affect files that run before it. Two consequences:
> * Keep `mock.module()` to `tests/unit/`, never `tests/integration/` or
>   `tests/e2e/`. A test that mocks `src/models/db` is a unit test by
>   definition; if it needs a real database it belongs in another tier.
> * Prefer `spyOn(namespace, 'fn')` with `mockRestore()` when you only need to
>   replace a function — that genuinely restores, whereas re-calling
>   `mock.module()` in `afterAll` does not.
>
> **Never close a shared singleton in a hook.** `src/models/db` and
> `tests/helpers/testPool` both export a process-wide connection. Calling
> `.end()` on either in `afterAll` closes it for every later file in the run.
> Let the process exit release it.

```typescript
// Example: backend/tests/unit/services/userService.test.ts
import { describe, it, expect } from 'bun:test';

describe('userService', () => {
  it('adds two numbers', () => {
    expect(1 + 1).toBe(2);
  });
});
```

### Integration Tests
* **Path**: `backend/tests/integration/**/*.test.ts`
* **Guidelines**: Tests query the real PostgreSQL test database. Use the helpers `testPool` and `resetDb` to manage connections and clear tables before each test.

```typescript
// Example: backend/tests/integration/repositories/userRepository.test.ts
import { beforeEach, describe, it, expect } from 'bun:test';
import { testPool } from '../helpers/testPool';
import { resetDb } from '../helpers/resetDb';

describe('userRepository', () => {
  beforeEach(async () => {
    await resetDb(); // Clears users, rooms, messages, room_members
  });

  // Do NOT call `testPool.end()` here — it is a module singleton shared by
  // every test file in the run, and closing it breaks all later files.

  it('queries database successfully', async () => {
    const result = await testPool.query('SELECT 1 + 1 AS sum');
    expect(result.rows[0].sum).toBe(2);
  });
});
```

---

## 7. Troubleshooting

* **`bun test errors`**: Backend container `node_modules` is out of sync. Rebuild container:
  ```bash
  docker compose rm -v -s -f backend
  docker compose up -d --build backend
  ```
* **`bun test` runs far more tests than expected, or hangs**: `bun test <dir>`
  treats its argument as a path *substring* filter, not a directory. Because
  `backend/tsconfig.json` includes `tests/**/*`, running `pnpm build` emits
  compiled copies to `backend/dist/backend/tests/…`, which also match the filter
  and run as a stale second copy of the suite. `backend/bunfig.toml` sets
  `pathIgnorePatterns = ["**/dist/**"]` to prevent this — if you invoke `bun test`
  with a config that bypasses bunfig, add `--path-ignore-patterns='**/dist/**'`,
  or clear the stale build with `rm -rf backend/dist`.
* **`DATABASE_URL_TEST is not set`**: Ensure `backend/.env.test` exists. If not:
  ```bash
  cp backend/.env.test.example backend/.env.test
  ```
* **`db-test` connection hangs/timeouts**: Ensure `db-test` is running using `docker compose -f docker-compose.test.yml ps`. Spin it up if down.
* **`TRUNCATE` failures**: Make sure migrations were applied to the test DB using:
  ```bash
  docker compose exec -e DATABASE_URL=postgresql://postgres:postgres@db-test:5432/ntnu_test backend bun run migrate:up
  ```
* **Backend will not start, and `docker compose ps` shows `redis` unhealthy or exited**:
  `backend` waits for `redis` to pass its healthcheck, so a Redis that cannot
  start also blocks `migrate:up`. The usual cause is the host port: check for
  `port is already allocated` in `docker compose logs redis`, and free
  `127.0.0.1:6385` or change the mapping in `docker-compose.yml`.
* **Checking that the backend can actually reach Redis**: the backend image has
  no `redis-cli`, and its shell is not bash, so `/dev/tcp` is unavailable. Node
  is present, so use it to prove that `REDIS_URL` landed in the container and
  resolves:
  ```bash
  docker compose exec backend node -e "const u=new URL(process.env.REDIS_URL);require('net').createConnection(u.port||6379,u.hostname).on('connect',()=>{console.log('ok');process.exit(0)}).on('error',e=>{console.error(e.message);process.exit(1)})"
  ```
* **Redis logs a memory-overcommit or transparent-hugepage warning at startup**:
  expected, and safe to ignore here. Those warnings are about `fork()` for
  background saves, which this deployment disables (`--save "" --appendonly no`).
  `vm.overcommit_memory` is not namespaced, so it cannot be set per container
  anyway.

---

## 8. Git Workflow, PR Guidelines & Release Automation

### Git Branching Strategy
* **Active Development Branch**: The main development branch is `main`.
* **Feature Branches**: All feature and bugfix branches must be created from `main` (e.g. `feat/my-feature` or `fix/my-bug`).
* **Pull Requests**: Submit all Pull Requests back to the `main` branch. Direct pushes to `main` are prohibited.

### PR Merge Requirement: Squash and Merge
To keep the commit history clean and prevent cluttered changelogs, **all Pull Requests merged into `main` must use Squash and Merge**.
* **PR Title Format**: PR titles must follow [Conventional Commits](https://www.conventionalcommits.org/) format in English:
  - `feat(scope): short description` - New feature
  - `fix(scope): short description` - Bug fix
  - `docs: short description` - Documentation update
  - `refactor(scope): short description` - Code refactoring
  - `chore: short description` - Maintenance task
  - `BREAKING CHANGE:` or `feat!:` - Breaking API or schema changes
* **Squash Merge Benefit**: Squashing compresses multiple small/WIP commits in a feature branch into a single, clean conventional commit on `main`.

### Automated Version Release Flow (tag-based)
After changes merge into `main`, GitHub Actions runs CI and then Release Please prepares a reviewable Release PR:

1. **Semantic Versioning (`a.b.c`) Calculation**:
   - `fix:` → Increments **Patch (`c`)** (e.g. `v1.0.1` → `v1.0.2`)
   - `feat:` → Increments **Minor (`b`)** (e.g. `v1.0.1` → `v1.1.0`)
   - `BREAKING CHANGE:` → Increments **Major (`a`)** (e.g. `v1.0.1` → `v2.0.0`)
   - `docs:`, `chore:`, `refactor:` → No version increment
2. **Reviewable Release PR**: After the exact `main` commit passes CI, `.github/workflows/release-please.yml` creates or updates one Release PR. Its manifest-mode configuration synchronizes root, frontend, and backend `package.json`, `.release-please-manifest.json`, and `CHANGELOG.md`. No production tag is created yet.
3. **Tag & GitHub Release**: A maintainer reviews and merges the Release PR. After that merge passes CI, Release Please creates the matching `vX.Y.Z` tag and English GitHub Release.
4. **Tag → Stack Hand-off**: App token events start workflows, so the `vX.Y.Z` tag directly triggers `release-stack.yml`. The Stack workflow waits for the matching Release Please run, then appends images, attestations, the deployment bundle, and a full diff link.
5. **Stack Image & Bundle Publication**: `.github/workflows/release-stack.yml` builds & pushes Docker images to GHCR, signs provenance attestations, appends its stack section (image digests, PostgreSQL runtime, bundle SHA-256) to the existing release notes, and uploads the `near-chat-stack-vX.Y.Z.tar.gz` deployment bundle. The bundle asset — not the Release itself — is the idempotency key that marks a version as published.

For the full flow, manual entry points (`gh workflow run release-stack.yml --ref vX.Y.Z`), and a table of what to check when a release stalls, see [docs/RELEASE.md](RELEASE.md).
