# Contributing to Near Chat

English | [繁體中文](CONTRIBUTING.zh-TW.md)

First off, thank you for taking the time to contribute to Near Chat! This project is a database course project, structured as a monorepo containing a React/Next.js frontend, a Bun/Hono backend API, and a PostgreSQL 18 database, orchestrated locally via Docker Compose.

Please read through this guide to understand our development, testing, and contribution workflows.

---

## Table of Contents
1. [Git Workflow & Branching](#1-git-workflow--branching)
2. [Commit Message Conventions](#2-commit-message-conventions)
3. [Language Conventions](#3-language-conventions)
4. [Database & Migration Rules](#4-database--migration-rules)
5. [Local Development & Code Verification](#5-local-development--code-verification)
6. [API & WebSocket Contract Verification](#6-api--websocket-contract-verification)
7. [Submitting a Pull Request](#7-submitting-a-pull-request)

---

## 1. Git Workflow & Branching

* **Active Development Branch**: The main branch for development is **`main`**.
* **Branching Strategy**: 
  - Always branch off `main` (e.g., `feat/my-feature` or `fix/my-bug`).
  - Submit all Pull Requests back to the `main` branch.
  - Avoid pushing changes directly to `main`.
* **Releases**: Releases are cut by pushing a version tag (e.g., `v1.2.0`) on `main`; there is no long-lived release branch.

---

## 2. Commit Message Conventions

We follow the standard [Conventional Commits](https://www.conventionalcommits.org/) specification for all commits.

### Commit Format
```
<type>(<scope>): <description>
```
* **`<type>`**: Must be in lowercase. Common types include:
  - `feat`: A new feature
  - `fix`: A bug fix
  - `refactor`: A code change that neither fixes a bug nor adds a feature
  - `docs`: Documentation only changes
  - `test`: Adding missing tests or correcting existing tests
  - `chore`: Changes to the build process or auxiliary tools and libraries
  - `perf`: A code change that improves performance
  - `ci`: Changes to CI configuration files and scripts
* **`<scope>`** (Optional): The scope of the change (e.g., `frontend`, `backend`, `db`, `shared`).
* **`<description>`**: A brief summary of the changes, written in English.

### Example Commits
* `feat(backend): add room invitation code validation`
* `fix(frontend): resolve memory leak in message list subscription`
* `docs: update setup steps in DEVELOPMENT.md`

---

## 3. Language Conventions

To ensure consistent project communications:
1. **PR title**: **English**, following Conventional Commits (e.g. `feat(vimeo): add batch thumbnail download`).
2. **PR body / PR comment / review comment**: **Traditional Chinese (繁體中文)**.
3. **Issue title / body / comment**: **Traditional Chinese (繁體中文)**.
4. **Git commit message**: **English**, following Conventional Commits.
5. **Branch name**: **English**.
6. **Code identifiers** (classes, functions, variables, types, interfaces, enums, constants, file/directory names, API and other code identifiers): **English**.

Technical terms, code identifiers, CLI commands, API names, package names, and proper nouns without a suitable Chinese translation must stay in their original English form even inside Traditional Chinese text.

---

## 4. Database & Migration Rules

* **Raw SQL Database Access**: Prisma has been completely removed from this project. We access the database using raw SQL queries.
* **Database Migrations**:
  - Do not run arbitrary SQL directly on the database to make schema changes.
  - All schema modifications must be done by writing migrations under `backend/migrations/` as plain SQL, split into `-- Up migration` and `-- Down migration` sections.
  - Refer to [docs/database-design.md](docs/database-design.md) for actual column structures, constraints, and relationships.
* **Migration Commands** (Execute inside the backend container):
  - **Create migration**: `docker compose exec backend pnpm run migrate:create <name>`
  - **Run migrations**: `docker compose exec backend pnpm run migrate:up`
  - **Rollback migrations**: `docker compose exec backend pnpm run migrate:down`

---

## 5. Local Development & Code Verification

Before submitting a Pull Request, ensure that your code compiles, conforms to styling rules, and passes all test suites locally.

### Local Setup
Ensure you have copied `.env.example` to `.env` in the project root:
```bash
cp .env.example .env
```
Start the local stack:
```bash
docker compose up -d
```
Seed the development database (clears and populates mock data):
```bash
docker compose exec backend pnpm run db:seed
```
*Note: The default password for all mock test users is `password123`.*

### Code Quality Checkpoints
1. **TypeScript Compiler Check**: Run in both folders to ensure no type errors.
   ```bash
   # Backend
   docker compose exec backend pnpm exec tsc --noEmit
   # Frontend
   docker compose exec frontend pnpm exec tsc --noEmit
   ```
2. **ESLint Checks**: Verify syntax, code style, and Hook rules compliance.
   ```bash
   docker compose exec frontend pnpm run lint
   ```
3. **Running Bun Tests**:
   - **Unit Tests**:
     ```bash
     docker compose exec backend pnpm run test:unit
     ```
   - **Integration Tests** (Runs against the ephemeral test database `db-test`):
     ```bash
     # Start test DB
     pnpm -C backend run test:db:up
     # Run migrations on test DB
     docker compose exec -e DATABASE_URL=postgresql://postgres:postgres@db-test:5432/ntnu_test backend pnpm run migrate:up
     # Run tests
     docker compose exec backend pnpm run test:integration
     # Stop test DB
     pnpm -C backend run test:db:down
     ```

For details, refer to [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

---

## 6. API & WebSocket Contract Verification

* Any changes to Hono routes, backend services, or Socket.IO events must strictly align with the payloads and models defined in [docs/api-documentation.md](docs/api-documentation.md).
* Breaking contracts will cause frontend-backend integration failures and fail CI builds.

---

## 7. Submitting a Pull Request

1. **Self-Review**: Run ESLint, Type checks, and the full test suite locally.
2. **Branch base**: Ensure the base branch of your PR is set to **`main`**.
3. **Commit Messages**: Verify your commit messages match the Conventional Commit format.
4. **Description**: Describe your changes in **Traditional Chinese (繁體中文)** using our Pull Request Template.
5. **Test Plan**: Document your verification steps clearly in the PR description.
