# Near Chat Stack Version Release

[繁體中文](ZH-TW/backend-release.md) | English

Near Chat release tags represent a deployable stack, not only the Express backend. Starting with `v1.0.1`, every release contains the frontend image, backend image, PostgreSQL 18 runtime digest, database migration runner, and a Docker Compose bundle. The existing `v1.0.0` backend-only release is immutable and remains available for rollback.

## Publish a version

Publishing starts only when an annotated tag exactly matching `vX.Y.Z` is pushed. The numeric version must match the root, `backend/package.json`, and `frontend/package.json` files. The tag must point to the current `main` HEAD, and that commit must have a successful main CI run containing frontend lint/typecheck/build, backend build, unit, integration, E2E, and security jobs.

```bash
git switch main
git pull --ff-only origin main
git tag -a v1.0.1 -m "Near Chat Stack v1.0.1"
git push origin v1.0.1
```

The workflow publishes two immutable application images, each with a version tag and commit tag:

- `ghcr.io/nearcsie/near-chat-backend:1.0.1`
- `ghcr.io/nearcsie/near-chat-backend:sha-<12-character-commit>`
- `ghcr.io/nearcsie/near-chat-frontend:1.0.1`
- `ghcr.io/nearcsie/near-chat-frontend:sha-<12-character-commit>`

It also records the pinned PostgreSQL runtime (`postgres:18-alpine`), both image digests, provenance attestations, and a `near-chat-stack-vX.Y.Z.tar.gz` deployment bundle in the Traditional Chinese GitHub Release. No mutable `latest` tag is published.

## Deploy the release bundle

Download the bundle from the GitHub Release, extract it, copy the environment example, and replace every placeholder with deployment-specific values. The example contains no credentials.

```bash
tar -xzf near-chat-stack-v1.0.1.tar.gz
cd near-chat-stack-v1.0.1
cp near-chat.env.example .env
docker compose --env-file .env -f docker-compose.release.yml up -d
```

The Compose bundle starts PostgreSQL, runs `pnpm run migrate:up` once from the pinned backend image, then starts the backend and frontend. PostgreSQL data and uploaded files remain in deployment-managed volumes; they are never included in the image or Release archive.

For production deployments, keep `BACKEND_IMAGE` and `FRONTEND_IMAGE` pinned to the manifest's digest references. The frontend image is built with `http://localhost:4005` as the default API URL; the existing frontend runtime logic maps the standard `3005`/`4005` host ports, while a different public topology requires a separately configured build.

## Database compatibility

The database runtime is fixed to PostgreSQL 18 Alpine by digest. The schema is versioned by `backend/migrations` and shipped inside the backend image; the `migrate` service applies pending migrations before the application starts. Never publish a database volume or real data dump as a release artifact. Destructive schema changes must follow expand-and-contract and remain compatible with the legacy Express deployment during the migration window.

## Immutability and failure handling

The four application image references and the GitHub Release are treated as one immutable publication. A clean first publication requires all four image references and the Release to be absent. A rerun only verifies that all four references resolve to their recorded digests, both provenance attestations exist, and the Release contains the matching manifest and bundle. Partial publications, mismatched digests, missing attestations, or missing bundle assets fail closed; the workflow never overwrites an existing version.

Release artifacts must never contain `.env` files, credentials, database volumes or dumps containing real data, or uploaded user files.
