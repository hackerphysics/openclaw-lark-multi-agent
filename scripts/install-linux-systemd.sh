#!/usr/bin/env bash
set -euo pipefail

APP_NAME="lark-multi-agent"
SERVICE_NAME="${APP_NAME}.service"
MODE="user"
DEPLOY_DIR="${LMA_DEPLOY_DIR:-$HOME/.local/lib/$APP_NAME}"
STATE_DIR="${LMA_STATE_DIR:-$HOME/.openclaw/$APP_NAME}"
RESTART="1"

usage() {
  cat <<USAGE
Usage: $0 [--user|--system] [--deploy-dir DIR] [--no-restart]

Build and deploy ${APP_NAME} to a runtime directory, then install a systemd service.

Defaults:
  mode:       --user
  deploy dir: ~/.local/lib/${APP_NAME}
  state dir:  ~/.openclaw/${APP_NAME}

Examples:
  $0
  $0 --system
  $0 --deploy-dir ~/.local/lib/${APP_NAME}-prod
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --user) MODE="user"; shift ;;
    --system) MODE="system"; shift ;;
    --deploy-dir) DEPLOY_DIR="$2"; shift 2 ;;
    --no-restart) RESTART="0"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage; exit 1 ;;
  esac
done

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
NPM_BIN="${NPM_BIN:-$(command -v npm)}"
CURRENT_USER="$(id -un)"

if [[ -z "${NODE_BIN}" || -z "${NPM_BIN}" ]]; then
  echo "node/npm not found in PATH" >&2
  exit 1
fi

cd "$ROOT_DIR"
echo "==> Building ${APP_NAME} from ${ROOT_DIR}"
"$NPM_BIN" ci
"$NPM_BIN" run build

mkdir -p "$DEPLOY_DIR/dist" "$STATE_DIR/data"

# First install convenience: migrate existing local runtime data if the state dir
# does not already have a database. Future installs preserve state data in place.
if [[ ! -f "$STATE_DIR/data/messages.db" && -d "$ROOT_DIR/data" ]]; then
  echo "==> Migrating existing data/ to state dir"
  cp -a "$ROOT_DIR/data/." "$STATE_DIR/data/"
fi

echo "==> Deploying runtime files to ${DEPLOY_DIR}"
# Deploy build output only; source files are intentionally not copied.
rsync -a --delete "$ROOT_DIR/dist/" "$DEPLOY_DIR/dist/"
cp "$ROOT_DIR/package.json" "$DEPLOY_DIR/package.json"
cp "$ROOT_DIR/package-lock.json" "$DEPLOY_DIR/package-lock.json"

if [[ -f "$STATE_DIR/config.json" ]]; then
  echo "==> Keeping existing config: ${STATE_DIR}/config.json"
elif [[ -f "$ROOT_DIR/config.json" ]]; then
  echo "==> Copying config.json to state dir"
  cp "$ROOT_DIR/config.json" "$STATE_DIR/config.json"
elif [[ -f "$ROOT_DIR/config.example.json" ]]; then
  echo "==> Creating config.json from config.example.json (edit before use)"
  cp "$ROOT_DIR/config.example.json" "$STATE_DIR/config.json"
else
  echo "WARNING: no config.json or config.example.json found" >&2
fi

# Install runtime dependencies only in deploy dir.
echo "==> Installing production dependencies in deploy dir"
(cd "$DEPLOY_DIR" && "$NPM_BIN" ci --omit=dev)

UNIT_CONTENT="[Unit]
Description=Lark Multi-Agent - Multi-bot bridge for OpenClaw
After=network.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${DEPLOY_DIR}
ExecStart=${NODE_BIN} dist/index.js ${STATE_DIR}/config.json
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=LMA_DATA_DIR=${STATE_DIR}/data

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${APP_NAME}
"

if [[ "$MODE" == "system" ]]; then
  UNIT_CONTENT+="User=${CURRENT_USER}

[Install]
WantedBy=multi-user.target
"
  UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}"
  echo "==> Installing system service: ${UNIT_PATH}"
  printf '%s' "$UNIT_CONTENT" | sudo tee "$UNIT_PATH" >/dev/null
  sudo systemctl daemon-reload
  sudo systemctl enable "$SERVICE_NAME"
  if [[ "$RESTART" == "1" ]]; then
    sudo systemctl restart "$SERVICE_NAME"
    sudo systemctl status "$SERVICE_NAME" --no-pager --lines=8 || true
  fi
else
  UNIT_CONTENT+="
[Install]
WantedBy=default.target
"
  UNIT_DIR="$HOME/.config/systemd/user"
  UNIT_PATH="${UNIT_DIR}/${SERVICE_NAME}"
  mkdir -p "$UNIT_DIR"
  echo "==> Installing user service: ${UNIT_PATH}"
  printf '%s' "$UNIT_CONTENT" > "$UNIT_PATH"
  systemctl --user daemon-reload
  systemctl --user enable "$SERVICE_NAME"
  if [[ "$RESTART" == "1" ]]; then
    systemctl --user restart "$SERVICE_NAME"
    systemctl --user status "$SERVICE_NAME" --no-pager --lines=8 || true
  fi
fi

echo "==> Done"
echo "Deploy dir: ${DEPLOY_DIR}"
echo "State dir:  ${STATE_DIR}"
echo "Mode: ${MODE}"
