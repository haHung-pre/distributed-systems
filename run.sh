#!/usr/bin/env bash
# One-command startup that survives a workspace snapshot restore.
#
# Workspace snapshots exclude node_modules and drop executable bits, so a
# restored workspace fails with "Permission denied" or "Cannot find module 'ws'".
# This script repairs both, then starts the cluster.
#
#   bash run.sh [numReplicas]     (default 2)
set -euo pipefail
cd "$(dirname "$0")"

chmod +x scripts/*.sh
[ -d node_modules/ws ] || { echo "==> installing dependencies"; npm install --silent; }
[ -f .env ] || {
  echo "==> creating .env with fresh secrets"
  sed -e "s|replace-with-64-random-hex-chars|$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')|" \
      -e "s|replace-with-another-random-string|$(node -e 'console.log(require("crypto").randomBytes(24).toString("hex"))')|" \
      .env.example > .env
}

./scripts/stop-cluster.sh >/dev/null 2>&1 || true
exec ./scripts/start-cluster.sh "${1:-2}"
