# 使い方ガイド

xangiの詳細な使い方ガイドです。

## 目次

- [基本操作](#基本操作)
- [チャンネルトピック注入](#チャンネルトピック注入)
- [タイムスタンプ注入](#タイムスタンプ注入)
- [セッション管理](#セッション管理)
- [スケジューラー](#スケジューラー)
- [チャット操作（xangi-cmd）](#チャット操作xangi-cmd)
- [イベントトリガー](#イベントトリガー)
- [ランタイム設定](#ランタイム設定)
- [AIによる自律操作](#aiによる自律操作)
- [Standaloneモード](#standaloneモード)
- [Docker実行](#docker実行)
- [Local LLM](#local-llm)
- [ワークスペース hooks（Stop hook）](#ワークスペース-hooksstop-hook)
- [Tool Trajectory Logger](#tool-trajectory-logger)
- [セキュリティ](#セキュリティ)
- [環境変数一覧](#環境変数一覧)
- [複数インスタンスの運用](#複数インスタンスの運用)
- [セッションの保持期間](#セッションの保持期間)
- [オプション](#オプション)
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

| コマンド              | 説明                   |
| --------------------- | ---------------------- |
| `/new`, `!new`, `new` | 新しいセッションを開始 |

### Discordボタン操作

応答メッセージにボタンが表示されます。

- **処理中**: `Stop` / `延長` / `⏱ MM:SS` ボタン
  - `Stop` — `/stop` と同等。タスクを中断
  - `延長` — タイムアウトを「**残り時間 2 倍**」に延長（`TIMEOUT_MAX_MS` 上限内）
  - `⏱ MM:SS` — 残り時間表示（クリック無効、残り 30 秒以下で赤色に）
- **完了後**: `New` ボタン — `/new` と同等。セッションをリセット

`DISCORD_SHOW_BUTTONS=false` でボタンを非表示にできます。

### タイムアウト動的延長

長時間タスク（コード生成、調査タスク等）が初期タイムアウト（`TIMEOUT_MS`、デフォルト 30 分）に
ぶつかる前に、`延長` ボタンで残り時間を 2 倍にして引き伸ばせます。

- 初期タイムアウト: `TIMEOUT_MS` (デフォルト 30 分)
- 延長動作: 押下時点の残り時間を加算 → 結果として残り時間が **2 倍**
  - 例: 残り 3 分の状態で押すと残り 6 分に
  - 例: 残り 30 秒の状態で押すと残り 1 分に（緊急対応）
- 絶対上限: `TIMEOUT_MAX_MS` (デフォルト 10 時間 = 36000000ms)
  - さらに長く / 短く制限したい場合は `TIMEOUT_MAX_MS` で調整できる (例: `TIMEOUT_MAX_MS=3600000` = 1h)
- 機能 ON/OFF: `TIMEOUT_EXTEND_ENABLED` (デフォルト `true`)
  - `false` にすると `延長` ボタンが UI から消え、extendTimeout API は `unsupported` を返す
- UI:
  - Web Chat — 入力欄の `⏹` 右に `[延長][⏱ MM:SS]` が出る（送信中のみ）
  - Discord — 「考え中.」メッセージのボタン行に `[Stop][延長][⏱ MM:SS]` の順
  - Slack — メッセージ末尾の Block Kit actions に同様
- 残り 30 秒以下で表示が赤色 + パルスアニメーション
- 上限到達後は `延長` が disabled / 非表示

対応バックエンド:

- Claude Code (`persistent-runner`): タイマーをスケジュール再設定して延長
- Codex / Cursor / Grok / Antigravity: 子プロセスの kill タイマーを再設定
- Local LLM: AbortController を最新参照経由で延長
- Dynamic Runner: 内部 Runner にパススルー

API（プログラマブル操作）:

- `GET /api/sessions/:id/timeout` — 現在のタイムアウト状態 `{active, timeoutAt, maxTimeoutAt, remainingMs, timeoutMs}`
- `POST /api/sessions/:id/timeout/extend` — `{additionalMs?: number}` で延長（デフォルト 5 分）

> 💡 危険コマンドの実行前に Discord/Slack で承認を求めるオプションもあります（デフォルト無効）。詳しくは [オプション > 危険コマンドの承認フロー](#危険コマンドの承認フロー) を参照してください。

## スケジューラー

定期実行やリマインダーを設定できます。AI に自然言語で頼むと、AI が `xangi-cmd schedule_add` などを呼び出してスケジュールを登録します。

### 操作方法

| 入り口                          | 説明                                       |
| ------------------------------- | ------------------------------------------ |
| `/schedule` (Discord スラッシュ) | GUI でスケジュールを追加・一覧・削除・切替 |
| `xangi-cmd schedule_*`          | AI または CLI から操作（下記）             |
| 自然言語                        | 「毎日 9 時におはようって言って」等で AI が登録 |

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

### `xangi-cmd schedule_*`

AI ／ シェルから直接スケジュール操作できます。xangi 上で AI が実行する場合 `--channel` は省略可（現在のチャンネル ID が使われる）。

```bash
# スケジュール追加（自然言語）
xangi-cmd schedule_add --input "毎日 9:00 おはよう"
xangi-cmd schedule_add --input "30分後 ミーティング"
xangi-cmd schedule_add --input "15:00 レビュー"
xangi-cmd schedule_add --input "毎週月曜 10:00 週次MTG"
xangi-cmd schedule_add --input "cron 0 9 * * * おはよう"

# 別チャンネルに送りたい場合
xangi-cmd schedule_add --input "毎日 9:00 おはよう" --channel <channelId>

# 一覧表示
xangi-cmd schedule_list

# 削除（ID 指定）
xangi-cmd schedule_remove --id <スケジュールID>

# 有効/無効切り替え
xangi-cmd schedule_toggle --id <スケジュールID>
```

### データ保存

スケジュールデータは `${DATA_DIR}/schedules.json` に保存されます。

- デフォルト: `/workspace/.xangi/schedules.json`
- 環境変数 `DATA_DIR` で変更可能

## チャット操作（xangi-cmd）

AIが `xangi-cmd` CLIツール経由でDiscord / Slack操作を実行します。xangi内蔵のtool-server（HTTP API）を介するため、DISCORD_TOKEN / SLACK_BOT_TOKEN 等のシークレットはAI CLIからアクセスできません。

| コマンド | 説明 |
|----------|------|
| `xangi-cmd discord_history --channel <ID> [--count N] [--offset M]` | チャンネル履歴取得 |
| `xangi-cmd discord_send --channel <ID> --message "text"` | メッセージ送信 |
| `xangi-cmd discord_channels --guild <ID>` | チャンネル一覧 |
| `xangi-cmd discord_search --channel <ID> --keyword "text"` | メッセージ検索 |
| `xangi-cmd discord_edit --channel <ID> --message-id <ID> --content "text"` | メッセージ編集 |
| `xangi-cmd discord_delete --channel <ID> --message-id <ID>` | メッセージ削除 |
| `xangi-cmd discord_thread_leave --user <ID> [--channel <ID>]` | スレッドから指定ユーザーを退出させる＝そのユーザーのサイドバーから消す（`--channel` 省略で現在のスレッド） |
| `xangi-cmd media_send --channel <ID> --file /path/to/file` | ファイル送信 |
| `xangi-cmd web_history [--session <id>] [--count N]` | Web Chat 現ペイン履歴取得（`XANGI_CHANNEL_ID=web-chat:<id>` 自動解決） |
| `xangi-cmd slack_history [--channel <id>] [--count N]` | Slack 現チャンネル履歴取得（`XANGI_CHANNEL_ID=<channel>` 自動解決） |
| `xangi-cmd slack_send --channel <id> --message "text" [--thread-ts <ts>]` | Slackメッセージ送信 |
| `xangi-cmd slack_channels [--types public_channel,private_channel] [--limit N]` | Slackチャンネル一覧 |
| `xangi-cmd slack_search --channel <id> --keyword "text" [--count N]` | Slackメッセージ検索 |
| `xangi-cmd slack_edit --channel <id> --message-ts <ts> --content "text"` | Slackメッセージ編集 |
| `xangi-cmd slack_delete --channel <id> --message-ts <ts>` | Slackメッセージ削除 |

### 使用例

```bash
# チャンネル履歴を取得
xangi-cmd discord_history --count 10
xangi-cmd discord_history --channel 1234567890 --count 10
xangi-cmd discord_history --channel 1234567890 --count 30 --offset 30  # 遡り

# 別チャンネルにメッセージ送信
xangi-cmd discord_send --channel 1234567890 --message "作業完了しました！"

# チャンネル一覧
xangi-cmd discord_channels --guild 9876543210

# メッセージ検索
xangi-cmd discord_search --channel 1234567890 --keyword "PR"

# Slack操作
xangi-cmd slack_send --channel C01234567 --message "作業完了しました！"
xangi-cmd slack_send --channel C01234567 --thread-ts 1719876543.000100 --message "スレッド返信"
xangi-cmd slack_channels --types public_channel,private_channel --limit 100
xangi-cmd slack_search --channel C01234567 --keyword "PR" --count 15
```

`--channel` を省略した場合、xangi上で実行中なら現在のチャンネルIDが使われます。CLI単体実行では `--channel` が必要です。

```bash
# メッセージ編集・削除
xangi-cmd discord_edit --channel 1234567890 --message-id 111222333 --content "修正後の内容"
xangi-cmd discord_delete --channel 1234567890 --message-id 111222333

# スレッドから指定ユーザーを退出させる＝そのユーザーのサイドバーから消す（--channel 省略で現在のスレッド）
xangi-cmd discord_thread_leave --user 111222333
xangi-cmd discord_thread_leave --user 111222333 --channel 1234567890
xangi-cmd slack_edit --channel C01234567 --message-ts 1719876543.000100 --content "修正後の内容"
xangi-cmd slack_delete --channel C01234567 --message-ts 1719876543.000100
```

### Tool Server

xangi-cmdはxangiプロセス内のtool-server（HTTP API）に中継します。

- ポートはOS自動割り当て（複数インスタンスでも競合なし）
- xangi本体が起動時に `XANGI_TOOL_SERVER` を子プロセスへ注入
- `xangi-cmd` は `XANGI_TOOL_SERVER` を使って接続先を解決
- 現在のチャンネルIDなど、xangi実行時の文脈は `context` としてtool-serverに引き渡されます

## イベントトリガー

外部の出来事（ビルド完了・CI 結果・新着検知など）をきっかけに、エージェントターンを起動できます。定期スケジュールでの確認（ポーリング）を「イベント発生時だけ起動」（プッシュ）に置き換えることで、即応性が上がり、空振りターンのトークン消費もなくなります。

### 有効化

`.env` に以下を設定します（デフォルトは無効）:

```bash
TRIGGER_ENABLED=true
XANGI_TRIGGER_TOKEN=<ランダムな長い文字列>   # 例: openssl rand -hex 32
# TRIGGER_MIN_INTERVAL_MS=10000             # 同一 source の最短発火間隔（デフォルト 10 秒）
```

トークンは必須です。`XANGI_TRIGGER_TOKEN` が未設定の場合、`TRIGGER_ENABLED=true` でも HTTP 経由のリクエストはすべて拒否されます（tool-server はネットワークに開いているため、認証なしの受け付けは任意プロンプト注入の入口になります）。

### HTTP で発火する

```bash
curl -X POST "$XANGI_TOOL_SERVER/api/trigger" \
  -H "Authorization: Bearer $XANGI_TRIGGER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "channel": "<チャンネルID>",
    "message": "docker build が完了した。結果を確認して報告して",
    "source": "docker-build"
  }'
```

- `channel`（必須）: ターンを起動して結果を投稿するチャンネル ID
- `message`（必須）: エージェントへの指示（最大 4000 文字）
- `source`（任意）: 発火元の識別子（英数と `_.:-`、最大 64 文字）。表示ラベル・レート制限の単位になる
- `platform`（任意）: `discord`（デフォルト）または `slack`

成功すると `202 { "ok": true, "triggerId": "trg_..." }` が即座に返ります（ターンの完了は待ちません）。チャンネルには `⚡ trigger: <source>` のラベルが投稿され、続けてエージェントの応答が流れます。

### xangi-cmd で発火する

ローカルのスクリプトからは `xangi-cmd` でも発火できます（トークン不要、`TRIGGER_ENABLED=true` は必要）:

```bash
xangi-cmd trigger --channel <チャンネルID> --message "ビルドが終わった。結果を報告して" --source build
```

`TRIGGER_ENABLED=true` のときは、エージェント自身のシステムプロンプト（XANGI_COMMANDS）にもこの使い方が注入されるため、エージェントが長時間処理を `nohup` で投げる際に「完了したら trigger で自分を起こす」パターンを自発的に使えます。

### 活用例

```bash
# 長時間ビルドの完了を即報告
docker build -t myapp . && \
  curl -X POST "$XANGI_TOOL_SERVER/api/trigger" \
    -H "Authorization: Bearer $XANGI_TRIGGER_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"channel":"...","message":"docker build 完了。イメージを確認して報告して","source":"docker-build"}'

# GitHub Actions の最後に 1 ステップ足して CI 結果を即通知
# 新着監視 cron が「新着があった時だけ」エージェントを起こす（空振りゼロ）
```

### 暴走防止

- 同一 `source` は `TRIGGER_MIN_INTERVAL_MS`（デフォルト 10 秒）以内の連続発火を拒否（`429`）
- 同一 `source` のターンが実行中の間は新規発火を拒否（`409`）

## ランタイム設定

`${DATA_DIR}/settings.json`（既定: `${WORKSPACE_PATH}/.xangi/settings.json`）にランタイム設定が保存されます。

```json
{
  "autoRestart": true,
  "discordCompletionNotifyChannels": {
    "123456789012345678": "mention"
  }
}
```

| 設定 | 説明 | デフォルト |
| ---- | ---- | ---------- |
| `autoRestart` | AIエージェントによる再起動を許可 | `true` |
| `discordCompletionNotifyChannels` | チャンネルごとの完了通知 override（`off` / `message` / `mention`） | なし |

### 設定の確認・変更

| コマンド    | 説明             |
| ----------- | ---------------- |
| `/settings`  | 現在の設定を表示                               |
| `/restart`   | ボットを再起動                                 |
| `/autoreply` | このチャンネルのメンションなし応答をトグル（再起動不要） |
| `/notify <off\|message\|mention\|default\|show>` | このチャンネルの完了通知を切替（再起動不要、`settings.json` に永続化） |
| `/respondtobots` | bot メッセージへの応答を ON/OFF トグル（反応対象は `RESPOND_TO_BOTS` 環境変数で事前指定） |
| `/llmmode <agent\|lite\|chat\|default\|show>` | このチャンネルの Local LLM 動作モードを per-channel で切替（`.env` の `CHANNEL_OVERRIDES` に永続化） |

### バックエンド動的切り替え

チャンネルごとにバックエンド・モデル・effortレベルを切り替えられます。

| コマンド                                          | 説明                                   |
| ------------------------------------------------- | -------------------------------------- |
| `/backend show`                                   | 現在のバックエンド・モデルを表示       |
| `/backend set claude-code`                        | Claude Codeに切り替え                  |
| `/backend set cursor`                             | Cursor CLIに切り替え                   |
| `/backend set grok`                               | Grok CLIに切り替え                     |
| `/backend set antigravity`                        | Antigravity CLIに切り替え              |
| `/backend set local-llm --model nemotron-3-nano`  | Local LLM + モデル指定                 |
| `/backend set claude-code --effort high`          | effort指定付きで切り替え               |
| `/backend reset`                                  | デフォルト（.env設定）に戻す           |
| `/backend list`                                   | 利用可能なバックエンド・モデル一覧     |

切り替え時は自動的に新しいセッションが開始されます（会話履歴は引き継がれません）。

#### 環境変数で制限

```bash
# 切り替え許可バックエンド（未設定=全バックエンド許可）
ALLOWED_BACKENDS=claude-code,cursor,grok,antigravity,local-llm

# 切り替え許可モデル（未設定=制限なし）
ALLOWED_MODELS=nemotron-3-nano,nemotron-3-super,qwen3.5:9b

# チャンネル別バックエンド設定（JSON）
CHANNEL_OVERRIDES={"チャンネルID":{"backend":"local-llm","model":"nemotron-3-nano"}}
```

#### 永続化

`/backend set` で変更した設定は `.env` の `CHANNEL_OVERRIDES` に自動保存されます。再起動後も設定が維持されます。

Docker環境では `.env` はコンテナ外にあるため、AI（Claude Code等）から変更されることはありません。

#### effort オプション（Claude Code用）

Claude Code の `--effort` オプション（`low` / `medium` / `high` / `max`）をチャンネルごとに設定可能。persistent モードではプロセス再起動が必要なため、切り替え時にセッションがリセットされます。`/backend set claude-code --effort デフォルト` で未指定状態に戻せます。

## AIによる自律操作

### 設定変更（ローカル実行時のみ）

AIは `.env` ファイルを編集して設定を変更できます：

```
「このチャンネルでも応答して」
→ AIが AUTO_REPLY_CHANNELS を編集 → 再起動
```

`/autoreply` コマンドでもメンションなし応答をチャンネルごとに切り替えられます（再起動不要、`.env` にも永続化）。
このコマンドを無効にするには `.env` に `ALLOW_AUTOREPLY_COMMAND=false` を設定してください（デフォルト: 有効）。

`/notify` コマンドで、長い Discord ターン完了時の別メッセージ通知をチャンネルごとに切り替えられます。起動時の `DISCORD_COMPLETION_NOTIFY` はデフォルト値として使われ、チャンネル override は `settings.json` に保存されます。対象は通常の Discord メッセージターンのみで、スケジュール起点ターンは通知しません。

### 他 bot のメッセージへの応答（A/B 比較等）

デフォルトでは他の bot メッセージには反応しません。応答対象は `RESPOND_TO_BOTS` 環境変数で事前にホワイトリスト指定し、有効/無効は `RESPOND_TO_BOTS_ENABLED` か `/respondtobots` で切り替えます。

```
# 反応対象 (事前設定)
RESPOND_TO_BOTS=*                       # 全 bot
RESPOND_TO_BOTS=1469919453155164160     # 特定 bot のみ

# 機能 ON/OFF
RESPOND_TO_BOTS_ENABLED=true            # ON
RESPOND_TO_BOTS_ENABLED=false           # OFF (default)

# 連続返信の上限 (default 3、0 で無制限)
RESPOND_TO_BOTS_MAX_CONSECUTIVE=3
```

自分自身の bot ID は常に除外されます（無限ループ防止）。許可された bot からのメッセージは `DISCORD_ALLOWED_USER` チェックをバイパスします。

同じ bot との連続応答は `RESPOND_TO_BOTS_MAX_CONSECUTIVE` 回（default 3）で打ち切られます。別 bot や人間のメッセージが入ると連鎖カウンタはリセットされます。bot 同士の無限往復を防ぐ安全装置です。

`/respondtobots` で機能の ON/OFF を動的に切替でき、`.env` にも永続化されます。コマンドを無効化するには `ALLOW_RESPOND_TO_BOTS_COMMAND=false` を設定してください（デフォルト: 有効）。

ユースケース: 複数の xangi インスタンス（例: xangi-borot=Claude / xangi-dev=Local LLM）を同じチャンネルに常駐させて、同じプロンプトに対する応答を並べて品質比較する。

#### 制約・既知の制限

- bot メッセージへの応答は **メンション・DM・AUTO_REPLY_CHANNELS 経由** でのみ発火する。bot メッセージだからといってチャンネル全体で勝手に反応する仕様ではない。bot 同士の応答テストを行う場合は対象チャンネルを `AUTO_REPLY_CHANNELS` に追加する必要がある。
- `xangi-cmd discord_send` は通知抑止のため `allowed_mentions: { parse: [] }` 固定で送信する。そのため xangi-cmd 経由で送信されたメッセージ中の `<@user_id>` / `<@&role_id>` / `@everyone` は受信側の `message.mentions` に含まれない (Discord 公式仕様)。bot 同士のテストでメンション経由のトリガーは現状動かない。
- 上記の `xangi-cmd discord_send` の mention 抑制を一時的に解除したい場合は別途オプトイン機能の追加が必要（このスキル/機能のスコープ外）。

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

## Standaloneモード

Docker環境があれば、ワンコマンドでAIアシスタントを起動できます。Discord/Slackのトークン不要。ローカルLLM（Ollama）+ WebチャットUIで動作します。

### セットアップ

```bash
git clone https://github.com/karaage0703/xangi.git
cd xangi
./quickstart.sh
```

ブラウザで `http://localhost:18888` にアクセスしてチャットを開始。

### 仕組み

- **Ollama** — ローカルLLMサーバー（gemma4:e4b を初回起動時に自動ダウンロード）
- **xangi** — AIアシスタント（WebチャットUI付き）
- **[ai-assistant-workspace](https://github.com/karaage0703/ai-assistant-workspace)** — ワークスペース（AGENTS.md・スキル・メモリ）

### モデル変更

```bash
LOCAL_LLM_MODEL=gemma4:26b ./quickstart.sh
```

### 停止

```bash
docker compose -f docker-compose.standalone.yml down
```

### ワークスペースの永続化

ワークスペースはホストの`workspace/`ディレクトリにマウントされます。コンテナを停止・削除してもデータは保持されます。`workspace/`内のファイルを直接編集・git pushすることも可能です。

## Docker実行

コンテナ隔離環境で実行できます。3つのコンテナが用意されています：

| コンテナ | Dockerfile | 用途 |
|---|---|---|
| `xangi` | `Dockerfile` | 軽量版（Claude Code / Codex / Cursor CLI / Grok CLI / Antigravity CLI） |
| `xangi-max` | `Dockerfile.max` | フル版（uv + Python対応、Local LLM向け） |
| `xangi-gpu` | `Dockerfile.gpu` | GPU版（CUDA + PyTorch、画像生成・音声処理向け） |

### Claude Code バックエンド

```bash
docker compose up xangi -d --build

# Claude Code 認証
docker exec -it xangi claude
```

Claude Code を Anthropic API key 課金で動かす場合は、`.env` に `ANTHROPIC_API_KEY` を設定します。
この値は Claude Code 子プロセスにのみ渡され、通常の環境変数ホワイトリストには含めません。
OAuth / keychain を使わず API key 認証に固定したい場合は `CLAUDE_CODE_BARE=true` を設定します。
API 呼び出しの上限額を付けたい場合は `CLAUDE_CODE_MAX_BUDGET_USD` を設定します。

```env
AGENT_BACKEND=claude-code
ANTHROPIC_API_KEY=sk-ant-...
CLAUDE_CODE_BARE=true
CLAUDE_CODE_MAX_BUDGET_USD=0.25
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
| Docker | `XANGI_WORKSPACE` | ホスト側のパス（コンテナ内は `/workspace` に固定） |

Docker実行時は `.env` に `XANGI_WORKSPACE` を設定します：

```bash
XANGI_WORKSPACE=/home/user/my-workspace
```

> **⚠️ `WORKSPACE_PATH` は使わないこと。** ホストのシェル環境変数と衝突する可能性があります。

### セキュリティ

- コンテナはホストネットワークに**直接アクセスできません**
- Ollamaコンテナは同じdocker network内で隔離
- AIエージェントへの環境変数はホワイトリスト方式で制限（`DISCORD_TOKEN` 等はアクセス不可）

## Local LLM

xangiのLocal LLMバックエンドはOpenAI互換API（`/v1/chat/completions`）を使用します。OllamaとvLLM、その他のOpenAI互換サーバー（LM Studio、llama.cpp等）に対応しています。

### ローカル実行（Ollama）

```bash
# .env を設定
AGENT_BACKEND=local-llm
LOCAL_LLM_MODEL=gpt-oss:20b
# LOCAL_LLM_BASE_URL=http://localhost:11434  # デフォルト
```

Ollamaが起動していればそのまま動作します。

### vLLM（OpenAI互換高速サーバー）

vLLMはOpenAI互換のAPIを提供する高速推論サーバー。大規模モデル・長コンテキスト・MTP (Multi-Token Prediction) drafter など、Ollamaよりも本格的な運用に向いています。

#### 起動コマンド例（Gemma 4 26B-A4B-NVFP4 + MTP）

```bash
vllm serve nvidia/Gemma-4-26B-A4B-NVFP4 \
  --host 0.0.0.0 --port 8001 \
  --served-model-name gemma-4-26b-a4b \
  --max-num-batched-tokens 131072 \
  --max-model-len 131072 \
  --gpu-memory-utilization 0.85 \
  --kv-cache-dtype fp8 \
  --enable-auto-tool-choice --tool-call-parser gemma4 \
  --speculative-config '{"method":"mtp","num_speculative_tokens":2,"model":"google/gemma-4-26B-A4B-it-assistant"}'
```

#### .env での接続設定

```bash
AGENT_BACKEND=local-llm
LOCAL_LLM_BASE_URL=http://localhost:8001
# Docker から接続する場合: http://host.docker.internal:8001
LOCAL_LLM_MODEL=gemma-4-26b-a4b
LOCAL_LLM_NUM_CTX=131072  # vLLM の --max-model-len と揃える
```

#### チューニング指針

| オプション | 推奨値 | 説明 |
|------------|--------|------|
| `--max-model-len` | `131072` | arxiv全文 (~70k tokens)・site-patrol等の長プロンプトを安定処理。65536では論文全文読解が入らない |
| `--kv-cache-dtype` | `fp8` | context wide化でKV-cacheが膨張するため fp8 圧縮で吸収。GB10 80GiB クラスで余裕 |
| `--gpu-memory-utilization` | `0.85` | 0.6だとKV-cache不足、0.85で安定 |
| `--max-num-batched-tokens` | `--max-model-len` と同値 | バッチング上限 |
| `--enable-auto-tool-choice` `--tool-call-parser <model>` | モデル依存 | tool calling有効化。Gemma 4は `gemma4` パーサー |
| `--speculative-config` (MTP) | モデル依存 | MTP drafter利用時に指定。応答速度向上 |

`LOCAL_LLM_NUM_CTX` は xangi 側のクライアント上限。vLLM の `--max-model-len` と揃えないと、xangi 側で先にプロンプト切り詰めて拡大の恩恵を失う。

#### 確認

```bash
# モデル一覧 (vLLM)
curl -s http://localhost:8001/v1/models | jq '.data[] | {id, max_model_len}'

# Discord 上で
/backend list  # サーバー側のモデル一覧を表示 (Ollama + vLLM 両対応)
/backend show  # 現在のチャンネルの Local LLM 詳細設定を表示
```

### ログ

全バックエンドでセッション単位のトランスクリプトログ（`logs/sessions/<appSessionId>.jsonl`）が保存されます。プロンプト・応答・エラーがセッションごとのJSONLファイルに記録されます。

Docker実行については [Docker実行](#docker実行) セクションを参照してください。

### 機能の個別制御

Local LLMの各機能は環境変数で個別にon/offできます。

```bash
# .env — 例: ツールだけ無効にする
LOCAL_LLM_TOOLS=false

# 例: 雑談ボット（全部off）
LOCAL_LLM_TOOLS=false
LOCAL_LLM_SKILLS=false
LOCAL_LLM_XANGI_COMMANDS=false

# 例: トリガー付き雑談
LOCAL_LLM_TOOLS=false
LOCAL_LLM_SKILLS=false
LOCAL_LLM_XANGI_COMMANDS=false
LOCAL_LLM_TRIGGERS=true
```

| 変数 | 説明 | デフォルト |
|------|------|-----------|
| `LOCAL_LLM_TOOLS` | ツール実行（exec/read/write/edit/glob/grep/send_file/web_fetch） | `true` |
| `LOCAL_LLM_SKILLS` | スキル一覧注入 | `true` |
| `LOCAL_LLM_XANGI_COMMANDS` | XANGI_COMMANDS注入 | `true` |
| `LOCAL_LLM_TRIGGERS` | トリガー（!コマンド） | `false` |

`LOCAL_LLM_MODE` でプリセットも使えます（個別設定が優先）：
- `agent`（デフォルト）— tools / skills / xangi_commands ON、triggers OFF
- `chat` — 全部 OFF（純粋雑談ボット）
- `lite` — tools / xangi_commands / triggers ON、skills OFF（軽めだが Discord/Slack 操作はできるチャットボット向け）

ワークスペースコンテキスト（AGENTS.md等）はどの設定でも注入されます。

### Triggers（カスタムツール）

ワークスペースの `triggers/` ディレクトリにシェルスクリプトを置くだけで、LLMが使えるカスタムツールを追加できます。`LOCAL_LLM_TRIGGERS=true` で有効化。

LLMがfunction callingでトリガーを呼び出し、handler.shを実行して結果を返します。

#### セットアップ

ワークスペースに `triggers/` ディレクトリを作成し、コマンドごとにサブディレクトリを配置します。

```
workspace/
  triggers/
    weather/
      trigger.yaml    # トリガー定義
      handler.sh      # 実行スクリプト
    search/
      trigger.yaml
      handler.sh
```

#### trigger.yaml フォーマット

```yaml
name: weather
description: "天気予報を取得する（例: weather 名古屋）"
handler: handler.sh
```

| フィールド | 必須 | 説明 |
|-----------|------|------|
| `name` | Yes | ツール名（LLMがfunction callingで呼ぶ名前） |
| `description` | No | ツールの説明（LLMに渡されるツール定義に含まれる） |
| `handler` | Yes | 実行スクリプトのファイル名 |

#### handler の仕様

- ワークスペースルートを `cwd` として `bash handler.sh [引数...]` で実行
- 引数はLLMがfunction callingで渡した`args`をスペース区切りで渡す
- タイムアウト: `EXEC_TIMEOUT_MS`（デフォルト120秒）
- `stdout` の内容がLLMに返され、LLMが自然な文章で応答を生成

#### 動作フロー

1. xangi起動時にワークスペースの `triggers/` をスキャンしてツール定義を自動生成
2. LLMにカスタムツールとして登録
3. LLMがfunction callingでツールを呼び出し
4. handler.shが実行され、結果がLLMに返される
5. LLMが結果を踏まえて自然な文章で応答

#### 注意事項

- ツールが有効なモード（lite/agent）で動作します
- 新しいトリガーを追加したらxangiを再起動してください

### マルチモーダル（画像入力）

Local LLMバックエンドは画像入力に対応しています。Discord/Slackで画像を添付してメッセージを送ると、画像の内容をLLMに渡して分析・説明を求めることができます。

#### 対応画像形式

JPEG (.jpg, .jpeg)、PNG (.png)、GIF (.gif)、WebP (.webp)

#### 対応LLMサーバー

- **Ollama** — `/api/chat` の `images` フィールド（base64形式）で画像を送信
- **OpenAI互換API（vLLM等）** — `messages[].content` を配列形式（`text` + `image_url`）で送信

エンドポイントのURLにポート `11434` または `ollama` が含まれる場合はOllama形式、それ以外はOpenAI互換形式が使用されます。

#### 使用例

```
@xangi この画像について説明して
（画像を添付）
```

画像以外のファイル（PDF、テキスト等）は従来通りファイルパスとしてプロンプトに渡されます。

#### 注意事項

- マルチモーダル対応モデル（例: `llava`, `llama3.2-vision` 等）が必要です
- 画像はbase64エンコードしてそのまま送信されます（リサイズなし）
- 画像がない場合は従来通りテキストのみで動作します（後方互換性あり）

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
| `Qwen3.5-27B-FP8` | 29GB | ツールコール高精度、約6tok/s | vLLM推奨 |

その他Ollama/vLLMで利用可能なモデルに対応しています。

## ワークスペース hooks（Stop hook）

エージェントループのターン終了時に外部検証プロセス（hook）を挟む機構。Claude Code / Codex CLI の Stop hook と互換の契約を採用しているため、同じ hook スクリプトを複数のランタイムで共用できる。現在対応しているのは Local LLM バックエンドのターン終了（`Stop` イベント）のみ。

使い所の例: 「あとで確認して報告します」と約束したのにスケジュール登録ツールを呼んでいない応答を block し、登録を促すフィードバックを返す（やりっぱなし防止）。

### 設定

hooks はデフォルト有効です。ワークスペースに `hooks/hooks.json` を置くだけで動きます（無ければ何もしない no-op）。skills / triggers と同じ「置いたら効く」の慣行です。

```bash
# 一時的に止めたい場合のみ（キルスイッチ）
# XANGI_HOOKS_ENABLED=false
# 設定ファイルの場所を変える場合のみ（既定: <workspace>/hooks/hooks.json）
# XANGI_HOOKS_FILE=/path/to/hooks.json
```

ワークスペースに `hooks/hooks.json` を置く:

```json
{
  "hooks": {
    "Stop": [
      { "command": "python3 hooks/check-promise/hook.py", "timeoutMs": 10000 }
    ]
  }
}
```

### hook の契約（Claude Code 互換）

hook はターン終了時にコマンドとして実行され（cwd = ワークスペース）、stdin に JSON を受け取る:

```json
{
  "hook_event_name": "Stop",
  "session_id": "...",
  "cwd": "/path/to/workspace",
  "stop_hook_active": false,
  "last_assistant_message": "（このターンの最終応答テキスト）",
  "channel_id": "...",
  "tools_called": ["exec", "schedule_add"]
}
```

`channel_id` / `tools_called` は xangi 拡張。transcript を parse しなくても「このターンで実際に実行されたツール」を hook 側が直接判定できる。

block の返し方（どちらでも可）:

- exit 0 + stdout に `{"decision": "block", "reason": "..."}`（reason 必須）
- exit 2 + stderr に理由テキスト

それ以外（出力なし / JSON 以外 / 他の exit code / タイムアウト / spawn 失敗）はすべて素通り（フェイルオープン）。hook の異常で本体の応答が止まることはない。

### block されたときの動作

1. hook の reason を `[STOP HOOK FEEDBACK]` として system message で LLM に注入
2. 同じセッションで 1 回だけ継続ラウンドを実行（ツール呼び出し可。例: ここで `schedule_add` を呼んで約束を実体化できる）
3. ユーザーに返る最終応答は「元の応答 + 継続ラウンドの応答」の連結
4. 継続ラウンドの結果は再チェックしない（1 ターン 1 ナッジ、block 無限ループ防止）

### 環境変数

| 変数 | デフォルト | 説明 |
|---|---|---|
| `XANGI_HOOKS_ENABLED` | `true` | `false` で hooks 機構を無効化（キルスイッチ） |
| `XANGI_HOOKS_FILE` | `<workspace>/hooks/hooks.json` | hooks 設定ファイルのパス |

### オン/オフの制御

- 全体: `XANGI_HOOKS_ENABLED`（既定 `true`。`false` でキルスイッチ、`hooks.json` を残したまま一時停止できる）
- モード連動: ツール無効モード（`chat`）ではゲート自体を自動スキップする。継続ラウンドで LLM がフィードバックに対処する手段（`schedule_add` 等のツール呼び出し）を持たないため
- チャンネル別: `CHANNEL_OVERRIDES` の `localLlmMode` や `/llmmode` でチャンネルを `chat` に切り替えれば、そのチャンネルだけ hooks が無効になる

### 制限

- 対応イベントは `Stop` のみ（`PreToolUse` 等は将来拡張）
- 対応バックエンドは `local-llm` のみ。`claude-code` / `codex` バックエンドでは各 CLI 自身の hooks 機構（Claude Code の `.claude/settings.json` / Codex の lifecycle hooks）を使う
- 複数 hook は登録順に直列実行し、最初に block を返した hook で確定
- hook の stdout/stderr の取り込みは 64KB まで、タイムアウトは既定 10 秒・上限 60 秒

## Tool Trajectory Logger

Local LLM の tool 使用挙動 (drift / loop / tool_search 採用ミス) を構造化 jsonl で記録する観測ロガー。既存 `transcript-logger` (会話の正史) とは独立して動き、session restore とは完全分離されている。

### 出力先

```
logs/tool-trajectory/<appSessionId>.jsonl
```

1 line = 1 event。既存 `logs/sessions/<appSessionId>.jsonl` (transcript) とは別ディレクトリで干渉しない。

### 記録される event 種別

| kind | 何を記録するか |
|------|----------------|
| `session_start` | backend / model / baseUrl / features / logger 設定 (per appSession 1 回) |
| `tool_call` | tool_name / args_sanitized / result_truncated / duration_ms / status / round |
| `tool_search` | query / candidates_top5 / activated_tools / activated_skills |
| `drift_rescue` | raw_text_head / parsed_name / safety_verdict / executed |
| `loop_detected` | loop_kind (exact / similar / idempotent_cache_hit) / signature / action |
| `runner_event` | streaming_hold_buffer_drop / context_prune / session_retry / idempotent_cache_store |

全 event に共通 fields: `ts` / `event_id` / `kind` / `schema_version=1` / `appSessionId` / `seq` / `turn_index` / `round` / `platform` / `backend` / `model` / `channelId_hash`。

### 強制 sanitize

OSS 公開前提のため log の中身が後で公開されても問題ない設計:

- secret 系 key (`token` / `apiKey` / `bearer` / `cookie` / `authorization` / `password` 等) の値 → `[REDACTED_SECRET]` 固定文字列に置換
- Discord channelId / userId / LINE userId → salt 付き sha256 hash (12 字、`h_` prefix)
- 絶対 path home prefix → `$HOME` に置換
- URL の secret-like query → redact
- 長文 args / result → head/tail 方式で切り詰め (args 8KB / result 16KB / drift raw 2KB がデフォルト)

### Retention

- default では削除しない (TTL / size cap いずれも env で明示指定された時のみ動作)
- 観察データを残す前提なので、自動削除はオプトイン
- env で TTL 日数を指定すると起動時に超過分を削除
- env で size cap MB を指定すると超えた分を古いファイルから削除
- 1 session = 1 file の構造は維持 (rotation 無し)

### 設定 env

| env | default | 説明 |
|-----|---------|------|
| `XANGI_TOOL_TRAJECTORY_LOG` | `true` | `false` で完全 no-op、ファイル作成もしない |
| `TOOL_TRAJECTORY_LOG_HASH_SALT` | (起動毎ランダム) | Discord/LINE ID hash 用の固定 salt。プロセス跨ぎで ID 相関を追いたい場合のみ指定 |
| `TOOL_TRAJECTORY_LOG_MAX_ARGS_CHARS` | `8192` | args 切り詰め上限 |
| `TOOL_TRAJECTORY_LOG_MAX_RESULT_CHARS` | `16384` | tool 結果切り詰め上限 |
| `TOOL_TRAJECTORY_LOG_RETENTION_DAYS` | (未設定) | 削除しない。設定時のみ TTL 日数として動作 |
| `TOOL_TRAJECTORY_LOG_SIZE_CAP_MB` | (未設定) | 上限なし。設定時のみ全体サイズ上限 (MB) として動作 |

### fail-safe

ロガー書き込みエラーは `console.warn` で出力されるだけで例外を投げない。jsonl 破損・ディスクフル等が起きても runner は落とさない。session restore は `logs/tool-trajectory/` を一切見ないので、このログ側の障害は会話継続に影響しない。

### 設計意図

- 観察対象: Local LLM の多段防御 (loop / 冪等キャッシュ / streaming hold buffer / pseudo tool_call rescue / context prune の 5+1 機構) がどう発火しているか、tool_search の採用結果、drift_rescue の安全判定内訳
- runner 本体には dataset 都合を一切混ぜず、観測ログの生成だけを行う。蓄積データを別形式に変換したい場合は、この jsonl を入力に後段で別途処理する

## セキュリティ

### 環境変数のホワイトリスト

AIエージェント（CLI spawn / Local LLM exec）に渡す環境変数は `src/safe-env.ts` で管理。ホワイトリストに記載された変数のみ渡され、`DISCORD_TOKEN` 等のシークレットはAIからアクセス不可。

**許可される変数:** `PATH`, `HOME`, `USER`, `SHELL`, `LANG`, `LC_*`, `TERM`, `TMPDIR`, `TZ`, `NODE_ENV`, `NODE_PATH`, `WORKSPACE_PATH`, `AGENT_BACKEND`, `AGENT_MODEL`, `SKIP_PERMISSIONS`, `DATA_DIR`, `XANGI_TOOL_SERVER`, `XANGI_CHANNEL_ID`

`ANTHROPIC_API_KEY`、`CURSOR_API_KEY`、`XAI_API_KEY` は通常のホワイトリストには含めず、それぞれ Claude Code / Cursor CLI / Grok CLI の子プロセスにだけ渡されます。

**渡されない変数（例）:** `DISCORD_TOKEN`, `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `LOCAL_LLM_API_KEY`, `GH_TOKEN`

ホワイトリストを変更する場合は `src/safe-env.ts` の `ALLOWED_ENV_KEYS` を編集。

## 環境変数一覧

### Discord

| 変数 | 説明 | デフォルト |
|------|------|-----------|
| `DISCORD_TOKEN` | Discord Bot Token | **必須** |
| `DISCORD_ALLOWED_USER` | 許可ユーザーID（カンマ区切りで複数可、`*`で全員許可） | **必須** |
| `AUTO_REPLY_CHANNELS` | メンションなしで応答するチャンネルID（カンマ区切り） | - |
| `DISCORD_REPLY_IN_THREAD` | 返信をチャンネルではなく発言ごとに作成したスレッドへ投稿 | `false` |
| `DISCORD_STREAMING` | ストリーミング出力 | `true` |
| `DISCORD_SHOW_THINKING` | 思考過程を表示 | `true` |
| `DISCORD_SHOW_BUTTONS` | Stop/New Sessionボタン表示 | `true` |
| `DISCORD_TOOL_HISTORY_MODE` | ツール利用履歴表示（`button` / `inline` / `off`） | `button` |
| `DISCORD_SHOW_TOOL_BUTTON` | `button` モード時に Tools ボタンを表示 | `true` |
| `DISCORD_SHOW_LIVE_TOOL_USE` | 実行中だけ raw ツール履歴を表示 | `true` |
| `TOOL_HISTORY_MAX_LINES` | ツール履歴の最大表示行数（超過分は `… (+N 件省略)`、`0` 以下で無制限） | `10` |
| `DISCORD_SHOW_TOOL_USE` | 互換設定。`false` は `off`、`true` は `inline` として扱う | - |
| `DISCORD_COMPLETION_NOTIFY` | 一定時間以上かかった Discord ターン完了時に別メッセージで通知（`off` / `message` / `mention`） | `message` |
| `DISCORD_COMPLETION_NOTIFY_AFTER_MS` | 完了通知を出す最短経過時間（ms） | `10000` |
| `ALLOW_AUTOREPLY_COMMAND` | `/autoreply` コマンドの有効化 | `true` |
| `RESPOND_TO_BOTS` | 反応対象 bot ID のホワイトリスト（`*` で全 bot） | - |
| `RESPOND_TO_BOTS_ENABLED` | bot メッセージ応答機能の ON/OFF（`/respondtobots` で動的切替） | `false` |
| `RESPOND_TO_BOTS_MAX_CONSECUTIVE` | 同じ bot との連続応答の上限（0 で無制限） | `3` |
| `ALLOW_RESPOND_TO_BOTS_COMMAND` | `/respondtobots` コマンドの有効化 | `true` |
| `ALLOW_LLM_MODE_COMMAND` | `/llmmode` コマンド（Local LLM 動作モード切替）の有効化 | `true` |
| `INJECT_CHANNEL_TOPIC` | チャンネルトピックをプロンプトに注入 | `true` |
| `INJECT_TIMESTAMP` | 現在時刻をプロンプトに注入 | `true` |

### AIエージェント

| 変数 | 説明 | デフォルト |
|------|------|-----------|
| `AGENT_BACKEND` | バックエンド（`claude-code` / `codex` / `cursor` / `grok` / `antigravity` / `local-llm`） | `claude-code` |
| `AGENT_MODEL` | 使用するモデル | - |
| `WORKSPACE_PATH` | 作業ディレクトリ（ローカル実行時） | `./workspace` |
| `XANGI_WORKSPACE` | ワークスペースのホスト側パス（Docker実行時） | `./workspace` |
| `SKIP_PERMISSIONS` | デフォルトで許可スキップ（非対話実行で待ち状態を防ぐため既定有効。明示的に `false` で無効化） | `true` |
| `TIMEOUT_MS` | リクエストの初期タイムアウト（ミリ秒） | `1800000` |
| `XANGI_TOOL_SERVER_PORT` | 内部ツールサーバーの固定ポート。未設定時は前回ポートを再利用（使用中なら自動割り当て） | 前回ポート再利用 |
| `XANGI_CONFIG_STRICT` | 環境変数の不正値（数値でない・範囲外・enum typo 等）を起動エラーに格上げ。デフォルトは警告 + デフォルト値フォールバック | `false` |
| `TIMEOUT_MAX_MS` | タイムアウト延長の絶対上限（ミリ秒） | `36000000` |
| `TIMEOUT_EXTEND_ENABLED` | 延長ボタン (`[延長]`) の有効/無効 | `true` |
| `WEB_CHAT_UPLOAD_ACCEPT` | Web Chat 受信ファイル許可リスト（カンマ区切り、HTML `<input accept>` 互換） | 全許可 |
| `WEB_CHAT_DOWNLOAD_ACCEPT` | Web Chat ダウンロード許可拡張子リスト（`.html,.txt` 等） | 全許可 |
| `ALLOWED_BACKENDS` | `/backend` で切り替え許可するバックエンド（カンマ区切り）。未設定なら全バックエンド許可 | 全バックエンド |
| `ALLOWED_MODELS` | `/backend` で切り替え許可するモデル（カンマ区切り） | - |
| `CHANNEL_OVERRIDES` | チャンネル別バックエンド設定（JSON） | - |
| `ANTHROPIC_API_KEY` | Claude Code backend に渡す Anthropic API key（Claude Code利用時のみ） | - |
| `CLAUDE_CODE_BARE` | Claude Code に `--bare` を渡し、OAuth/keychain ではなく API key 認証に固定 | `false` |
| `CLAUDE_CODE_MAX_BUDGET_USD` | Claude Code に `--max-budget-usd` を渡し、API呼び出しの上限額を設定 | - |
| `CURSOR_API_KEY` | Cursor CLI backend に渡す API key（Cursor CLI利用時のみ） | - |
| `CURSOR_FORCE` | Cursor CLI に `--force` を渡す（明示的に `false` で無効化） | `true` |
| `CURSOR_TRUST_WORKSPACE` | Cursor CLI に `--trust` を渡す（明示的に `false` で無効化） | `true` |
| `XAI_API_KEY` | Grok CLI backend に渡す API key（Grok CLI利用時のみ。`grok login` 済みなら不要） | - |
| `PERSISTENT_MODE` | 常駐プロセスモード | `true` |
| `MAX_PROCESSES` | 同時実行プロセス数の上限 | `10` |
| `IDLE_TIMEOUT_MS` | アイドルプロセスの自動終了時間 | `1800000` |
| `DATA_DIR` | データ保存ディレクトリ（スケジュール・セッション等） | `WORKSPACE_PATH/.xangi` |
| `GH_TOKEN` | GitHub CLIトークン | - |

### ワークスペース hooks

| 変数 | 説明 | デフォルト |
|------|------|-----------|
| `XANGI_HOOKS_ENABLED` | ターン終了時の Stop hook 実行（[ワークスペース hooks](#ワークスペース-hooksstop-hook) 参照）。`false` でキルスイッチ | `true` |
| `XANGI_HOOKS_FILE` | hooks 設定ファイルのパス | `<workspace>/hooks/hooks.json` |

### ツール承認

| 変数 | 説明 | デフォルト |
|------|------|-----------|
| `APPROVAL_ENABLED` | 危険コマンド実行前にDiscord/Slackで承認を求める | `false` |
| `APPROVAL_SERVER_PORT` | 承認サーバーのリッスンポート | `18181` |

### WebチャットUI

| 変数 | 説明 | デフォルト |
|------|------|-----------|
| `WEB_CHAT_ENABLED` | WebチャットUIの有効化。`true` で `http://localhost:<WEB_CHAT_PORT>` を公開 | `false` |
| `WEB_CHAT_PORT` | WebチャットUIのポート | `18888` |
| `WEB_CHAT_UPLOAD_ACCEPT` | アップロード許可リスト (HTML `accept` 形式)。未設定なら全許可。`.ext` 部分はサーバでも検証される | (未設定 / 全許可) |

### スケジューラ

| 変数 | 説明 | デフォルト |
|------|------|-----------|
| `SCHEDULER_ENABLED` | スケジューラ有効化 | `true` |
| `STARTUP_ENABLED` | スタートアップタスク有効化 | `true` |

### 外部イベントストリーム（pull 型 SSE）

応答ライフサイクル（`turn.started` / `message.delta` / `turn.complete` / `turn.aborted` / `agent.error`）を SSE で配信する。consumer は web-chat サーバの `GET /api/events/stream` に接続して購読する。詳細は [外部イベントストリーム](events.md) を参照。

| 変数 | 説明 | デフォルト |
|------|------|-----------|
| `XANGI_EVENTS_ENABLED` | `false` で SSE 配信を完全無効化（接続要求は 503） | `true` |
| `XANGI_INSTANCE_ID` | 送信元インスタンスの識別子。未指定なら `xangi-<hostname>-<sha1(DATA_DIR)[:6]>` で自動採番 | `auto` |

### Pet / Device からの入力 (`POST /api/*/inbox`)

`xangi-pet` や Even G2 などの consumer 側 UI からテキストを 1 行投げ込むための書き込み endpoint。`/api/pet/inbox` / `/api/device/inbox` / `/api/terminal/inbox` を提供する。受理されたら 202 が即返り、応答は既存の events SSE 経由で broadcast される。詳細とリクエスト形式は [外部イベントストリーム#Pet / Device からの入力経路](events.md#pet--device-からの入力経路-post-apiinbox) を参照。

| 変数 | 説明 | デフォルト |
|------|------|-----------|
| `XANGI_PET_INBOX_ENABLED` | `false` で書き込み経路を完全無効化（503 を返す） | `true` |
| `XANGI_PET_INBOX_TOKEN` | 設定時は `Authorization: Bearer <token>` 必須。未設定時は loopback + LAN (RFC1918) + Tailscale (CGNAT 100.64/10) からのみ許可 (グローバル IP は 403) | (未設定) |
| `XANGI_DEVICE_INBOX_ENABLED` | `false` で device/terminal 書き込み経路を無効化（503 を返す） | `true` |
| `XANGI_DEVICE_INBOX_TOKEN` | device/terminal 用 token。未設定時は `XANGI_PET_INBOX_TOKEN` に fallback | (未設定) |

### Even Terminal 互換 API

Even G2 の公式ターミナルモード（`@evenrealities/even-terminal` 互換）から xangi Web Chat サーバを直接 host として使うための API。`/api/prompt` / `/api/events` / `/api/messages` などを提供する。詳細は [外部イベントストリーム#Even Terminal 互換 API](events.md#even-terminal-互換-api) を参照。

Even 側の provider 選択は `claude` / `codex` ラベルとして受け取るだけで、実際の backend は xangi の `AGENT_BACKEND` が決める。Even Terminal 経由だけ別 backend / model / Local LLM mode にしたい場合は `XANGI_EVEN_TERMINAL_BACKEND` / `XANGI_EVEN_TERMINAL_MODEL` / `XANGI_EVEN_TERMINAL_LOCAL_LLM_MODE` を使う。`CHANNEL_OVERRIDES` の `web-chat:<appSessionId>` 個別設定がある場合は、個別設定が専用 default より優先される。

| 変数 | 説明 | デフォルト |
|------|------|-----------|
| `XANGI_EVEN_TERMINAL_TOKEN` | Even Terminal 互換 API 専用 token。未設定時は `XANGI_DEVICE_INBOX_TOKEN` → `XANGI_PET_INBOX_TOKEN` に fallback | (未設定) |
| `XANGI_EVEN_TERMINAL_BACKEND` | Even Terminal 経由だけの backend default (`claude-code` / `codex` / `cursor` / `grok` / `antigravity` / `local-llm`) | `AGENT_BACKEND` |
| `XANGI_EVEN_TERMINAL_MODEL` | Even Terminal 経由だけの model default | `AGENT_MODEL` / backend側の既定 |
| `XANGI_EVEN_TERMINAL_LOCAL_LLM_MODE` | Even Terminal 経由だけの Local LLM mode default (`agent` / `lite` / `chat`) | `LOCAL_LLM_MODE` / `agent` |

### Terminal / Device セッション (`xangi-cmd terminal_session`)

`xangi-cmd terminal_session` は Web Chat セッションを作成し、外部 device / terminal 側が使う inbox URL と thread filter 付き events URL を表示する。Even G2 向けには alias として `xangi-cmd g2_session` も使える。

```bash
xangi-cmd terminal_session --base-url http://127.0.0.1:18888 --title "Terminal Session"
xangi-cmd g2_session --base-url http://127.0.0.1:18888 --title "Even G2 Terminal"
```

### GitHub App認証（オプション）

GitHub App設定があれば、`gh` CLI実行時にインストールトークンを自動生成。PATや `gh auth login` が不要に。

| 変数 | 説明 |
|------|------|
| `GITHUB_APP_ID` | GitHub App ID |
| `GITHUB_APP_INSTALLATION_ID` | インストールID |
| `GITHUB_APP_PRIVATE_KEY_PATH` | 秘密鍵ファイルパス |

設定しなければ従来の `gh` 認証（`gh auth login` / `GH_TOKEN`）をそのまま使用。

**Docker環境:** 秘密鍵は `/secrets/github-app.pem` に自動マウントされます。`.env` にはホスト側のパスを設定してください。

**`gh` / `git` ラッパー:** GitHub App 認証が有効な場合、xangi は `/tmp/xangi-gh-wrapper/gh` と `/tmp/xangi-gh-wrapper/git` を生成し、AI エージェントに渡す `PATH` の先頭へ固定します。さらに `BASH_ENV` でも同じ設定を再適用するため、非対話 shell が起動時に `PATH` を組み直しても通常の `gh` / `git` に戻りにくくなります。

`gh` ラッパーは実行ごとに `/github-token` から短寿命の installation token を取得し、`GH_TOKEN` として本物の `gh` に渡します。`git` ラッパーは既存の `gh auth git-credential` を bypass し、GitHub HTTPS の credential 要求時だけ `/github-token` から取得した installation token を `x-access-token` ユーザーとして返します。SSH remote は対象外です。

**実行時確認:**

```bash
curl -i "$XANGI_TOOL_SERVER/github-token"
```

- `200 OK`: GitHub App 認証が有効
- `404 {"error":"GitHub App is not configured"}`: 実装不足ではなく、起動中プロセスに `GITHUB_APP_*` が未設定または未反映。`.env` 設定後に xangi を再起動してください
- `500`: 秘密鍵、App ID、Installation ID、GitHub API 呼び出しのいずれかで失敗

**セキュリティ:**
- 秘密鍵は起動時にメモリに読み込まれ、AIエージェントからはファイルとして直接アクセスできません
- トークン生成はtool-serverのHTTPエンドポイント（`/github-token`）経由で行われ、AIエージェントが取得できるのは短寿命のインストールトークン（1時間有効）のみです
- トークン生成に失敗した場合、PATへのフォールバックは行わずエラーになります

### Cursor CLI（`AGENT_BACKEND=cursor` 時）

Cursor CLI backend は `cursor-agent` コマンドを使用します。非対話実行は `cursor-agent -p ... --output-format json`、ストリーミングは `--output-format stream-json --stream-partial-output` です。

Cursor CLI の自動化認証が必要な場合は `CURSOR_API_KEY` を設定してください。この値は Cursor CLI 子プロセスにのみ渡されます。

Cursor CLI backend は、非対話実行で workspace trust 待ちにならないよう、デフォルトで `--trust` を渡します。信頼できない workspace で実行する場合は `CURSOR_TRUST_WORKSPACE=false` を明示してください。

Cursor CLI backend は、Codex / Claude Code の `SKIP_PERMISSIONS=true` 既定と同じく、非対話運用で permission 待ちにならないよう、デフォルトで `--force` も渡します。通常の対話運用や信頼できない workspace では `CURSOR_FORCE=false` を明示してください。

### Grok CLI（`AGENT_BACKEND=grok` 時）

Grok CLI backend は xAI の `grok` コマンドを使用します。非対話実行は `grok --no-auto-update -p ... --output-format json`、ストリーミングは `--output-format streaming-json` です。

認証はローカルの `grok login`、または `XAI_API_KEY` に依存します。`XAI_API_KEY` は Grok CLI 子プロセスにのみ渡されます。

`SKIP_PERMISSIONS=true` 既定時は、非対話運用で tool approval 待ちにならないよう `--always-approve` を渡します。個人用・信頼済み workspace 前提の設定です。

### Antigravity CLI（`AGENT_BACKEND=antigravity` 時）

Antigravity CLI backend は Google Antigravity CLI の `agy` コマンドを使用します。インストールは `curl -fsSL https://antigravity.google/cli/install.sh | bash`、認証は `agy` の初回起動フローに従います。

非対話実行は `agy --print-timeout <timeout> -p ...` です。`ANTIGRAVITY_PRINT_TIMEOUT`（デフォルト `5m`）で Agy 自身の print mode タイムアウトを設定できます。`AGENT_MODEL` が設定されていれば `--model`、provider session があれば `--conversation` を渡します。

Agy が成功終了しても stdout が空の場合、stderr に出力された timeout・quota・認証などの詳細をエラーとして表示します。

`SKIP_PERMISSIONS=true` 既定時は、非対話運用で permission 待ちにならないよう `--dangerously-skip-permissions` を渡します。個人用・信頼済み workspace 前提の設定です。

Antigravity CLI は現時点で安定した JSON/stream-json 出力を前提にしないため、xangi 側のストリーミング表示は最終応答を1回送るフォールバック動作です。将来 `agy` 側に機械可読な stream 出力が追加された場合は runner 側で逐次表示に拡張できます。

### Local LLM（`AGENT_BACKEND=local-llm` 時）

| 変数 | 説明 | デフォルト |
|------|------|-----------|
| `LOCAL_LLM_BASE_URL` | LLMサーバーURL | `http://localhost:11434` |
| `LOCAL_LLM_MODE` | プリセット（`agent` / `chat` / `lite`） | `agent` |
| `LOCAL_LLM_TOOLS` | ツール実行 | `true` |
| `LOCAL_LLM_SKILLS` | スキル一覧注入 | `true` |
| `LOCAL_LLM_XANGI_COMMANDS` | XANGI_COMMANDS注入 | `true` |
| `LOCAL_LLM_TRIGGERS` | トリガー（!コマンド） | `false` |
| `LOCAL_LLM_MODEL` | 使用するモデル名 | - |
| `LOCAL_LLM_API_KEY` | APIキー（vLLM等で必要な場合） | - |
| `LOCAL_LLM_THINKING` | Thinkingモデルの推論を有効にするか | `true` |
| `LOCAL_LLM_MAX_TOKENS` | 最大トークン数（API 呼び出しの max_tokens） | `8192` |
| `LOCAL_LLM_NUM_CTX` | コンテキストウィンドウサイズ（Ollama用、context budget 逆算の基準） | モデルのデフォルト |
| `LOCAL_LLM_TEMPERATURE` | サンプリング温度（0 で決定的、agent モードの format drift を抑える時に有効） | モデルのデフォルト |
| `LOCAL_LLM_CONTEXT_MAX_CHARS` | 履歴の最大文字数（明示優先、未指定なら `LOCAL_LLM_NUM_CTX` から逆算） | 自動計算 |
| `LOCAL_LLM_SYSTEM_PROMPT_BUDGET_TOKENS` | system prompt が占める想定トークン数（逆算用） | `8000` |
| `LOCAL_LLM_OUTPUT_BUDGET_TOKENS` | 1 リクエストの最大出力トークン（逆算用） | `4096` |
| `LOCAL_LLM_SAFETY_MARGIN_TOKENS` | 安全マージン（逆算用） | `1000` |
| `LOCAL_LLM_CONTEXT_KEEP_LAST` | 直近 N 件のメッセージは削除しない | `10` |
| `LOCAL_LLM_TOOL_RESULT_MAX_CHARS` | tool 結果の最大文字数（コンテキスト内） | `4000` |
| `LOCAL_LLM_MAX_SESSION_MESSAGES` | セッションの最大メッセージ数 | `50` |
| `LOCAL_LLM_TOOL_SEARCH_ENABLED` | tool 遅延ロード機能（`tool_search`）を有効化 | `true` |
| `LOCAL_LLM_TOOL_SEARCH_LIMIT` | `tool_search` が 1 回で返す最大ツール数 | `8` |
| `LOCAL_LLM_ALWAYS_LOADED_TOOLS` | 常駐 tool 名（カンマ区切り）。ここに無い tool は deferred 扱い | `read,write,edit,exec,glob,grep,send_file,web_fetch,tool_search` |
| `EXEC_TIMEOUT_MS` | execツールのタイムアウト（ミリ秒） | `120000` |
| `WEB_FETCH_TIMEOUT_MS` | web_fetchツールのタイムアウト（ミリ秒） | `15000` |
| `LOCAL_LLM_READ_MAX_BYTES` | readツールのファイルサイズ上限（バイト） | `524288`（512KB） |
| `LOCAL_LLM_READ_JSON_MAX_BYTES` | readツールでJSONを読むときの上限（バイト） | `5120`（5KB） |
| `LOCAL_LLM_WRITE_MAX_BYTES` | writeツールのコンテンツサイズ上限（バイト） | `524288`（512KB） |

### Slack

| 変数 | 説明 |
|------|------|
| `SLACK_BOT_TOKEN` | Slack Bot Token（xoxb-...） |
| `SLACK_APP_TOKEN` | Slack App Token（xapp-...） |
| `SLACK_ALLOWED_USER` | 許可ユーザーID |
| `SLACK_AUTO_REPLY_CHANNELS` | メンションなしで応答するチャンネルID |
| `SLACK_REPLY_IN_THREAD` | スレッド返信するか（デフォルト: `true`） |
| `SLACK_REPLY_IN_CHANNELS` | スレッド返信が有効な場合でも、チャンネル直下に返信するチャンネルID（カンマ区切り） |

## 複数インスタンスの運用

開発用と本番用など、**1台のマシンで xangi を複数同時に動かす**場合は、必ず `DATA_DIR` をインスタンスごとに分けること。デフォルトは `${WORKSPACE_PATH}/.xangi/` で、ここを共有すると `sessions.json` を取り合って書き潰し合い、新しく作ったセッションがもう一方の古い in-memory state で消去される事故が起きる（特に長時間プロセスがメモリ上の古いリストを保持しているとき）。

### 推奨構成

```bash
# 本番（borot）
WORKSPACE_PATH=/home/user/borot
# DATA_DIR は省略 → /home/user/borot/.xangi/

# 開発（xangi-dev）
WORKSPACE_PATH=/home/user/borot
DATA_DIR=/home/user/xangi-dev/.xangi   # ← 明示的に分離
```

`WORKSPACE_PATH` 自体を共有しても OK（スキル・メモリは同じものを使いたい）。**`DATA_DIR` だけ分離**すれば衝突は起きない。

### 起動時の警告

`DATA_DIR` は起動時に `proper-lockfile` で排他ロックされる。別の xangi プロセスが同じ `DATA_DIR` をすでに握っていると、コンソールへ警告が出る:

```
[xangi] ⚠️  Another xangi process is using the same dataDir: /path/to/.xangi
[xangi] ⚠️  Sessions and settings will be overwritten unpredictably. Set DATA_DIR to a separate path for this instance.
```

このメッセージが出たら片方を停止するか、`DATA_DIR` を分離して再起動する。

ロックは 30 秒ごとに mtime ハートビートで更新され、60 秒以上更新が止まれば stale 判定で次の起動時に強制取得される。crash や SIGKILL で残った lock はそのまま自動回収されるので手動削除は不要。

## セッションの保持期間

デフォルトでは**セッション履歴をすべて保持**する（`sessions.json` は 1 エントリ数百バイト程度のため、長期運用でも容量への影響は小さい）。

古いセッションを整理したい場合は `XANGI_SESSION_RETENTION_DAYS` に日数を設定すると、起動時に `updatedAt` 基準で剪定される。

```bash
XANGI_SESSION_RETENTION_DAYS=90    # 90日より古いセッションを起動時に剪定
XANGI_SESSION_RETENTION_DAYS=0     # 剪定しない（デフォルトと同じ）
```

なお、会話本文のトランスクリプト（`logs/sessions/`）とツール実行軌跡ログ（`logs/tool-trajectory/`、`TOOL_TRAJECTORY_LOG_RETENTION_DAYS` で別管理）は本設定の対象外。

## オプション

普段は触らなくていい設定。信頼境界を強めたい・許可確認を厳しくしたい等、特定の用途で使う。

### 危険コマンドの承認フロー

`APPROVAL_ENABLED=true` を設定すると、エージェントが危険なコマンドを実行しようとしたときに Discord/Slack にボタン付きの確認メッセージを出します。**デフォルトは無効**です。

```
⚠️ 危険なコマンドを検知
git push origin main
Git push

[許可] [拒否]
```

- 2分以内に応答がなければ自動拒否
- Claude Code / Local LLM 両バックエンド対応
- 承認サーバー（`localhost:18181`、`APPROVAL_SERVER_PORT` で変更可）で統一管理

**検知対象コマンド:**

| カテゴリ | パターン | 説明 |
|---------|---------|------|
| ファイル削除 | `rm -r`, `rm -f` | 再帰的・強制削除 |
| Git | `git push` | リモートへのpush |
| Git | `git reset --hard` | 変更の破棄 |
| Git | `git clean -f` | 未追跡ファイル削除 |
| Git | `git branch -D` | ブランチ強制削除 |
| 権限 | `chmod 777` | 全権限付与 |
| 権限 | `chown -R` | 再帰的所有権変更 |
| システム | `shutdown`, `reboot` | システム停止・再起動 |
| システム | `kill -9`, `killall` | プロセス強制終了 |
| リモート実行 | `curl \| sh`, `wget \| bash` | リモートスクリプト実行 |
| DB | `DROP TABLE`, `TRUNCATE` | データベース削除 |
| 機密ファイル | `cat .env`, `cat *.pem` | 認証情報の読み取り |
| 機密ファイル | Write/Editで `.env`, `.pem`, `credentials` を変更 | 認証情報の変更 |

**Claude Codeバックエンドの設定:**

ワークスペースの `.claude/settings.json` に PreToolUse フックを追加：

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "http",
            "url": "http://127.0.0.1:18181/hooks/pre-tool-use",
            "timeout": 120
          }
        ]
      }
    ]
  }
}
```

**Local LLMバックエンド:** 設定不要。自動的に承認サーバーに問い合わせます。

### 許可確認のスキップ（per-message）

xangi は **デフォルトで AI の許可確認をスキップ**します（`SKIP_PERMISSIONS=true` 相当）。Discord/Slack/Web チャットからの呼び出しは非対話実行のため、許可プロンプトに答える人間がいないとタスクが待ち状態になるからです。

`.env` で `SKIP_PERMISSIONS=false` を明示すると許可確認が有効になります。その場合のみ、メッセージ単位で例外的にスキップしたいときに以下が使えます：

| 入り口             | 説明                                                        |
| ------------------ | ----------------------------------------------------------- |
| `!skip <メッセージ>` | メッセージ冒頭に付けると、そのメッセージだけスキップ実行     |
| `/skip <メッセージ>` | スラッシュコマンド版。`!skip` と同じ動作                     |

```
@xangi !skip gh pr list
!skip ビルドして                    # 専用チャンネルではメンション不要
/skip ビルドして                    # スラッシュコマンド版
```

> **⚠️ セキュリティ注意:** 信頼できないワークスペースやマルチユーザー環境では `SKIP_PERMISSIONS=false` を明示し、上記の[危険コマンドの承認フロー](#危険コマンドの承認フロー)と組み合わせて使ってください。

## トラブルシューティング

### 「Prompt is too long」エラー

**症状:** 特定のチャンネルで全てのメッセージに対して「❌ エラーが発生しました: Prompt is too long」と返される。

**原因:** セッションの会話履歴がClaude Code（Agent SDK）のコンテキスト上限を超えた。通常はAgent SDKが自動でコンテキストを圧縮するが、セッションが異常終了した場合など、状態が壊れて回復できなくなることがある。

**対処法:**

1. 該当チャンネルで `/new` コマンドを実行してセッションをリセットする
2. それでも解消しない場合は、xangiを再起動する（`pm2 restart xangi`）
