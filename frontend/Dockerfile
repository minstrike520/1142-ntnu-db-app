# Dev image for the frontend.
#
# Built from the REPOSITORY ROOT as context (see docker-compose.yml), because
# this repo is a single-lockfile pnpm workspace: the lockfile, the workspace
# manifest and every package's package.json all live outside frontend/.
FROM node:26-slim

# Pinned to match "packageManager" in the root package.json, and prepared at
# build time so the image does not fetch pnpm on first use at runtime.
RUN corepack enable pnpm && corepack prepare pnpm@11.15.0 --activate

WORKDIR /workspace

RUN chown -R node:node /workspace

USER node

# Every workspace manifest must be present: `--frozen-lockfile` validates the
# lockfile against all of its importers, so omitting backend/package.json
# fails the install even though only the frontend is being built.
COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --chown=node:node frontend/package.json ./frontend/
COPY --chown=node:node backend/package.json ./backend/

# `--frozen-lockfile` replaces the previous `--no-frozen-lockfile`, which was
# only tolerable while the per-package lockfiles were drifting from their
# manifests. With one root lockfile enforced in CI, a frozen install is both
# correct and a supply-chain improvement.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store,uid=1000,gid=1000 \
    pnpm install --store-dir /pnpm/store --frozen-lockfile --ignore-scripts \
      --filter near-chat-frontend...

COPY --chown=node:node tsconfig.base.json ./
COPY --chown=node:node shared/ ./shared/
COPY --chown=node:node frontend/ ./frontend/

# docker-compose.yml mounts an anonymous volume at .next to keep the build cache
# off the bind-mounted host filesystem. The volume inherits ownership from this
# path in the image, so it must exist and be owned by `node` — otherwise Docker
# creates it as root and `next dev` fails with EACCES on mkdir .next/dev.
RUN mkdir -p /workspace/frontend/.next

WORKDIR /workspace/frontend

EXPOSE 3000

CMD ["pnpm", "dev"]
