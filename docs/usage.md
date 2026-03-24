# 使い方ガイド

xangiの詳細な使い方ガイドです。

## 目次

- [基本操作](#基本操作)
- [チャンネルトピック注入](#チャンネルトピック注入)
- [タイムスタンプ注入](#タイムスタンプ注入)
- [セッション管理](#セッション管理)
- [スケジューラー](#スケジューラー)
- [Discordコマンド](#discordコマンド)
- [コマンドプレフィックス](#コマンドプレフィックス)
- [ランタイム設定](#ランタイム設定)
- [AIによる自律操作](#aiによる自律操作)
- [Docker実行](#docker実行)
- [Local LLM（Ollama）](#local-llmollama)
- [トラブルシューティング](#トラブルシューティング)

## 基本操作

### メンションで呼び出し

```
@xangi 質問内容
```

### 専用チャンネル

`AUTO_REPLY_CHANNELS` に設定したチャンネルではメンション不要で応答します。

## チャンネルトピック注入

Discordチャンネルのトピック（概要）が設定されている場合、その内容がプロンプトに自動注入されます。

チャンネルごとに異なるコンテキストや指示をAIに渡すことができます。

### 設定方法

Discordのチャンネル設定 → 「トピック」に自然言語で指示を記述します。

### 活用例

- `作業前に必ず ~/project/README.md を読むこと`
- `このチャンネルでは日本語で返答すること`
- `常にmemory-RAGを検索してから返答すること`

トピックが空の場合は何も注入されません。

## タイムスタンプ注入

プロンプトの先頭に現在時刻（JST）を自動注入します。AIが時間経過を認識でき、経過時間の把握や時間に関連する判断が正確になります。

デフォルトで有効です。無効にするには：

```bash
INJECT_TIMESTAMP=false
```

注入フォーマット: `[現在時刻: 2026/3/8 12:34:56]`

## セッション管理

| コマンド                    | 説明                   |
| --------------------------- | ---------------------- |
| `/new`, `!new`, `new`       | 新しいセッションを開始 |
| `/clear`, `!clear`, `clear` | セッション履歴をクリア |

## スケジューラー

定期実行やリマインダーを設定できます。AIが自然言語を解釈して `!schedule` コマンドを自動実行します。

### コマンド一覧

| コマンド                        | 説明                                 |
| ------------------------------- | ------------------------------------ |
| `/schedule`                     | スラッシュコマンドでスケジュール操作 |
| `!schedule <時間> <メッセージ>` | スケジュール追加                     |
| `!schedule list` / `!schedule`  | 一覧表示（全チャンネル）             |
| `!schedule remove <番号>`       | 削除（複数可: `remove 1 2 3`）       |
| `!schedule toggle <番号>`       | 有効/無効切り替え                    |

> 💡 `/schedule` スラッシュコマンドでも同様の操作ができます。

### 時間指定の書き方

#### 単発リマインダー

```
30分後 〇〇をリマインド
1時間後 会議の準備
15:30 今日の15時半に通知
```

#### 繰り返し（自然言語）

```
毎日 9:00 朝の挨拶
毎日 18:00 日報を書く
毎週月曜 10:00 週次レポート
毎週金曜 17:00 週末の予定確認
```

#### cron式

より細かい制御が必要な場合はcron式も使えます：

```
0 9 * * * 毎日9時
0 */2 * * * 2時間ごと
30 8 * * 1-5 平日8:30
0 0 1 * * 毎月1日
```

| フィールド | 値   | 説明                |
| ---------- | ---- | ------------------- |
| 分         | 0-59 |                     |
| 時         | 0-23 |                     |
| 日         | 1-31 |                     |
| 月         | 1-12 |                     |
| 曜日       | 0-6  | 0=日曜, 1=月曜, ... |

### CLI（コマンドライン）

```bash
# スケジュール追加
npx tsx src/schedule-cli.ts add --channel <channelId> "毎日 9:00 おはよう"

# 一覧表示
npx tsx src/schedule-cli.ts list

# 削除（番号指定）
npx tsx src/schedule-cli.ts remove --channel <channelId> 1

# 複数削除
npx tsx src/schedule-cli.ts remove --channel <channelId> 1 2 3

# 有効/無効切り替え
npx tsx src/schedule-cli.ts toggle --channel <channelId> 1
```

### データ保存

スケジュールデータは `${DATA_DIR}/schedules.json` に保存されます。

- デフォルト: `/workspace/.xangi/schedules.json`
- 環境変数 `DATA_DIR` で変更可能

## Discordコマンド

AIがDiscord操作を実行するためのコマンドです。

| コマンド                               | 説明                                                          |
| -------------------------------------- | ------------------------------------------------------------- |
| `!discord send <#channel> メッセージ`  | 指定チャンネルにメッセージ送信                                |
| `!discord channels`                    | サーバーのチャンネル一覧表示                                  |
| `!discord history [件数] [<#channel>]` | チャンネルの最新メッセージを取得（デフォルト10件、最大100件） |
| `!discord search キーワード`           | 現在のチャンネルでメッセージ検索                              |
| `!discord delete <メッセージID>`       | 指定メッセージを削除                                          |
| `!discord delete <メッセージリンク>`   | リンク先のメッセージを削除（別チャンネルも可）                |
| `!discord edit <ID/リンク/last> 内容`  | 自分のメッセージを編集（`last` で直前のメッセージ）           |

### 使用例

```
# 別チャンネルに投稿
!discord send <#1234567890> 作業完了しました！

# チャンネル一覧を確認
!discord channels

# チャンネル履歴を取得（結果はAIのコンテキストに返る）
!discord history              # 現在のチャンネル最新10件
!discord history 50           # 現在のチャンネル最新50件
!discord history 20 <#1234>   # 指定チャンネル20件
!discord history 30 offset:30 # 30〜60件目を取得（遡り）

# メッセージを検索
!discord search PR

# メッセージIDを指定して削除
!discord delete 123456789012345678

# メッセージリンクで削除（別チャンネルのメッセージもOK）
!discord delete https://discord.com/channels/111/222/333

# 直前の自分のメッセージを編集
!discord edit last 修正後の内容

# メッセージIDを指定して編集
!discord edit 123456789012345678 新しい内容
```

## 許可確認のスキップ

デフォルトではAIはファイル作成やコマンド実行時に許可確認を求めます。
`!skip` プレフィックスまたは `/skip` スラッシュコマンドで許可確認をスキップできます。

環境変数 `SKIP_PERMISSIONS=true` を設定すると、デフォルトで全メッセージがスキップモードになります。

### `!skip` プレフィックス

メッセージの先頭に `!skip` を付けると、そのメッセージだけスキップモードで実行します。

### `/skip` スラッシュコマンド

`/skip メッセージ` で、許可確認をスキップしてメッセージを実行します。`!skip` プレフィックスと同じ動作です。

### 使用例

```
@xangi !skip gh pr list
!skip ビルドして                    # 専用チャンネルではメンション不要
/skip ビルドして                    # スラッシュコマンド版
```

## ランタイム設定

`${WORKSPACE_PATH}/settings.json` にランタイム設定が保存されます。

```json
{
  "autoRestart": true
}
```

| 設定          | 説明                             | デフォルト |
| ------------- | -------------------------------- | ---------- |
| `autoRestart` | AIエージェントによる再起動を許可 | `true`     |

### 設定の確認・変更

| コマンド    | 説明             |
| ----------- | ---------------- |
| `/settings` | 現在の設定を表示 |
| `/restart`  | ボットを再起動   |

## AIによる自律操作

### 設定変更（ローカル実行時のみ）

AIは `.env` ファイルを編集して設定を変更できます：

```
「このチャンネルでも応答して」
→ AIが AUTO_REPLY_CHANNELS を編集 → 再起動
```

### システムコマンド

AIが出力する特殊コマンド：

| コマンド                 | 説明           |
| ------------------------ | -------------- |
| `SYSTEM_COMMAND:restart` | ボットを再起動 |

### メッセージ分割セパレータ

AIの応答テキストに `\n===\n`（前後に改行を含む `===`）が含まれている場合、そこで分割して別メッセージとして送信します。スケジューラー経由の応答だけでなく、Discordメンションからの直接メッセージでも機能します。1回のLLM応答で複数の独立した投稿を生成したい場合に便利です。

```
📝 ツイート解説1
> ツイート本文...

===
📝 ツイート解説2
> ツイート本文...
```

上記の応答はDiscordに2つの別メッセージとして送信されます。

### 再起動の仕組み

- **Docker**: `restart: always` により自動復帰
- **ローカル**: pm2等のプロセスマネージャが必要

```bash
# pm2での運用例
pm2 start "npm start" --name xangi
pm2 logs xangi
```

### pm2で環境変数を変更する場合

xangiは `node --env-file=.env` で環境変数を読み込みます。環境変数を変更したい場合は **`.env` ファイルを編集してから `pm2 restart`** してください。

```bash
# 正しい方法: .envを編集してrestart
vim .env  # TIMEOUT_MS=60000 を追加
pm2 restart xangi
```

> **⚠️ `pm2 restart --update-env` は使わないこと！**
> `--update-env` はシェルの全環境変数をpm2に保存します。複数のxangiインスタンスを動かしている場合、別インスタンスの `DISCORD_TOKEN` 等が混入し、同じbotトークンで二重ログインする原因になります。
> `node --env-file=.env` は既存の環境変数を上書きしないため、pm2が先にセットした値が優先されてしまいます。

## Docker実行

コンテナ隔離環境で実行できます。3つのコンテナが用意されています：

| コンテナ | Dockerfile | 用途 |
|---|---|---|
| `xangi` | `Dockerfile` | 軽量版（Claude Code / Codex / Gemini CLI） |
| `xangi-max` | `Dockerfile.max` | フル版（uv + Python対応、Local LLM向け） |
| `xangi-gpu` | `Dockerfile.gpu` | GPU版（CUDA + PyTorch、画像生成・音声処理向け） |

### Claude Code バックエンド

```bash
docker compose up xangi -d --build

# Claude Code 認証
docker exec -it xangi claude
```

### Local LLM バックエンド（Ollama）

Ollamaコンテナが同梱されているため、ホストにOllamaをインストールする必要はありません。

```bash
# .env を設定
AGENT_BACKEND=local-llm
LOCAL_LLM_MODEL=nemotron-3-nano

# 起動（ollama + xangi-max）
docker compose up xangi-max -d --build
```

### GPU版（CUDA + Python + PyTorch）

PyTorch（CUDA対応）が利用可能で、DGX Spark（ARM64）でも動作します。

```bash
# 起動（xangi-gpu + ollama）
docker compose up xangi-gpu -d --build

# Claude Code 認証
docker exec -it xangi-gpu claude

# GPU確認
docker exec -it xangi-gpu python3 -c "import torch; print(torch.cuda.is_available())"
```

> **💡 ヒント**: `xangi-gpu` は `xangi-max` の上位互換です。GPU/PyTorchが必要なスキル（音声文字起こし、画像生成等）を使う場合はこちらを選択してください。

### Docker操作

```bash
# 停止
docker compose down

# 再起動（.env変更後など）
docker compose up xangi-max -d --force-recreate

# ログ確認
docker logs -f xangi-max
```

### ワークスペースのマウント

| 環境 | 変数 | 説明 |
|---|---|---|
| ローカル | `WORKSPACE_PATH` | エージェントが直接使うパス |
| Docker | `DOCKER_WORKSPACE_PATH` | ホスト側のパス（コンテナ内は `/workspace` に固定） |

Docker実行時は `.env` に `DOCKER_WORKSPACE_PATH` を設定します：

```bash
DOCKER_WORKSPACE_PATH=/home/user/my-workspace
```

> **⚠️ `WORKSPACE_PATH` は使わないこと。** ホストのシェル環境変数と衝突する可能性があります。

### セキュリティ

- コンテナはホストネットワークに**直接アクセスできません**
- Ollamaコンテナは同じdocker network内で隔離
- AIエージェントへの環境変数はホワイトリスト方式で制限（`DISCORD_TOKEN` 等はアクセス不可）

## Local LLM（Ollama）

xangiのLocal LLMバックエンドはOpenAI互換API（`/v1/chat/completions`）を使用します。

### ローカル実行（Ollama）

```bash
# .env を設定
AGENT_BACKEND=local-llm
LOCAL_LLM_MODEL=gpt-oss:20b
# LOCAL_LLM_BASE_URL=http://localhost:11434  # デフォルト
```

Ollamaが起動していればそのまま動作します。

Local LLMバックエンドでもトランスクリプトログ（`logs/transcripts/`）が保存されます。プロンプト・応答・エラーがチャンネルごとのJSONLファイルに記録されます。

Docker実行については [Docker実行](#docker実行) セクションを参照してください。

### セッション管理と自動リトライ

Local LLMバックエンドはチャンネルごとにセッション（会話履歴）を保持します。コンテキスト長超過や不正メッセージ形式などセッション履歴に起因するエラーが発生した場合、自動的にセッションをクリアして最後のユーザーメッセージだけでリトライします。

### エラーハンドリング

| エラー | メッセージ |
|--------|-----------|
| ECONNREFUSED / fetch failed | LLMサーバーに接続できませんでした。サーバーが起動しているか確認してください。 |
| timeout / aborted | LLMからの応答がタイムアウトしました。しばらくしてから再試行してください。 |
| 401 / 403 | LLMサーバーへの認証に失敗しました。APIキーを確認してください。 |
| 429 | LLMサーバーのレートリミットに達しました。しばらくしてから再試行してください。 |
| 500 / 502 / 503 | LLMサーバーで内部エラーが発生しました。しばらくしてから再試行してください。 |
| その他 | LLMエラー: （元のエラーメッセージ） |

### 対応モデル例

| モデル | サイズ | 特徴 | 備考 |
|--------|--------|------|------|
| `gpt-oss:20b` | 13GB | MoE、高品質・ツールコール対応 | 推奨 |
| `gpt-oss:120b` | 65GB | MoE（アクティブ12B）、最高品質 | 大容量メモリ必要 |
| `nemotron-3-nano` | 24GB | Mambaハイブリッド、高速 | |
| `nemotron-3-super` | 86GB | Mambaハイブリッド、高精度 | 大容量メモリ必要 |
| `qwen3.5:9b` | 6.6GB | 軽量・Thinking対応 | |

その他Ollamaで利用可能なモデルに対応しています。

## セキュリティ

### 環境変数のホワイトリスト

AIエージェント（CLI spawn / Local LLM exec）に渡す環境変数は `src/safe-env.ts` で管理。ホワイトリストに記載された変数のみ渡され、`DISCORD_TOKEN` 等のシークレットはAIからアクセス不可。

**許可される変数:** `PATH`, `HOME`, `USER`, `SHELL`, `LANG`, `LC_*`, `TERM`, `TMPDIR`, `TZ`, `NODE_ENV`, `NODE_PATH`, `WORKSPACE_PATH`, `AGENT_BACKEND`, `AGENT_MODEL`, `SKIP_PERMISSIONS`, `DATA_DIR`

**渡されない変数（例）:** `DISCORD_TOKEN`, `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `LOCAL_LLM_API_KEY`, `GH_TOKEN`

ホワイトリストを変更する場合は `src/safe-env.ts` の `ALLOWED_ENV_KEYS` を編集。

## 環境変数一覧

### Discord

| 変数 | 説明 | デフォルト |
|------|------|-----------|
| `DISCORD_TOKEN` | Discord Bot Token | **必須** |
| `DISCORD_ALLOWED_USER` | 許可ユーザーID（カンマ区切りで複数可、`*`で全員許可） | **必須** |
| `AUTO_REPLY_CHANNELS` | メンションなしで応答するチャンネルID（カンマ区切り） | - |
| `DISCORD_STREAMING` | ストリーミング出力 | `true` |
| `DISCORD_SHOW_THINKING` | 思考過程を表示 | `true` |
| `INJECT_CHANNEL_TOPIC` | チャンネルトピックをプロンプトに注入 | `true` |
| `INJECT_TIMESTAMP` | 現在時刻をプロンプトに注入 | `true` |

### AIエージェント

| 変数 | 説明 | デフォルト |
|------|------|-----------|
| `AGENT_BACKEND` | バックエンド（`claude-code` / `codex` / `gemini` / `local-llm`） | `claude-code` |
| `AGENT_MODEL` | 使用するモデル | - |
| `WORKSPACE_PATH` | 作業ディレクトリ（ローカル実行時） | `./workspace` |
| `DOCKER_WORKSPACE_PATH` | ワークスペースのホスト側パス（Docker実行時） | `./workspace` |
| `SKIP_PERMISSIONS` | デフォルトで許可スキップ | `false` |
| `TIMEOUT_MS` | タイムアウト（ミリ秒） | `300000` |
| `PERSISTENT_MODE` | 常駐プロセスモード | `true` |
| `MAX_PROCESSES` | 同時実行プロセス数の上限 | `10` |
| `IDLE_TIMEOUT_MS` | アイドルプロセスの自動終了時間 | `1800000` |
| `DATA_DIR` | データ保存ディレクトリ | `.xangi` |
| `GH_TOKEN` | GitHub CLIトークン | - |

### Local LLM（`AGENT_BACKEND=local-llm` 時）

| 変数 | 説明 | デフォルト |
|------|------|-----------|
| `LOCAL_LLM_BASE_URL` | LLMサーバーURL | `http://localhost:11434` |
| `LOCAL_LLM_MODEL` | 使用するモデル名 | - |
| `LOCAL_LLM_API_KEY` | APIキー（vLLM等で必要な場合） | - |
| `LOCAL_LLM_THINKING` | Thinkingモデルの推論を有効にするか | `true` |
| `LOCAL_LLM_MAX_TOKENS` | 最大トークン数 | `8192` |
| `LOCAL_LLM_NUM_CTX` | コンテキストウィンドウサイズ（Ollama用） | モデルのデフォルト |
| `EXEC_TIMEOUT_MS` | execツールのタイムアウト（ミリ秒） | `120000` |
| `WEB_FETCH_TIMEOUT_MS` | web_fetchツールのタイムアウト（ミリ秒） | `15000` |

### Slack（非推奨）

| 変数 | 説明 |
|------|------|
| `SLACK_BOT_TOKEN` | Slack Bot Token（xoxb-...） |
| `SLACK_APP_TOKEN` | Slack App Token（xapp-...） |
| `SLACK_ALLOWED_USER` | 許可ユーザーID |
| `SLACK_AUTO_REPLY_CHANNELS` | メンションなしで応答するチャンネルID |
| `SLACK_REPLY_IN_THREAD` | スレッド返信するか（デフォルト: `true`） |

## トラブルシューティング

### 「Prompt is too long」エラー

**症状:** 特定のチャンネルで全てのメッセージに対して「❌ エラーが発生しました: Prompt is too long」と返される。

**原因:** セッションの会話履歴がClaude Code（Agent SDK）のコンテキスト上限を超えた。通常はAgent SDKが自動でコンテキストを圧縮するが、セッションが異常終了した場合など、状態が壊れて回復できなくなることがある。

**対処法:**

1. 該当チャンネルで `/new` コマンドを実行してセッションをリセットする
2. それでも解消しない場合は、xangiを再起動する（`pm2 restart xangi`）
