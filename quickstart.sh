#!/bin/bash
set -e

echo "🚀 xangi standalone setup"

# ワークスペースが未クローンならクローン
if [ ! -d "workspace" ]; then
  echo "📁 Cloning ai-assistant-workspace..."
  git clone https://github.com/karaage0703/ai-assistant-workspace.git workspace
else
  echo "📁 Workspace already exists, pulling latest..."
  cd workspace && git pull && cd ..
fi

# Docker Compose起動
echo "🐳 Starting xangi + Ollama..."
echo "📦 Model: ${LOCAL_LLM_MODEL:-gemma4:e4b}"
echo "🌐 Web UI: http://localhost:18888"
docker compose -f docker-compose.standalone.yml up --build
