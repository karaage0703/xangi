#!/bin/bash
set -e

MAC_MODE=false
if [ "$1" = "--mac" ]; then
  MAC_MODE=true
fi

echo "🚀 xangi standalone setup"

# テンプレート展開（.gitなし）
if [ ! -d "ai-assistant-workspace" ]; then
  echo "📁 Downloading ai-assistant-workspace template..."
  git clone --depth 1 https://github.com/karaage0703/ai-assistant-workspace.git
  rm -rf ai-assistant-workspace/.git
else
  echo "📁 ai-assistant-workspace already exists, skipping."
fi

MODEL=${LOCAL_LLM_MODEL:-gemma4:e4b}

if [ "$MAC_MODE" = true ]; then
  COMPOSE_FILE="docker/docker-compose.standalone.mac.yml"
  echo "🍎 Mac mode: using host Ollama (Metal GPU)"

  # Ollamaがなければインストール
  if ! command -v ollama > /dev/null 2>&1; then
    echo "📦 Installing Ollama..."
    curl -fsSL https://ollama.com/install.sh | sh
  fi

  # ホストのOllamaが起動しているか確認
  if ! curl -sf http://localhost:11434/api/tags > /dev/null 2>&1; then
    echo "⚠️  Ollama is not running. Starting..."
    ollama serve &
    sleep 2
  fi

  # モデルがなければpull
  if ! ollama list | grep -q "$MODEL"; then
    echo "📦 Pulling model: $MODEL"
    ollama pull "$MODEL"
  fi
else
  COMPOSE_FILE="docker/docker-compose.standalone.yml"
  echo "🐳 Docker mode: Ollama in container"
fi

echo "📦 Model: $MODEL"
echo "🌐 Web UI: http://localhost:18888"

# 既存コンテナを停止・削除
docker rm -f xangi-standalone ollama ollama-init-1 2>/dev/null
docker compose -f docker/docker-compose.standalone.yml down --remove-orphans 2>/dev/null
docker compose -f docker/docker-compose.standalone.mac.yml down --remove-orphans 2>/dev/null
docker compose -f "$COMPOSE_FILE" build --no-cache
docker compose -f "$COMPOSE_FILE" up
