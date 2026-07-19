# Express / Node Legacy Backend Archive

[繁體中文](ZH-TW/legacy-backend.md) | English

This document defines the frozen Express backend baseline, its supported use cases, and its maintenance policy. The archive covers the complete monorepo because the backend depends on shared types, PostgreSQL migrations, Docker configuration, frontend contracts, and documentation.

## Archive identity

| Item | Frozen value |
| --- | --- |
| Application-code baseline | `f6debb622da60afcdd8071fe32c7f327cf6b2933` (`f6debb6`) |
| Annotated release tag | `backend-express-node-v1.0.0` |
| Maintenance branch | `legacy/backend-express-node` |
| Runtime | Node.js 24 |
| Package manager | pnpm 11 |
| HTTP framework | Express 5.2.1 |
| Realtime server | Socket.IO 4.8.3 |
| Database | PostgreSQL 18 |

The release tag points to the freeze merge commit containing this policy and the archive workflows. Production application code at that commit remains based on `f6debb6`.

## Start the archived stack

Use a separate clone or worktree so that checking out the archive does not disturb Hono source files. A worktree isolates only the checkout; it does **not** isolate Docker containers, volumes, networks, or host ports. The Compose variables below are therefore required whenever this archived stack is started alongside another checkout:

```bash
export COMPOSE_PROJECT_NAME=near-chat-express-node
export COMPOSE_NETWORK_NAME=near-chat-express-node_network
export POSTGRES_HOST_PORT=55435
export BACKEND_HOST_PORT=44005
export FRONTEND_HOST_PORT=43005
export TEST_POSTGRES_HOST_PORT=55436
export NEXT_PUBLIC_API_URL=http://localhost:44005
export CORS_ORIGINS=http://localhost:43005
git fetch origin --tags
git worktree add ../near-chat-express-node backend-express-node-v1.0.0
cd ../near-chat-express-node
cp .env.example .env
docker compose up -d --build
docker compose ps
```

Replace the development secrets in `.env` before any non-local deployment. Do not run `db:seed` against data that must be preserved; the seed command resets application data.

`COMPOSE_PROJECT_NAME` gives this checkout its own `near-chat-express-node_pgdata` and `near-chat-express-node_app_uploads` named volumes, while `COMPOSE_NETWORK_NAME` and the host-port variables prevent network and port collisions. Keep these exports in the same shell for every Compose command.

With these values, the backend is available at `http://localhost:44005`, the frontend at `http://localhost:43005`, and PostgreSQL at `localhost:55435`. The backend applies pending migrations when its container starts.

## Verification and tests

The legacy CI uses Node.js 24 and pnpm 11. Every push to `legacy/backend-express-node` and every pull request targeting it runs the full frontend lint/type/build, backend build/type, unit, PostgreSQL 18 integration, E2E, and security suite regardless of changed paths. Path filters reduce work only for `main` and `dev`. To reproduce the Docker-based checks locally without using the development database:

```bash
export COMPOSE_PROJECT_NAME=near-chat-express-node
export COMPOSE_NETWORK_NAME=near-chat-express-node_network
export POSTGRES_HOST_PORT=55435
export BACKEND_HOST_PORT=44005
export FRONTEND_HOST_PORT=43005
export TEST_POSTGRES_HOST_PORT=55436
export NEXT_PUBLIC_API_URL=http://localhost:44005
export CORS_ORIGINS=http://localhost:43005
cp backend/.env.test.example backend/.env.test
docker compose up -d --build
docker compose -f docker-compose.test.yml up -d --wait
docker compose exec backend pnpm run build
docker compose exec backend pnpm exec tsc --noEmit
docker compose exec frontend pnpm run lint
docker compose exec frontend pnpm exec tsc --noEmit
docker compose exec backend pnpm run test:unit
docker compose exec -e DATABASE_URL=postgresql://postgres:postgres@db-test:5432/ntnu_test backend pnpm run migrate:up
docker compose exec backend pnpm run test:integration
docker compose exec backend pnpm run test:e2e
docker compose -f docker-compose.test.yml down
```

The test database listens on `localhost:55436`, uses tmpfs, and is isolated from the archive's project-scoped `pgdata` volume. Never use `docker compose down -v` during archive verification because it deletes this archive project's persistent development data and uploads.

## Release image and rollback

Pushing a tag matching `backend-express-node-v*` publishes both of these references from the repository-root build context and `backend/Dockerfile.prod`:

- `ghcr.io/nearcsie/near-chat-backend:express-node-v1.0.0`
- `ghcr.io/nearcsie/near-chat-backend:sha-<12-character-commit>`

Although the trigger uses a glob, publishing accepts only the exact `backend-express-node-vX.Y.Z` format. The ref must be an annotated tag whose peeled commit is both the remote `legacy/backend-express-node` HEAD and a commit with a completed successful `ci.yml` run.

The GitHub Release records the full commit SHA and content digest. Use the digest, rather than a mutable tag, for a deterministic rollback:

```bash
docker pull ghcr.io/nearcsie/near-chat-backend@sha256:<digest-from-release>
```

Before replacing Hono, back up PostgreSQL and the uploads mount, confirm the current schema is still Express-compatible, and stop only the backend service. Do not delete volumes. Deploy the digest-pinned image with the existing backend environment variables, network, port `4000`, and `/app/uploads` mount. The image runs pending legacy migrations before starting Express. If the schema has crossed the compatibility window described below, restore a tested database backup instead of attempting an unplanned `migrate:down`.

For a source-based rollback, deploy from a clean checkout of `backend-express-node-v1.0.0` with `docker-compose.prod.yml`. Record the actual Release digest in the deployment change so the binary can be audited later.

The publishing workflow treats both version and commit image references as immutable. It permits only a clean first publication (no Release and neither image reference exists) or verification of a complete existing publication (the Release exists and both references resolve to the same digest). Any image-only partial publication requires manual investigation: the workflow does not attest an existing artifact or create a missing Release around it. An existing Release is never edited; its body must already contain the expected commit SHA and digest. If a Release exists but either image reference is missing, the workflow does not rebuild because a new build could produce a different digest.

## Maintenance and database compatibility

- The maintenance branch accepts only fixes for security vulnerabilities, data loss or corruption, startup failures, and blocking compatibility defects. It does not accept features.
- Every change must use a pull request, pass the required CI, and receive at least one approval. Protect the branch by requiring only the `Legacy required checks` status; this fixed gate fails when any applicable lint, type, build, test, or security job fails or is cancelled. Direct pushes, force-pushes, and branch deletion are prohibited.
- Each accepted fix receives a patch tag such as `backend-express-node-v1.0.1`. Applicable fixes are then cherry-picked or independently ported to Hono; Hono changes are never merged back into the legacy branch.
- Until 30 calendar days after Hono is declared stable in production, migrations must remain backward-compatible with Express. Additive changes land first; readers and writers are migrated next; destructive removal or renaming occurs only after the compatibility window (expand-and-contract).
- Record the Hono stable-production date and the resulting EOL date in the project Release or tracking issue. At EOL, make the maintenance branch read-only. Tags, Releases, digests, and provenance attestations remain permanently available.

## Known limitations and archive hygiene

- This is a frozen compatibility target, not a parallel product line; feature requests belong to Hono.
- Compose resources can be isolated by the documented project, network, and host-port variables, but a separate worktree does not provide that isolation automatically. Omitting the variables may collide with another checkout's ports or `near-chat_network`.
- The development and production Dockerfiles track `node:lts-slim` and activate `pnpm@latest`. Node 24 and pnpm 11 are the validated baseline, while the published image digest is the authoritative reproducible artifact.
- Partial publication is never repaired automatically. Existing images without a Release, a single existing reference, a digest mismatch, an inconsistent existing Release, or an existing Release with missing images all require manual investigation. The workflow never signs provenance for a pre-existing artifact, never wraps it in a new Release, never overwrites published references or Releases, and never rebuilds missing images beneath an existing Release.
- Uploads are filesystem-backed and are not part of Git or the container image. They require a separate backup and restore procedure.
- Database compatibility is guaranteed only during the defined transition window. Post-EOL Hono-only destructive migrations may prevent the Express backend from starting.
- Archive tags and Releases must contain source and generated metadata only. Never commit or attach `.env` files, database volumes or dumps containing real data, uploads, tokens, credentials, or other secrets.
