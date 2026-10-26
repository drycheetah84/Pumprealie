# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig*.json vitest.config.ts eslint.config.mjs ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production APP_ENV=production DATA_DIR=/data API_HOST=0.0.0.0
WORKDIR /app
RUN useradd --system --uid 10001 --home /app pumpraelie && mkdir -p /data && chown pumpraelie /data
COPY --from=build --chown=pumpraelie /app/node_modules ./node_modules
COPY --from=build --chown=pumpraelie /app/dist ./dist
COPY --chown=pumpraelie package.json ./
USER pumpraelie
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server/server/index.js"]
