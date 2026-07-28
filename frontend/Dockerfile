# Bun is both the package manager and the runtime, installing from the single
# root bun.lock. Build context is the repo root (see docker-compose.yml).
FROM oven/bun:1.3-slim

WORKDIR /workspace

# Give the built-in bun user ownership of /workspace before switching
RUN chown -R bun:bun /workspace

USER bun

COPY --chown=bun:bun package.json bun.lock ./
COPY --chown=bun:bun frontend/package.json ./frontend/
COPY --chown=bun:bun backend/package.json ./backend/
COPY --chown=bun:bun shared/ ./shared/

# --filter keeps the backend's dependency tree out of the frontend image; its
# package.json is still copied above because the workspace lockfile covers it.
RUN bun install --frozen-lockfile --filter './frontend' --filter '.'

COPY --chown=bun:bun tsconfig.base.json ./
COPY --chown=bun:bun frontend/ ./frontend/

WORKDIR /workspace/frontend

EXPOSE 3000

CMD ["bun", "run", "dev"]
