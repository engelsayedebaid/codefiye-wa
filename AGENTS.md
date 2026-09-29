# AGENTS.md

pnpm monorepo (pnpm 12, Node 22+, TypeScript 5.9, ESM). Internal packages export TS sources directly (`exports: ./src/index.ts`) and are run with `tsx` — no build step. Use extensionless relative imports.

## Layout
- `apps/api` — Fastify 5 + Zod (fastify-type-provider-zod), OpenAPI at `/docs`. Bearer auth via `api_keys` (SHA-256).
- `apps/worker` — owns Baileys sessions. RPC queue `wa-rpc-{workerId}`, send queue `wa-send-{workerId}` (serialized per session in-process). Publishes events via Postgres NOTIFY.
- `apps/dashboard` — React 19 + Vite 8 + Tailwind 4, Arabic RTL. Use Cairo for the site and dashboard UI (user preference); keep IBM Plex Mono for code.
- `packages/provider` — `Provider` interface, `BaileysProvider`, `usePostgresAuthState` (AES-256-GCM, AAD = sessionId:type:id).
- `packages/db` — Drizzle schema (snake_case casing), migrations in `packages/db/migrations`.
- `packages/shared` — response contracts, Zod schemas, JID utils, event/queue names.

## Commands
- Install: `pnpm install`
- Typecheck everything: `pnpm typecheck`
- Tests: `pnpm test` (vitest; tests live in `packages/*/test`, `apps/*/test`)
- Dashboard build: `pnpm --filter @wa/dashboard build`
- Generate migration after schema change: `pnpm db:generate`; apply: `pnpm db:migrate`
- Create workspace + PAT: `pnpm bootstrap [email] [name]`
- Dev: `pnpm dev:api`, `pnpm dev:worker`, `pnpm dev:dashboard`
- Baileys POC (file auth, port 3001): `pnpm poc`

## Neon (Postgres)
- Linked via `.neon` (project `floral-lake-67692203`, branch `production`). `neon.ts` is the Neon infra config (`@neon/config`).
- `neon link` / `neon deploy` / `neon env pull` write `DATABASE_URL` (pooled) and `DATABASE_URL_UNPOOLED` to `.env.local`.
- All scripts load `.env` then `.env.local` (later wins). Put non-Neon vars (`AUTH_ENCRYPTION_KEY`, …) in `.env`.
- App traffic uses the pooled `DATABASE_URL`; drizzle-kit migrations, BullMQ and LISTEN/NOTIFY use `DATABASE_URL_UNPOOLED`.
- No Redis: BullMQ runs on its Postgres backend (`bullmq` schema, auto-migrated), events use `NOTIFY wa_events`, worker heartbeat is the `workers` table, QR lives in `sessions.qr`.
- Run everything: `npm run dev` (api :4000, worker, dashboard :5173 — landing `/`, console `/app`). Port 3000 is used by another local app (CodeFiye), don't use it.
- Admin login (until real auth lands): `pnpm bootstrap <email> "<workspace>"` prints a workspace token (PAT); paste it at `/app`.
- Preview Neon changes: `neon config plan`; apply: `neon deploy`. Test risky migrations on a branch: `neon checkout <name> --create`.

## Conventions
- Pin exact dependency versions; prefer versions published ≥ 7 days ago.
- Build scripts are gated via `allowBuilds` in `pnpm-workspace.yaml`.
- API responses: `{ success: true, data }` / `{ success: false, message, errors? }`.
