# Backend Source Code Walkthrough for AI Agents

<!-- Parent: ../CLAUDE.md -->
<!-- Generated: 2026-06-14 | Updated: 2026-07-24 -->

## Purpose
This directory contains the TypeScript source code for the backend service built on Hono and Bun. It strictly implements the Hono routes-services-repositories layering pattern.

## Layer Walkthrough & Structure

| Directory | Layer & Role | Code Standards & Guidelines |
|-----------|--------------|----------------------------|
| [config/](config/) | **Configuration Layer** | [config/env.ts](config/env.ts) is the only place the backend reads `process.env`. Every variable is declared there once, with its parser, default and typed shape (`Env`); nothing else in `src/` should call `process.env` or hand-roll a coercion. `env()` re-reads on each call and never throws — bad values fall back — while `assertStartupEnv()`, called once by [index.ts](index.ts), warns about ignored values and refuses to boot without a database or a production `JWT_SECRET`. Add a new variable by adding a field here, not at the call site. |
| [bootstrap/](bootstrap/) | **Assembly Layer** | One factory per stage of startup — `config`, `repositories`, `services`, `httpApp`, `realtime`, `jobs`, `start` — called in dependency order by [index.ts](index.ts). Wiring only: no business rules, no SQL, no route handlers. Services are built before Socket.IO exists, so they receive a `getIo` accessor rather than the server itself; see the comment in `bootstrap/services.ts` before changing that order. |
| [routes/](routes/) | **Routing Layer** | Defines Hono HTTP endpoints, mounts validation middleware via `zValidator`, extracts auth context (`c.get('user')`), and delegates to the Service layer. Also holds the Zod schemas validating each route's payloads (e.g. `userSchemas.ts`, `roomSchemas.ts`, `folderSchemas.ts`, `messageSchemas.ts`). |
| [services/](services/) | **Business Logic Layer** | Domain orchestration and permission checking. Throws `AppError` subclasses. |
| [models/](models/) | **Data Access Layer** | Executes raw SQL statements, and holds the shared `pg.Pool` in `db.ts`. Repositories must conform to corresponding interfaces (e.g., `IRoomRepository.ts`) to allow mock testing. |
| [utils/](utils/) | **Shared Utilities** | Cross-cutting helpers: `AppError.ts` / `mapError.ts`, JWT and cookie handling, upload path resolution, and the `inactivityJob.ts` emergency-alert scheduler. |
| [middlewares/](middlewares/) | **Middlewares** | Intercepts HTTP requests (JWT validation in `authMiddleware.ts`, security headers, global exception catching in `errorHandler.ts`). |
| [realtime/](realtime/) | **WebSocket layer** | Handles Socket.IO connection handshakes, JWT authorization via Socket middlewares, and registers listeners for instant messages, typing indicators, and read receipts. |

## AI Agent Guidelines

### 1. Interface-Driven Design
- Repositories utilize interface declarations (e.g., `IMessageRepository`) which are instantiated in [bootstrap/repositories.ts](bootstrap/repositories.ts) and handed to services by [bootstrap/services.ts](bootstrap/services.ts).
- This structure enables unit tests to inject mocked repositories via Bun test, checking services in isolation. Always write unit tests by mocking interfaces.

### 2. JWT & Socket Authorization
- The Socket.IO server authenticates client connections via the token passed during handshake.
- Once verified, the user data is attached to `socket.user`. Inside websocket event handlers, you must retrieve the current user's ID using `socket.user.userId`.

### 3. Zod Request Validations
- Every Hono route handler receiving HTTP request payloads must validate using `validate()` / `zValidator`:
  ```typescript
  app.post('/', validate('json', createFolderSchema), async (c) => {
    const data = c.req.valid('json');
    // ...
  });
  ```
- Make sure to write Zod schemas for any new request payloads under `routes/`, in the existing `*Schemas.ts` module that owns that domain rather than one file per route module — `authRoutes.ts` and `friendRoutes.ts` both draw from `userSchemas.ts`.
