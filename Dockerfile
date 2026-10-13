# One image for every backend process. APP selects which one runs.
FROM node:22-alpine AS build
ARG APP
WORKDIR /repo
COPY package.json package-lock.json* ./
COPY packages ./packages
COPY apps/api/package.json ./apps/api/
COPY apps/realtime/package.json ./apps/realtime/
COPY apps/worker/package.json ./apps/worker/
RUN npm ci --omit=dev=false --workspace=@contestly/${APP} --include-workspace-root
COPY apps/${APP} ./apps/${APP}
RUN npm run build --workspaces --if-present

FROM node:22-alpine
ARG APP
ENV NODE_ENV=production APP=${APP}
WORKDIR /repo
COPY --from=build /repo ./
USER node
CMD node apps/${APP}/dist/index.js
