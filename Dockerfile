# One image for every backend process. APP selects which one runs.
FROM node:22-alpine AS build
ARG APP
WORKDIR /repo
COPY package.json package-lock.json* tsconfig.base.json ./
COPY packages ./packages
COPY apps/api/package.json ./apps/api/
COPY apps/realtime/package.json ./apps/realtime/
COPY apps/worker/package.json ./apps/worker/
COPY apps/questions/package.json ./apps/questions/
# Every workspace: the root prepare script builds every package, auth's firebase-admin included, whatever APP is.
RUN npm ci --include=dev
COPY apps/${APP} ./apps/${APP}
# Server-only operations, run inside a container (docs/engineering/deploy-notes.md), e.g.
#   docker compose -f docker-compose.prod.yml exec api npm run payments:break-glass -- --grant-config <handle> --reason "…"
COPY scripts/payments-break-glass.ts ./scripts/
RUN npm run build -w apps/${APP}   # npm ci already built the packages (the root prepare script)

FROM node:22-alpine
ARG APP
ENV NODE_ENV=production APP=${APP}
WORKDIR /repo
COPY --from=build /repo ./
USER node
CMD node apps/${APP}/dist/index.js
