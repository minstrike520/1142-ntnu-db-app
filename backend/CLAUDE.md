# Backend API Server Directory Orientation for AI Agents

<!-- Parent: ../CLAUDE.md -->
<!-- Generated: 2026-06-14 | Updated: 2026-07-24 -->

## Purpose
This directory contains the Bun + Hono TypeScript API server for the chat application, handling HTTP REST routes, JWT authentication, Zod validation, and Socket.IO real-time websocket messaging. All persistent data is stored in PostgreSQL 18 using raw SQL.

## Key Files

| File | Description |
|------|-------------|
| [src/index.ts](src/index.ts) | Composition Root: calls the `src/bootstrap/` factories in dependency order and launches the HTTP server. Holds wiring only — no construction logic of its own |
| [src/config/env.ts](src/config/env.ts) | Typed configuration: the one place `process.env` is read, parsed and defaulted. Also holds the startup validation that fails a misconfigured process fast |
| [src/bootstrap/](src/bootstrap/) | One factory per assembly stage: `config`, `repositories`, `redis`, `services`, `httpApp`, `realtime`, `jobs`, `start` |
| [src/models/db.ts](src/models/db.ts) | Exports the shared `Bun.SQL` instance, connected to the database resolved by `src/config/env.ts` |
| [src/utils/redis.ts](src/utils/redis.ts) | Redis connection manager built on Bun's native client. Redis holds derived state only, so an outage degrades realtime rather than stopping the API |
| [src/realtime/presenceStore.ts](src/realtime/presenceStore.ts) | Cross-instance presence as per-instance leases in Redis (hash-field TTLs, Redis 7.4+). Its Redis semantics are pinned in `tests/integration/realtime/` against a real server |
| [src/realtime/redisAdapter.ts](src/realtime/redisAdapter.ts) | Cross-instance event fan-out as a Socket.IO cluster adapter over the `near-chat-ws` Redis channel. Installed only when `REDIS_URL` is set, so without it the in-memory adapter keeps realtime single-node |
| [migrations/](migrations/) | PostgreSQL migration files written in raw SQL, applied by the Bun.SQL runner in [src/models/migrate.ts](src/models/migrate.ts) |
| [package.json](package.json) | NPM scripts (`pnpm run dev` for `bun --watch`, `pnpm run test`) and dependencies |

## Subdirectories

| Directory | Purpose | Detail Orientation |
|-----------|---------|--------------------|
| [src/](src/) | TypeScript source code (routes, services, models, middlewares, realtime, utils) | See [backend/src/CLAUDE.md](src/CLAUDE.md) |
| [tests/](tests/) | Unit, integration, and E2E test suites | Written using Bun test |

## For AI Agents

### 1. Database Access & Query Policies
- Prisma has been completely removed.
- **NEVER** use Prisma or any ORM. You must use raw parameterized SQL via the `Bun.SQL` client exported from `src/models/db.ts` in repositories.
- Schema modifications must be performed by creating a new migration file under `migrations/` via `pnpm run migrate:create <name>`. Refer to existing migrations to understand table names and schema patterns.

### 2. Architecture & Layering Rules
The server strictly implements a 3-tier Hono architecture:
1. **Routes**: Mount Hono route endpoints, validate inputs via `zValidator`, extract JWT context (`c.get('user')`), and call services. (Located in `src/routes/`).
2. **Services**: Contain all business logic, authorization checks, state invariants. (Located in `src/services/`).
3. **Repositories**: Execute raw SQL queries to persist and retrieve data. (Located in `src/models/`).

Do not bypass these layers (e.g., calling repositories directly from route handlers).

### 3. Error Handling Pattern
- All errors are subclassed from the base `AppError` class (e.g., `ValidationError`, `NotFoundError`, `UnauthorizedError`).
- Services and routes throw these errors. The global `errorHandler` middleware in `src/middlewares/errorHandler.ts` catches them and sends the formatted JSON error response described in `docs/api-documentation.md`.

### 4. Socket.IO WebSocket Guidelines
- WebSockets run concurrently on the same HTTP server port (4000).
- Handshake auth expects `auth: { token }` containing the user JWT. The socket connection is verified by auth middleware and sets the decoded payload on `socket.user`.
- Consult `docs/api-documentation.md` for expected event payloads and names.

### 5. Running Tests
- Execute `pnpm run test` or `docker compose exec backend bun run test` to run all unit, integration, and E2E tests.

### 6. Frequently Used Commands
- Run a single test file quietly: `bun test tests/unit/<file>.test.ts`
- Fast feedback loop (skip integration/e2e): `pnpm run test:unit`
- Type check without building: `pnpm exec tsc --noEmit`
- Lint: `pnpm run lint`
