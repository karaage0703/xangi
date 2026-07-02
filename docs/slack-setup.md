# Slack App セットアップガイド

xangi を Slack で使用するための App 作成手順。

## 1. Slack API にアクセス

https://api.slack.com/apps

Slack アカウントでログイン。

## 2. 新しいアプリ作成

1. **「Create New App」** をクリック
2. **「From scratch」** を選択
3. App Name: `xangi`（任意の名前）
4. ワークスペースを選択
5. **「Create App」** をクリック

## 3. Socket Mode を有効化（重要）

xangi は Socket Mode で動作します（Webhook 不要）。

1. 左メニュー **「Socket Mode」** をクリック
2. **「Enable Socket Mode」** を ON
3. App-Level Token を作成：
   - Token Name: `xangi-socket`
   - Scopes: `connections:write`
   - **「Generate」** をクリック
4. 表示された **App Token（xapp-...）をコピー**

## 4. Event Subscriptions 設定

1. 左メニュー **「Event Subscriptions」** をクリック
2. **「Enable Events」** を ON
3. **「Subscribe to bot events」** で以下を追加：

| Event | 説明 | 用途 |
|-------|------|------|
| `app_mention` | メンションされた時 | 必須 |
| `message.im` | DM を受け取った時 | DM対応時 |
| `message.channels` | パブリックチャンネルのメッセージ | メンションなし応答時 |
| `message.groups` | プライベートチャンネルのメッセージ | メンションなし応答時 |

⚠️ **`SLACK_AUTO_REPLY_CHANNELS` を使う場合は `message.channels` / `message.groups` が必要です**

## 5. OAuth & Permissions 設定

1. 左メニュー **「OAuth & Permissions」** をクリック
2. **「Scopes」** → **「Bot Token Scopes」** で以下を追加：

| Scope | 説明 | 用途 |
|-------|------|------|
| `app_mentions:read` | メンションの読み取り | 必須 |
| `chat:write` | メッセージ送信 | 必須 |
| `files:read` | ファイルの読み取り | 添付ファイル対応時 |
| `reactions:write` | リアクション追加（👀など） | 必須 |
| `im:history` | DM の履歴読み取り | DM対応時 |
| `im:read` | DM の読み取り | DM対応時 |
| `im:write` | DM の送信 | DM対応時 |
| `channels:read` | パブリックチャンネル情報の読み取り | `xangi-cmd slack_channels` 使用時 |
| `groups:read` | プライベートチャンネル情報の読み取り | `xangi-cmd slack_channels` 使用時 |
| `channels:history` | パブリックチャンネルの履歴読み取り | メンションなし応答時 |
| `groups:history` | プライベートチャンネルの履歴読み取り | メンションなし応答時 |

## 6. スラッシュコマンド登録（オプション）

1. 左メニュー **「Slash Commands」** をクリック
2. 以下のコマンドを作成：

| Command | Description |
|---------|-------------|
| `/new` | 新しいセッションを開始 |
| `/skills` | 利用可能なスキル一覧 |
| `/skill` | スキルを実行（Usage Hint: `<スキル名> [引数]`） |

⚠️ Socket Mode では Request URL は不要です。

## 7. ワークスペースにインストール

1. 左メニュー **「Install App」** をクリック
2. **「Install to Workspace」** をクリック
3. 権限を確認して **「許可する」**
4. 表示された **Bot User OAuth Token（xoxb-...）をコピー**

## 8. 環境変数を設定

```bash
# .env を編集
vim .env
```

```bash
# Slack Bot Token（xoxb-...）
SLACK_BOT_TOKEN=xoxb-your-bot-token

# Slack App Token（xapp-...）Socket Mode 用
SLACK_APP_TOKEN=xapp-your-app-token

# 許可するユーザー ID（Slack の User ID）
SLACK_ALLOWED_USER=U01234567

# 任意: 特定チャンネルだけスレッドではなくチャンネル直下に返信
SLACK_REPLY_IN_CHANNELS=C01234567
```

> **⚠️ Slack のみで使用する場合は `.env` から `DISCORD_TOKEN` を削除（またはコメントアウト）してください。**
> `DISCORD_TOKEN` が設定されていると Discord 側の設定（`DISCORD_ALLOWED_USER` など）も必要になります。

## 9. 動作確認

```bash
# ビルド
npm run build

# Docker で起動
docker compose up -d --build

# ログ確認
docker logs -f xangi
```

Slack で以下を試す：
- Bot をメンション: `@xangi こんにちは！`
- DM を送信
- `/new` コマンド
- `/skills` コマンド

## IDの調べ方

### ユーザーID

1. ユーザーのプロフィールを開く
2. **「︙」**（その他）→ **「メンバーIDをコピー」**

### チャンネルID

**方法1:** リンクから取得
1. チャンネル名を右クリック → **「リンクをコピー」**
2. URLの末尾がチャンネルID: `https://xxx.slack.com/archives/C01234567` ← `C01234567` がID

**方法2:** チャンネル情報から取得
1. チャンネルを開く → チャンネル名をクリック
2. 一番下に **チャンネルID** が表示される

## トラブルシューティング

### Bot が反応しない

1. Socket Mode が有効になっているか確認
2. Event Subscriptions で `app_mention`, `message.im` が設定されているか確認
3. Bot がチャンネルに招待されているか確認（`/invite @xangi`）
4. `SLACK_ALLOWED_USER` が Slack の User ID になっているか確認

### スラッシュコマンドが動かない

1. Slash Commands でコマンドが登録されているか確認
2. アプリを再インストール（権限変更後は必要）

### 「Slack tokens not configured」エラー

`.env` の `SLACK_BOT_TOKEN` と `SLACK_APP_TOKEN` が設定されているか確認。

### DM で反応しない

1. OAuth Scopes に `im:history`, `im:read` があるか確認
2. Event Subscriptions で `message.im` が設定されているか確認

## チャンネルへの Bot 招待

Bot をチャンネルで使うには、チャンネルに招待する必要があります：

```
/invite @xangi
```

## セキュリティ注意事項

- **トークンを Git にコミットしない**（`.gitignore` に `.env` を追加済み）
- **トークンを公開しない**（漏洩した場合は Slack App 設定で再生成）
- `SLACK_ALLOWED_USER` で使用できるユーザーを1人に制限（Claude Code 利用規約遵守）

## 参考リンク

- [Slack API Documentation](https://api.slack.com/docs)
- [Bolt for JavaScript](https://slack.dev/bolt-js/)
- [Socket Mode](https://api.slack.com/apis/connections/socket)
