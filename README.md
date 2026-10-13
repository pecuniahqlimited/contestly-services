# Contestly

Ground-up rebuild. Nothing here depends on the previous app.

Social trivia app: **Party** (play with friends, split the pot) and **Payout Challenge** (solo ladder, walk away or risk it).

```
apps/
  api/        Fastify HTTP API        :4000   users, follows, parties, wallet
  realtime/   Socket.io               :4001   lobby presence, chat, party status
  worker/     BullMQ                           notifications, party start/cancel + refunds
  web/        Vite + React            :5173   the clickable prototype + backend check strip
packages/
  shared/     zod schemas, event names, money helpers (kobo)
  db/         Drizzle schema, client, append-only ledger, seed
  auth/       dev-header or Firebase token → user
  queue/      BullMQ queues + Redis connections
```

One codebase, one Docker image, three backend processes. Postgres and Valkey are the only things in Docker locally.

## Run it

```bash
cp .env.example .env
npm install            # also builds the shared packages (prepare script)
npm run infra:up        # postgres + valkey in docker
npm run db:push         # create tables
npm run db:seed         # demo users + parties
npm run dev             # api, realtime, worker, web with hot reload
```

Open http://localhost:5173. The strip at the top should show API ok, Realtime ok, and you signed in as `@tunde` with 🪙 500.

## Poke the API

```bash
H='-H x-dev-user:tunde -H content-type:application/json'
curl $H localhost:4000/me
curl $H localhost:4000/parties
curl $H localhost:4000/users/kemz
curl $H -X POST localhost:4000/parties -d '{"title":"Office quiz","category":"Tech","entryKobo":20000,"maxPlayers":6,"funding":"pooled","split":[70,30],"startsInMinutes":1}'
curl $H -X POST localhost:4000/parties/<id>/join            # as another user: -H x-dev-user:zee
curl $H localhost:4000/wallet
```

With `startsInMinutes: 1`, watch the worker log: after a minute the party goes `live` (2+ players) or `cancelled` with refunds (fewer).

## Rules baked in

- **Money is integer kobo.** Never floats.
- **Ledger is append-only, double-entry style** with a materialised balance per (user, kind). Every write has an idempotency key, so retries and duplicate webhooks are no-ops.
- **Cash and bonus coins are separate accounts.** Entries drain bonus first, then cash. Prizes and refunds go where the rules say, never by accident.
- **Joins lock the party row** so a full party can't be oversubscribed by two people tapping at once.
- **Realtime is stateless.** Rooms live in Redis via the Socket.io adapter, so a second instance later needs no code change.
- **Worker publishes, realtime fans out.** Party lifecycle events travel over a Redis channel; services never call each other directly.

## Auth modes

`AUTH_MODE=dev` (default): send `x-dev-user: <handle>`; unknown handles are created on first request.
`AUTH_MODE=firebase`: send `Authorization: Bearer <Firebase ID token>`; set `FIREBASE_PROJECT_ID` and `GOOGLE_APPLICATION_CREDENTIALS`. A verified token with no user row gets 401 until `POST /me` completes onboarding.

## Not built yet (next)

Game engine (question delivery, server-side timing and scoring, prize settlement), Payout Challenge stages and seats, feed and leaderboard queries, device tokens + FCM in the worker, Paystack webhooks and payout rails (cash vs voucher per platform), block/report/moderation, Caddy + CI for deploy.
