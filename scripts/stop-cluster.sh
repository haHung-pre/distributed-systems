#!/usr/bin/env bash
# Stop every process started by start-cluster.sh (graceful SIGTERM).
set -uo pipefail
cd "$(dirname "$0")/.."
shopt -s nullglob
for f in logs/*.pid; do
  pid=$(cat "$f"); name=$(basename "$f" .pid)
  if kill -0 "$pid" 2>/dev/null; then kill -TERM "$pid" 2>/dev/null && echo "  stopped $name ($pid)"; fi
  rm -f "$f"
done
sleep 0.4
pkill -f 'node src/(directory|storage|collab|gateway)/server.js' 2>/dev/null || true
echo "cluster stopped"
