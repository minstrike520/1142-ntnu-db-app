# Bun is both the package manager and the runtime, installing from the single
# root bun.lock. Build context is the repo root (see docker-compose.yml).
FROM oven/bun:1.3-slim

RUN apt-get update -y && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

# uploads/ is resolved from the backend's cwd (see src/utils/uploads.ts).
RUN mkdir -p /workspace/backend/uploads/attachments /workspace/backend/uploads/avatars

# Give the built-in bun user ownership of /workspace before switching
RUN chown -R bun:bun /workspace

USER bun

COPY --chown=bun:bun package.json bun.lock ./
COPY --chown=bun:bun backend/package.json ./backend/
COPY --chown=bun:bun frontend/package.json ./frontend/
COPY --chown=bun:bun shared/ ./shared/

# --filter keeps the frontend's dependency tree out of the backend image; its
# package.json is still copied above because the workspace lockfile covers it.
RUN bun install --frozen-lockfile --filter './backend' --filter '.'

COPY --chown=bun:bun tsconfig.base.json ./
COPY --chown=bun:bun backend/ ./backend/

WORKDIR /workspace/backend

EXPOSE 4000

CMD ["bun", "dev"]
