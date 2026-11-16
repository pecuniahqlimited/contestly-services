#!/usr/bin/env bash
# On the server during a load test (docs/engineering/load-testing.md): every few seconds, each container's CPU,
# memory and network, plus the machine's load and free memory, into a CSV. Ctrl-C to stop.
#
#   bash scripts/load-watch.sh                 # → load-watch-<time>.csv
#   bash scripts/load-watch.sh run1.csv 2      # file, seconds between samples
set -euo pipefail
out="${1:-load-watch-$(date +%Y%m%dT%H%M%S).csv}"
every="${2:-5}"

echo "time,name,cpu,mem,net" > "$out"
echo "Writing $out every ${every}s. Ctrl-C to stop."
while true; do
  now="$(date +%T)"
  docker stats --no-stream --format '{{.Name}},{{.CPUPerc}},{{.MemUsage}},{{.NetIO}}' | sed "s|^|$now,|" >> "$out"
  read -r load1 _ < /proc/loadavg
  free_mb="$(awk '/MemAvailable/ { printf "%d", $2 / 1024 }' /proc/meminfo)"
  echo "$now,host,load $load1,${free_mb} MiB available," >> "$out"
  tail -n 1 "$out"
  sleep "$every"
done
