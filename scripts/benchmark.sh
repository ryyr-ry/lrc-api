#!/usr/bin/env bash
# Benchmark the LRC API against LRCLIB upstream.
# Usage: scripts/benchmark.sh [base-url]
set -euo pipefail

BASE="${1:-https://partykit-slot-test.ryyr-ry.partykit.dev}"
UPSTREAM="https://lrclib.net"

QUERIES=(
  "track_name=Shape%20of%20You&artist_name=Ed%20Sheeran"
  "track_name=Blinding%20Lights&artist_name=The%20Weeknd"
  "track_name=Yesterday&artist_name=The%20Beatles"
)

time_endpoint_ms() {
  local url="$1"
  local sum=0
  local count=0
  local t
  for _ in 1 2 3; do
    t=$(curl -sS -m 30 -o /dev/null -w "%{time_total}" "$url")
    sum=$(awk "BEGIN { print $sum + $t }")
    count=$((count + 1))
  done
  awk "BEGIN { printf \"%.0f\", $sum / $count * 1000 }"
}

echo "== /api/get latency ms (avg of 3) =="
for q in "${QUERIES[@]}"; do
  mine=$(time_endpoint_ms "$BASE/api/get?$q")
  upstream=$(time_endpoint_ms "$UPSTREAM/api/get?$q")
  printf "  %-55s mine=%sms upstream=%sms\n" "$q" "$mine" "$upstream"
done

echo "== /api/search latency ms (avg of 3) =="
for q in "q=shape" "q=blinding" "q=yesterday"; do
  mine=$(time_endpoint_ms "$BASE/api/search?$q")
  upstream=$(time_endpoint_ms "$UPSTREAM/api/search?$q")
  printf "  %-20s mine=%sms upstream=%sms\n" "$q" "$mine" "$upstream"
done

echo "== /api/search-lyrics latency ms (mine only) =="
for q in "q=la%20la%20la" "q=nanana"; do
  mine=$(time_endpoint_ms "$BASE/api/search-lyrics?$q")
  printf "  %-20s mine=%sms\n" "$q" "$mine"
done