# Backend Source Code Walkthrough for AI Agents

<!-- Parent: ../CLAUDE.md -->
<!-- Generated: 2026-06-14 | Updated: 2026-07-24 -->

## Purpose
This directory contains the TypeScript source code for the backend service built on Hono and Bun. It strictly implements the Hono routes-services-repositories layering pattern.

## Layer Walkthrough & Structure

| Directory | Layer & Role | Code Standards & Guidelines |
|-----------|--------------|----------------------------|
| [config/](config/) | **Configuration Layer** | [config/env.ts](config/env.ts) is the only place the backend reads `process.env`. Every variable is declared there once, with its parser, default and typed shape (`Env`); nothing else in `src/` should hand-roll a coercion. The only permitted mention of `process.env` elsewhere is a `source: NodeJS.ProcessEnv = process.env` parameter default forwarded straight to `env(source)`, so a test can inject a literal environment — `utils/attachmentUploadConfig.ts` and the two resolvers in `utils/logger.ts` are the cases. `models/migrate.ts` sits outside the rule by design: it is a standalone CLI that must run when the application cannot boot, and its connection target should become an explicit argument rather than an ambient variable (#597). `env()` re-reads on each call and never throws — bad values fall back — while `assertStartupEnv()`, called once by [index.ts](index.ts), warns about ignored values and refuses to boot without a database or a production `JWT_SECRET`. Add a new variable by adding a field here, not at the call site. |
| [bootstrap/](bootstrap/) | **Assembly Layer** | One factory per stage of startup — `config`, `repositories`, `services`, `httpApp`, `realtime`, `jobs`, `start` — called in dependency order by [index.ts](index.ts). Wiring only: no business rules, no SQL, no route handlers. Services publish through the transport-independent `RealtimePublisher`; the composition root binds that publisher to Socket.IO after the Bun engine is assembled. |
| [routes/](routes/) | **Routing Layer** | Defines Hono HTTP endpoints, mounts validation middleware via `zValidator`, extracts auth context (`c.get('user')`), and delegates to the Service layer. Also holds the Zod schemas validating each route's payloads (e.g. `userSchemas.ts`, `roomSchemas.ts`, `folderSchemas.ts`, `messageSchemas.ts`). |
| [services/](services/) | **Business Logic Layer** | Domain orchestration and permission checking. Throws `AppError` subclasses. |
| [models/](models/) | **Data Access Layer** | Executes raw SQL statements, and holds the shared `Bun.SQL` client in `db.ts`. Repositories must conform to corresponding interfaces (e.g., `IRoomRepository.ts`) to allow mock testing. |
| [utils/](utils/) | **Shared Utilities** | Cross-cutting helpers: `AppError.ts` / `mapError.ts`, JWT and cookie handling, upload path resolution, and the `inactivityJob.ts` emergency-alert scheduler. |
| [middlewares/](middlewares/) | **Middlewares** | Intercepts HTTP requests (JWT validation in `authMiddleware.ts`, security headers, global exception catching in `errorHandler.ts`). |
| [realtime/](realtime/) | **Realtime layer** | Handles Socket.IO connection handshakes, JWT authorization, durable room subscriptions, presence, and ephemeral typing. Durable message commands and read positions use REST; the publisher sends their committed events to sockets. |

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
