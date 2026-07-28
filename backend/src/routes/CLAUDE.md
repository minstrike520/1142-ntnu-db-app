<!-- Parent: ../CLAUDE.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-05-25 -->

# routes

## Purpose
Express Router handlers defining the REST API surface for User, Room, and Message resources. Each file is responsible solely for HTTP concerns: parsing request params/body, input validation, delegating to the service layer, and setting the correct HTTP response status codes. No database logic lives here.

## Current State

**All route files in this directory were quarantined (deleted) in issue #0.** New implementations following the layered architecture are being created in issues #9–#11.

| File | Status |
|------|--------|
| `userRoutes.ts` | Deleted — reimplemented in [#9] User Controller + Auth Routes |
| `roomRoutes.ts` | Deleted — reimplemented in [#10] Room Controller + Routes |
| `messageRoutes.ts` | Deleted — reimplemented in [#11] Message Controller + Routes |

## For AI Agents

### Working In This Directory
- Do not recreate the old route files here. New implementations follow the controller pattern defined in `backend/CLAUDE.md`.
- New controllers use JWT middleware from issue #4 rather than the placeholder `(req as any).user` pattern.
- All ID params must be validated (parseInt + isNaN check) before passing to the service layer.

### Common Patterns (for new implementations)
- Route → Controller → Service → Repository is the strict call chain; routes never import database drivers directly.
- Typed `AppError` instances (from issue #2) are caught by the central error handler — no per-route error message string matching.
- `res.status(204).send()` for successful DELETE — no body.

## Dependencies

### Internal
- `../services/` — service layer (implemented in #6–#8)
- `../middleware/auth` — JWT auth middleware (implemented in #4)

### External
- `express` — `Router`, `Request`, `Response` types

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
