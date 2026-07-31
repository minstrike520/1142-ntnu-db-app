# Near Chat

English | [繁體中文](README.zh-TW.md)

A real-time group chat application built as an NTNU Database Theories course project. This monorepo features a Next.js frontend, a Node.js/Express backend API using raw SQL query pools, and a PostgreSQL database orchestrating custom permissions, chat folders, message lifecycle triggers, and emergency contact alerts.

---

## Table of Contents

- [Key Features](#key-features)
- [Database & Architecture](#database--architecture)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Getting Started](#getting-started)
- [Production Deployment](#production-deployment)
- [Testing](#testing)

---

## Key Features

1. **Real-time Messaging & Status**: Seamless private and group messaging powered by Socket.IO with dynamic online status indicators.
2. **Granular Chat Room Permissions**:
   - Customizable user roles (`owner`, `admin`, `member`, `pending`).
   - Mute control (`is_muted`), room-specific custom user nicknames, and approval workflows (`require_approval`).
   - Selective history visibility for new members (`view_history`).
3. **Emergency Auto-Contact / "Last Words" Mode**: 
   - Uses scheduler rules checking users' `last_activity`.
   - When a user goes offline exceeding `warning_days`, pre-defined emergency messages are dispatched automatically to emergency contacts.
4. **Chat Folder Categorization**: Users can organize multiple chat rooms into customizable directories (`folders` and `folder_rooms`).
5. **Message Lifecycle & Actions**: Supports replying to messages (`reply_to_id`), message recalls (`is_recalled`), attachments, and soft deletes (`deleted_at`).

## Tech Stack

- **Frontend**: Next.js 16.2 (App Router), React 19, Tailwind CSS v4, Socket.IO Client.
- **Backend**: Node.js, Express v5, Socket.IO, `pg` (PostgreSQL raw client).
- **Database**: PostgreSQL 18.
- **Orchestration**: Docker & Docker Compose.
- **Package Manager**: pnpm.

## Project Structure

```text
.
├── backend/                # Express API backend
│   ├── src/                # Backend TypeScript source code (routes, controllers, services, repositories)
│   ├── migrations/         # PostgreSQL node-pg-migrate schema migrations
│   └── Dockerfile          # Backend container configurations
├── frontend/               # Next.js frontend web app
│   ├── app/                # React App Router pages and layouts
│   ├── components/         # Reusable styling & UI components
│   └── Dockerfile          # Frontend container configurations
├── shared/                 # Shared TypeScript models and types (mounted read-only)
├── docs/                   # Full documentation (DESIGN, DEVELOPMENT, TESTING, APIs)
├── docker-compose.yml      # Local multi-container development orchestration
└── README.md               # Overview and orientation index
```

## Getting Started

Detailed configuration guides can be found in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

### 1. Copy Environment Settings
Copy the development environment example file (the defaults work out of the box):
```bash
cp .env.example .env
```

Here are the key environment parameters you can configure in `.env`:

| Parameter | Description | Default Value |
| :--- | :--- | :--- |
| `DATABASE_URL` | PostgreSQL connection URL | `postgresql://chatuser:chatpassword@db:5432/chatdb` |
| `JWT_SECRET` | Secret key for signing JWT tokens | `dev_secret_key` |
| `RATE_LIMIT_DISABLED` | Disables request rate limiting for testing | `true` (Set `false` or omit in production) |
| `NEXT_PUBLIC_API_URL` | Browser-facing backend API URL | `http://localhost:4005` |
| `ALLOWED_DEV_ORIGINS` | Allowed remote origins for dev (e.g., Tailscale IPs) | *(Empty)* |
| `UPLOADS_MOUNT_SOURCE` | Storage path or Docker volume name for attachments | `app_uploads` |
| `ATTACHMENT_TYPE_RESTRICTION_ENABLED` | Enable MIME type and extension check restrictions | `false` |
| `ATTACHMENT_ALLOWED_MIME_TYPES` | Allowed upload MIME types (comma-separated list) | `image/jpeg,image/png,image/gif,application/pdf,application/zip,text/plain` |
| `ATTACHMENT_ALLOWED_EXTENSIONS` | Allowed upload extensions (comma-separated list) | `.jpg,.jpeg,.png,.gif,.pdf,.zip,.txt` |
| `ATTACHMENT_MAX_BYTES` | Maximum size cap in bytes for uploaded attachments | `10485760` (10 MB) |
| `TUNNEL_TOKEN` | Cloudflare Tunnel token for production deployment | *(Empty)* |

After modifying any environment variables in `.env` (especially database credentials or attachment limits), rebuild and restart the containers with `docker compose up -d --build` to apply the changes.

### 2. Boot Services
Build and run the containers using Docker Compose:
```bash
docker compose up -d
```
The backend container automatically runs all pending database migrations on startup before the dev server launches.
### 3. Seed Mock Data
Populate the database with pre-configured test users:
```bash
docker compose exec backend pnpm run db:seed
```
*Note: The seed script resets your database and generates 6 pre-configured users (e.g. `alice@test.com`, password: `password123`) for testing.*

### 4. Port Access Table

| Service | Address | Description |
| :--- | :--- | :--- |
| **Frontend App** | [http://localhost:3005](http://localhost:3005) | Main Next.js web application |
| **Backend API** | [http://localhost:4005](http://localhost:4005) | Express API & Socket.IO server |
| **PostgreSQL Database** | `localhost:5435` | PostgreSQL 18 instance (Mapped from internal port `5432`) |

---

## Production Deployment

The project provides a production-ready configuration using `docker-compose.prod.yml`, which runs optimized production builds (`Dockerfile.prod`) and sets up a Cloudflare Tunnel for secure remote access.

### 1. Configure Production Environment
Ensure all production environment variables (e.g., `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `DATABASE_URL`, `JWT_SECRET`, `NEXT_PUBLIC_API_URL`, `TUNNEL_TOKEN`) are configured in your `.env` file.

### 2. Boot Production Services
Build and start the services in production mode:
```bash
docker compose -f docker-compose.prod.yml up -d --build
```

### 3. Run Database Migrations
Run the pending database migrations on the production container:
```bash
docker compose -f docker-compose.prod.yml exec backend pnpm run migrate:up
```

### 4. Stopping Services
To tear down the production services:
```bash
docker compose -f docker-compose.prod.yml down
```

---

## Testing

For detailed instructions on running unit, integration, and E2E tests, please refer directly to the [Developer & Testing Guide](docs/DEVELOPMENT.md#5-testing-guide).

