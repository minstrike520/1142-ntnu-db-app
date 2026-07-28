<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-07-24 -->

# routes

## Purpose
Hono Route modules defining the REST API surface for User, Room, Message, Friend, Folder, and Attachment resources. Each file is responsible for HTTP concerns: routing, input validation via `zValidator`, extracting context (`c.get('user')`), delegating to the service layer, and setting appropriate HTTP response status codes.

## Current State

| File | Status | Description |
|------|--------|-------------|
| `authRoutes.ts` | Active | Registration, login, logout, refresh token endpoints |
| `userRoutes.ts` | Active | Profile, settings, emergency contacts, search endpoints |
| `roomRoutes.ts` | Active | Group & private room management, membership endpoints |
| `messageRoutes.ts` | Active | Room messages listing, editing/recalling endpoints |
| `friendRoutes.ts` | Active | Friends, pending requests, and blocking endpoints |
| `folderRoutes.ts` | Active | Chat room folder organization endpoints |
| `attachmentRoutes.ts` | Active | Attachment upload and download endpoints |

## For AI Agents

### Working In This Directory
- Hono route modules export factory functions (e.g. `makeRoomRoutes(service: RoomService)`) returning a Hono app instance.
- Routes use `authMiddleware` for authentication and `validate(target, schema)` (`zValidator`) for request payload validation.
- All errors (subclassed from `AppError`) are handled by the global `errorHandler` middleware.
- Return `c.body(null, 204)` for successful DELETE operations.
