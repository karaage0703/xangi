#!/usr/bin/env bash
set -euo pipefail

# This stable entry point is published as the install.sh asset on every release.
# It selects a target-specific installer; that installer verifies the signed
# manifest and release bundle before extracting either one.
readonly DEFAULT_RELEASE_BASE_URL='https://github.com/karaage0703/xangi/releases/latest/download'
readonly RELEASE_BASE_URL="${XANGI_RELEASE_BASE_URL:-$DEFAULT_RELEASE_BASE_URL}"

fail() {
  echo "xangi bootstrap: $*" >&2
  exit 1
}

command -v curl >/dev/null 2>&1 || fail 'curl is required'

case "$RELEASE_BASE_URL" in
  https://*) ;;
  *) fail 'release URL must use HTTPS' ;;
esac
case "$RELEASE_BASE_URL" in
  *[[:space:]]*) fail 'release URL must not contain whitespace' ;;
esac

case "$(uname -s)" in
  Darwin) platform='darwin' ;;
  Linux) platform='linux' ;;
  *) fail 'this installer supports macOS, Linux, and WSL2 only' ;;
esac

case "$(uname -m)" in
  arm64|aarch64) arch='arm64' ;;
  x86_64|amd64) arch='x64' ;;
  *) fail "unsupported architecture: $(uname -m)" ;;
esac

asset="xangi-installer-${platform}-${arch}.sh"
temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/xangi-bootstrap.XXXXXX")"
installer="$temp_dir/$asset"
cleanup() {
  status=$?
  rm -rf -- "$temp_dir"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

curl --fail --silent --show-error --location \
  --proto '=https' --proto-redir '=https' --tlsv1.2 \
  --max-filesize 2097152 \
  --output "$installer" "${RELEASE_BASE_URL%/}/$asset"

if [[ -t 0 ]]; then
  bash "$installer"
elif { exec 3</dev/tty; } 2>/dev/null; then
  # `curl ... | bash` uses stdin for the bootstrap script itself. Reconnect the
  # downloaded interactive installer to the controlling terminal so its setup
  # prompt reads the user's input instead of the exhausted script pipe.
  set +e
  bash "$installer" <&3
  status=$?
  set -e
  exec 3<&-
  exit "$status"
else
  # Headless callers still get a usable CLI and can resume setup later.
  XANGI_INSTALL_DEFER_SETUP=1 bash "$installer"
fi
