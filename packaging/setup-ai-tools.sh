#!/usr/bin/env bash
set -euo pipefail

readonly SCRIPT_NAME="${0##*/}"

usage() {
  cat <<'EOF'
AIコーディングツールをxangiとは独立してセットアップします。

使い方:
  setup-ai-tools.sh check
  setup-ai-tools.sh codex
  setup-ai-tools.sh opencode
  setup-ai-tools.sh claude-code
  setup-ai-tools.sh cursor
  setup-ai-tools.sh grok
  setup-ai-tools.sh antigravity
  setup-ai-tools.sh github-copilot

checkはインストール・認証状態を変更しません。
ツール名を指定すると、未導入なら公式installerで導入し、対話型の認証を開始します。
EOF
}

fail() {
  echo "$SCRIPT_NAME: $*" >&2
  exit 1
}

show_node_guide() {
  local display_name="$1"
  local tool_name="$2"
  printf '%s\n' \
    "${display_name}の導入にはNode.jsとnpmが必要です。" \
    '' \
    'nvmを使う場合は、次の順番で準備してください。' \
    '' \
    '1. nvmをインストールします。' \
    '   curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.4/install.sh | bash' \
    '' \
    '2. 重要: 現在のTerminalを閉じて、新しいTerminalを開きます。' \
    '   新しいshellでnvmの設定を読み込むため、この手順を挟んでから先へ進んでください。' \
    '' \
    '3. nvmを確認し、LTS版のNode.jsをインストールします。' \
    '   command -v nvm' \
    '   nvm install --lts' \
    '   node --version' \
    '   npm --version' \
    '' \
    "4. 新しいTerminalで${display_name}のセットアップを再実行します。" \
    "   bash <(curl -fsSL https://github.com/karaage0703/xangi/releases/latest/download/setup-ai-tools.sh) ${tool_name}" \
    '' \
    '参考:' \
    '  https://github.com/nvm-sh/nvm' >&2
  exit 1
}

refresh_path() {
  export PATH="$HOME/.local/bin:$HOME/.opencode/bin:$HOME/.cursor/bin:$PATH"
  hash -r 2>/dev/null || true
}

version_of() {
  local command_name="$1"
  "$command_name" --version 2>&1 | head -n 1
}

auth_status() {
  local tool="$1"
  case "$tool" in
    codex) codex login status >/dev/null 2>&1 ;;
    claude-code) claude auth status >/dev/null 2>&1 ;;
    cursor) cursor-agent status >/dev/null 2>&1 ;;
    opencode|grok|antigravity|github-copilot) return 2 ;;
  esac
}

command_for() {
  case "$1" in
    codex) echo codex ;;
    opencode) echo opencode ;;
    claude-code) echo claude ;;
    cursor) echo cursor-agent ;;
    grok) echo grok ;;
    antigravity) echo agy ;;
    github-copilot) echo copilot ;;
  esac
}

check_tool() {
  local tool="$1"
  local command_name
  command_name="$(command_for "$tool")"
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf '%-14s not installed\n' "$tool"
    return
  fi

  local version status
  version="$(version_of "$command_name" || true)"
  if auth_status "$tool"; then
    printf '%-14s ready (%s)\n' "$tool" "${version:-version unknown}"
  else
    status=$?
    if [[ $status -eq 2 ]]; then
      printf '%-14s installed; authentication is checked on launch (%s)\n' "$tool" "${version:-version unknown}"
    else
      printf '%-14s installed; login required (%s)\n' "$tool" "${version:-version unknown}"
    fi
  fi
}

download_and_run() {
  local url="$1"
  command -v curl >/dev/null 2>&1 || fail 'curlが必要です'
  local temp_dir installer
  temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/xangi-ai-tools.XXXXXX")"
  installer="$temp_dir/install.sh"
  if ! curl --fail --silent --show-error --location \
    --proto '=https' --proto-redir '=https' --tlsv1.2 \
    --output "$installer" "$url"; then
    rm -rf -- "$temp_dir"
    fail "installerを取得できませんでした: $url"
  fi
  if ! bash "$installer"; then
    rm -rf -- "$temp_dir"
    fail "公式installerが失敗しました: $url"
  fi
  rm -rf -- "$temp_dir"
}

install_tool() {
  case "$1" in
    codex)
      command -v npm >/dev/null 2>&1 || show_node_guide 'Codex' 'codex'
      npm install -g @openai/codex
      ;;
    opencode) download_and_run 'https://opencode.ai/install' ;;
    claude-code) download_and_run 'https://claude.ai/install.sh' ;;
    cursor) download_and_run 'https://cursor.com/install' ;;
    grok) download_and_run 'https://x.ai/cli/install.sh' ;;
    antigravity) download_and_run 'https://antigravity.google/cli/install.sh' ;;
    github-copilot)
      command -v npm >/dev/null 2>&1 || show_node_guide 'GitHub Copilot CLI' 'github-copilot'
      npm install -g @github/copilot
      ;;
  esac
}

login_tool() {
  case "$1" in
    codex) codex login ;;
    opencode) opencode auth login ;;
    claude-code) claude auth login ;;
    cursor) cursor-agent login ;;
    grok) grok login ;;
    antigravity)
      echo 'Antigravityを起動します。画面の案内に従ってGoogleアカウントで認証してください。'
      agy
      ;;
    github-copilot)
      echo 'GitHub Copilot CLIを起動します。/loginを入力し、画面の案内に従って認証してください。'
      copilot
      ;;
  esac
}

setup_tool() {
  local tool="$1"
  local command_name
  command_name="$(command_for "$tool")"
  if ! command -v "$command_name" >/dev/null 2>&1; then
    install_tool "$tool"
    refresh_path
  fi
  command -v "$command_name" >/dev/null 2>&1 || fail "$command_nameをPATH上で確認できません。新しいTerminalを開いて再実行してください"

  if auth_status "$tool"; then
    echo "$tool はインストール・認証済みです。"
    return
  fi
  login_tool "$tool"
  echo "$tool のセットアップを終了しました。"
}

refresh_path
case "${1:-}" in
  check)
    for tool in codex claude-code cursor grok antigravity github-copilot opencode; do
      check_tool "$tool"
    done
    ;;
  codex|claude-code|cursor|grok|antigravity|github-copilot|opencode) setup_tool "$1" ;;
  -h|--help|'') usage ;;
  *) usage >&2; fail "未対応のツールです: $1" ;;
esac
