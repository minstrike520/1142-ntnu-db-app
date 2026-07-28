FROM oven/bun:1.3.14-slim

RUN apt-get update -y && apt-get install -y openssl

WORKDIR /app

RUN mkdir -p /app/uploads/attachments /app/uploads/avatars

# Give the built-in bun user ownership of /app before switching
RUN chown -R bun:bun /app

USER bun

COPY --chown=bun:bun package.json bun.lock ./

RUN bun install --frozen-lockfile

COPY --chown=bun:bun . .

EXPOSE 4000

CMD ["bun", "dev"]
