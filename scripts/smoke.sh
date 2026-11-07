#!/usr/bin/env bash
# End-to-end smoke test against a running local stack (npm run dev). Needs curl + python3.
set -e
# The ports come from the repo's .env (API_PORT), so a worktree with its own stack is checked, not main's.
ENV_FILE="$(dirname "$0")/../.env"
API_PORT=$( (grep -E '^API_PORT=' "$ENV_FILE" 2>/dev/null || true) | tail -1 | cut -d= -f2)
API="${API_URL:-http://localhost:${API_PORT:-4000}}"
H=(-s -H "x-dev-user: tunde" -H "content-type: application/json")
j() { python3 -c "import sys,json;d=json.load(sys.stdin);print($1)"; }
echo "health:   $(curl -s $API/health)"
# Top up the paying users so repeat runs don't drain the seed balances (brokeuser stays broke on purpose).
for u in tunde zee; do
  echo "topup $u: $(curl -s -H "x-dev-user: $u" -H 'content-type: application/json' -X POST $API/wallet/dev-topup -d '{"nairaAmount":1000}')"
done
echo "me:       $(curl "${H[@]}" $API/me | j "d['handle'], d['wallet']")"
PID=$(curl "${H[@]}" -X POST $API/parties -d '{"title":"Smoke test party","brief":"Nigerian tech startups and the people behind them","entryKobo":20000,"maxPlayers":6,"funding":"pooled","split":"70_30","startsAt":"'"$(date -u -v+3M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "+3 minutes" +%Y-%m-%dT%H:%M:%SZ)"'"}' | j "d['id']")
echo "created:  $PID"
echo "join zee: $(curl -s -H 'x-dev-user: zee' -X POST $API/parties/$PID/join)"
echo "replay:   $(curl -s -H 'x-dev-user: zee' -X POST $API/parties/$PID/join)"
echo "no funds: $(curl -s -H 'x-dev-user: brokeuser' -X POST $API/parties/$PID/join)"
echo "bad id:   $(curl -s -H 'x-dev-user: zee' -X POST $API/parties/nope/join)"
# Leaving (more than 2 minutes before the start): the whole entry back, a retry answers the same, the host can't.
echo "leave:    $(curl -s -H 'x-dev-user: zee' -X POST $API/parties/$PID/leave)"
echo "again:    $(curl -s -H 'x-dev-user: zee' -X POST $API/parties/$PID/leave)"
echo "host:     $(curl -s -H 'x-dev-user: tunde' -X POST $API/parties/$PID/leave)"
echo "rejoin:   $(curl -s -H 'x-dev-user: zee' -X POST $API/parties/$PID/join)"
# The host cancels their own party: every seat refunded, a retry answers the same, nobody else may.
CID=$(curl "${H[@]}" -X POST $API/parties -d '{"title":"Smoke cancel","brief":"Lagos landmarks","entryKobo":20000,"maxPlayers":6,"funding":"pooled","split":"winner","startsAt":"'"$(date -u -v+30M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "+30 minutes" +%Y-%m-%dT%H:%M:%SZ)"'"}' | j "d['id']")
curl -s -H 'x-dev-user: zee' -X POST $API/parties/$CID/join >/dev/null
echo "not host: $(curl -s -H 'x-dev-user: zee' -H 'content-type: application/json' -X POST $API/parties/$CID/cancel -d '{}')"
echo "cancel:   $(curl "${H[@]}" -X POST $API/parties/$CID/cancel -d '{"reason":"smoke"}')"
echo "again:    $(curl "${H[@]}" -X POST $API/parties/$CID/cancel -d '{}')"
echo "detail:   $(curl "${H[@]}" $API/parties/$PID | j "d['status'], d['playerCount'], d['potKobo']")"
# Party templates (ADR 0015): the builder's occasions; a template party with a host-written question is curate and says so.
TV=$(curl "${H[@]}" $API/party-templates | j "d['version']")
echo "templates: $(curl "${H[@]}" $API/party-templates | j "len(d['templates']), [t['id'] for t in d['templates']]")"
echo "tpl free: $(curl "${H[@]}" -X POST $API/parties -d '{"template":{"id":"birthday","version":'"$TV"'},"entryKobo":0,"maxPlayers":6,"funding":"pooled","split":"winner"}' | j "d['error']")"
echo "tpl host: $(curl "${H[@]}" -X POST $API/parties -d '{"template":{"id":"birthday","version":'"$TV"'},"entryKobo":20000,"maxPlayers":6,"funding":"pooled","split":"winner","hostQuestions":[{"question":"Which city was Ada born in?","answer":"Ibadan","distractors":["Lagos","Enugu","Kano"]}]}' | j "d['mode'], d['title'], d['questions']['hostWritten']")"
echo "climb:    $(curl "${H[@]}" $API/climb | j "d['ladder']['version'], len(d['ladder']['stages']), d['week']['week']")"
RUN=$(curl "${H[@]}" -X POST $API/climb/runs | j "d['run']['id'], d['round']['type']")
echo "run:      $RUN"
echo "board:    $(curl "${H[@]}" "$API/climb/leaderboard?board=friends" | j "d['board'], len(d['rows'])")"
# Payments with the mock provider: a top-up paid on the mock checkout is credited by the worker, never by polling.
TREF=$(curl "${H[@]}" -X POST $API/wallet/topups -d '{"amountKobo":50000}' | j "d['reference']")
echo "topup:    $TREF $(curl "${H[@]}" $API/wallet/topups/$TREF | j "d['status']")"
echo "checkout: $(curl -s -H 'content-type: application/json' -X POST $API/payments/mock/checkout/$TREF -d '{"action":"pay"}' | j "d['deliveries']")"
sleep 3
echo "credited: $(curl "${H[@]}" $API/wallet/topups/$TREF | j "d['status'], d['creditedAt'] is not None")"
echo "bad sig:  $(curl -s -o /dev/null -w '%{http_code}' -H 'content-type: application/json' -H 'x-mock-signature: 00' -X POST $API/webhooks/mock -d '{"event":"topup.paid","data":{}}')"
echo "payments: $(curl "${H[@]}" $API/admin/payments | j "d['settings']['collections'], d['topups']")"
echo "In ~3 min the worker will flip this party to 'live'. Watch the worker log, then: curl -H 'x-dev-user: tunde' $API/parties/$PID"
