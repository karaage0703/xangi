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

## 4. xangi 側の `.env` 設定

```bash
LINE_CHANNEL_ACCESS_TOKEN=<step 2 でコピーしたトークン>
LINE_CHANNEL_SECRET=<step 2 でコピーしたシークレット>
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

## セキュリティ

- LINE Webhook は `X-Line-Signature` ヘッダの HMAC-SHA256 で署名検証される。`@line/bot-sdk` の `validateSignature` で自動検証 (Channel secret を知らないと正しい署名が作れない)
- `LINE_ALLOWED_USER` で `*` 全許可は推奨しない。1:1 用途なら特定の userId のみ
- Channel access token / secret は `.env` に保存し、リポジトリに commit しない (`.env` は `.gitignore` 済)

## 応答性とコンテキスト UX

LINE は Slack/Discord のような「スレッド」「新規会話ボタン」が無く、reply token も 60s で失効するため、Bot が無音になりやすい。xangi では 2 段の対策で「ちゃんと受け取って考えてる」体験を作る:

### 1. 即時 ACK — Loading animation (default ON)

webhook 受信直後に LINE 公式の Loading animation API (`POST /v2/bot/chat/loading/start`) を叩いてトーク画面に「入力中…」を表示する。Runner 起動より前にユーザに反応を返せる。`LINE_LOADING_ANIMATION_ENABLED=false` で無効化、`LINE_LOADING_ANIMATION_SECONDS` で表示秒数 (default 60、5 の倍数で 60 以下のみ valid、範囲外は最寄り値にスナップ)。Bot から新メッセージを送った時点で自動消滅。1:1 DM のみ機能 (グループ・ルームでは LINE 側で無視されるが API call 自体は成功する)。

### 2. Reply→Push 自動切替 — Slow response fallback (default ON)

LINE reply token は 60s で失効するため、応答に時間がかかると返信不能になる。`LINE_SLOW_RESPONSE_THRESHOLD_MS` (default 45000 = 45 秒) を超えた時点で:

1. reply token を「🤔 ちょっと待ってね、考えてる…」テンプレに使って先に消費
2. Runner の本回答が出たら Push API (`POST /v2/bot/message/push`) で後追い送信

これで応答が 60s を超えても会話が切れない。`LINE_SLOW_RESPONSE_ENABLED=false` で無効化 (この場合 60s 超応答は完全に失われる、推奨しない)。

Push API は LINE 公式アカウントの個人プランで月 200 通まで無料、超過後は従量課金。Local LLM (Gemma 等) の運用で頻繁に slow response 発火するなら、`LINE_SLOW_RESPONSE_THRESHOLD_MS` を緩めるか、より速い推論バックエンドを検討する。

## Session 境界 (会話履歴のクリアタイミング)

LINE には Slack の「スレッド」「New チャンネル」や Discord の「New ボタン」のような明示的な会話境界が無く、reply フローが永続的に 1 本の session に積み続けると context window が肥大化したり、トピックが混ざる。xangi は時間ベース + コマンドベースの 2 段で session を切る:

### 1. Idle session reset (default ON、4h)

直前の発話から `LINE_IDLE_RESET_HOURS` (default `4` 時間) 以上経過していたら、次のメッセージ到着時に既存 session を `archiveSession()` で archive し、新規 session を発番する。`logs/sessions/<sessionId>.jsonl` は残るため過去履歴は失われない。

- 子どもの会話パターン (学校・就寝・食事クラスタ) は数時間単位で自然に分かれるので 4h で切るとちょうど良い境界になる
- 小数指定可 (例: `LINE_IDLE_RESET_HOURS=0.5` で 30 分、テスト時に便利)
- `LINE_IDLE_RESET_ENABLED=false` で完全に無効化 (永続 1 session のまま)

### 2. Reset コマンド検出 (default ON、slash 3 つ)

ユーザが reset patterns に完全一致するテキストを送ったら、Runner は起動せず session を archive + 新規発番し「最初からお話するね！何かあった？」と即返信する。

- default パターン: `/reset` `/new` `/clear` の 3 つだけ (曖昧さの無い slash 形式のみ)
- メイン境界は idle reset (時間ベース)。コマンドは「明示的にリセットしたい」用の保険なので default は最小限に絞る
- 大文字小文字無視、前後空白を strip、完全一致のみ (「/reset please」のような部分一致は誤発火しない)
- 日本語自然言語パターン (`リセット` `最初から` `やり直し` 等) は誤発火境界 (「リセットってどういう意味？」「最初からお話したい」等) との切り分けが難しいので default からは外している。必要なら CSV で明示追加可能: `LINE_RESET_TEXT_PATTERNS=/reset,/new,/clear,リセット,最初から`
- 空 CSV で検出無効化: `LINE_RESET_TEXT_PATTERNS=`

### Rich Menu との組み合わせ (推奨運用)

LINE Bot は画面下部に常時表示できる Rich Menu (画像 + ボタン bind) を持てる。「最初から話す」「ヘルプ」「ママに伝える」等のボタンを bind して、押下時に対応するテキスト (例: 「リセット」「ヘルプ」) を Bot に送信するように設定すると、reset コマンド検出経路でそのまま処理される。Rich Menu 設定方法は別ドキュメント (TBD) 参照。
