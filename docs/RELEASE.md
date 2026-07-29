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
  1. ci.yml              gate jobs → release job → Semantic Release creates commit R + tag
  2. release-bridge.yml  fires when that same ci.yml run completes → dispatches stage 3
  3. release-stack.yml   images, attestations, bundle
```

1. **`ci.yml` — Semantic Release.** After the eight gate jobs pass on the merge commit `M`, the `release` job computes the next version, runs `scripts/update-versions.js` to sync `version` across the root, `backend/package.json`, and `frontend/package.json`, updates `CHANGELOG.md`, pushes the `chore(release): X.Y.Z` commit `R` and the `vX.Y.Z` tag, and — via `@semantic-release/github` — creates the GitHub Release with the generated notes. Semantic Release owns the tag and the Release.
2. **`release-bridge.yml` — the hand-off.** Listens for that same `ci.yml` run completing on `main`. By then `R` and the tag already exist, so the bridge looks for a `vX.Y.Z` tag on `M` or on `M`'s direct child on `main` (which is `R`), checks the tag's Release does not already carry a bundle, and dispatches stage 3. When the run produced no version tag it exits quietly — most `ci.yml` runs land here.
3. **`release-stack.yml` — the stack.** Builds and pushes the four GHCR image references, signs both provenance attestations, appends its stack section to the existing release notes, and uploads `near-chat-stack-vX.Y.Z.tar.gz`.

### Why the release commit never gets its own CI run

`ci.yml` hands Semantic Release the default `secrets.GITHUB_TOKEN`, and [GitHub suppresses workflow runs for events produced by that token](https://docs.github.com/en/actions/security-for-github-actions/security-guides/automatic-token-authentication#using-the-github_token-in-a-workflow) — `workflow_dispatch` and `repository_dispatch` are the only exceptions. This applies to **both** pushes made by Semantic Release:

- pushing commit `R` to `main` does not start a `ci.yml` run for `R`;
- pushing the `vX.Y.Z` tag does not start `release-stack.yml`.

The second is why the bridge exists. The first is why stage 3's CI gate accepts a successful run for the tag commit **or its first parent**: requiring `R` to have passed CI itself would be an unsatisfiable condition.

That fallback is not unconditional. Stage 3 diffs the tag commit against its first parent and only falls back when every changed path is one of the four `@semantic-release/git` `assets` — `package.json`, `frontend/package.json`, `backend/package.json`, `CHANGELOG.md`. A commit carrying anything else must have passed CI itself, so pushing an untested commit together with a tag cannot borrow its parent's green run.

### What is still enforced

Semantic Release is the source of truth for tags. It creates **lightweight** tags, and `release-stack.yml` accepts both lightweight and annotated tags; the tag type is not checked. Stage 3 still refuses to publish unless: the tag name matches `vX.Y.Z` exactly, the numeric version matches all three `package.json` files, the tag commit is on `main`'s history, and the tag commit — or its first parent, when the tag commit changes nothing outside the four release assets — has a main CI run whose frontend lint/typecheck/build, backend build, unit, integration, E2E, and security jobs all either succeeded or were skipped by the paths filter.

### Manual entry points

Stage 3 can be dispatched by hand at any time — this is the normal way to finish a release whose bridge did not fire:

```bash
gh workflow run release-stack.yml --ref v1.0.1
```

If the tag itself is missing, push one manually. A tag pushed with your own credentials *does* trigger `release-stack.yml` directly, so this also works when the bridge is broken:

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

The four application image references and the stack artifacts attached to the GitHub Release are treated as one immutable publication. Because Semantic Release creates the Release before `release-stack.yml` runs, the existence of a Release is *not* the idempotency key — the presence of the `near-chat-stack-vX.Y.Z.tar.gz` bundle asset is. A clean first publication requires all four image references and that bundle asset to be absent; `release-stack.yml` then appends its stack section to the existing release notes and uploads the bundle. A rerun only verifies that all four references resolve to their recorded digests, both provenance attestations exist, and the Release contains the matching manifest and bundle. Partial publications, mismatched digests, missing attestations, or a bundle asset present without its images fail closed; the workflow never overwrites an existing version.

Recovering from a half-published version therefore means deleting the bundle asset and the four image references (or the whole Release and tag) by hand before rerunning.

### Where to look when a release stalls

A releasing merge produces three workflow runs. Find the last one that appeared and read the row below it:

| Runs you see | What happened | What to do |
| --- | --- | --- |
| `CI` only, `release` job green, no tag | Semantic Release found no release-worthy commits (`no release` in the job log) | Nothing. Not a failure. |
| `CI` green but the `release` job failed | Semantic Release could not compute or push the release | Read the job log. Common causes: shallow clone (`fetch-depth: 0` missing from the `release` job checkout), or the push being rejected by a branch protection rule — the default `GITHUB_TOKEN` cannot push to a protected branch. |
| `CI` + tag + Release, no `橋接 CI 至 Stack 發布` run | The bridge did not fire | Check the bridge's `workflow_run` filter still names the `CI` workflow. Dispatch stage 3 by hand meanwhile. |
| Bridge ran and exited quietly | No `vX.Y.Z` tag was found on the merge commit or its child, or the Release already has its bundle | Read the bridge's log line — it says which. Usually correct behaviour. |
| `發布完整 Near Chat Stack` failed | A stage 3 gate rejected the publication | The failing step names the reason: tag format, `package.json` version mismatch, tag not on `main`, no successful CI run for the tag commit or its parent, or a partial publication. |

There is deliberately no "second `CI` run" to look for — see "Why the release commit never gets its own CI run" above.

Once the cause is fixed, re-run stage 3 with `gh workflow run release-stack.yml --ref vX.Y.Z`. It is safe to run repeatedly: a version whose bundle is already attached takes the verify-only path and changes nothing.

Release artifacts must never contain `.env` files, credentials, database volumes or dumps containing real data, or uploaded user files.
