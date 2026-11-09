#!/usr/bin/env bash
# Runs on the droplet; .github/workflows/deploy.yml pipes it over SSH, so the copy from the release runs.
#
#   bash -s -- <git sha> <registry, e.g. registry.digitalocean.com/contestly> <repo dir> < scripts/deploy.sh
#
# Pulls the release's images with the short-lived read-only registry login the workflow left in
# ~/.contestly-deploy, puts the checkout on the release (compose file, Caddyfile), then stop → migrate → start,
# as every release needs since 0022 (docs/engineering/deploy-notes.md), and waits for the API and realtime.
# A failed pull changes nothing. .env is untracked: a release only sets IMAGE_REGISTRY and IMAGE_TAG in it.
set -euo pipefail

sha="$1"
registry="$2"
dir="$3"
apps=(api realtime worker questions)
registry_login="$HOME/.contestly-deploy"
health_attempts=30
trap 'rm -rf "$registry_login"' EXIT

cd "$dir"
compose=(docker compose -f docker-compose.prod.yml)

echo "→ pull images for $sha"
for app in "${apps[@]}"; do
  DOCKER_CONFIG="$registry_login" docker pull --quiet "$registry/contestly-$app:$sha"
done

echo "→ checkout"
git fetch --quiet origin
git reset --hard --quiet "$sha"

set_env() {
  if grep -q "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else printf '%s=%s\n' "$1" "$2" >> .env; fi
}
set_env IMAGE_REGISTRY "$registry"
set_env IMAGE_TAG "$sha"

echo "→ stop, migrate, start"
"${compose[@]}" stop "${apps[@]}"
"${compose[@]}" --profile tools run --rm migrate
# COMPOSE_PROFILES in .env adds the optional services (mock: Mailpit on a test box).
"${compose[@]}" up -d

answers() { # service, URL as seen inside its container: true once it replies
  "${compose[@]}" exec -T "$1" sh -c "wget -qO- $2" > /dev/null 2>&1
}
echo "→ wait for api and realtime"
for _ in $(seq "$health_attempts"); do
  if answers api 'http://127.0.0.1:${API_PORT:-4000}/health' && answers realtime 'http://127.0.0.1:${REALTIME_PORT:-4001}/'; then
    echo "✓ $sha is live"
    docker image prune -af > /dev/null   # earlier releases; they stay in the registry for a rollback
    exit 0
  fi
  sleep 2
done

echo "✗ api or realtime didn't come up; last logs:" >&2
"${compose[@]}" ps >&2
"${compose[@]}" logs --tail=40 api realtime worker questions >&2
exit 1
