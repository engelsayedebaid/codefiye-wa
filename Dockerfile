# One image for both services: the API (default CMD, also serves the dashboard) and the worker
# (override the command with `pnpm --filter @wa/worker start`).
FROM node:24-slim
RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/dashboard/package.json apps/dashboard/
COPY packages/db/package.json packages/db/
COPY packages/provider/package.json packages/provider/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm --filter @wa/dashboard build

ENV NODE_ENV=production \
    DASHBOARD_DIST=/app/apps/dashboard/dist
EXPOSE 4000
CMD ["pnpm", "--filter", "@wa/api", "start"]
