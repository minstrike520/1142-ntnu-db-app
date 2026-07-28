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

For browser-facing frontend requests, set the API environment variable to:
```env
NEXT_PUBLIC_API_URL=http://localhost:4005
```

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
- **Rollback migrations**: `docker compose exec backend bun run migrate:down`
- **Seed database**: `docker compose exec backend bun run db:seed`

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
When changes are merged into `main`, GitHub Actions (`.github/workflows/ci.yml`) automatically triggers the `release` job running `semantic-release` upon CI completion:

1. **Semantic Versioning (`a.b.c`) Calculation**:
   - `fix:` → Increments **Patch (`c`)** (e.g. `v1.0.1` → `v1.0.2`)
   - `feat:` → Increments **Minor (`b`)** (e.g. `v1.0.1` → `v1.1.0`)
   - `BREAKING CHANGE:` → Increments **Major (`a`)** (e.g. `v1.0.1` → `v2.0.0`)
   - `docs:`, `chore:`, `refactor:` → No version increment
2. **Multi-Package Version Sync**: Runs `scripts/update-versions.js` to synchronize `"version"` in root `package.json`, `frontend/package.json`, and `backend/package.json`.
3. **Changelog & GitHub Release**: Automatically generates `CHANGELOG.md` and publishes formatted **Release Notes directly on the GitHub Release page**.
4. **Stack Image & Bundle Publication**: Creating tag `vX.Y.Z` triggers `.github/workflows/release-stack.yml`, building & pushing Docker images to GHCR, signing provenance attestations, and attaching `near-chat-stack-vX.Y.Z.tar.gz` deployment bundle to the GitHub Release.

