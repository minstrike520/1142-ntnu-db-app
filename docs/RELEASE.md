# Near Chat Stack Version Release

[繁體中文](ZH-TW/RELEASE.md) | English

Near Chat release tags represent a deployable stack, not only the Express backend. Starting with `v1.0.1`, every release contains the frontend image, backend image, PostgreSQL 18 runtime digest, database migration runner, and a Docker Compose bundle. The existing `v1.0.0` backend-only release is immutable and remains available for rollback.

## Publish a version

Releases are cut automatically. Merging a Conventional Commit into `main` runs the `release` job in `.github/workflows/ci.yml`, which runs Semantic Release: it computes the next version, syncs `version` across the root, `backend/package.json`, and `frontend/package.json`, updates `CHANGELOG.md`, pushes the version commit and the `vX.Y.Z` tag, and creates the GitHub Release with the generated notes. `.github/workflows/release-stack.yml` then adds the stack artifacts — images, provenance attestations, and the deployment bundle — to that same Release.

Semantic Release is the source of truth for tags. It creates **lightweight** tags, and `release-stack.yml` accepts both lightweight and annotated tags; the tag type is not checked. What is still enforced: the tag name must match `vX.Y.Z` exactly, the numeric version must match all three `package.json` files, the tag must point to the current `main` HEAD, and that commit must have a successful main CI run containing frontend lint/typecheck/build, backend build, unit, integration, E2E, and security jobs.

As a fallback — when the automated chain fails and a version has to be published by hand — pushing a tag manually still works:

```bash
git switch main
git pull --ff-only origin main
git tag v1.0.1
git push origin v1.0.1
```

If no GitHub Release exists for the tag, `release-stack.yml` creates one itself. Never create a tag by hand for a version Semantic Release has already released; see "Immutability and failure handling" below.

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

The four application image references and the stack artifacts attached to the GitHub Release are treated as one immutable publication. Because Semantic Release creates the Release before `release-stack.yml` runs, the existence of a Release is *not* the idempotency key — the presence of the `near-chat-stack-vX.Y.Z.tar.gz` bundle asset is. A clean first publication requires all four image references and that bundle asset to be absent; `release-stack.yml` then appends its stack section to the existing release notes and uploads the bundle. A rerun only verifies that all four references resolve to their recorded digests, both provenance attestations exist, and the Release contains the matching manifest and bundle. Partial publications, mismatched digests, missing attestations, or a bundle asset present without its images fail closed; the workflow never overwrites an existing version.

Recovering from a half-published version therefore means deleting the bundle asset and the four image references (or the whole Release and tag) by hand before rerunning.

Release artifacts must never contain `.env` files, credentials, database volumes or dumps containing real data, or uploaded user files.
