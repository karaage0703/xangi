[English](en/line-setup.md) | 日本語

# LINE Messaging API セットアップガイド

xangi を LINE Bot として動かすための設定手順。1:1 chat 想定。

## 1. LINE Developers でチャネル作成

<https://developers.line.biz/> に LINE アカウントでログインしてから:

1. プロバイダー作成 (まだ無ければ。任意の名前、例: `xangi`)
2. プロバイダー画面で「Create a new channel」→ 「Messaging API」を選択
3. チャネル情報を入力:
   - Channel name: 任意 (例: `xangi-bot`)
   - Channel description / Category / Subcategory: 適当に
   - Region: 日本
4. 利用規約に同意して作成

## 2. Channel secret と Channel access token を取得

作成したチャネルの設定画面で:

- 「Basic settings」タブ:
  - 「Channel secret」をコピー → `LINE_CHANNEL_SECRET`
- 「Messaging API」タブ:
  - 「Channel access token (long-lived)」の「Issue」ボタンで発行してコピー → `LINE_CHANNEL_ACCESS_TOKEN`

## 3. Webhook と応答設定

「Messaging API」タブの下のほうで:

- 「Webhook URL」: 後で Tailscale Funnel / Cloudflare Tunnel 等で取得した公開 URL を設定する。形式: `https://<host>/webhook` (`LINE_WEBHOOK_PATH` に合わせる)。今は空のままで OK
- 「Use webhook」: ON
- 「Auto-reply messages」: 「LINE Official Account Manager」で無効化 (応答メッセージを xangi に任せるため)
- 「Greeting messages」: お好み (友だち追加直後の挨拶。xangi の応答とは独立)

## 4. トークンを設定

```bash
xangi settings
```

開いたローカル設定画面のLINE欄へChannel access token、Channel secret、許可ユーザーIDを入力して保存する。

source checkoutで詳細設定を行う場合は、同じ許可ユーザーIDや他の詳細値を`.env`へ設定できる。

```bash
LINE_ALLOWED_USER=<反応したい LINE userId、カンマ区切り、"*" で全許可>
# Optional: webhook
LINE_WEBHOOK_PORT=8765
LINE_WEBHOOK_PATH=/webhook
# Optional: UX (応答性改善)
LINE_LOADING_ANIMATION_ENABLED=true       # 受信直後の「入力中…」表示
LINE_LOADING_ANIMATION_SECONDS=60         # 5/10/15/20/25/30/40/50/60 のいずれか
LINE_SLOW_RESPONSE_ENABLED=true           # 45s 超で reply→push 自動切替
LINE_SLOW_RESPONSE_THRESHOLD_MS=45000     # 「考え中」通知 + Push 切替の閾値
# Optional: Session 境界 (時間ベース + コマンド)
LINE_IDLE_RESET_ENABLED=true              # idle 一定時間で session 自動切替
LINE_IDLE_RESET_HOURS=4                   # 何時間 idle で切るか (小数可、0 で無効)
# LINE_RESET_TEXT_PATTERNS=/reset,リセット,最初から,はじめから   # 上書きする場合のみ
```

LINE userId は LINE 内のユーザ識別子 (`U` で始まる 33 文字)。友だち追加して話しかけた時、xangi のログに `[xangi-line] user Uxxxx... not in allowlist, ignoring` と表示されるので、それを `LINE_ALLOWED_USER` に追加して再起動する。

## 5. 公開エンドポイント (Tailscale Funnel 例)

LINE Webhook は HTTPS 公開 URL が必須。Tailscale Funnel が一番手軽:

```bash
# Tailscale 導入済み前提
tailscale funnel --bg 8765
```

Funnel が公開する URL (`https://<machine>.<tailnet>.ts.net/`) の末尾に `LINE_WEBHOOK_PATH` (default `/webhook`) を付けて、LINE Developers コンソールの「Webhook URL」に登録する。

例: `https://spark-edbc.tail12345.ts.net/webhook`

設定後「Verify」ボタンで `Success` が出れば OK。

Cloudflare Tunnel を使う場合は `cloudflared` を導入して `cloudflared tunnel --url http://localhost:8765` でも可。

## 6. 起動と動作確認

```bash
npm run build
npm start
```

起動ログに `[xangi-line] webhook listening on port 8765, path /webhook` が出れば OK。

LINE 公式アカウントの QR コード (「Messaging API」タブの下のほう) で友だち追加して、メッセージを送る。xangi が応答すれば成功。

画像、応答表示、連投、Session 境界など利用時の挙動は[使い方ガイド](usage.md#プラットフォーム別のメッセージ処理)を参照。

## セキュリティ

- LINE Webhook は `X-Line-Signature` ヘッダの HMAC-SHA256 で署名検証される。`@line/bot-sdk` の `validateSignature` で自動検証 (Channel secret を知らないと正しい署名が作れない)
- `LINE_ALLOWED_USER` で `*` 全許可は推奨しない。1:1 用途なら特定の userId のみ
- Channel access token / secretは`xangi settings`で保存し、GitやAIとの会話へ貼り付けない
