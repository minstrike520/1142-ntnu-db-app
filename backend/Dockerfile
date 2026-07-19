FROM node:lts-slim

RUN apt-get update -y && apt-get install -y openssl
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

RUN mkdir -p /app/uploads/attachments /app/uploads/avatars

# Give the built-in node user ownership of /app before switching
RUN chown -R node:node /app

USER node

COPY --chown=node:node package.json pnpm-lock.yaml ./

RUN --mount=type=cache,id=pnpm,target=/pnpm/store,uid=1000,gid=1000 \
    pnpm install --store-dir /pnpm/store --no-frozen-lockfile --ignore-scripts

COPY --chown=node:node . .

EXPOSE 4000

CMD ["pnpm", "dev"]
