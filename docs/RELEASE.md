# Near Chat Stack Version Release

[繁體中文](ZH-TW/RELEASE.md) | English

Near Chat release tags represent a deployable stack, not only one application package. Starting with `v1.0.1`, every release contains the frontend image, backend image, PostgreSQL 18 runtime digest, database migration runner, and a Docker Compose bundle. The existing `v1.0.0` backend-only release is immutable and remains available for rollback.

## Publish a version

Release Please prepares releases behind a reviewable pull request. A normal merge into `main` never creates a production tag by itself.

### What the version number comes from

Pull requests are squash-merged, so the **PR title** becomes the Conventional Commit on `main` that Release Please reads:

| Commit prefix | Effect | Example |
| --- | --- | --- |
| `fix:` | Patch | `v1.0.1` → `v1.0.2` |
| `feat:` | Minor | `v1.0.1` → `v1.1.0` |
| `feat!:` or a `BREAKING CHANGE:` footer | Major | `v1.0.1` → `v2.0.0` |
| `docs:`, `chore:`, `refactor:`, `test:`, `ci:` | No release | — |

If the unreleased commits contain only no-release types, Release Please does not open a Release PR. That is normal, not a failure.

### Review and publish flow

```
normal PR merge → CI → release-please.yml → create/update Release PR
Release PR review and merge → CI → release-please.yml → vX.Y.Z + GitHub Release
vX.Y.Z push → release-stack.yml → images + attestations + bundle
```

1. **`ci.yml` — the gate.** Every `main` commit produces a completed CI run. A single `detect` job decides which lanes must run, so documentation-only commits skip the expensive ones; code changes must pass the frontend lane (lint/typecheck/test/build), the backend lane (lint/unit/build), the database lane (integration and E2E against Postgres), the browser lane (Playwright smoke tests in Chromium against a production frontend build), and the dependency security lane. Those lanes are reusable workflows, and one aggregate job — `required-checks` — collapses their outcomes into the single status check that branch protection and the release workflow rely on. CI has no release credentials and publishes nothing.
2. **`release-please.yml` — the review boundary.** After the exact `main` commit passes CI, Release Please parses its Conventional Commits. It creates or updates one Release PR using `release-please-config.json` and `.release-please-manifest.json`. The PR proposes the version, updates `CHANGELOG.md`, and synchronizes `version` in the root, backend, and frontend `package.json` files. No tag is created while this PR remains open.
3. **Merge the Release PR.** A maintainer checks the proposed version, English changelog structure, and all four version files before merging. After that merge passes CI, Release Please creates the matching `vX.Y.Z` tag and GitHub Release. The tag points to the reviewed commit containing the three synchronized package versions, manifest version, and changelog.
4. **`release-stack.yml` — the stack.** The App-generated tag push starts this workflow. It builds and pushes four immutable GHCR references, signs both provenance attestations, appends an English Stack section with a full diff link to the GitHub Release, and uploads `near-chat-stack-vX.Y.Z.tar.gz`.

The repository is configured as one logical release package at path `.`. Backend and frontend are `extra-files`, not independently versioned components, so a release produces one tag and one version shared by the whole Stack.

### Release App identity and the event chain

The default `secrets.GITHUB_TOKEN` does not start workflows for resources it creates and cannot bypass the ruleset that restricts `v*` tags. `release-please.yml` therefore exchanges `RELEASE_APP_CLIENT_ID` and `RELEASE_APP_PRIVATE_KEY` for a short-lived installation token. The App must be installed on this repository with write permission for Contents, Issues, and Pull Requests. It must also be an allowed bypass actor for the tag ruleset.

The repository's "Allow GitHub Actions to create and approve pull requests" setting only controls `GITHUB_TOKEN`; it can remain disabled because this workflow uses the dedicated App token and never approves its own PR. The repository currently has no branch protection rule that blocks an App-created Release PR. If protection is added later, it must allow the App to create and update the PR branch while retaining the normal checks and maintainer-controlled merge into `main`. App installation-token events start workflows, so the Release PR gets CI and the `vX.Y.Z` push starts Stack publication without an Actions API dispatch bridge.

If `main` advances after a CI run completes, the older Release Please run exits without using release credentials and leaves the work to the newer run. This keeps the tag source equal to the commit that passed CI. Because Release Please creates the tag before it finishes creating the GitHub Release, `release-stack.yml` waits for the matching Release Please run before it reads or recovers the Release.

### What is still enforced

Release Please is the source of truth for tags. `release-stack.yml` refuses to publish unless the tag matches `vX.Y.Z` exactly, its numeric version equals all three `package.json` versions, the tag commit is in `main` history, and that exact commit has a successful main CI run containing a successful `required-checks` job. `required-checks` is where lane-level judgement lives: a lane that `detect` marked as required must have succeeded, a lane that was legitimately not required may be skipped, and any failed or cancelled lane fails the gate. The release workflow therefore names no individual lane, so lanes can be renamed, split, or added without touching it.

### Manual entry points

Stage 3 can be dispatched by hand at any time — this is the normal way to retry a tag whose Stack workflow did not finish:

```bash
gh workflow run release-stack.yml --ref v1.0.1
```

Do not manually create a production tag in the normal flow. If Release Please created a tag but not the GitHub Release, wait for or rerun `release-please.yml`; `release-stack.yml` retains a recovery path that can create a missing Release after the upstream run has reached a terminal state.

The workflow publishes two immutable application images, each with a version tag and commit tag:

- `ghcr.io/nearcsie/near-chat-backend:1.0.1`
- `ghcr.io/nearcsie/near-chat-backend:sha-<12-character-commit>`
- `ghcr.io/nearcsie/near-chat-frontend:1.0.1`
- `ghcr.io/nearcsie/near-chat-frontend:sha-<12-character-commit>`

It also records the pinned PostgreSQL runtime (`postgres:18-alpine`), both image digests, provenance attestations, a comparison link, and a `near-chat-stack-vX.Y.Z.tar.gz` deployment bundle in the English GitHub Release. No mutable `latest` tag is published.

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

The four application image references and the stack artifacts attached to the GitHub Release are treated as one immutable publication. Release Please normally creates the Release immediately after the tag, and `release-stack.yml` waits for that upstream run; nevertheless, the existence of a Release is *not* the idempotency key — the presence of `near-chat-stack-vX.Y.Z.tar.gz` is. A clean first publication requires all four image references and that bundle asset to be absent. A rerun only verifies that all references resolve to their recorded digests, both attestations exist, and the Release contains the matching manifest and bundle. Partial publication, digest mismatch, missing attestation, or a bundle without its images fails closed; the workflow never overwrites a completed version.

Recovering from a half-published version therefore means deleting only the partial bundle asset and four image references before rerunning. The `v*` tag ruleset forbids updating or deleting a published tag, so historical tags such as `v1.1.0` and `v2.0.0` must not be moved to rewritten commits. Incorrect historical notes can be corrected in the GitHub Release body and in a later changelog entry without changing the tag target.

### Where to look when a release stalls

A release passes through the Release PR and then the Stack workflow. Find the last stage that appeared and read the row below it:

| Runs you see | What happened | What to do |
| --- | --- | --- |
| `CI` failed | A quality or security gate rejected the `main` commit | Read the failing CI job. `release-please.yml` correctly does not run. |
| `CI` and `release-please.yml` green, Release PR open, no tag | Normal pre-release state | Review the proposed version, `CHANGELOG.md`, manifest, and three package versions, then merge the Release PR when ready. |
| `release-please.yml` green, no Release PR | There are no unreleased `feat:`, `fix:`, or breaking commits, or a newer `main` run superseded this one | Read the guard and Release Please log. No production tag should exist. |
| `release-please.yml` failed | Release Please could not create/update the PR, tag, or Release | Check `RELEASE_APP_CLIENT_ID`, `RELEASE_APP_PRIVATE_KEY`, App installation and Contents/Issues/Pull Requests permissions, branch rules, and the tag-ruleset bypass actor. |
| Tag exists but no `發布完整 Near Chat Stack` run | The App-generated tag event did not start stage 3 | Check that `release-stack.yml` still listens for `push.tags: v*`; dispatch stage 3 by hand meanwhile. |
| `發布完整 Near Chat Stack` failed | A Stack gate rejected the publication | The failing step names the reason: tag format, package-version mismatch, tag not on `main`, no successful CI for the exact tag commit, or a partial publication. |

Once the cause is fixed, re-run stage 3 with `gh workflow run release-stack.yml --ref vX.Y.Z`. It is safe to run repeatedly: a version whose bundle is already attached takes the verify-only path and changes nothing.

Release artifacts must never contain `.env` files, credentials, database volumes or dumps containing real data, or uploaded user files.
