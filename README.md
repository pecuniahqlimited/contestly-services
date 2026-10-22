# contestly-services

Ground-up rebuild. Nothing here depends on the previous app.

Social trivia app: **Party** (play with friends, split the pot) and **The Climb** (solo puzzle ladder, free runs, weekly boards).

```
apps/
  api/        Fastify HTTP API        :4000   users, follows, parties, wallet
  realtime/   Socket.io               :4001   lobby presence, chat, party status
  worker/     BullMQ                           notifications, party start/cancel + refunds
packages/
  shared/     zod schemas, event names, money helpers (kobo)
  db/         Drizzle schema, client, append-only ledger, seed
  auth/       Firebase ID token (or the dev header) → user; a guest for a new anonymous session
  email/      EmailSender: ZeptoMail, Brevo, Mailpit (dev), with fallback
  queue/      BullMQ queues + Redis connections
```

One codebase, one Docker image, three backend processes. Postgres and Valkey are the only things in Docker locally.

The UI (Expo mobile app, Vite web app, design tokens, API client and the prototype) lives in the sibling repo [`contestly-app`](../contestly-app).

## Run it

```bash
cp .env.example .env
npm install            # also builds the shared packages (prepare script)
npm run infra:up        # postgres, valkey, storage, mailpit (:8025) and the Firebase Auth emulator (:9099) in docker
npm run db:migrate      # create tables (drizzle migrations)
npm run db:seed         # demo users + parties
npm run dev             # api, realtime, worker with hot reload
scripts/smoke.sh        # end-to-end check against the running stack
```

To see it in a UI, run `contestly-app` next to this repo (see its README).

## How `contestly-app` consumes `@contestly/shared`

For now the app links this package straight from disk: its `package.json` files depend on `"@contestly/shared": "file:../../../contestly-services/packages/shared"`, so this repo must be checked out next to `contestly-app` and `npm install` must have been run here (that builds `packages/shared/dist`). After changing `packages/shared`, run `npm run build -w @contestly/shared`.

To switch to a published package later:

1. Drop `"private"` if set, give `packages/shared` a real version and a `publishConfig` for the registry (e.g. GitHub Packages, `@contestly` scope).
2. `npm publish -w @contestly/shared` (in CI on tag).
3. In `contestly-app`, replace the `file:` specifier with a version range (`"@contestly/shared": "^0.1.0"`), add an `.npmrc` pointing the scope at the registry, and remove the shared path from `apps/mobile/metro.config.js` `watchFolders`.

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
- **Live rooms live in process; everything around them lives in Valkey.** Each room's state stays in memory on the one realtime process hosting it. Valkey holds presence, room discovery and pub/sub, so any instance can find any room and a second instance is config, not code. If a room disappears mid-round, the worker cancels and refunds the party through the ledger. (Realtime is still Socket.io; roadmap step 1 replaces it with Colyseus.)
- **Worker publishes, realtime fans out.** Party lifecycle events travel over a Redis channel; services never call each other directly.

## Auth modes

Sessions are Firebase ID tokens (`Authorization: Bearer …`): anonymous from the first screen (a guest), then a custom token the API mints after an email code or Google/Apple (ADR 0006). Locally the API talks to the Auth emulator (`FIREBASE_AUTH_EMULATOR_HOST`), and codes land in Mailpit.

`AUTH_MODE=dev` (default) also accepts `x-dev-user: <handle>`; unknown handles are created as signed-up accounts. It refuses to start with `NODE_ENV=production`.
`AUTH_MODE=firebase`: tokens only; set `FIREBASE_PROJECT_ID`, `FIREBASE_SERVICE_ACCOUNT_JSON`, `EMAIL_CODE_SECRET` and `PHONE_HASH_SECRET`.

## Not built yet (next)

Game engine (question delivery, server-side timing and scoring, prize settlement), The Climb, feed and leaderboard queries, device tokens + FCM in the worker, Paystack webhooks and payout rails (cash vs voucher per platform), block/report/moderation, Caddy + CI for deploy.
