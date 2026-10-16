#!/usr/bin/env bash
# v1 (Deno) ↔ v2 (Node) compatibility check. Run from the repository root.
#
#   v2/compat/run.sh [v1-image] [v2-image] [source-volume]
#
# 1. Wire parity: both images on fresh volumes, the same request script
#    replayed against each (login gate on, then off), responses diffed —
#    status, app-level headers, normalized bodies.
# 2. Storage: a COPY of <source-volume> (default: capillary_capillary-data,
#    opened read-only) is read by v1, then by v2, then v2 writes and v1 reads
#    it back. The source volume is never written.
#
# Expected: every wire diff is a random id (CDP target/session ids); both
# storage snapshots are byte-identical; v1 sees v2's write.
set -euo pipefail

V1=${1:-capillary-cr:v1-head}
V2=${2:-capillary-cr:v2-node}
SRC=${3:-capillary_capillary-data}
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$(mktemp -d)"
P1=18181 P2=18182 P3=18183

cleanup() {
  docker rm -f cap-compat-v1 cap-compat-v2 cap-compat-store >/dev/null 2>&1 || true
  docker volume rm cap-compat-v1 cap-compat-v2 cap-compat-store >/dev/null 2>&1 || true
}
trap cleanup EXIT

wait_up() {
  for _ in $(seq 1 60); do curl -sf "http://127.0.0.1:$1/healthz" >/dev/null && return; sleep 0.5; done
  echo "server on :$1 did not come up" >&2; exit 1
}

pair() {
  cleanup
  docker run -d --name cap-compat-v1 -e CAPILLARY_REQUIRE_GITHUB_LOGIN="$1" -e CAPILLARY_EMBEDDINGS=0 \
    -p 127.0.0.1:$P1:8080 -v cap-compat-v1:/var/lib/capillary "$V1" >/dev/null
  docker run -d --name cap-compat-v2 -e CAPILLARY_REQUIRE_GITHUB_LOGIN="$1" -e CAPILLARY_EMBEDDINGS=0 \
    -p 127.0.0.1:$P2:8080 -v cap-compat-v2:/var/lib/capillary "$V2" >/dev/null
  wait_up $P1; wait_up $P2
}

store() {
  docker rm -f cap-compat-store >/dev/null 2>&1 || true
  docker run -d --name cap-compat-store -e CAPILLARY_REQUIRE_GITHUB_LOGIN=0 -e CAPILLARY_EMBEDDINGS=0 \
    -p 127.0.0.1:$P3:8080 -v cap-compat-store:/var/lib/capillary "$1" >/dev/null
  wait_up $P3
}

echo "== wire parity ($V1 vs $V2)"
pair 1; python3 "$HERE/parity.py" gate "http://127.0.0.1:$P1" "http://127.0.0.1:$P2"
pair 0; python3 "$HERE/parity.py" open "http://127.0.0.1:$P1" "http://127.0.0.1:$P2"

echo "== storage compatibility (copy of $SRC)"
cleanup
docker volume create cap-compat-store >/dev/null
docker run --rm -v "$SRC":/from:ro -v cap-compat-store:/to alpine cp -a /from/. /to/
store "$V1"; python3 "$HERE/snapshot.py" "http://127.0.0.1:$P3" "$OUT/v1.json"
docker stop -t 10 cap-compat-store >/dev/null
store "$V2"; python3 "$HERE/snapshot.py" "http://127.0.0.1:$P3" "$OUT/v2.json"
cmp "$OUT/v1.json" "$OUT/v2.json" && echo "v1 and v2 read identical data"
curl -sf -X POST -H 'content-type: application/json' \
  -d '{"app":"slack","label":"#compat-probe","webhookUrl":"https://hooks.slack.com/services/T0/B0/compatprobe","events":["review.completed"]}' \
  "http://127.0.0.1:$P3/api/team/connections" >/dev/null
docker stop -t 10 cap-compat-store >/dev/null
store "$V1"
curl -sf "http://127.0.0.1:$P3/api/team/connections" | grep -q '"#compat-probe"' \
  && echo "v1 reads v2's write (rollback safe)"
