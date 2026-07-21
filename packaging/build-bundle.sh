#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: packaging/build-bundle.sh [options]

Options:
  --project-root PATH   Built xangi project root
  --output PATH         Exact output .tar.gz path
  --output-dir PATH     Output directory (uses versioned default filename)
  --version VERSION     Release SemVer
  --platform PLATFORM   Release platform (darwin, linux, or win32)
  --arch ARCH           Release architecture (arm64 or x64)
  --node-binary PATH    Node.js executable to bundle

Equivalent environment variables use the XANGI_BUNDLE_ prefix, for example
XANGI_BUNDLE_VERSION and XANGI_BUNDLE_NODE_BINARY.
EOF
}

script_dir="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_root="${XANGI_BUNDLE_PROJECT_ROOT:-$(dirname -- "$script_dir")}"
output="${XANGI_BUNDLE_OUTPUT:-}"
output_dir="${XANGI_BUNDLE_OUTPUT_DIR:-}"
version="${XANGI_BUNDLE_VERSION:-}"
platform="${XANGI_BUNDLE_PLATFORM:-}"
arch="${XANGI_BUNDLE_ARCH:-}"
node_binary="${XANGI_BUNDLE_NODE_BINARY:-}"

while (($# > 0)); do
  case "$1" in
    --project-root|--output|--output-dir|--version|--platform|--arch|--node-binary)
      (($# >= 2)) || { echo "Missing value for $1" >&2; exit 2; }
      case "$1" in
        --project-root) project_root="$2" ;;
        --output) output="$2" ;;
        --output-dir) output_dir="$2" ;;
        --version) version="$2" ;;
        --platform) platform="$2" ;;
        --arch) arch="$2" ;;
        --node-binary) node_binary="$2" ;;
      esac
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

node - "$version" <<'NODE' || {
const version = process.argv[2];
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
process.exit(semver.test(version) ? 0 : 1);
NODE
  echo "A valid --version is required" >&2
  exit 2
}
[[ "$platform" == "darwin" || "$platform" == "linux" || "$platform" == "win32" ]] || {
  echo "--platform must be darwin, linux, or win32" >&2
  exit 2
}
[[ "$arch" == "arm64" || "$arch" == "x64" ]] || {
  echo "--arch must be arm64 or x64" >&2
  exit 2
}
[[ -d "$project_root/dist" ]] || { echo "Missing dist directory" >&2; exit 2; }
[[ -f "$project_root/package.json" ]] || { echo "Missing package.json" >&2; exit 2; }
[[ -f "$project_root/package-lock.json" ]] || { echo "Missing package-lock.json" >&2; exit 2; }
[[ -f "$project_root/README.md" ]] || { echo "Missing README.md" >&2; exit 2; }
[[ -f "$project_root/README.en.md" ]] || { echo "Missing README.en.md" >&2; exit 2; }
[[ -d "$project_root/docs" ]] || { echo "Missing docs directory" >&2; exit 2; }
[[ -f "$project_root/src/approval-patterns.json" ]] || { echo "Missing src/approval-patterns.json" >&2; exit 2; }
for web_asset in index.html monitor.html inter-chat.html; do
  [[ -f "$project_root/web/$web_asset" ]] || { echo "Missing web/$web_asset" >&2; exit 2; }
done
[[ -d "$project_root/node_modules" ]] || { echo "Missing node_modules directory" >&2; exit 2; }
[[ -f "$node_binary" && -x "$node_binary" ]] || {
  echo "--node-binary must point to an executable file" >&2
  exit 2
}
node_platform="$("$node_binary" -p 'process.platform')" || {
  echo "--node-binary must run on the release host" >&2
  exit 2
}
node_arch="$("$node_binary" -p 'process.arch')" || {
  echo "--node-binary must report its architecture" >&2
  exit 2
}
[[ "$node_platform" == "$platform" && "$node_arch" == "$arch" ]] || {
  echo "--node-binary target $node_platform/$node_arch does not match $platform/$arch" >&2
  exit 2
}

bundle_name="xangi-${version}-${platform}-${arch}"
if [[ -z "$output" ]]; then
  output_dir="${output_dir:-$project_root/release-bundles}"
  output="$output_dir/${bundle_name}.tar.gz"
fi
mkdir -p -- "$(dirname -- "$output")"

template_suffix="$(printf 'X%.0s' 1 2 3 4 5 6)"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/xangi-bundle.${template_suffix}")"
temporary_output="$(mktemp "${output}.tmp.${template_suffix}")"
cleanup() {
  rm -rf -- "$work_dir"
  rm -f -- "$temporary_output"
}
trap cleanup EXIT INT TERM

bundle_root="$work_dir/$bundle_name"
mkdir -p -- "$bundle_root/runtime/bin" "$bundle_root/node_modules" "$bundle_root/web"
cp -R -- "$project_root/dist" "$bundle_root/dist"
cp -- "$project_root/src/approval-patterns.json" "$bundle_root/dist/approval-patterns.json"
cp -R -- "$project_root/docs" "$bundle_root/docs"
cp -- "$project_root/web/index.html" "$bundle_root/web/index.html"
cp -- "$project_root/web/monitor.html" "$bundle_root/web/monitor.html"
cp -- "$project_root/web/inter-chat.html" "$bundle_root/web/inter-chat.html"
cp -- "$project_root/README.md" "$bundle_root/README.md"
cp -- "$project_root/README.en.md" "$bundle_root/README.en.md"
cp -- "$project_root/package.json" "$bundle_root/package.json"
cp -- "$project_root/package-lock.json" "$bundle_root/package-lock.json"
cp -- "$node_binary" "$bundle_root/runtime/bin/node"
chmod 0755 "$bundle_root/runtime/bin/node"

production_paths="$work_dir/production-paths.txt"
node - "$project_root/package-lock.json" >"$production_paths" <<'NODE'
const fs = require('node:fs');
const lock = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (!lock.packages || typeof lock.packages !== 'object') {
  throw new Error('package-lock.json must contain a packages map');
}
for (const [path, metadata] of Object.entries(lock.packages).sort(([a], [b]) => a.localeCompare(b))) {
  if (!path.startsWith('node_modules/')) continue;
  if (/[\r\n\\]/.test(path) || path.split('/').includes('..')) throw new Error(`Unsafe package path: ${path}`);
  if (metadata && metadata.dev !== true && metadata.link !== true) process.stdout.write(`${path}\n`);
}
NODE

while IFS= read -r package_path; do
  [[ -n "$package_path" ]] || continue
  source_path="$project_root/$package_path"
  [[ -d "$source_path" ]] || { echo "Missing production package: $package_path" >&2; exit 2; }
  destination="$bundle_root/$package_path"
  mkdir -p -- "$(dirname -- "$destination")"
  cp -R -- "$source_path" "$destination"
  # Nested dependencies are copied only through their own lockfile entry.
  rm -rf -- "$destination/node_modules"
done <"$production_paths"

# Defense in depth for accidentally generated files inside otherwise allowed trees.
find "$bundle_root" -type d \( -name .git -o -name logs -o -name memory -o -name secrets \) \
  -prune -exec rm -rf -- {} +
find "$bundle_root" -type f \( \
  -name .env -o -name '.env.*' -o -name '*.pem' -o -name '*.key' -o \
  -name id_rsa -o -name 'id_rsa.*' -o -name credentials.json -o \
  -name secrets.json -o -name .npmrc -o -name '*.secret' \
  \) -delete
find "$bundle_root" -type l -delete

# Stable mtimes, path order, and gzip header make repeated builds byte-identical.
find "$bundle_root" -exec touch -h -t 198001010000 {} +
file_list="$work_dir/files.txt"
(
  cd "$work_dir"
  LC_ALL=C find "$bundle_name" -type f -print | LC_ALL=C sort >"$file_list"
  tar -cf - -T "$file_list"
) | gzip -n >"$temporary_output"

mv -f -- "$temporary_output" "$output"
echo "$output"
