#!/usr/bin/env bash
# Update the consolidated lma-core gateway plugin from the LMA repo source.
#
# Usage:  bash scripts/update-lma-core.sh          (build + deploy + hot reload)
#         bash scripts/update-lma-core.sh --check  (verify only, no changes)
#
# Requirements: repo at ~/openclaw-lark-multi-agent with the plugin sources
# under plugins/lma-core/src. Runtime activation must use the Gateway-supported
# plugin control path. A generic core capability response is NOT steer activation proof.
set -euo pipefail

REPO="${LMA_REPO:-$HOME/openclaw-lark-multi-agent}"
EXT_DIR="$HOME/.openclaw/extensions/lma-core"
PLUGIN_ID="lma-core"

say() { printf '[update-lma-core] %s\n' "$*"; }

if [[ "${1:-}" == "--check" ]]; then
  say "verifying deployed plugin health..."
  openclaw gateway call health 2>/dev/null | grep -o "\"$PLUGIN_ID\"" >/dev/null \
    && say "OK: $PLUGIN_ID loaded in gateway" || { say "FAIL: $PLUGIN_ID not in loaded list"; exit 1; }
  openclaw gateway call lma.core.capabilities 2>/dev/null | grep -q '"lma-core"' \
    && say "OK: lma.core.capabilities responds" || { say "FAIL: capabilities RPC"; exit 1; }
  node "$REPO/dist/cli.js" check-core-plugin || { say "FAIL: callback/durable insertion protocol not active"; exit 1; }
  say "all checks passed."
  exit 0
fi

cd "$REPO"
say "building plugins/lma-core..."
npm run build:core-plugin

say "deploying to $EXT_DIR..."
mkdir -p "$EXT_DIR"
rm -rf "$EXT_DIR/dist"
cp -r plugins/lma-core/dist "$EXT_DIR/dist"
cp plugins/lma-core/openclaw.plugin.json plugins/lma-core/package.json "$EXT_DIR/"
if [[ -f plugins/lma-core/README.md ]]; then cp plugins/lma-core/README.md "$EXT_DIR/"; fi

say "hot-reloading $PLUGIN_ID..."
openclaw plugins reload "$PLUGIN_ID"

say "verifying..."
sleep 1
bash "$0" --check
say "done. (rollback: git -C $REPO checkout <prev> && re-run this script)"
