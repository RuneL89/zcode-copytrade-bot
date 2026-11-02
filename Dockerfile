# =============================================================================
# ZCode Bot — single production image: React build + API + worker in one process
# =============================================================================

FROM node:24-slim AS build
WORKDIR /app
RUN corepack enable
COPY pnpm-workspace.yaml package.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/config/package.json packages/config/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/providers/package.json packages/providers/
RUN pnpm install --frozen-lockfile || pnpm install

COPY tsconfig.base.json ./
COPY packages packages
COPY apps apps
COPY fixtures fixtures
RUN pnpm --filter @zcode-bot/config run build \
  && pnpm --filter @zcode-bot/core run build \
  && pnpm --filter @zcode-bot/db run build \
  && pnpm --filter @zcode-bot/providers run build \
  && pnpm --filter @zcode-bot/server run build \
  && pnpm --filter @zcode-bot/web run build

FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DATA_DIR=/data
RUN corepack enable
COPY pnpm-workspace.yaml package.json ./
COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/apps/server/package.json apps/server/
COPY --from=build /app/apps/web/dist apps/web/dist
COPY --from=build /app/packages/config/package.json packages/config/
COPY --from=build /app/packages/config/dist packages/config/dist
COPY --from=build /app/packages/core/package.json packages/core/
COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/packages/db/package.json packages/db/
COPY --from=build /app/packages/db/dist packages/db/dist
COPY --from=build /app/packages/db/drizzle packages/db/drizzle
COPY --from=build /app/packages/providers/package.json packages/providers/
COPY --from=build /app/packages/providers/dist packages/providers/dist
COPY fixtures fixtures

RUN pnpm install --frozen-lockfile --prod || pnpm install --prod
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8787/api/bootstrap').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/server/dist/index.js"]
