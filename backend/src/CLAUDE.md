# Backend Source Code Walkthrough for AI Agents

<!-- Parent: ../CLAUDE.md -->
<!-- Generated: 2026-06-14 | Updated: 2026-06-14 -->

## Purpose
This directory contains the TypeScript source code for the backend service. It strictly implements the routes-controllers-services-repositories layering pattern.

## Layer Walkthrough & Structure

| Directory | Layer & Role | Code Standards & Guidelines |
|-----------|--------------|----------------------------|
| [routes/](routes/) | **Routing Layer** | Defines HTTP endpoints and mounts Express controllers. Mounts middlewares like `authMiddleware`. Does not contain inline business logic. |
| [controllers/](controllers/) | **Controller Layer** | Binds Express request/response. Uses Zod schemas for request validation. Bypasses core logic by calling Service layer methods. Formats return JSON envelopes. |
| [services/](services/) | **Business Logic Layer** | Domain orchestration and permission checking. Throws `AppError` subclasses. |
| [repositories/](repositories/) | **Data Access Layer** | Executes raw SQL statements. Repositories must conform to corresponding interfaces (e.g., `IRoomRepository.ts`) to allow mock testing. |
| [validators/](validators/) | **Validation Schemas** | Contains Zod validation schemas (e.g. `userSchemas.ts`, `roomSchemas.ts`, `folderSchemas.ts`) to validate HTTP payload structures. |
| [middlewares/](middlewares/) | **Middlewares** | Intercepts HTTP requests (JWT validation in `authMiddleware.ts`, global exception catching in `errorHandler.ts`). |
| [realtime/](realtime/) | **WebSocket layer** | Handles Socket.IO connection handshakes, JWT authorization via Socket middlewares, and registers listeners for instant messages, typing indicators, and read receipts. |

## AI Agent Guidelines

### 1. Interface-Driven Design
- Repositories utilize interface declarations (e.g., `IMessageRepository`) which are instantiated in the composition root [index.ts](index.ts).
- This structure enables unit tests to inject mocked repositories via Vitest, checking services in isolation. Always write unit tests by mocking interfaces.

### 2. JWT & Socket Authorization
- The Socket.IO server authenticates client connections via the token passed during handshake.
- Once verified, the user data is attached to `socket.user`. Inside websocket event handlers, you must retrieve the current user's ID using `socket.user.userId`.

### 3. Zod Request Validations
- Every controller receiving HTTP requests must parse the payload using Zod safe parsing:
  ```typescript
  const parsed = createFolderSchema.safeParse(req.body);
  if (!parsed.success) return next(new ValidationError('Invalid data'));
  ```
- Make sure to write Zod schemas for any new request payloads.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
