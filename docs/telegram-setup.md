# Telegram Bot セットアップガイド

xangi を Telegram Bot として動かすための設定手順。

## 1. BotFather で Bot を作成する

Telegram で [@BotFather](https://t.me/BotFather) を開き、以下のコマンドを送る。

```
/newbot
```

1. Bot の表示名を入力 (例: `xangi`)
2. Bot の username を入力 (末尾が `bot` で終わる必要がある。例: `xangi_bot`)
3. 発行された **API トークン** をコピーして控える

```
Use this token to access the HTTP API:
<BotFather が発行した API トークン>
```

⚠️ **注意**: トークンは秘密鍵相当。外部に漏らさないこと。

## 2. Bot Settings を設定する（重要）

BotFather で `/mybots` → 対象 Bot を選択 → **Bot Settings** を開く。

### Allow Groups（グループ参加の許可）

グループチャットで xangi を使う場合は必須。

**Bot Settings → Allow Groups → Enable**

### Group Privacy（グループ内メッセージの受信範囲）

デフォルトは Privacy ON（Bot へのメンション・返信・コマンドのみ受信）。

`TELEGRAM_AUTO_REPLY_CHATS` でメンションなしメッセージにも反応させる場合は OFF に変更する。

**Bot Settings → Group Privacy → Turn off**

> Privacy を ON のままにすると、グループ内でメンション・返信以外のメッセージが Telegram サーバー側で遮断され、xangi には届かない。DM のみで使う場合は変更不要。

### Bot to Bot Communication（Bot 間通信の許可）

`TELEGRAM_ALLOWED_BOTS` で許可 Bot と連携する場合は必須。

デフォルトは OFF のため、Bot からのメッセージを受信できない。

**Bot Settings → Bot to Bot Communication → Enable**

> これを ON にしないと、`TELEGRAM_ALLOWED_BOTS` に Bot ID を追加しても、相手 Bot からのメッセージが xangi に届かない。

## 3. ユーザー ID と Chat ID の確認

### 自分のユーザー ID を確認する

[@userinfobot](https://t.me/userinfobot) にメッセージを送ると、自分の数値 ID が返ってくる。

```
Your ID: 123456789
```

この数値を `TELEGRAM_ALLOWED_USER` に設定する。

### グループの Chat ID を確認する

xangi を起動した後、対象グループでメッセージを送ると、ログに chat ID が表示される:

```
[xangi-telegram] group chat detected: -1001234567890
```

この数値を `TELEGRAM_ALLOWED_CHATS` に設定する。

グループの chat ID はマイナス値になることが多い（例: `-1001234567890`）。

### 許可 Bot の ID を確認する

連携する Bot の ID も数値で指定する。[@userinfobot](https://t.me/userinfobot) に対象 Bot を forward するか、xangi のログから確認する。

## 4. トークンを設定

```bash
xangi settings
```

開いたローカル設定画面のTelegram欄へBotFatherが発行したAPIトークンを貼り付けて保存する。Webhook secretを使う場合も同じ画面で設定できる。

source checkoutで詳細設定を行う場合、許可ユーザーIDなど機密ではない値は`.env`へ設定できる。

```bash
# 許可ユーザー (Telegram 数値 ID の CSV)。"*" で全許可
TELEGRAM_ALLOWED_USER=123456789,987654321

# Optional: グループ設定
TELEGRAM_ALLOWED_CHATS=-1001234567890        # 処理対象グループの chat ID (CSV)
TELEGRAM_AUTO_REPLY_CHATS=-1001234567890     # メンションなしでも反応するグループ (CSV)

# Optional: 許可 Bot (数値 ID の CSV)
TELEGRAM_ALLOWED_BOTS=555000001,555000002
TELEGRAM_ALLOWED_BOTS_MAX_CONSECUTIVE=3      # 5分以内の同じBotからの連続メンション上限

# Optional: 起動モード (polling が既定)
TELEGRAM_MODE=polling                        # polling | webhook
# TELEGRAM_FORCE_IPV4=true                  # IPv6 経路で timeout する場合のみ

# Webhook モードの場合は以下2項目が必須
# TELEGRAM_WEBHOOK_URL=https://your-host.example.com  # Bot API が Webhook 登録に使う公開 URL

# Optional: Webhook サーバーの待ち受け設定
# TELEGRAM_WEBHOOK_PORT=8766                # 待ち受けポート (既定: 8766)
# TELEGRAM_WEBHOOK_PATH=/telegram/webhook  # パス (既定値。先頭 / は省略可)

# Optional: 応答表示
TELEGRAM_STREAMING=true
TELEGRAM_SHOW_THINKING=true

# Optional: Session 境界
TELEGRAM_IDLE_RESET_ENABLED=true
TELEGRAM_IDLE_RESET_HOURS=4
# TELEGRAM_RESET_TEXT_PATTERNS=/reset,/new,/clear  # 上書きする場合のみ

# Optional: 画像・動画
TELEGRAM_MEDIA_ENABLED=true
# TELEGRAM_MEDIA_MAX_DOWNLOAD_MB=20
# TELEGRAM_MEDIA_RETENTION_HOURS=24
# TELEGRAM_MEDIA_ALLOWED_MIME=image/jpeg,image/png,image/webp,video/mp4
# TELEGRAM_MEDIA_GROUP_DEBOUNCE_MS=750
```

## 5. 起動と動作確認

```bash
npm run build
npm start
```

起動ログに以下が出れば OK:

```
[xangi-telegram] Ready! Logged in as @xangi_bot (7123456789)
[xangi-telegram] Starting bot with long polling...
```

BotFather から発行した Bot に DM を送って応答が返れば成功。

### グループへの追加

1. グループの設定 → メンバー追加 → `@xangi_bot` を追加
2. 管理者権限は不要（メッセージ送受信のみ）
3. グループで `@xangi_bot こんにちは` と送ってみる

起動ログの `Allowed group chats` に対象Chat IDが表示されることを確認する。メンションが無視された場合は、ログの `chat ... (allowed=...)` と `sender ... (allowed=...)` で `TELEGRAM_ALLOWED_CHATS` / `TELEGRAM_ALLOWED_USER` のどちらが不一致か確認できる。メンションなしで反応させる場合は、BotFatherのGroup PrivacyをOFFにし、対象Chat IDを `TELEGRAM_AUTO_REPLY_CHATS` に設定する。

グループでは他Botの誤反応を避けるため、最初の「考え中...」と最終回答への編集だけを行い、途中経過は更新しない。また、自分以外のBot username（`bot` で終わるusername）へのメンションを含む投稿には反応しない。許可Botからの投稿も、グループ内ではxangi自身への明示メンションがある場合だけ処理し、返信やメンションなしの投稿には反応しない。ループ防止カウンターはグループChat IDと送信元Bot IDごとに5分間だけ保持し、人間が同じグループで発言すると処理対象外の発言でもリセットする。xangi自身の投函、スケジュール投稿、DMはこのカウンターに加算しない。

## 6. セキュリティ

- `TELEGRAM_BOT_TOKEN`は`xangi settings`で保存し、GitやAIとの会話へ貼り付けない
- `TELEGRAM_ALLOWED_USER` の `*` 全許可は個人環境以外では推奨しない
- `TELEGRAM_ALLOWED_BOTS` は必要な Bot ID のみ明示し、`*` は対応していない
- `TELEGRAM_ALLOWED_CHATS` を設定することで、意図しないグループからのメッセージを遮断できる

## 7. DM のみで使う場合の最小設定

グループを使わず 1:1 DM だけなら以下で十分:

```bash
TELEGRAM_BOT_TOKEN=<BotFather が発行した API トークン>
TELEGRAM_ALLOWED_USER=123456789
```

Bot Settings の Group Privacy・Allow Groups・Bot to Bot Communication の変更も不要。

## 8. コマンド一覧

| コマンド                 | 動作                                     |
| ------------------------ | ---------------------------------------- |
| `/new` `/reset` `/clear` | セッションをリセットして新しい会話を開始 |
| `/stop`                  | 実行中のタスクを停止                     |
| `/help`                  | 使い方の案内を表示                       |

## 9. 画像・動画を使う

`TELEGRAM_MEDIA_ENABLED=true` にすると、写真、動画、許可MIMEに一致するファイルをDMとグループで受信できる。キャプションは指示文として扱い、キャプションがない場合は添付の確認をAgentへ依頼する。同じTelegramアルバムの媒体は、既定750ms待って1回のAgent実行へまとめる。

受信ファイルは送信者・Chat allowlistとメンション条件を通過した後だけダウンロードし、`.xangi/media/attachments/telegram`へ保存する。既定の上限は20MBで、Telegram Bot APIの`getFile`上限に合わせて20MBを超える設定は受け付けない。保存ファイルは既定24時間で削除し、`TELEGRAM_MEDIA_RETENTION_HOURS=0`で自動削除を無効化できる。

`TELEGRAM_MEDIA_ALLOWED_MIME`は、Telegramから通知された送信者申告のMIMEメタデータを検査する。JPEG、PNG、WebP、MP4、PDF、ZIPはダウンロード後にファイル先頭のシグネチャも照合し、一致しなければAgentへ渡さない。それ以外の独自MIMEは内容自体を保証しないため、信頼できるallowlist登録済み送信者からの利用を前提とする。

Agentが画像、MP4動画、またはその他のファイルを生成して添付として返した場合、xangiはそれぞれTelegramの写真、動画、文書として送信する。送信タイムアウトはTelegram側で成功済みか判別できないため、失敗した添付は自動再送しない。複数添付では後続の未試行ファイルの送信を続け、確認できなかった件数を利用者へ通知する。

動画は現時点ではファイルをそのままAgentへ渡す。キーフレーム抽出や音声文字起こしは行わないため、利用するAgentバックエンドが動画入力を扱える必要がある。

## 10. Telegram API への接続がタイムアウトする場合

`ETIMEDOUT` や `Network request for 'getMe' failed` が出る場合、まず Raspberry Pi で接続経路を確認する。

```bash
curl -4 --connect-timeout 10 -I https://api.telegram.org
curl -6 --connect-timeout 10 -I https://api.telegram.org
```

IPv4 だけ成功する場合は `.env` に以下を追加して再起動する。

```bash
TELEGRAM_FORCE_IPV4=true
```

xangi は一時的な DNS・接続・Telegram API 障害をバックグラウンドで再試行する。他のチャット媒体は待機中も起動を継続する。認証エラーは再試行しない。

`editMessageText` のタイムアウトは、Telegram側では編集が完了していて応答だけ届かなかった可能性がある。xangi は同じmessage IDへの編集だけを再試行し、別メッセージへのフォールバック送信は行わない。再試行後も成否を確認できない場合は、二重応答を避けることを優先して新規送信を抑止する。

Telegram のエラーには Bot API の URL が含まれることがあるため、xangi はトークン部分をマスクしてログ出力する。過去のログへトークンが出た場合は BotFather の `/revoke` で失効・再発行する。

## 11. `409 Conflict` が出る場合

同じ Bot トークンで複数の long polling プロセスが動いている。Telegram Bot API では、1つのトークンにつきlong pollingを実行できるのは1プロセスだけ。

```bash
pm2 list
pm2 describe xangi
pgrep -af 'dist/index.js|xangi'
```

PM2 は `fork` mode・`instances: 1` にし、手動起動、systemd、Docker、別端末で同じBotを起動していないか確認する。xangi は409を検知すると競合ループを避けるためTelegram pollingだけを停止する。重複プロセスを止めた後、使用する側のxangiを再起動する。
