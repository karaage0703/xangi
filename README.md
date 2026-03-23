# xangi

> **A**I **N**EON **G**ENESIS **I**NTELLIGENCE

Claude Code / Codex / Gemini CLI / Local LLM（Ollama等）をバックエンドに、Discord から利用できる AI アシスタント。

## Features

- 🤖 マルチバックエンド対応（Claude Code / Codex / Gemini CLI / Local LLM）
- 💬 Discord 対応
- 👤 マルチユーザー対応（複数ユーザー許可 / 全員許可）
- 🐳 Docker対応（コンテナ隔離環境）
- 🔒 環境変数ホワイトリスト（AIにシークレットを渡さない）
- 📚 スキルシステム（スラッシュコマンド対応）
- 🐙 GitHub CLI（gh）対応
- ⏰ スケジューラー機能（cron / 単発 / 起動時タスク）
- 🚀 常駐プロセスモードで高速応答
- 💾 セッション永続化（再起動後も会話継続）

## アーキテクチャ

![Architecture](docs/images/architecture.png)

## Quick Start

### 1. 環境変数設定

```bash
cp .env.example .env
```

**最低限の設定（.env）:**
```bash
# Discord Bot Token（必須）
DISCORD_TOKEN=your_discord_bot_token

# 許可ユーザーID（必須、カンマ区切りで複数可、"*"で全員許可）
DISCORD_ALLOWED_USER=123456789012345678
```

> 💡 作業ディレクトリはデフォルトで `./workspace` を使用。変更する場合は `WORKSPACE_PATH` を設定。

> 💡 Discord Bot の作成方法・IDの調べ方は [Discord セットアップ](docs/discord-setup.md) を参照

### 2. ビルド・起動

```bash
# Node.js 22+ と使用するAI CLIが必要
# Claude Code: curl -fsSL https://claude.ai/install.sh | bash
# Codex CLI:   npm install -g @openai/codex
# Gemini CLI:  npm install -g @google/gemini-cli
# Local LLM:   Ollama (https://ollama.com) をインストール

npm install
npm run build
npm start

# 開発時
npm run dev
```

### 3. 動作確認

Discord で bot にメンションして話しかけてください。

### 自動再起動（pm2）

xangi は `/restart` コマンドで再起動できます。自動復帰にはプロセスマネージャが必要です。

```bash
npm install -g pm2
pm2 start "npm start" --name xangi
pm2 restart xangi  # 手動再起動
pm2 logs xangi     # ログ確認
```

## 使い方

### 基本
- `@xangi 質問内容` - メンションで反応
- 専用チャンネル設定時はメンション不要

### 主なコマンド

| コマンド | 説明 |
|----------|------|
| `/new` | 新しいセッションを開始 |
| `/clear` | セッション履歴をクリア |
| `/settings` | 現在の設定を表示 |
| `!schedule` | スケジューラー（定期実行・リマインダー） |
| `!discord` | Discord操作（チャンネル送信・検索） |

詳細は [使い方ガイド](docs/usage.md) を参照してください。

## Docker で実行する場合

コンテナ隔離環境で実行したい場合は Docker も利用できます。

```bash
# Claude Code バックエンド
docker compose up xangi -d --build

# Local LLM バックエンド（Ollama）
docker compose up xangi-max -d --build

# GPU版（CUDA + Python + PyTorch）
docker compose up xangi-gpu -d --build
```

詳細は [使い方ガイド: Docker実行](docs/usage.md#docker実行) を参照してください。

## 環境変数

### 必須

| 変数 | 説明 |
|------|------|
| `DISCORD_TOKEN` | Discord Bot Token |
| `DISCORD_ALLOWED_USER` | 許可ユーザーID（カンマ区切りで複数可、`*`で全員許可） |

全ての環境変数（オプション含む）は [使い方ガイド](docs/usage.md#環境変数一覧) を参照してください。

## ワークスペース

推奨ワークスペース: [ai-assistant-workspace](https://github.com/karaage0703/ai-assistant-workspace)

スキル（メモ管理・日記・音声文字起こし・Notion連携など）がプリセットされたスターターキットです。xangi と組み合わせることで、チャットからスキルを呼び出して日常タスクを自動化できます。

### Claude Code channels との違い

Claude Code には Discord 連携プラグイン（channels）があり、CLI セッションに Discord からメッセージを送れます。xangi とは役割が異なります。

| | xangi | Claude Code channels |
|---|---|---|
| 用途 | 共用 AI ボットサービス | 今の CLI セッションへのリモコン |
| マルチユーザー | 対応 | ペアリング制 |
| マルチバックエンド | Claude Code / Codex / Gemini CLI / Ollama | Claude Code のみ |
| スケジューラー | あり | なし |
| チャンネル × 作業場所の対応付け | 可能（下記参照） | 不可（設定が1つ固定） |

### プロジェクトごとにチャンネルを分ける

複数のプロジェクトを Discord チャンネルで分けて運用する方法は2つあります。

**方法1: 複数インスタンス（確実な隔離）**

プロジェクトごとに xangi ディレクトリを用意し、それぞれの `.env` でワークスペースとチャンネルを設定します。Discord Bot もプロジェクトごとに別途作成が必要です（1トークン = 1ボット）。

```
xangi-project-a/.env:
  WORKSPACE_PATH=/path/to/project-a
  AUTO_REPLY_CHANNELS=111111111
  DISCORD_TOKEN=bot_token_A

xangi-project-b/.env:
  WORKSPACE_PATH=/path/to/project-b
  AUTO_REPLY_CHANNELS=222222222
  DISCORD_TOKEN=bot_token_B
```

**方法2: チャンネルトピック注入（手軽）**

1つの xangi インスタンスで、チャンネルのトピックに作業指示を書くことでコンテキストを切り替えます。Bot は1つで済みますが、`WORKSPACE_PATH` 自体は共通のため AI への指示ベースになります。

```
#project-a のトピック → 作業ディレクトリは ~/project-a で作業すること
#project-b のトピック → 作業ディレクトリは ~/project-b で作業すること
```

| | 方法1（複数インスタンス） | 方法2（トピック注入） |
|---|---|---|
| 隔離レベル | 完全 | ベストエフォート |
| 管理コスト | Bot × N 個 | 1つ |
| 確実性 | 高い | AI が従わない可能性あり |

## 書籍

📖 [生活に溶け込むAI — AIエージェントで作る、自分だけのアシスタント](https://karaage0703.booth.pm/items/8027277)

xangi を使ったAIアシスタント構築のノウハウをまとめた書籍です。

## ドキュメント

- [使い方ガイド](docs/usage.md) - Docker実行・環境変数・Local LLM・トラブルシューティング
- [Discord セットアップ](docs/discord-setup.md) - Bot作成・ID確認方法
- [Slack セットアップ](docs/slack-setup.md) - Slack連携（非推奨）
- [設計ドキュメント](docs/design.md) - アーキテクチャ・設計思想・データフロー

## Acknowledgments

xangi のコンセプトは [OpenClaw](https://github.com/openclaw/openclaw) に影響を受けています。

## License

MIT
