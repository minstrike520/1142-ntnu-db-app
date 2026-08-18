# Documentation

Reference documentation for Near Chat — a real-time group chat application built
as an NTNU Database Theories course project.

Each reference document below is maintained in English and Traditional Chinese.
The two versions are kept in sync; if they disagree, the English version is
authoritative. 繁體中文索引請見 [ZH-TW/README.md](ZH-TW/README.md)。

| Document | English | 繁體中文 |
| :--- | :--- | :--- |
| Local setup, ports, seeding and running the test suites | [DEVELOPMENT.md](DEVELOPMENT.md) | [ZH-TW/DEVELOPMENT.md](ZH-TW/DEVELOPMENT.md) |
| REST endpoints, payload schemas and Socket.IO events | [api-documentation.md](api-documentation.md) | [ZH-TW/api-documentation.md](ZH-TW/api-documentation.md) |
| PostgreSQL 18 schema: tables, constraints, indexes | [database-design.md](database-design.md) | [ZH-TW/database-design.md](ZH-TW/database-design.md) |
| Release and versioning process | [RELEASE.md](RELEASE.md) | [ZH-TW/RELEASE.md](ZH-TW/RELEASE.md) |

## Elsewhere in the repository

- [../README.md](../README.md) — project overview and quick start
- [../CONTRIBUTING.md](../CONTRIBUTING.md) — branching, commit conventions, language
  rules and the pre-submit checklist
- [CLAUDE.md](CLAUDE.md) — orientation for AI coding agents working in this
  directory (symlinked as `AGENTS.md`). Agent instruction files are kept in
  English only: they are read by tooling, and a second copy would drift.

## Archive

[archive/](archive/) holds the frozen course deliverables — the original ER
diagram, the graded reports and their screenshots. It is kept for provenance and
is **not** maintained alongside the code; see [archive/README.md](archive/README.md).
