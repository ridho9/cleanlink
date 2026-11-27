# syntax=docker/dockerfile:1
FROM node:26-bookworm-slim@sha256:0042e17d232a87a2cd485be1da7900fca4d10a4ad11b29e9285da1d2e54798c9 AS base

FROM base AS deps
WORKDIR /app
COPY --chown=0:0 --chmod=0644 package.json pnpm-lock.yaml ./
RUN npm install --global corepack@0.36.0 \
    && corepack pnpm install --frozen-lockfile --prod

FROM base
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg python3 \
    && rm -rf /var/lib/apt/lists/*
ADD --checksum=sha256:e8665ed64d6b9172773e812f891fb707a0cb1ee8d9ef4fc1acb00cabee4c5256 --chmod=0755 \
    https://github.com/yt-dlp/yt-dlp/releases/download/2026.11.23/yt-dlp /usr/local/bin/yt-dlp

ENV NODE_ENV=production XDG_CACHE_HOME=/tmp
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --chown=0:0 --chmod=0644 package.json ./
COPY --chown=0:0 --chmod=u=rwX,go=rX src/ ./src/
USER node
CMD ["node", "src/bot.ts"]
