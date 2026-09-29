FROM node:22-alpine
RUN apk add --no-cache git && corepack enable
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/dashboard/package.json apps/dashboard/
COPY packages/db/package.json packages/db/
COPY packages/provider/package.json packages/provider/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile
COPY . .
# Vite bakes these into the dashboard bundle at build time (empty VITE_API_URL = same-origin).
ARG VITE_API_URL=""
ARG VITE_NEON_AUTH_URL=""
ENV VITE_API_URL=$VITE_API_URL VITE_NEON_AUTH_URL=$VITE_NEON_AUTH_URL
RUN pnpm --filter @wa/dashboard build
ENV NODE_ENV=production
CMD ["pnpm", "--filter", "@wa/api", "start"]
