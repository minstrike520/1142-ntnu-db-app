# Backend Source Code Walkthrough for AI Agents

<!-- Parent: ../CLAUDE.md -->
<!-- Generated: 2026-06-14 | Updated: 2026-07-24 -->

## Purpose
This directory contains the TypeScript source code for the backend service built on Hono and Bun. It strictly implements the Hono routes-services-repositories layering pattern.

## Layer Walkthrough & Structure

| Directory | Layer & Role | Code Standards & Guidelines |
|-----------|--------------|----------------------------|
| [routes/](routes/) | **Routing Layer** | Defines Hono HTTP endpoints, mounts validation middleware via `zValidator`, extracts auth context (`c.get('user')`), and delegates to the Service layer. Also holds the Zod schemas validating each route's payloads (e.g. `userSchemas.ts`, `roomSchemas.ts`, `folderSchemas.ts`, `messageSchemas.ts`). |
| [services/](services/) | **Business Logic Layer** | Domain orchestration and permission checking. Throws `AppError` subclasses. |
| [models/](models/) | **Data Access Layer** | Executes raw SQL statements, and holds the shared `pg.Pool` in `db.ts`. Repositories must conform to corresponding interfaces (e.g., `IRoomRepository.ts`) to allow mock testing. |
| [utils/](utils/) | **Shared Utilities** | Cross-cutting helpers: `AppError.ts` / `mapError.ts`, JWT and cookie handling, upload path resolution, and the `inactivityJob.ts` emergency-alert scheduler. |
| [middlewares/](middlewares/) | **Middlewares** | Intercepts HTTP requests (JWT validation in `authMiddleware.ts`, security headers, global exception catching in `errorHandler.ts`). |
| [realtime/](realtime/) | **WebSocket layer** | Handles ticket-authenticated Bun WebSocket upgrades, connection lifecycle, typed routing, command ACK/NACK, limits, and graceful drain. |

## AI Agent Guidelines

### 1. Interface-Driven Design
- Repositories utilize interface declarations (e.g., `IMessageRepository`) which are instantiated in the composition root [index.ts](index.ts).
- This structure enables unit tests to inject mocked repositories via Bun test, checking services in isolation. Always write unit tests by mocking interfaces.

### 2. JWT & WebSocket Authorization
- REST authentication issues a short-lived, single-use WebSocket ticket; the upgrade consumes it and stores only connection metadata in the realtime manager.
- Room subscriptions are always synchronized from authoritative database membership. Membership revocation must immediately remove the transient subscription.

### 3. Zod Request Validations
- Every Hono route handler receiving HTTP request payloads must validate using `validate()` / `zValidator`:
  ```typescript
  app.post('/', validate('json', createFolderSchema), async (c) => {
    const data = c.req.valid('json');
    // ...
  });
  ```
- Make sure to write Zod schemas for any new request payloads under `routes/`, in the existing `*Schemas.ts` module that owns that domain rather than one file per route module — `authRoutes.ts` and `friendRoutes.ts` both draw from `userSchemas.ts`.
