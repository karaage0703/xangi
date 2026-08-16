#!/bin/bash

set -euo pipefail

ROOT_DIR="${1:-}"
shift

print_help() {
  cat <<'EOF'
Usage:
  xangi update
  xangi update --managed [--manifest URL] [--public-key PATH] [--allow-downgrade]

Checkout update:
  Fast-forwards the current branch, installs locked dependencies, and builds xangi.
  The checkout must be clean, attached to a branch, and configured with an upstream.

The service is not restarted automatically. Run `xangi service restart` when ready.
EOF
}

for arg in "$@"; do
  if [ "$arg" = "--help" ] || [ "$arg" = "-h" ]; then
    print_help
    exit 0
  fi
  echo "Error: unknown checkout update option: $arg" >&2
  exit 1
done

if [ -z "$ROOT_DIR" ] || [ ! -d "$ROOT_DIR/.git" ] || [ ! -f "$ROOT_DIR/package.json" ]; then
  echo "Error: xangi checkout directory is invalid" >&2
  exit 1
fi

cd "$ROOT_DIR"

if [ -n "$(git status --porcelain)" ]; then
  echo "Error: checkout has uncommitted changes. Commit or stash them before xangi update." >&2
  exit 1
fi

branch="$(git symbolic-ref --quiet --short HEAD || true)"
if [ -z "$branch" ]; then
  echo "Error: checkout is detached. Switch to a branch before xangi update." >&2
  exit 1
fi
if ! git rev-parse --abbrev-ref '@{upstream}' >/dev/null 2>&1; then
  echo "Error: branch $branch has no upstream. Configure one before xangi update." >&2
  exit 1
fi

before="$(git rev-parse HEAD)"
git pull --ff-only
after="$(git rev-parse HEAD)"

if [ "$before" = "$after" ]; then
  echo "xangi checkout is already up to date ($branch, ${after:0:7})."
  exit 0
fi

npm ci
npm run build

echo "Updated xangi checkout: $branch ${before:0:7} -> ${after:0:7}"
echo "Build: complete"
