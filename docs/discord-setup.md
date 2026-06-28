# Discord Bot セットアップガイド

xangi を Discord で使用するための Bot 作成手順。

## 1. Discord Developer Portal にアクセス

https://discord.com/developers/applications

Discord アカウントでログイン。

## 2. 新しいアプリケーション作成

1. 右上の **「New Application」** をクリック
2. 名前を入力: `xangi`（任意の名前）
3. **「Create」** をクリック

## 3. Bot 作成とトークン取得

1. 左メニューの **「Bot」** をクリック
2. **「Reset Token」** → **「Yes, do it!」**
3. 表示された **トークンをコピー**（後で使用）

⚠️ **注意**: トークンは一度しか表示されない。紛失した場合は再生成が必要。

## 4. Bot 権限設定（重要）

同じ Bot ページで **Privileged Gateway Intents** を設定：

| Intent | 必須 | 説明 |
|--------|------|------|
| Presence Intent | 任意 | ユーザーのオンライン状態取得 |
| Server Members Intent | 任意 | サーバーメンバー情報取得 |
| **Message Content Intent** | **必須** | メッセージ内容の読み取り |

**⚠️ Message Content Intent を ON にしないとメッセージが読めない！**

## 5. Bot をサーバーに招待

1. 左メニュー **「OAuth2」** → **「URL Generator」**
2. **SCOPES** で選択：
   - ✅ `bot`
   - ✅ `applications.commands`（スラッシュコマンド用）
3. **BOT PERMISSIONS** で選択：
   - ✅ Send Messages
   - ✅ Send Messages in Threads
   - ✅ Read Message History
   - ✅ Add Reactions
   - ✅ Use Slash Commands
4. 生成された URL をコピー
5. ブラウザで URL を開き、Bot を招待するサーバーを選択

## 6. 環境変数を設定

```bash
# .env を編集
cp .env.example .env
vim .env
```

```bash
# Discord Bot Token
DISCORD_TOKEN=YOUR_BOT_TOKEN_HERE

# 許可するユーザーID（1人のみ）
DISCORD_ALLOWED_USER=YOUR_DISCORD_USER_ID
```

## 7. 動作確認

```bash
# ビルド
npm run build

# Docker で起動
docker compose up -d --build

# ログ確認
docker logs -f xangi
```

Discord サーバーで `/new` や `/skills` を試す、または Bot をメンションして話しかける：
```
@xangi こんにちは！
```

## IDの調べ方

### 開発者モードを有効にする

1. Discord設定 → 詳細設定 → **開発者モード** を ON

### ユーザーID

1. ユーザーを右クリック → **「ユーザーIDをコピー」**

### チャンネルID

1. チャンネルを右クリック → **「チャンネルIDをコピー」**

## トラブルシューティング

### Bot が反応しない

1. **Message Content Intent** が ON になっているか確認
2. Bot がサーバーに招待されているか確認
3. `DISCORD_ALLOWED_USER` が正しく設定されているか確認

### スラッシュコマンドが表示されない

1. `applications.commands` スコープで招待したか確認
2. Bot を一度サーバーから削除して再招待
3. Discord を再起動

### 「Discord token not configured」エラー

`.env` の `DISCORD_TOKEN` が空になっている。トークンを設定する。

## セキュリティ注意事項

- **トークンを Git にコミットしない**（`.gitignore` に `.env` を追加済み）
- **トークンを公開しない**（漏洩した場合は即座に再生成）
- `DISCORD_ALLOWED_USER` で使用できるユーザーを1人に制限（Claude Code 利用規約遵守）
