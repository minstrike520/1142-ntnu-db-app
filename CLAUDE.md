# Project Directory Orientation for AI Agents

<!-- Generated: 2026-06-14 | Updated: 2026-06-14 -->

## Purpose
This is a real-time group chat application built as a database course project. It is structured as a monorepo containing a Next.js/React frontend, a Bun/Hono backend API utilizing raw PostgreSQL queries, and a PostgreSQL 18 database, orchestrated locally via Docker Compose.

## Key Files for Project Orientation

| File | Description |
|------|-------------|
| [docker-compose.yml](docker-compose.yml) | Defines the local four-service development stack: `db` (PostgreSQL 18), `redis` (Redis 8), `backend` (Bun + Hono), and `frontend` (Next.js) |
| [docker-compose.prod.yml](docker-compose.prod.yml) | Defines the local four-service production stack with optimized builds and Cloudflare Tunnel |
| [.env.example](.env.example) | Template for environment variables. Must be copied to `.env` in the root folder before local runs |
| [issues.json](issues.json) | **CRITICAL TASK LIST**: Contains the active catalog of outstanding issues, bugs, refactorings, and features to implement with detailed tasks and acceptance criteria |

## Documentation Roadmap

To get details on database schemas, REST APIs, or local setups, refer to the following files in the `docs/` directory:

| Topic | Document (English) | Document (繁體中文) |
|-------|--------------------|-------------------|
| **Database Schema & Constraints** | [docs/database-design.md](docs/database-design.md) | [docs/ZH-TW/database-design.md](docs/ZH-TW/database-design.md) |
| **API Endpoints & Websocket Events** | [docs/api-documentation.md](docs/api-documentation.md) | [docs/ZH-TW/api-documentation.md](docs/ZH-TW/api-documentation.md) |
| **Local Environment Setup & Tests** | [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | [docs/ZH-TW/DEVELOPMENT.md](docs/ZH-TW/DEVELOPMENT.md) |

## Monorepo Subdirectories

| Directory | Purpose | Detail Orientation |
|-----------|---------|--------------------|
| [backend/](backend/) | Hono + Socket.IO API server | See [backend/CLAUDE.md](backend/CLAUDE.md) |
| [frontend/](frontend/) | Next.js 16 + React 19 Client Web App | See [frontend/CLAUDE.md](frontend/CLAUDE.md) |
| [shared/](shared/) | Shared TypeScript models and interfaces | Mounts read-only into both services |
| [docs/](docs/) | Design specifications and guidelines | See [docs/CLAUDE.md](docs/CLAUDE.md) |
| [reference/](reference/) | Course materials (original ER diagram, project reports) | Reference only |

## AI Agent Guidelines

### 1. Database Operations & Schema Integrity
- Prisma has been **completely removed**. The database is accessed via raw SQL.
- When modifying schemas, do not run arbitrary SQL manually on the DB. You must write migrations under [backend/migrations/](backend/migrations/) using `node-pg-migrate`.
- Refer to [docs/database-design.md](docs/database-design.md) for actual column structures, default values, and foreign keys.

### 2. API Contract Verification
- When modifying controllers, routes, or Socket.IO handlers, you must align precisely with the types and payload schemas described in [docs/api-documentation.md](docs/api-documentation.md).
- Any discrepancy will break the frontend client integration.

### 3. Local Development Workflows
- Docker Compose handles container orchestration. Root `.env` values are automatically injected.
- The `db` service must start before `backend`. Run `docker compose up -d` from the root folder.
- Run database seeding via `docker compose exec backend pnpm run db:seed`. This wipes the database and creates reproducible testing profiles (such as `alice@test.com`, password: `password123`).
- For production deployment testing:
  - Run `docker compose -f docker-compose.prod.yml up -d`.
- For more setup troubleshooting, refer to [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

### 4. Git Workflows
- The active branch is `dev`.
- Code changes should be verified with TypeScript compiler checks (`pnpm exec tsc --noEmit` on both backend and frontend) and E2E/integration tests.

### 5. GitHub Text Language
- Write all human-readable GitHub text in **Traditional Chinese (繁體中文)**: PR titles (the description after the conventional-commit prefix), PR bodies, and Issue titles/bodies/comments.
- Keep structural tokens and code in English: the conventional-commit type prefix (e.g. `fix:`, `docs:`), `Closes #<n>`, branch names, file paths, code identifiers, and any trailer/footer lines.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
