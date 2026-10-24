#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' 'Node.js 22 or newer is required: https://nodejs.org/' >&2
  exit 1
fi
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) { console.error("Node.js 22 or newer is required."); process.exit(1); }'
if [ ! -f node_modules/ws/package.json ]; then
  npm ci --no-audit --no-fund
fi
exec npm start
