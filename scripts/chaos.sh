#!/usr/bin/env bash
# Fault-injection helper (§4.4).  Usage:
#   ./scripts/chaos.sh kill  collab-1     SIGKILL a replica (crash, no cleanup)
#   ./scripts/chaos.sh stop  collab-1     SIGSTOP  (simulates a frozen/hung node)
#   ./scripts/chaos.sh cont  collab-1     SIGCONT  (resume the frozen node)
#   ./scripts/chaos.sh start collab-1     restart a replica
#   ./scripts/chaos.sh lossy collab-2 0.2 restart with 20% outgoing frame loss
#   ./scripts/chaos.sh storage-down       stop the storage service (DLQ demo)
#   ./scripts/chaos.sh storage-up         bring storage back (DLQ drains)
#   ./scripts/chaos.sh status             show the cluster view
set -uo pipefail
cd "$(dirname "$0")/.."
CMD="${1:-status}"; NODE="${2:-}"; ARG="${3:-}"
pidof() { cat "logs/$1.pid" 2>/dev/null; }
port_of() { echo $((7200 + ${1##*-})); }

start_replica() { # id [extra env]
  local id="$1" port; port=$(port_of "$1")
  REPLICA_ID="$id" COLLAB_PORT="$port" COLLAB_WS_URL="ws://127.0.0.1:$port" \
  CHAOS_DROP_OUT="${CHAOS_DROP_OUT:-0}" CHAOS_DUPLICATE="${CHAOS_DUPLICATE:-0}" CHAOS_DELAY_MS="${CHAOS_DELAY_MS:-0}" \
    node src/collab/server.js >> "logs/$id.log" 2>&1 &
  echo $! > "logs/$id.pid"
  echo "  started $id on :$port (drop=${CHAOS_DROP_OUT:-0} dup=${CHAOS_DUPLICATE:-0} delay=${CHAOS_DELAY_MS:-0}ms)"
}

case "$CMD" in
  kill)  kill -9    "$(pidof "$NODE")" && echo "  SIGKILL -> $NODE (lease will expire, clients fail over)";;
  stop)  kill -STOP "$(pidof "$NODE")" && echo "  SIGSTOP -> $NODE (node frozen: heartbeats stop)";;
  cont)  kill -CONT "$(pidof "$NODE")" && echo "  SIGCONT -> $NODE (node resumed)";;
  start) start_replica "$NODE";;
  lossy) CHAOS_DROP_OUT="${ARG:-0.2}" start_replica "$NODE";;
  storage-down) kill -TERM "$(pidof storage)" && echo "  storage stopped: replicas buffer ops in their dead-letter queue";;
  storage-up)   node src/storage/server.js >> logs/storage.log 2>&1 & echo $! > logs/storage.pid; echo "  storage restarted: DLQ will drain automatically";;
  status)
    echo "== directory registry =="
    curl -s "http://127.0.0.1:${DIRECTORY_PORT:-7000}/registry/replicas" || echo "  directory unreachable"
    echo; echo "== replica health =="
    for f in logs/collab-*.pid; do
      [ -e "$f" ] || continue
      id=$(basename "$f" .pid)
      printf '  %s: ' "$id"
      curl -s --max-time 1 "http://127.0.0.1:$(port_of "$id")/health" || echo "DOWN"
      echo
    done;;
  *) echo "unknown command: $CMD"; exit 1;;
esac
