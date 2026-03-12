#!/bin/bash
# Setup systemd user service for xangi-logomix
#
# Usage:
#   ./scripts/setup-service.sh              # Install and start service
#   ./scripts/setup-service.sh --uninstall  # Stop and remove service
#
# Environment variables:
#   SERVICE_NAME  - systemd service name (default: xangi-logomix)
#
set -euo pipefail

SERVICE_NAME="${SERVICE_NAME:-xangi-logomix}"
SERVICE_FILE="$HOME/.config/systemd/user/${SERVICE_NAME}.service"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Detect node binary path
NODE_BIN="$(which node 2>/dev/null || echo "")"
if [[ -z "$NODE_BIN" ]]; then
  echo "Error: node not found in PATH" >&2
  exit 1
fi

# Detect tool paths for PATH env
CLAUDE_BIN="$(dirname "$(which claude 2>/dev/null || echo "/dev/null")")"
GH_BIN="$(dirname "$(which gh 2>/dev/null || echo "/dev/null")")"
NODE_DIR="$(dirname "$NODE_BIN")"

build_path() {
  local parts=()
  [[ -d "$CLAUDE_BIN" && "$CLAUDE_BIN" != "/" ]] && parts+=("$CLAUDE_BIN")
  parts+=("$NODE_DIR")
  [[ -d "$GH_BIN" && "$GH_BIN" != "/" ]] && parts+=("$GH_BIN")
  parts+=("$HOME/.local/bin" "/usr/local/bin" "/usr/bin" "/bin")
  local IFS=':'
  echo "${parts[*]}"
}

uninstall() {
  echo "Stopping and removing ${SERVICE_NAME}..."
  systemctl --user stop "${SERVICE_NAME}.service" 2>/dev/null || true
  systemctl --user disable "${SERVICE_NAME}.service" 2>/dev/null || true
  rm -f "$SERVICE_FILE"
  systemctl --user daemon-reload
  echo "Done."
  exit 0
}

install() {
  # Ensure dist/ exists
  if [[ ! -f "$REPO_DIR/dist/index.js" ]]; then
    echo "dist/index.js not found. Building..."
    (cd "$REPO_DIR" && npm run build)
  fi

  # Ensure .env exists
  if [[ ! -f "$REPO_DIR/.env" ]]; then
    echo "Error: .env file not found. Copy .env.example and configure it first." >&2
    exit 1
  fi

  # Create service file
  mkdir -p "$(dirname "$SERVICE_FILE")"
  cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=${SERVICE_NAME} - xangi Slack AI Assistant
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${REPO_DIR}
ExecStart=${NODE_BIN} --env-file=.env dist/index.js
Restart=always
RestartSec=5
KillMode=process
Environment=HOME=${HOME}
Environment="PATH=$(build_path)"

[Install]
WantedBy=default.target
EOF

  # Enable lingering (auto-start without login)
  if ! loginctl show-user "$(whoami)" -p Linger 2>/dev/null | grep -q "yes"; then
    echo "Enabling lingering for $(whoami)..."
    loginctl enable-linger "$(whoami)"
  fi

  # Reload, enable, and start
  systemctl --user daemon-reload
  systemctl --user enable "${SERVICE_NAME}.service"
  systemctl --user restart "${SERVICE_NAME}.service"

  echo ""
  echo "=== ${SERVICE_NAME} service installed ==="
  echo ""
  systemctl --user status "${SERVICE_NAME}.service" --no-pager
  echo ""
  echo "Useful commands:"
  echo "  systemctl --user status  ${SERVICE_NAME}   # Check status"
  echo "  systemctl --user restart ${SERVICE_NAME}   # Restart"
  echo "  systemctl --user stop    ${SERVICE_NAME}   # Stop"
  echo "  journalctl --user -u ${SERVICE_NAME} -f    # View logs"
}

# Main
if [[ "${1:-}" == "--uninstall" ]]; then
  uninstall
else
  install
fi
