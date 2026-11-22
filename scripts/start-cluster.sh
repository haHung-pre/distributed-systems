#!/usr/bin/env bash
# Start the whole distributed system as independent OS processes.
#   ./scripts/start-cluster.sh [numReplicas]        (default 2)
# Logs -> logs/<node>.log ; PIDs -> logs/<node>.pid
set -euo pipefail
cd "$(dirname "$0")/.."
REPLICAS="${1:-2}"
mkdir -p logs data
export LOG_FORMAT="${LOG_FORMAT:-json}"

start() { # name  cmd...
  local name="$1"; shift
  "$@" > "logs/$name.log" 2>&1 &
  echo $! > "logs/$name.pid"
  echo "  started $name (pid $(cat logs/$name.pid))"
}

wait_http() { # url
  for _ in $(seq 1 60); do
    if curl -fsS "$1" >/dev/null 2>&1; then return 0; fi
    sleep 0.25
  done
  echo "TIMEOUT waiting for $1" >&2; return 1
}

echo "==> starting Directory Service"
NODE_ID=directory-1 start directory node src/directory/server.js
wait_http http://127.0.0.1:${DIRECTORY_PORT:-7000}/health

echo "==> starting Storage Service"
NODE_ID=storage-1 start storage node src/storage/server.js
wait_http http://127.0.0.1:${STORAGE_PORT:-7100}/health

for i in $(seq 1 "$REPLICAS"); do
  port=$((7200 + i))
  echo "==> starting Collaboration Replica collab-$i on :$port"
  REPLICA_ID="collab-$i" COLLAB_PORT="$port" COLLAB_WS_URL="ws://127.0.0.1:$port" \
    start "collab-$i" node src/collab/server.js
  wait_http "http://127.0.0.1:$port/health"
done

echo "==> starting Gateway + Web UI"
start gateway node src/gateway/server.js
wait_http "http://127.0.0.1:${GATEWAY_PORT:-8080}/health"

echo
echo "Cluster is up:"
echo "  Directory : http://127.0.0.1:${DIRECTORY_PORT:-7000}/health"
echo "  Storage   : http://127.0.0.1:${STORAGE_PORT:-7100}/health"
for i in $(seq 1 "$REPLICAS"); do echo "  collab-$i  : http://127.0.0.1:$((7200+i))/health"; done
echo "  Web UI    : http://127.0.0.1:${GATEWAY_PORT:-8080}/"
