#!/usr/bin/env bash
set -euo pipefail

# This file is a release template. build-installer.mjs replaces every @...@
# token after verifying the Ed25519-signed release manifest and artifact.
readonly MANIFEST_URL='@MANIFEST_URL@'
readonly MANIFEST_SHA256='@MANIFEST_SHA256@'
readonly ASSET_URL='@ASSET_URL@'
readonly ASSET_SHA256='@ASSET_SHA256@'
readonly ASSET_SIZE='@ASSET_SIZE@'
readonly RELEASE_VERSION='@RELEASE_VERSION@'
readonly RELEASE_PLATFORM='@RELEASE_PLATFORM@'
readonly RELEASE_ARCH='@RELEASE_ARCH@'
readonly ARCHIVE_ROOT='@ARCHIVE_ROOT@'

fail() {
  echo "xangi installer: $*" >&2
  exit 1
}

command -v curl >/dev/null 2>&1 || fail 'curl is required'
command -v tar >/dev/null 2>&1 || fail 'tar is required'
if ! command -v shasum >/dev/null 2>&1 && ! command -v sha256sum >/dev/null 2>&1; then
  fail 'shasum or sha256sum is required'
fi

sha256_file() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    sha256sum "$1" | awk '{print $1}'
  fi
}

case "$(uname -s)" in
  Darwin) detected_platform='darwin' ;;
  Linux) detected_platform='linux' ;;
  *) fail 'this installer supports macOS, Linux, and WSL2 only' ;;
esac
[[ "$detected_platform" == "$RELEASE_PLATFORM" ]] || \
  fail "installer platform is $RELEASE_PLATFORM, but this host is $detected_platform"
if [[ "$detected_platform" == 'linux' ]]; then
  for xdg_value in "${XDG_DATA_HOME:-}" "${XDG_CONFIG_HOME:-}" "${XDG_STATE_HOME:-}"; do
    [[ -z "$xdg_value" || "$xdg_value" == /* ]] || fail 'XDG paths must be absolute'
  done
fi
machine="$(uname -m)"
case "$machine" in
  arm64|aarch64) detected_arch='arm64' ;;
  x86_64) detected_arch='x64' ;;
  *) fail "unsupported architecture: $machine" ;;
esac
[[ "$detected_arch" == "$RELEASE_ARCH" ]] || \
  fail "installer architecture is $RELEASE_ARCH, but this host is $detected_arch"

temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/xangi-install.XXXXXX")"
staging=''
backup=''
target=''
installed_target=0
current_switched=0
previous_current=''
had_previous_current=0
cleanup() {
  status=$?
  if [[ $status -ne 0 ]]; then
    if [[ $current_switched -eq 1 ]]; then
      rm -f -- "$app_root/current"
      if [[ $had_previous_current -eq 1 ]]; then
        ln -s -- "$previous_current" "$app_root/current" || true
      fi
    fi
    if [[ $installed_target -eq 1 && -n "$target" ]]; then
      rm -rf -- "$target"
    fi
    if [[ -n "$backup" && -n "$target" && -d "$backup" ]]; then
      mv -- "$backup" "$target" || true
    fi
  fi
  [[ -z "$staging" ]] || rm -rf -- "$staging"
  rm -rf -- "$temp_dir"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

manifest="$temp_dir/manifest.json"
archive="$temp_dir/xangi.tar.gz"
curl --fail --silent --show-error --location \
  --proto '=https' --proto-redir '=https' --tlsv1.2 \
  --max-filesize 1048576 \
  --output "$manifest" "$MANIFEST_URL"
actual_manifest_sha="$(sha256_file "$manifest")"
[[ "$actual_manifest_sha" == "$MANIFEST_SHA256" ]] || \
  fail 'release manifest SHA-256 verification failed'

curl --fail --silent --show-error --location \
  --proto '=https' --proto-redir '=https' --tlsv1.2 \
  --max-filesize "$ASSET_SIZE" \
  --output "$archive" "$ASSET_URL"
actual_size="$(wc -c <"$archive" | tr -d '[:space:]')"
[[ "$actual_size" == "$ASSET_SIZE" ]] || fail 'release bundle size verification failed'
actual_asset_sha="$(sha256_file "$archive")"
[[ "$actual_asset_sha" == "$ASSET_SHA256" ]] || \
  fail 'release bundle SHA-256 verification failed'

# Never extract bytes before both the pinned manifest and bundle are verified.
entries="$temp_dir/archive-entries.txt"
tar -tzf "$archive" >"$entries"
LC_ALL=C awk -v root="$ARCHIVE_ROOT" '
  BEGIN { ok = 1 }
  {
    name = $0
    if (name == "" || name ~ /^\// || name ~ /\\/ || name ~ /[[:cntrl:]]/) ok = 0
    count = split(name, parts, "/")
    if (parts[1] != root) ok = 0
    for (i = 1; i <= count; i++) {
      if (parts[i] == "." || parts[i] == "..") ok = 0
    }
  }
  END { exit ok ? 0 : 1 }
' "$entries" || fail 'release bundle contains an unsafe path'
details="$temp_dir/archive-details.txt"
tar -tvzf "$archive" >"$details"
LC_ALL=C awk '
  substr($0, 1, 1) != "-" && substr($0, 1, 1) != "d" { exit 1 }
' "$details" || fail 'release bundle may contain only regular files and directories'

if [[ "$RELEASE_PLATFORM" == 'darwin' ]]; then
  default_app_root="$HOME/Library/Application Support/xangi/app"
  default_config_dir="$HOME/Library/Application Support/xangi/config"
else
  default_app_root="${XDG_DATA_HOME:-$HOME/.local/share}/xangi/app"
  default_config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/xangi"
fi
app_root="${XANGI_APP_ROOT:-$default_app_root}"
config_dir="${XANGI_CONFIG_DIR:-$default_config_dir}"
versions_dir="$app_root/versions"
staging="$app_root/staging/install.$$"
target="$versions_dir/$RELEASE_VERSION"
mkdir -p -- "$versions_dir" "$app_root/staging" "$app_root/bin" "$app_root/trust" "$config_dir"
chmod 0700 "$app_root/trust" "$config_dir"
if [[ -L "$app_root/current" ]]; then
  previous_current="$(readlink "$app_root/current")"
  had_previous_current=1
elif [[ -e "$app_root/current" ]]; then
  fail 'current must be a symbolic link'
fi
rm -rf -- "$staging"
mkdir -p -- "$staging"
tar -xzf "$archive" -C "$staging"
unpacked="$staging/$ARCHIVE_ROOT"
[[ -x "$unpacked/runtime/bin/node" ]] || fail 'bundle is missing its Node.js runtime'
[[ -f "$unpacked/dist/cli/xangi-main.js" ]] || fail 'bundle is missing the xangi CLI entrypoint'

if [[ -e "$target" ]]; then
  backup="$versions_dir/.${RELEASE_VERSION}.backup.$$"
  rm -rf -- "$backup"
  mv -- "$target" "$backup"
fi
mv -- "$unpacked" "$target"
installed_target=1

next_link="$app_root/.current.$$"
ln -s -- "$target" "$next_link"
"$target/runtime/bin/node" -e \
  'require("node:fs").renameSync(process.argv[1], process.argv[2])' \
  "$next_link" "$app_root/current"
current_switched=1

launcher="$app_root/bin/xangi"
cat >"$launcher" <<'LAUNCHER'
#!/bin/sh
set -eu
app_root="${XANGI_APP_ROOT:-$HOME/Library/Application Support/xangi/app}"
if [ "$(uname -s)" = Linux ]; then
  app_root="${XANGI_APP_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/xangi/app}"
fi
XANGI_INSTALLATION_KIND=managed exec "$app_root/current/runtime/bin/node" "$app_root/current/dist/cli/xangi-main.js" "$@"
LAUNCHER
chmod 0755 "$launcher"

# Persist the authenticated trust root and update channel outside versioned app
# files. Future updates can therefore verify Ed25519 without another bootstrap.
cat >"$app_root/trust/release-public-key.pem" <<'RELEASE_PUBLIC_KEY'
@PUBLIC_KEY_PEM@
RELEASE_PUBLIC_KEY
chmod 0644 "$app_root/trust/release-public-key.pem"
printf '{"manifestUrl":"%s"}\n' "$MANIFEST_URL" >"$config_dir/release.json"
chmod 0600 "$config_dir/release.json"

# Publish the verified CLI before starting interactive AI onboarding. AI tools
# are external processes and may fail independently; their failure must not
# roll back xangi or leave a dangling command.
command_dir="$HOME/.local/bin"
command_link="$command_dir/xangi"
mkdir -p -- "$command_dir"
if [[ -e "$command_link" && ! -L "$command_link" ]]; then
  fail "$command_link already exists and is not a symbolic link"
fi
next_command_link="$command_dir/.xangi.$$"
rm -f -- "$next_command_link"
ln -s -- "$launcher" "$next_command_link"
mv -f -- "$next_command_link" "$command_link"

# The verified application and stable command are now committed. Subsequent
# setup/service failures remain recoverable through `xangi setup` or
# `xangi install` and must not trigger bundle rollback.
[[ -z "$backup" ]] || rm -rf -- "$backup"
backup=''
staging=''
installed_target=0
current_switched=0

setup_pending=0
if [[ "${XANGI_INSTALL_DEFER_SETUP:-0}" == '1' ]]; then
  setup_pending=1
  echo 'No interactive terminal is available; AI setup was deferred.' >&2
elif [[ "${XANGI_INSTALL_SKIP_SETUP:-0}" != '1' ]]; then
  set +e
  XANGI_INSTALL_ACTIVATES_AFTER_SETUP=1 "$launcher" setup
  setup_status=$?
  set -e
  if [[ $setup_status -ne 0 ]]; then
    setup_pending=1
    echo "xangi setup did not complete (exit $setup_status). The installation was kept." >&2
  fi
fi
if [[ $setup_pending -eq 0 && "${XANGI_INSTALL_SKIP_ACTIVATE:-0}" != '1' ]]; then
  "$launcher" install
fi

echo "Installed xangi $RELEASE_VERSION."
echo "Launcher: $launcher"
echo "Command: $command_link"
case ":${PATH:-}:" in
  *":$command_dir:"*) command_on_path=1 ;;
  *) command_on_path=0 ;;
esac
if [[ $setup_pending -eq 1 ]]; then
  echo 'xangi is installed. AI setup and service activation are pending.'
  if [[ $command_on_path -eq 1 ]]; then
    echo 'Continue after installing and authenticating an AI CLI: xangi setup'
  else
    printf 'Continue after installing and authenticating an AI CLI: "%s" setup\n' "$launcher"
  fi
else
  echo 'Setup and service activation complete.'
  if [[ $command_on_path -eq 1 ]]; then
    echo 'Verify: xangi doctor'
  else
    printf 'Verify: "%s" doctor\n' "$launcher"
  fi
fi
if [[ $command_on_path -eq 1 ]]; then
  echo 'Token settings: xangi settings'
else
  printf 'Token settings: "%s" settings\n' "$launcher"
  printf 'Add xangi to this shell: export PATH="%s:$PATH"\n' "$command_dir"
  printf 'For zsh, add that export line to "%s/.zshrc".\n' "$HOME"
fi
