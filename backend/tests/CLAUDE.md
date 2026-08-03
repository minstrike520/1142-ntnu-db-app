<!-- Parent: ../CLAUDE.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-05-25 -->

# tests

## Purpose
Bun test integration tests for the backend service layer. Tests call the actual service functions against a real PostgreSQL database — no mocking. Each suite manages its own test data via `beforeAll`/`afterAll` setup and teardown.

## Current State

**Test files were quarantined (deleted) in issue #0** along with the service files they depended on. New integration tests are being written alongside each service reimplementation in issues #6–#8.

| File | Status |
|------|--------|
| `user.test.ts` | Deleted — new tests written in [#6] userService |
| `room.test.ts` | Deleted — new tests written in [#7] roomService |

## For AI Agents

### Working In This Directory
- Tests require a live PostgreSQL database; start the test DB with `docker compose -f docker-compose.test.yml up -d` before running.
- Run all tests from `backend/`: `bun run test` for a single pass. It runs the unit, integration and e2e tiers as three separate processes on purpose — a bare `bun test` loads all three into one runner, where the unit tier's process-global `mock.module()` calls leak into the tiers that need a real database.
- Test isolation: each suite creates a unique named record in `beforeAll` and deletes it in `afterAll`. Avoid using names like "TestRoomForAPI" or "TestUserAPI" in manual DB operations to prevent conflicts.
- Do not reach for `mock.module()` to stub a collaborator. It is process-global *within* a tier too, and it cannot be undone: re-registering the module in `afterAll` via the `?original` specifier does not restore the binding, so every later test file in the same process keeps the stub. That made `utils/avatarUpload.test.ts` pass or fail purely on test-file enumeration order (issue #467). Inject the collaborator instead — give the service factory a trailing optional parameter that defaults to the real implementation (see `AvatarStore` / `defaultAvatarStore` in `src/utils/avatarUpload.ts`), and pass a stub from the test.

### Testing Requirements
- `DATABASE_URL_TEST` env var must be set before running tests (points to the ephemeral test DB). Copy `.env.test.example` to `.env.test`.
- Tests are integration tests — they mutate real data. Do not run against a production database.

### Common Patterns (for new implementations)
- Pattern: `beforeAll` creates → tests use the created ID → `afterAll` deletes.
- Non-existent record tests use IDs `999999`/`999998` — safe to assume these don't exist in test environments.
- `expect(...).rejects.toThrow(message)` is the pattern for testing service-layer error messages.

## Dependencies

### Internal
- `../src/services/` — tested modules (reimplemented in #6–#8)

### External
- `bun:test` — test runner (imported as `describe`, `it`, `expect`, `beforeAll`, `afterAll`)

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
