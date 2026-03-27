FROM node:lts-slim

RUN apt-get update -y && apt-get install -y openssl
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml ./

RUN pnpm install

# COPY ..

EXPOSE 4000

CMD ["pnpm", "dev"]
