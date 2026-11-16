# Load testing

How many people can play at once: many free parties full of players, created, seated and played end to end
through the public API and the realtime rooms, the way the app does it. The target that set this up: **10,000
players at once, as 100 parties of 100** (Nov 2026). The game is designed for hundreds per party and thousands
of parties; this measures where one server stops keeping up.

## The pieces

- `scripts/load-party.ts` (`npm run load:party`): the players. Creates the parties (free, sealed, pick-one only,
  private, marked as sim data), seats every player through `POST /parties/:id/join`, connects each to its party
  room, answers every question at a random moment (some change their mind once), and sometimes chats on the
  standings screen. It never reads the database, so it runs from any machine. Writes a JSON report with the
  raw samples and prints a summary.
- `scripts/load-report.mjs` (`npm run load:report -- <files>`): merges reports from several machines.
- `.github/workflows/load-test.yml`: the same script on several GitHub runners at once (Actions → **Load test** →
  Run workflow), then one merged summary on the run's page.
- `scripts/load-watch.sh`: on the server, each container's CPU, memory and network plus the machine's load,
  every 5 s, into a CSV.

**The players never run on the server under test.** A server simulating its own players measures itself. One
runner holds about 2,000 players comfortably; use 5 machines for 10,000.

## What it measures

| | means |
|---|---|
| Create a party, join a party | API latency under the crowd. A join locks the party row, so 100 joins to one party queue. |
| Party created → questions ready | The questions service making sets for every party at once. |
| Connect to the party room | Realtime accepting the crowd. |
| Question opened → reaches a player | How late each player sees a question, against the server's `openedAt`. |
| Fan-out | For one question in one party, the first player's arrival to the last's: the room's send time. |
| Question closes → reveal | How late the reveal arrives after the clock ends. |
| Chat line → acknowledged | Party chat under load (written to Postgres, published over Valkey). |
| Counts | Parties created and ready, players seated and connected, questions received, finals seen, disconnects, errors by kind. |

A step passes when every count is at 100%, there are no unexpected disconnects, and the question lag stays low
(p95 under about 500 ms; players feel a second). The point where that stops being true is the result.

## Before a run (the server)

The test signs players in with dev identities (`x-dev-user`) and needs mock question generation: Firebase can't
mint thousands of anonymous accounts in minutes, and a real model can't write a hundred sets at once. **While
`AUTH_MODE=dev` is on, anyone who can reach the API can act as anyone, so only do this on a server with no real
users, and put it back right after.**

```bash
cd /opt/self-hosted/backend/contestly-services/contestly-services
cp .env .env.before-load-test
# NODE_ENV must be development: dev sign-in is refused in production.
sed -i 's/^AUTH_MODE=.*/AUTH_MODE=dev/' .env
grep -q '^AI_PROFILE=' .env && sed -i 's/^AI_PROFILE=.*/AI_PROFILE=mock/' .env || echo 'AI_PROFILE=mock' >> .env
grep -E '^(NODE_ENV|AUTH_MODE|AI_PROFILE|DB_POOL_MAX)=' .env
docker compose -f docker-compose.prod.yml up -d --force-recreate
```

Also check: Valkey's eviction policy is `noeviction` (DO console), and the admin party limits allow the seats you
ask for (`seatsMax`, default 200).

In a second terminal on the server, start the watcher and leave it running for the whole test:

```bash
bash scripts/load-watch.sh load-watch-$(date +%H%M).csv
```

## Running

GitHub → the repository → Settings → Secrets and variables → Actions → Variables, once:
`LOAD_API_URL` = `https://api.<server>` and `LOAD_RT_URL` = `wss://rt.<server>`.

Then Actions → **Load test** → Run workflow. Step up, one run per step, and look at each summary before the next:

| Step | parties | players | machines | players in total |
|---|---:|---:|---:|---:|
| 1 | 10 | 100 | 1 | 1,000 |
| 2 | 25 | 100 | 2 | 2,500 |
| 3 | 50 | 100 | 3 | 5,000 |
| 4 | 100 | 100 | 5 | 10,000 |

Stop climbing at the first step that fails; that step and the CSV say why. Each run takes about
`starts_in_minutes` plus the game (5 questions of 10 s is about 3 minutes) and uses runner minutes on every
machine.

From your own machine instead (one machine, a smaller crowd):

```bash
npm run load:party -- --api https://api.<server> --rt wss://rt.<server> --parties 5 --players 50 --starts-in 4
```

## After a run

Put the server back:

```bash
cp .env.before-load-test .env
docker compose -f docker-compose.prod.yml up -d --force-recreate
```

Stop the watcher (Ctrl-C) and keep its CSV with the run's summary. The test's accounts (`lt<run>.<party>.<n>`),
parties and chat lines stay in the database, marked as sim data, so real people never see them in suggestions.

## Reading the results

- **Joins slow, rooms fine**: the API or Postgres. `DB_POOL_MAX` (connections per process) against the
  cluster's limit is the first suspect: the smallest DO Postgres allows about 22 in total.
- **Question lag or fan-out climbing**: realtime's CPU (one Node process; every party's room shares one core).
- **Container restarts, or memory at its limit in the CSV**: `mem_limit` in `docker-compose.prod.yml`.
- **Questions not ready in time**: the questions service, or a real AI profile left on.
- **Parties cancelled**: fewer than two players seated by the start, or no question set.
