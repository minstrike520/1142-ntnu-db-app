# Backend API Server Directory Orientation for AI Agents

<!-- Parent: ../CLAUDE.md -->
<!-- Generated: 2026-06-14 | Updated: 2026-06-14 -->

## Purpose
This directory contains the Express + TypeScript API server for the chat application, handling HTTP REST routes, JWT authentication, and Socket.IO real-time websocket messaging. All persistent data is stored in PostgreSQL 18 using raw SQL.

## Key Files

| File | Description |
|------|-------------|
| [src/index.ts](src/index.ts) | Composition Root: Instantiates database pool, repositories, services, controllers, routes, Socket.IO handlers, and launches the HTTP server |
| [src/db.ts](src/db.ts) | Exports the shared `pg.Pool` instance initialized from the `DATABASE_URL` environment variable |
| [migrations/](migrations/) | PostgreSQL migration files written in raw SQL managed by `node-pg-migrate` |
| [package.json](package.json) | NPM scripts (`pnpm dev` for ts-node-dev, `pnpm run test:unit`, `pnpm run test:integration`) and dev/prod dependencies |

## Subdirectories

| Directory | Purpose | Detail Orientation |
|-----------|---------|--------------------|
| [src/](src/) | TypeScript source code (routes, controllers, services, repositories) | See [backend/src/CLAUDE.md](src/CLAUDE.md) |
| [tests/](tests/) | Unit and integration test suites | Written using Vitest |

## For AI Agents

### 1. Database Access & Query Policies
- Prisma has been completely removed.
- **NEVER** use Prisma or any ORM. You must use raw SQL queries parameterized via `pool.query()` in repositories.
- Schema modifications must be performed by creating a new migration file under `migrations/` via `pnpm run migrate:create <name>`. Refer to existing migrations to understand table names and schema patterns.

### 2. Architecture & Layering Rules
The server strictly implements a 4-layer architecture:
1. **Routes**: Mount route endpoints and validate inputs. (Located in `src/routes/`).
2. **Controllers**: Parse requests, extract tokens/JWT, extract params, delegate to service, send HTTP response. (Located in `src/controllers/`).
3. **Services**: Contain all business logic, authorization checks, state invariants. (Located in `src/services/`).
4. **Repositories**: Execute raw SQL queries to persist and retrieve data. (Located in `src/repositories/`).

Do not bypass these layers (e.g., calling repositories directly from controllers).

### 3. Error Handling Pattern
- All errors are subclassed from the base `AppError` class (e.g., `ValidationError`, `NotFoundError`, `UnauthorizedError`).
- Services should throw these errors. The global `errorHandler` middleware in `src/middlewares/errorHandler.ts` catches them and sends the formatted JSON error response described in `docs/api-documentation.md`.

### 4. Socket.IO WebSocket Guidelines
- WebSockets run concurrently on the same HTTP port (4000).
- Handshake auth expects `auth: { token }` containing the user JWT. The socket connection is verified by auth middleware and sets the decoded payload on `socket.user`.
- Consult `docs/api-documentation.md` for expected event payloads and names.

### 5. Running Tests
- Unit tests run in isolation: `pnpm run test:unit`.
- Integration tests query a real, ephemeral database: `pnpm run test:db:up` spins up `db-test`, and `pnpm run test:integration` executes the test suite. Refer to `docs/DEVELOPMENT.md` for detailed commands.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
