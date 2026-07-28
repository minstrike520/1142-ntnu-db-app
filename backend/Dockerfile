FROM oven/bun:1.3.14-slim

COPY --from=node:24-slim /usr/local/ /usr/local/

RUN apt-get update -y && apt-get install -y openssl

RUN corepack enable && corepack prepare pnpm@11 --activate

WORKDIR /app

RUN mkdir -p /app/uploads/attachments /app/uploads/avatars

# Give the built-in bun user ownership of /app before switching
RUN chown -R bun:bun /app

USER bun

COPY --chown=bun:bun package.json pnpm-lock.yaml ./

RUN pnpm install --frozen-lockfile

COPY --chown=bun:bun . .

EXPOSE 4000

CMD ["bun", "dev"]
