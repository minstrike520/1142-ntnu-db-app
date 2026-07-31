<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-05-25 -->

# services

## Purpose
Business-logic layer for User, Room, and Message operations. Each service module exports typed async functions for a single entity, delegating persistence to the repository layer.

## Current State

**All service files in this directory were quarantined (deleted) in issue #0** because the original implementations depended on Prisma, which has been removed from the project. New implementations using `pg` and the repository pattern are being created in issues #6–#11.

| File | Status |
|------|--------|
| `userService.ts` | Deleted — reimplemented in [#6] userService |
| `roomService.ts` | Deleted — reimplemented in [#7] roomService |
| `messageService.ts` | Deleted — reimplemented in [#8] messageService |

## For AI Agents

### Working In This Directory
- Do not recreate the old service files here. New implementations follow the layered architecture defined in `backend/AGENTS.md`.
- New service files will depend on repository interfaces (from issue #5a), not direct `pg` queries.
- Services should throw typed `AppError` instances (from issue #2), not raw `Error` objects.
- Room-scoped operations (messages) must enforce membership before mutation — this is a security boundary.

### Common Patterns (for new implementations)
- All functions are `async` and return typed objects matching `shared/types.ts`.
- Single-record lookups throw `AppError` with a 404 code if not found.
- Business rules (e.g., membership checks, password hashing) live in the service, not the repository.

## Dependencies

### Internal
- `../repositories/` — repository interfaces for data access
- `../../shared/types` — shared API contract types
- `../../db` — pg pool (accessed only through repositories)

### External
- `bcryptjs` — password hashing in userService
- `zod` — input validation

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
