FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.24.0 --activate

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/
RUN pnpm install --frozen-lockfile

FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/shared/node_modules ./shared/node_modules
COPY --from=deps /app/server/node_modules ./server/node_modules
COPY shared/ ./shared/
COPY server/ ./server/
RUN pnpm --filter @omnilp/shared build
RUN pnpm --filter @omnilp/server build

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 appuser
COPY --from=builder --chown=appuser:nodejs /app/shared/dist ./shared/dist
COPY --from=builder --chown=appuser:nodejs /app/shared/package.json ./shared/
COPY --from=builder --chown=appuser:nodejs /app/server/dist ./server/dist
COPY --from=builder --chown=appuser:nodejs /app/server/package.json ./server/
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/shared/node_modules ./shared/node_modules
COPY --from=deps /app/server/node_modules ./server/node_modules
USER appuser
EXPOSE 3001
CMD ["node", "server/dist/index.js"]
