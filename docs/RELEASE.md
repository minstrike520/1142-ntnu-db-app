# Near Chat Stack Version Release

[繁體中文](ZH-TW/RELEASE.md) | English

Near Chat release tags represent a deployable stack, not only the Express backend. Starting with `v1.0.1`, every release contains the frontend image, backend image, PostgreSQL 18 runtime digest, database migration runner, and a Docker Compose bundle. The existing `v1.0.0` backend-only release is immutable and remains available for rollback.

## Publish a version

Releases are cut automatically. You never pick a version number or push a tag — merging a Conventional Commit into `main` is the entire trigger.

### What the version number comes from

Pull requests are squash-merged, so the **PR title** becomes the commit on `main` that `@semantic-release/commit-analyzer` reads:

| Commit prefix | Effect | Example |
| --- | --- | --- |
| `fix:` | Patch | `v1.0.1` → `v1.0.2` |
| `feat:` | Minor | `v1.0.1` → `v1.1.0` |
| `feat!:` or a `BREAKING CHANGE:` footer | Major | `v1.0.1` → `v2.0.0` |
| `docs:`, `chore:`, `refactor:`, `test:`, `ci:` | No release | — |

If a batch of merges contains nothing but no-release types, Semantic Release logs `no release` and the chain stops there — that is normal, not a failure.

### The three stages of a release

```
merge commit M lands on main
  1. ci.yml            lint, builds, tests, security gate
  2. release.yml       successful CI → Release App → commit R + tag + GitHub Release
  3. release-stack.yml tag push → images, attestations, bundle
```

1. **`ci.yml` — the gate.** The merge commit `M` must finish the frontend lint/typecheck/test/build, backend build/unit/integration/E2E, and dependency security jobs successfully. CI has no release credentials and does not publish anything.
2. **`release.yml` — Semantic Release.** A successful `CI` `workflow_run` on `main` starts this workflow. It creates a short-lived installation token for the dedicated Release GitHub App, computes the next version, runs `scripts/update-versions.js` to sync `version` across the root, `backend/package.json`, and `frontend/package.json`, updates `CHANGELOG.md`, pushes the `chore(release): X.Y.Z` commit `R` and the `vX.Y.Z` tag, and — via `@semantic-release/github` — creates the GitHub Release with generated notes. Semantic Release owns the tag and the Release.
3. **`release-stack.yml` — the stack.** The App's tag push directly starts this workflow. It builds and pushes the four GHCR image references, signs both provenance attestations, appends its stack section to the existing release notes, and uploads `near-chat-stack-vX.Y.Z.tar.gz`.

### Release App identity and the event chain

The default `secrets.GITHUB_TOKEN` cannot bypass the repository ruleset that restricts creation of `v*` tags. `release.yml` therefore exchanges `RELEASE_APP_CLIENT_ID` and `RELEASE_APP_PRIVATE_KEY` for a short-lived GitHub App installation token. The App is installed only on this repository, has write permission for Contents, Issues, and Pull Requests, and is the actor granted bypass for the release-tag creation ruleset.

Events created with an App installation token start workflows, which makes the direct three-stage chain possible. The release workflow itself does not start until `M` has a successful, completed CI run. Its tag push then starts Stack publication without a bridge or an Actions API dispatch.

The App also pushes `R`, so `R` gets its own `CI` run. When that run completes, it would ordinarily trigger `release.yml` again; the release guard recognizes the exact `chore(release): X.Y.Z` subject from the CI source commit and exits before requesting an App token. If `main` has advanced, the guard reuses the successful result only when every intervening commit changes paths ignored by `ci.yml`; any code, workspace, Compose, or workflow change is left to its own newer CI run. This prevents a docs-only commit from silently stranding the only releasable CI result without allowing unverified code to ship.

The tag push can start stage 3 before `R`'s CI finishes. Stage 3 therefore accepts the already-successful CI for `R`'s first parent `M`, but only after proving that `R` is the tightly scoped version-assets commit Semantic Release is expected to create. It diffs the tag commit against its first parent and only falls back when **both** hold:

- every changed path is one of the four `@semantic-release/git` `assets` — `package.json`, `frontend/package.json`, `backend/package.json`, `CHANGELOG.md`; and
- the three `package.json` files are identical to the parent's apart from `version` (compared as parsed JSON, so formatting does not matter).

The second condition is not redundant. `backend/package.json` is copied into the runtime image (`backend/Dockerfile.prod`), and its `migrate:up` script is what the image's `CMD` and the release bundle's `migrate` service actually execute — a commit that bumps all three versions correctly while quietly editing that script would otherwise ship unreviewed behaviour into production on a borrowed green run. `CHANGELOG.md` is checked by path only: no Dockerfile copies it and nothing executes it, so the worst case is inaccurate release notes.

Anything failing either condition must have passed CI as itself.

Semantic Release pushes the tag immediately before `@semantic-release/github` creates the GitHub Release. When stage 3 starts from that tag, it waits for the active `release.yml` run to reach a terminal state so the two workflows cannot race to create the same Release. If the upstream publish failed after pushing the tag, stage 3 continues through the existing recovery path and creates the Release itself. A bounded timeout fails closed and can be retried through the manual entry point.

### What is still enforced

Semantic Release is the source of truth for tags. It creates **lightweight** tags, and `release-stack.yml` accepts both lightweight and annotated tags; the tag type is not checked. Stage 3 still refuses to publish unless: the tag name matches `vX.Y.Z` exactly, the numeric version matches all three `package.json` files, the tag commit is on `main`'s history, and the tag commit — or its first parent, when the tag commit changes nothing outside the four release assets — has a main CI run whose frontend lint/typecheck/build, backend build, unit, integration, E2E, and security jobs all either succeeded or were skipped by the paths filter.

### Manual entry points

Stage 3 can be dispatched by hand at any time — this is the normal way to retry a tag whose Stack workflow did not finish:

```bash
gh workflow run release-stack.yml --ref v1.0.1
```

If the tag itself is missing, push one manually. The tag push directly starts stage 3:

```bash
git switch main
git pull --ff-only origin main
git tag v1.0.1
git push origin v1.0.1
```

If no GitHub Release exists for the tag, `release-stack.yml` creates one itself. Never hand-create a tag for a version Semantic Release has already released; see "Immutability and failure handling" below.

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

The four application image references and the stack artifacts attached to the GitHub Release are treated as one immutable publication. Semantic Release normally creates the Release immediately after pushing the tag, and `release-stack.yml` waits for the active upstream workflow to finish; nevertheless, the existence of a Release is *not* the idempotency key — the presence of the `near-chat-stack-vX.Y.Z.tar.gz` bundle asset is. A clean first publication requires all four image references and that bundle asset to be absent; `release-stack.yml` then appends its stack section to the existing release notes and uploads the bundle. A rerun only verifies that all four references resolve to their recorded digests, both provenance attestations exist, and the Release contains the matching manifest and bundle. Partial publications, mismatched digests, missing attestations, or a bundle asset present without its images fail closed; the workflow never overwrites an existing version.

Recovering from a half-published version therefore means deleting the bundle asset and the four image references (or the whole Release and tag) by hand before rerunning.

### Where to look when a release stalls

A releasing merge has three publication stages, plus an expected validation `CI` and guarded `release.yml` run for version commit `R`. Find the last stage that appeared and read the row below it:

| Runs you see | What happened | What to do |
| --- | --- | --- |
| `CI` failed | A quality or security gate rejected the merge commit | Read the failing CI job. `release.yml` correctly does not run. |
| `CI` green, `release.yml` green, no tag | Semantic Release found no release-worthy commits (`no release` in the job log), skipped a version commit, or deferred to a newer CI because `main` gained CI-relevant paths | Read the guard and Semantic Release log. These are normally expected outcomes. |
| `release.yml` failed | Semantic Release could not compute or push the release | Common causes are shallow history, invalid `RELEASE_APP_CLIENT_ID` / `RELEASE_APP_PRIVATE_KEY`, missing App permissions or installation, or the App not being listed in the tag ruleset bypass actors. |
| Tag exists but no `發布完整 Near Chat Stack` run | The App-generated tag event did not start stage 3 | Check that `release-stack.yml` still listens for `push.tags: v*`; dispatch stage 3 by hand meanwhile. |
| `發布完整 Near Chat Stack` failed | A stage 3 gate rejected the publication | The failing step names the reason: tag format, `package.json` version mismatch, tag not on `main`, no successful CI run for the tag commit or its parent, or a partial publication. |

A releasing merge normally creates a second `CI` run for the `chore(release): X.Y.Z` commit. It is expected and performs validation only; its downstream `release.yml` run exits at the release-commit guard, preventing a loop.

Once the cause is fixed, re-run stage 3 with `gh workflow run release-stack.yml --ref vX.Y.Z`. It is safe to run repeatedly: a version whose bundle is already attached takes the verify-only path and changes nothing.

Release artifacts must never contain `.env` files, credentials, database volumes or dumps containing real data, or uploaded user files.
