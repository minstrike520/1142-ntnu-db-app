# Dev image for the backend.
#
# Built from the REPOSITORY ROOT as context (see docker-compose.yml), because
# this repo is a single-lockfile pnpm workspace: the lockfile, the workspace
# manifest and every package's package.json all live outside backend/.
FROM oven/bun:1.3.14-slim

# pnpm 11 requires `node:sqlite`, which bun does not implement, so pnpm cannot
# execute on a bun-only image. Graft the node toolchain in rather than switching
# the base image — bun stays the runtime and the test runner. (Approach from #419.)
#
# The package manager is now the ONLY reason node is here. #421 removed the
# other one by replacing `node-pg-migrate` with a `Bun.SQL` runner, so nothing
# the application itself runs needs node any more. This COPY can go when the
# package manager does — see #416 for the bun-toolchain proposal.
COPY --from=node:24-slim /usr/local/ /usr/local/

RUN apt-get update -y \
 && apt-get install -y --no-install-recommends openssl \
 && rm -rf /var/lib/apt/lists/*

# Pinned to match "packageManager" in the root package.json, and prepared at
# build time so the image does not fetch pnpm on first use at runtime.
RUN corepack enable pnpm && corepack prepare pnpm@11.15.0 --activate

WORKDIR /workspace

RUN mkdir -p /workspace/backend/uploads/attachments /workspace/backend/uploads/avatars \
 && chown -R bun:bun /workspace

USER bun

# Every workspace manifest must be present: `--frozen-lockfile` validates the
# lockfile against all of its importers, so omitting frontend/package.json
# fails the install even though only the backend is being built.
COPY --chown=bun:bun package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --chown=bun:bun backend/package.json ./backend/
COPY --chown=bun:bun frontend/package.json ./frontend/

RUN pnpm install --frozen-lockfile --filter near-chat-backend...

COPY --chown=bun:bun tsconfig.base.json ./
COPY --chown=bun:bun shared/ ./shared/
COPY --chown=bun:bun backend/ ./backend/

WORKDIR /workspace/backend

EXPOSE 4000

CMD ["pnpm", "run", "dev"]
