#!/usr/bin/env bash
# End-to-end smoke test against a running local stack (npm run dev). Needs curl + python3.
set -e
H=(-s -H "x-dev-user: tunde" -H "content-type: application/json")
j() { python3 -c "import sys,json;d=json.load(sys.stdin);print($1)"; }
echo "health:   $(curl -s localhost:4000/health)"
echo "me:       $(curl "${H[@]}" localhost:4000/me | j "d['handle'], d['wallet']")"
PID=$(curl "${H[@]}" -X POST localhost:4000/parties -d '{"title":"Smoke test party","category":"Tech","entryKobo":20000,"maxPlayers":6,"funding":"pooled","split":[70,30],"startsInMinutes":1}' | j "d['id']")
echo "created:  $PID"
echo "join zee: $(curl -s -H 'x-dev-user: zee' -X POST localhost:4000/parties/$PID/join)"
echo "replay:   $(curl -s -H 'x-dev-user: zee' -X POST localhost:4000/parties/$PID/join)"
echo "no funds: $(curl -s -H 'x-dev-user: brokeuser' -X POST localhost:4000/parties/$PID/join)"
echo "bad id:   $(curl -s -H 'x-dev-user: zee' -X POST localhost:4000/parties/nope/join)"
echo "detail:   $(curl "${H[@]}" localhost:4000/parties/$PID | j "d['status'], d['playerCount'], d['potKobo']")"
echo "In ~60s the worker will flip this party to 'live'. Watch the worker log, then: curl -H 'x-dev-user: tunde' localhost:4000/parties/$PID"
