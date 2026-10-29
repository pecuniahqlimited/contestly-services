#!/usr/bin/env bash
# End-to-end smoke test against a running local stack (npm run dev). Needs curl + python3.
set -e
H=(-s -H "x-dev-user: tunde" -H "content-type: application/json")
j() { python3 -c "import sys,json;d=json.load(sys.stdin);print($1)"; }
echo "health:   $(curl -s localhost:4000/health)"
# Top up the paying users so repeat runs don't drain the seed balances (brokeuser stays broke on purpose).
for u in tunde zee; do
  echo "topup $u: $(curl -s -H "x-dev-user: $u" -H 'content-type: application/json' -X POST localhost:4000/wallet/dev-topup -d '{"nairaAmount":1000}')"
done
echo "me:       $(curl "${H[@]}" localhost:4000/me | j "d['handle'], d['wallet']")"
PID=$(curl "${H[@]}" -X POST localhost:4000/parties -d '{"title":"Smoke test party","brief":"Nigerian tech startups and the people behind them","entryKobo":20000,"maxPlayers":6,"funding":"pooled","split":"70_30","startsAt":"'"$(date -u -v+3M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "+3 minutes" +%Y-%m-%dT%H:%M:%SZ)"'"}' | j "d['id']")
echo "created:  $PID"
echo "join zee: $(curl -s -H 'x-dev-user: zee' -X POST localhost:4000/parties/$PID/join)"
echo "replay:   $(curl -s -H 'x-dev-user: zee' -X POST localhost:4000/parties/$PID/join)"
echo "no funds: $(curl -s -H 'x-dev-user: brokeuser' -X POST localhost:4000/parties/$PID/join)"
echo "bad id:   $(curl -s -H 'x-dev-user: zee' -X POST localhost:4000/parties/nope/join)"
# Leaving (more than 2 minutes before the start): the whole entry back, a retry answers the same, the host can't.
echo "leave:    $(curl -s -H 'x-dev-user: zee' -X POST localhost:4000/parties/$PID/leave)"
echo "again:    $(curl -s -H 'x-dev-user: zee' -X POST localhost:4000/parties/$PID/leave)"
echo "host:     $(curl -s -H 'x-dev-user: tunde' -X POST localhost:4000/parties/$PID/leave)"
echo "rejoin:   $(curl -s -H 'x-dev-user: zee' -X POST localhost:4000/parties/$PID/join)"
echo "detail:   $(curl "${H[@]}" localhost:4000/parties/$PID | j "d['status'], d['playerCount'], d['potKobo']")"
echo "climb:    $(curl "${H[@]}" localhost:4000/climb | j "d['ladder']['version'], len(d['ladder']['stages']), d['week']['week']")"
RUN=$(curl "${H[@]}" -X POST localhost:4000/climb/runs | j "d['run']['id'], d['round']['type']")
echo "run:      $RUN"
echo "board:    $(curl "${H[@]}" "localhost:4000/climb/leaderboard?board=friends" | j "d['board'], len(d['rows'])")"
echo "In ~3 min the worker will flip this party to 'live'. Watch the worker log, then: curl -H 'x-dev-user: tunde' localhost:4000/parties/$PID"
