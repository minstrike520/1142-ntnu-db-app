FROM oven/bun:1.2-slim

RUN apt-get update -y && apt-get install -y openssl

WORKDIR /app

RUN mkdir -p /app/uploads/attachments /app/uploads/avatars

# Give the built-in bun user ownership of /app before switching
RUN chown -R bun:bun /app

USER bun

COPY --chown=bun:bun package.json pnpm-lock.yaml ./

RUN bun install

COPY --chown=bun:bun . .

EXPOSE 4000

CMD ["bun", "dev"]
