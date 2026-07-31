# Documentation Directory Orientation for AI Agents

<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-14 | Updated: 2026-06-14 -->

## Purpose
This directory contains the system architecture designs, database constraints, API route specifications, Socket.IO websocket event definitions, local environment setup instructions, and testing guidelines.

## Document Directory Map

| Document Name (English) | Document Name (繁體中文) | Purpose & Content |
| :--- | :--- | :--- |
| [DEVELOPMENT.md](DEVELOPMENT.md) | [ZH-TW/DEVELOPMENT.md](ZH-TW/DEVELOPMENT.md) | Setup instructions for Docker Compose, port allocations, environment variables, seeding, TypeScript validation checks, and running integration tests. |
| [database-design.md](database-design.md) | [ZH-TW/database-design.md](ZH-TW/database-design.md) | Aligned PostgreSQL 18 table structures, UUID primary keys, foreign key constraints, default values, and index definitions. |
| [api-documentation.md](api-documentation.md) | [ZH-TW/api-documentation.md](ZH-TW/api-documentation.md) | Comprehensive specification of all HTTP REST routes, request parameters, JSON request/response examples, and Socket.IO real-time client/server events. |

## Assets & Reports

- **ER Diagram Visuals**:
  - [ER_Digram.png](ER_Digram.png): PNG image of the system ER diagram.
  - [ER_Digram.drawio](ER_Digram.drawio): Editable source draw.io XML file.
- **Historical Snapshots**:
  - [reports/](reports/): Directory hosting historical course project reports (`report-1.md`, `report-2.md`, `report-3.md`). **Reference only, do not modify these**.

## Guidelines for AI Agents

### 1. Document Sync Requirement
- When updating database tables or schema constraints, you must write SQL migrations in `backend/migrations/` AND update both `database-design.md` and `ZH-TW/database-design.md` to keep documentation accurate.
- When creating or modifying backend routes, controllers, or Socket.IO handlers, you must ensure that they conform exactly to `api-documentation.md` and `ZH-TW/api-documentation.md`.
- **Note on Chinese API Docs**: For [ZH-TW/api-documentation.md](ZH-TW/api-documentation.md), all descriptions are in Traditional Chinese, but all JSON examples must remain in **pure English** (no Chinese characters inside JSON blocks).

### 2. Setup Reference
- If you run into database synchronization errors, connection timeouts, or package installer issues, always refer to the "Troubleshooting" section in [DEVELOPMENT.md](DEVELOPMENT.md).

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
