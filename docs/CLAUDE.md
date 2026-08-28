# Documentation Directory Orientation for AI Agents

<!-- Parent: ../CLAUDE.md -->

## Purpose
Reference documentation for the application: local setup, the REST/Socket.IO API
contract, and the PostgreSQL schema. Every document in the map below is
maintained in English with a Traditional Chinese counterpart under `ZH-TW/`.

The two exceptions are deliberate: this file (and its `AGENTS.md` symlink) is
English-only because it is read by tooling, and `archive/` is frozen as
submitted.

[README.md](README.md) and [ZH-TW/README.md](ZH-TW/README.md) are the
human-facing indexes; keep all three in agreement when adding or removing a
document.

## Document Directory Map

| Document (English) | Document (繁體中文) | Purpose & Content |
| :--- | :--- | :--- |
| [DEVELOPMENT.md](DEVELOPMENT.md) | [ZH-TW/DEVELOPMENT.md](ZH-TW/DEVELOPMENT.md) | Docker Compose setup, port allocations, environment variables, seeding, TypeScript checks, and running the test suites. |
| [api-documentation.md](api-documentation.md) | [ZH-TW/api-documentation.md](ZH-TW/api-documentation.md) | All HTTP REST routes, request parameters, JSON request/response examples, and Socket.IO client/server events. |
| [database-design.md](database-design.md) | [ZH-TW/database-design.md](ZH-TW/database-design.md) | PostgreSQL 18 table structures, UUID primary keys, foreign key constraints, default values, and index definitions. |
| [RELEASE.md](RELEASE.md) | [ZH-TW/RELEASE.md](ZH-TW/RELEASE.md) | Release and versioning process. |

## Archive

[archive/](archive/) holds the frozen course deliverables — ER diagram, graded
reports, and their screenshots. **Reference only: never modify these, and never
treat them as a current description of the system.** They describe the project as
it stood at submission time.

## Guidelines for AI Agents

### 1. Document Sync Requirement
- When updating database tables or schema constraints, you must write the SQL
  migration under `backend/migrations/` AND update both `database-design.md` and
  `ZH-TW/database-design.md`.
- When creating or modifying backend routes, controllers, or Socket.IO handlers,
  they must conform exactly to `api-documentation.md` and
  `ZH-TW/api-documentation.md`.
- Never update one language without the other. An English-only change silently
  makes the Chinese version wrong.
- **Note on Chinese API Docs**: in [ZH-TW/api-documentation.md](ZH-TW/api-documentation.md)
  all prose is Traditional Chinese, but JSON examples must remain **pure English**
  (no Chinese characters inside JSON blocks).

### 2. What Does Not Belong Here
This directory holds documentation that describes the system as it currently is.
Do **not** add:
- **ADRs / design-decision records** — the reasoning belongs in the pull request
  that makes the change, where it is reviewed alongside the diff.
- **Investigation write-ups, spike results, benchmark runs, or analysis reports** —
  point-in-time findings that go stale immediately and then never get updated.
  Put the conclusion in the PR description, and the durable part (a config value,
  a comment explaining a non-obvious choice) in the code itself.

If a finding is worth keeping, fold it into one of the maintained documents above
rather than filing it as a new standalone report.

### 3. Setup Reference
- For database synchronization errors, connection timeouts, or package installer
  issues, see the "Troubleshooting" section in [DEVELOPMENT.md](DEVELOPMENT.md).

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
