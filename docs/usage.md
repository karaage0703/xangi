[English](en/usage.md) | 日本語

# 使い方ガイド

xangiの詳細な使い方ガイドです。

## 目次

- [基本操作](#基本操作)
- [チャンネルトピック注入](#チャンネルトピック注入)
- [タイムスタンプ注入](#タイムスタンプ注入)
- [セッション管理](#セッション管理)
- [スケジューラー](#スケジューラー)
- [Terminal CLI（xangi）](#terminal-clixangi)
- [チャット操作（xangi tool）](#チャット操作xangi-tool)
- [イベントトリガー](#イベントトリガー)
- [ランタイム設定](#ランタイム設定)
- [AIによる自律操作](#aiによる自律操作)
- [Docker実行](#docker実行)
- [Extension連携](#extension連携)
- [Local LLM](#local-llm)
- [ワークスペース hooks](#ワークスペース-hooks)
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

`/autoreply` で有効化したチャンネルではメンション不要で応答します。設定は `settings.json` に保存されます。

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
- **完了後**: チャンネル直下の`New`はセッションをリセット。スレッド内はDiscord / Slackとも左端に`Close`を表示して現在のセッションを終了する。`History`は途中コメントとツール実行を時系列で本人だけに表示し、Slackでは表示内の`閉じる`で一時表示だけを削除
- **Discordスレッド内の`Close`**: セッションを終了して履歴へ移したうえで、押したユーザー自身をスレッドから退出させ、そのユーザーのサイドバーから消す。会話ログとDiscordスレッド自体は削除しない。BotにDiscordの「スレッドの管理」権限が必要

`DISCORD_SHOW_BUTTONS=false` でボタンを非表示にできます。

返信候補は既定OFFです。ONにすると、Discord / Slackの完了後メッセージには `返信候補` ボタンを1つだけ表示します。押すと候補と数字ボタンが本人だけに表示され、選択すると同じセッションへ送信されます。Web Chatも回答下の `返信候補` から候補を展開して送信できます。Discordの `/replysuggestions mode:on|off|show|default` で全プラットフォームを一括切替できます。OFF時は候補生成指示をAIプロンプトへ追加しないため、追加トークンや生成待ち時間は発生しません。各プラットフォームの `*_REPLY_SUGGESTIONS=true` で起動時にON、`*_REPLY_SUGGESTIONS_COUNT=1..5` で件数を変更できます（既定3件）。

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
  - Discord — 「考え中.」メッセージのボタン行に `[Stop][延長][⏱ MM:SS]` の順。通常メッセージ起点だけでなく schedule / trigger 起点のターンでも表示
  - Slack — メッセージ末尾の Block Kit actions に同様。通常メッセージ起点だけでなく schedule / trigger 起点のターンでも表示
- 残り 30 秒以下で表示が赤色 + パルスアニメーション
- 上限到達後は `延長` が disabled / 非表示

対応バックエンド:

- Claude Code (`persistent-runner`): タイマーをスケジュール再設定して延長
- Codex / Cursor / Grok / Antigravity: 子プロセスの kill タイマーを再設定
- Local LLM: AbortController を最新参照経由で延長
- Dynamic Runner: 内部 Runner にパススルー

API（プログラマブル操作）:

- `GET /api/sessions/:id/timeout` — 現在のタイムアウト状態 `{active, timeoutAt, maxTimeoutAt, remainingMs, timeoutMs}`
- `POST /api/sessions/:id/timeout/extend` — `{additionalMs?: number}`で延長。省略時は現在の残り時間を加算（残り時間を2倍）
- `POST /api/sessions/:id/close` — SessionをClosedにして次回投稿の紐付けとrunnerを外す。会話ログは削除しない。誤操作を避けるため、Web UIではMonitor詳細から実行する

MonitorはSessionを`実行中`・`入力待ち`・`完了`の3列に分け、内部のOpen / Closedは表示しません。provider側の文脈を持たないstateless extension backendは実行中だけ表示し、応答完了後はMonitorから消えます。検索結果などの会話ログはChatに残ります。完了は既定で直近24時間を表示します。エラーと中断は独立列にせず、入力待ちカードの状態ラベルと色付きドットで示します。完了後も履歴画面から元のDiscordで続けるか、履歴を引き継いだ新しいWeb会話へ分岐できます。状態未確定の既存Sessionは一旦完了として扱い、次の入力を受けると入力待ちまたは実行中へ戻ります。Discordスレッドでは`Close`がSessionの完了と本人のスレッド退出をまとめて行います。

### Agent Run API

同じタスクを異なるbackend・modelで比較する場合は、Agent Run APIで独立したWeb sessionを作成できます。`workspaceId`を省略するとdefault workspaceを使います。POSTは実行受付後すぐHTTP 202を返すため、個別GETで終端状態を確認します。

```http
POST /api/agent-runs
Content-Type: application/json

{
  "task": "対象テストを通るように実装してください",
  "backend": "codex",
  "model": "gpt-5.6-sol",
  "effort": "high",
  "workspaceId": "default"
}
```

- `GET /api/agent-runs` — run一覧
- `GET /api/agent-runs/:id` — 状態、task hash、session ID、所要時間、usageを含むmanifest。`trajectoryPath`は実際にログが生成された場合だけ含まれる
- 状態は`queued`、`running`、`succeeded`、`failed`
- 初版はacceptance gate、自動修復、複数runの集計を行いません

## スケジューラー

定期実行やリマインダーを設定できます。AI に自然言語で頼むと、AI が `xangi tool schedule_add` などを呼び出してスケジュールを登録します。
スケジュール実行結果には、成功・失敗とも所要時間が表示されます。Discord・Slack・Telegramでは結果末尾、Webではメッセージヘッダーに表示されます。

### 操作方法

| 入り口                           | 説明                                            |
| -------------------------------- | ----------------------------------------------- |
| `/schedule` (Discord スラッシュ) | GUI でスケジュールを追加・一覧・削除・切替      |
| Web UI の「予定」                | 全対応platformの予定を追加・編集・停止・削除    |
| `xangi tool schedule_*`          | AI または CLI から操作（下記）                  |
| 自然言語                         | 「毎日 9 時におはようって言って」等で AI が登録 |

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

### `xangi tool schedule_*`

AI ／ シェルから直接スケジュール操作できます。`schedule_add`では送信先を曖昧にしないため、`--channel`が必須です。Web Chatへ送る場合は`--platform web`とWeb session IDを指定します。

```bash
# スケジュール追加（自然言語）
xangi tool schedule_add --input "毎日 9:00 おはよう" --channel <channelId>
xangi tool schedule_add --input "30分後 ミーティング" --channel <channelId>
xangi tool schedule_add --input "15:00 レビュー" --channel <channelId>
xangi tool schedule_add --input "毎週月曜 10:00 週次MTG" --channel <channelId>
xangi tool schedule_add --input "cron 0 9 * * * おはよう" --channel <channelId>

# Webセッションに送りたい場合
xangi tool schedule_add --input "毎日 9:00 状況確認" --platform web --channel <sessionId>

# 一覧表示
xangi tool schedule_list

# 本文だけ更新（ID・日時・送信先・有効状態は維持）
xangi tool schedule_update --id <スケジュールID> --message "更新後の依頼"

# 日時・種別・本文をまとめて更新
xangi tool schedule_update --id <スケジュールID> --input "起動時に 更新後の依頼"

# 送信先platformを変更（platform変更時はchannelも必須）
xangi tool schedule_update --id <スケジュールID> --platform slack --channel <channelId>

# 削除（ID 指定）
xangi tool schedule_remove --id <スケジュールID>

# 有効/無効切り替え
xangi tool schedule_toggle --id <スケジュールID>
```

`schedule_update`は未指定項目を保持します。`--input`と`--message`は同時に指定できません。有効状態の変更には`schedule_toggle`を使います。

### データ保存

スケジュールデータは `${DATA_DIR}/schedules.json` に保存されます。

- デフォルト: `<WORKSPACE_PATHまたは起動時のカレントディレクトリ>/.xangi/schedules.json`（Dockerでは`/workspace/.xangi/schedules.json`）
- 環境変数 `DATA_DIR` で変更可能

## Gitを使わない初回インストール

macOS、Linux、WSL2で共通のコマンドです。

```bash
curl -fsSL https://github.com/karaage0703/xangi/releases/latest/download/install.sh | bash
```

共通`install.sh`がOSとCPUを判定し、同じGitHub Releaseにあるtarget installerを選択します。WSL2はLinuxとして扱います。`curl ... | bash`のpipeから起動した場合はxangi本体の配置だけを完了し、AI setupとservice起動を延期します。installer終了後、通常のTerminalから表示された`xangi setup`を実行してください。pipe内のshell/readlineからCodexなどのTUIへ端末を引き継がないことで、platform固有の端末初期化エラーを避けます。managed版は`~/.local/bin/xangi`を作成し、そのdirectoryがPATHに無い場合はbashまたはzshの起動設定へ重複なく追加して、現在のshell用の`export PATH=...`も表示します。

## Terminal CLI（xangi）

`xangi` は人間が端末から xangi Web セッションに接続するための薄いクライアントです。既存の Even Terminal 互換 API (`/api/sessions` / `/api/prompt` / `/api/messages` / `/api/status`) を使い、Claude Code / Codex CLI などのバックエンドを直接起動しません。実際の backend / model は xangi 本体の設定または `XANGI_EVEN_TERMINAL_BACKEND` 系の設定で決まります。

`xangi` はセッション操作・サービス操作・AI向けtool操作をまとめた正規CLIです。AIエージェントや運用スクリプトは `xangi tool <operation>` を使います。従来の `xangi-cmd <operation>` も互換shimとして同じdispatcherへ中継しますが、新しい文書とスクリプトでは `xangi tool` を使ってください。

```bash
# 開発中に xangi コマンドを PATH に通す
cd ~/xangi-dev
npm link

# npm link を使わない場合（単一 clone のとき）
mkdir -p ~/.local/bin
ln -sf ~/xangi-dev/bin/xangi ~/.local/bin/xangi

# 複数 clone を使う場合は名前付き symlink にする
ln -sf ~/xangi-dev/bin/xangi ~/.local/bin/xangi-dev
ln -sf ~/xangi-prod/bin/xangi ~/.local/bin/xangi-prod

# セッション一覧
xangi sessions --url http://127.0.0.1:18888

# 新規セッションに送信して応答まで待つ
xangi send "このリポジトリの状態を見て"

# 標準入力から送信
git diff | xangi send -

# 既存セッションへ送信して応答まで待つ
xangi send --session <sessionId> "続きお願いします"

# 送信だけして session ID を受け取る
xangi send --detach "あとで確認するタスクを投げる"

# 対話REPL
xangi chat --session <sessionId>

# macOS・Linux・WSL2初期設定
xangi setup

# config / service healthの診断（秘密値は表示しない）
xangi doctor

# 実行中instanceのWeb UIアクセス先・bind・Chat/Workspace疎通をJSONで表示
xangi tool web_status

# 現在のreleaseまたはcheckoutのバージョンを表示
xangi --version

# 署名済みreleaseへ安全に更新（installerが保存した公開鍵とmanifest URLを使用）
xangi update

# 更新後、反映したいタイミングでserviceを明示的に再起動
xangi service restart

# managed版を削除（workspace・設定・token・履歴は保持）
xangi uninstall

# 設定・token・履歴も削除（workspaceは保持）
xangi uninstall --purge --yes

```

`xangi setup` は最初にPATH上のCodex、OpenCode、Claude Code、Cursor Agent、Grok CLI、Antigravityをルールベースで検出し、`--version`が成功した候補だけを表示します。候補が複数なら利用するAIを選び、0件なら独立したAIツールセットアップを案内して終了します。Local LLMは通常利用できますが、ファイル操作を伴う初回オンボーディング役には選びません。

AIコーディングツールだけをセットアップする場合は、xangiをインストールせずに次のワンライナーを実行できます。

```bash
bash <(curl -fsSL https://github.com/karaage0703/xangi/releases/latest/download/setup-ai-tools.sh) codex
```

最後の引数は`codex`、`claude-code`、`cursor`、`grok`、`antigravity`、`github-copilot`、`opencode`から選びます。状態確認だけなら`check`を指定します。Codexに必要なNode.jsとnpmが無い場合は、nvmを導入したあとTerminalをいったん閉じ、新しいTerminalで`command -v nvm`、`nvm install --lts`の順に実行するガイドを表示します。

OpenCodeは`setup-ai-tools.sh opencode`で公式installerから導入し、OpenCode自身の認証画面を開きます。その後の`xangi setup`で、既存のOpenCode設定・認証を使うか、OpenAI互換ローカルLLMを使うかを選べます。ローカルLLMを選ぶとbase URL、model ID、context/output上限を確認し、xangiのconfig directoryへ専用`opencode.json`をmode 0600で保存します。通常のOpenCode設定は上書きせず、xangi実行時だけ`OPENCODE_CONFIG`と`AGENT_MODEL`を適用します。

選択したAIは日本語の対話モードで起動し、workspaceを一問ずつ確認します。初回はWeb Chatを`local`（loopbackのみ）に固定し、workspaceの最低限の準備、service起動、`doctor`によるconfig・workspace・backend・service・health・runtime-workspaceの確認までTailscaleを調べたり変更したりしません。localの基本セットアップが動作した後だけ、希望者へ`tailscale`（同一portのTailscale Serve TCP転送でTailnet内へ公開）または`lan`（`0.0.0.0`、認証なしの警告付き）を追加設定として案内します。`setup --access <local|tailscale|lan>`は完了済みのオンボーディング状態を戻さず、Web Chatの公開範囲だけを変更します。Tailscaleを選んだ時だけ`tailscale serve --bg --tcp=<PORT> tcp://127.0.0.1:<PORT>`を設定し、転送確認に成功してから`setup --access tailscale`を適用します。Tailscaleの追加設定に失敗してもlocalの基本セットアップは成功したままです。agent UIへ表示する初回メッセージは短い開始案内だけで、詳細手順はmode 0600の一時ファイルからAIが読み、終了時に削除します。既知workspaceが無い場合は`ai-assistant-workspace`を最初に推奨します。利用者が選ぶと、GitHub repositoryの`main`最新commitを解決し、そのcommitのarchiveをGitなしで取得します。別の空workspaceや別の絶対pathにある既存workspaceも選べます。AIは回答後に`xangi setup --apply`をlocal指定で呼びますが、絶対path・backend・workspace mode・Web Chat accessの検証、mode 0600のatomic config保存、repository template適用、空workspace用BOOTSTRAP.md生成はxangi側が行います。最低限のBOOTSTRAPが終わるまでは`xangi setup --complete`を拒否します。基本セットアップ後は、そのまま使い始めるか、Web Chatの追加アクセス、Discord、他platform、schedule、skillの追加設定へ進むかをAIが確認します。これらxangi自体の設定はworkspace内の手順を探さず、xangi本体に同梱したREADME、`docs/usage.md`、各platformの公式documentを正本として案内します。checkout版は`service start`の後に`doctor`を実行し、Gitなし配布版はinstallerがOS serviceを起動して`doctor`で確認します。template適用時はrepository・commit SHA・archive SHA-256・適用時刻をstateへ保存し、その後の更新でworkspaceを上書きしません。

AIオンボーディングを置き換えるsetup用browser UIはありません。ただしtoken入力だけは`xangi settings`のローカル専用GUIを使います。対応AIが無い場合は上記の単体セットアップを表示して終了するため、導入後に`xangi setup`をやり直してください。LinuxはXDG Base Directory準拠、常駐化は`systemd --user`を使います。WSL2はsystemdを有効化した環境が対象です。

`setup`、`update`、`doctor`はGitなし配布版とGit checkout版の両方で使えます。checkout版の`setup`が保存した共通設定はPM2起動時にも読み込まれるため、`.env`へ`WORKSPACE_PATH`を重複記入する必要はありません。`doctor`はPM2、Web Chatのhealth、`/api/sessions`が報告する実際のworkspaceを確認し、設定と違えばERRORで終了します。

checkout版の`./bin/xangi update`は、未commit変更、detached HEAD、upstreamなしを先に拒否し、`git pull --ff-only`、`npm ci`、`npm run build`を順に実行します。署名済みmanaged appのupdaterをcheckoutから明示的に呼ぶ場合は`./bin/xangi update --managed`を使います。

`xangi update --help`（短縮形は`-h`）は、checkout版とmanaged版それぞれの更新内容・利用可能なoption・serviceを自動再起動しないことを表示します。更新内容を反映するタイミングで`xangi service restart`を明示的に実行してください。

`xangi --version`（`xangi -V`、`xangi version`も可）は、managed版では現在有効な署名済みrelease番号を、checkout版ではGitのtagまたはcommitを表示します。

managed版の`xangi uninstall`は定期update、OS service、xangi本体の順に削除します。workspace、設定、token、履歴は保持するため、表示されたinstall commandを再実行すれば以前の設定を使って再インストールできます。設定、token、履歴も削除する場合だけ`xangi uninstall --purge --yes`を使います。`--purge`は`--yes`が無ければ何も削除せず終了し、どちらの方法でもworkspaceは削除しません。

開発checkoutの`./bin/xangi`は、`git pull`後もGit管理外の古い`dist/`を実行しないよう、`npm ci`で入れたlocal `tsx`から現在のsourceを起動します。配布bundleはsourceを含まないため、同梱`dist`とNode runtimeを使い、AIが参照するREADMEと利用者向けdocsも同梱します。

Discordの許可ユーザーIDとDiscord、Slack、LINE、Telegramのtokenは`xangi settings`で入力します。一時GUIは`127.0.0.1`だけにbindし、one-time URLとHost検証を使い、保存済み値をbrowserへ返しません。保存後はserverを閉じ、OS別config directoryの`secrets.json`へmode 0600でatomic保存します。利用者が`read`や`printf`を組み立てたり、tokenをAIとの会話へ貼り付けたりする必要はありません。明示的な環境変数は互換性のため引き続き優先されます。

GitHub Releaseでは共通入口を`install.sh`として公開します。`packaging/bootstrap.sh`がOSとCPUを検出し、同じReleaseにある`xangi-installer-<darwin|linux>-<arm64|x64>.sh`を選びます。pipe起動時はtarget installerへ`XANGI_INSTALL_DEFER_SETUP=1`を渡し、署名検証済みCLIの配置だけを完了して、AI setupとservice起動を別の`xangi setup`へ分離します。target installerは`packaging/build-installer.mjs`で生成し、xangi本体のEd25519署名済みmanifest/artifactを照合します。検証前にarchiveを展開せず、公開鍵と`releases/latest`の更新確認用manifest URLをversion領域外へ保存し、検証済みbundle、`current`、launcher、`~/.local/bin/xangi`を確定します。setupやservice起動が失敗してもxangi本体はrollbackせず、`xangi setup`または`xangi install`で再開できます。artifact URLはrelease versionへ固定し、更新時はlatest manifestの署名を検証してから新しいartifactを取得します。AIコーディングツールはRelease assetの`setup-ai-tools.sh`でxangiとは独立して導入・認証できます。通常のTerminalから実行した`xangi setup`が対話型オンボーディングを担当し、完了後にserviceを起動します。初回install後はLaunchAgentまたはsystemd user timerが6時間ごとに`xangi update`を実行します。workspaceテンプレートは選択時にrepositoryの最新commitを取得して空の初回だけ適用し、利用者の編集を更新・merge・上書きしません。

主なオプション:

| オプション        | 説明                                                                                                                               |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `--version`, `-V` | 現在有効なrelease番号、またはcheckoutのGit tag・commitを表示                                                                       |
| `--url`           | xangi Web Chat URL。未指定時は `XANGI_URL` / `XANGI_CLI_URL` / `~/.config/xangi/config.json` / `http://127.0.0.1:18888` の順で解決 |
| `--token`         | Even Terminal 互換 API token。未指定時は `.env` / `XANGI_TOKEN` / `XANGI_EVEN_TERMINAL_TOKEN` / config を使う                      |
| `--provider`      | Even Terminal 互換ラベル (`claude` / `codex`)。実 backend 選択ではなく互換用                                                       |
| `--session`       | attach する Web session ID                                                                                                         |
| `--detach`, `-d`  | `send` 後に応答を待たず、session ID だけを返す                                                                                     |

`send` はデフォルトで `/api/messages` をポーリングして最終応答を表示します。待たずに戻したい場合だけ `--detach` を指定します。

起動時には `XANGI_ENV_PATH`、`XANGI_DIR/.env`、カレントディレクトリの `.env` も自動で読みます。`~/xangi-dev` で実行する場合は、通常 `--token` を手で渡す必要はありません。

`~/.local/bin` が PATH に入っていない場合は、shell の設定ファイルに `export PATH="$HOME/.local/bin:$PATH"` を追加してください。

設定ファイル例:

```json
{
  "url": "http://127.0.0.1:18888",
  "token": "your-token",
  "provider": "codex",
  "sessionId": "optional-default-session"
}
```

## チャット操作（xangi tool）

AIが `xangi tool` CLIツール経由でDiscord / Slack操作を実行します。xangi内蔵のtool-server（HTTP API）を介するため、DISCORD_TOKEN / SLACK_BOT_TOKEN 等のシークレットはAI CLIからアクセスできません。

常駐システムプロンプトには全コマンド例を埋め込みません。AIは操作方法や引数が必要な時に `xangi tool help`、`xangi tool help <topic>`、`xangi tool help <command>` で現在のusageを確認します。topicは `discord` / `slack` / `web` / `schedule` / `models` / `trigger` / `system` / `local` です。ユーザー向けslash commandの正本は各platformの `/help` です。

| コマンド                                                                         | 説明                                                                                                       |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `xangi tool discord_history --channel <ID> [--count N] [--offset M]`             | チャンネル履歴取得                                                                                         |
| `xangi tool discord_message --channel <ID> --message-id <ID>`                    | 特定メッセージの全文取得                                                                                   |
| `xangi tool discord_send --channel <ID> --message "text"`                        | メッセージ送信                                                                                             |
| `xangi tool discord_channels --guild <ID>`                                       | チャンネル一覧                                                                                             |
| `xangi tool discord_search --channel <ID> --keyword "text"`                      | メッセージ検索                                                                                             |
| `xangi tool discord_edit --channel <ID> --message-id <ID> --content "text"`      | メッセージ編集                                                                                             |
| `xangi tool discord_delete --channel <ID> --message-id <ID>`                     | メッセージ削除                                                                                             |
| `xangi tool discord_thread_leave --user <ID> [--channel <ID>]`                   | スレッドから指定ユーザーを退出させる＝そのユーザーのサイドバーから消す（`--channel` 省略で現在のスレッド） |
| `xangi tool media_send --channel <ID> --file /path/to/file`                      | ファイル送信                                                                                               |
| `xangi tool web_history [--session <id>] [--count N]`                            | Web Chat 現ペイン履歴取得（`XANGI_CHANNEL_ID=web-chat:<id>` 自動解決）                                     |
| `xangi tool web_status`                                                          | 実行中instanceのWeb UIアクセス先・bind・port・Chat/Workspace HTTP状態をJSONで取得                          |
| `xangi tool slack_history [--channel <id>] [--count N]`                          | Slack 現チャンネル履歴取得（`XANGI_CHANNEL_ID=<channel>` 自動解決）                                        |
| `xangi tool slack_send --channel <id> --message "text" [--thread-ts <ts>]`       | Slackメッセージ送信                                                                                        |
| `xangi tool slack_channels [--types public_channel,private_channel] [--limit N]` | Slackチャンネル一覧                                                                                        |
| `xangi tool slack_search --channel <id> --keyword "text" [--count N]`            | Slackメッセージ検索                                                                                        |
| `xangi tool slack_edit --channel <id> --message-ts <ts> --content "text"`        | Slackメッセージ編集                                                                                        |
| `xangi tool slack_delete --channel <id> --message-ts <ts>`                       | Slackメッセージ削除                                                                                        |

Slack では `SLACK_REACTION_DELETE_ENABLED=true`（デフォルト）かつ Slack App が `reaction_added` event / `reactions:read` scope を持つ場合、許可ユーザーが bot 投稿に `:wastebasket:` または `:x:` リアクションを付けると、その投稿を削除できます。対象リアクションは `SLACK_DELETE_REACTIONS=wastebasket,x` で変更できます。

### 使用例

```bash
# チャンネル履歴を取得
xangi tool discord_history --count 10
xangi tool discord_history --channel 1234567890 --count 10
xangi tool discord_history --channel 1234567890 --count 30 --offset 30  # 遡り
xangi tool discord_message --channel 1234567890 --message-id 111222333  # 履歴で省略された本文を全文取得

# 別チャンネルにメッセージ送信
xangi tool discord_send --channel 1234567890 --message "作業完了しました！"

# チャンネル一覧
xangi tool discord_channels --guild 9876543210

# メッセージ検索
xangi tool discord_search --channel 1234567890 --keyword "PR"

# Slack操作
xangi tool slack_send --channel C01234567 --message "作業完了しました！"
xangi tool slack_send --channel C01234567 --thread-ts 1719876543.000100 --message "スレッド返信"
xangi tool slack_channels --types public_channel,private_channel --limit 100
xangi tool slack_search --channel C01234567 --keyword "PR" --count 15
```

`--channel` を省略した場合、xangi上で実行中なら現在のチャンネルIDが使われます。CLI単体実行では `--channel` が必要です。

```bash
# メッセージ編集・削除
xangi tool discord_edit --channel 1234567890 --message-id 111222333 --content "修正後の内容"
xangi tool discord_delete --channel 1234567890 --message-id 111222333

# スレッドから指定ユーザーを退出させる＝そのユーザーのサイドバーから消す（--channel 省略で現在のスレッド）
xangi tool discord_thread_leave --user 111222333
xangi tool discord_thread_leave --user 111222333 --channel 1234567890
xangi tool slack_edit --channel C01234567 --message-ts 1719876543.000100 --content "修正後の内容"
xangi tool slack_delete --channel C01234567 --message-ts 1719876543.000100
```

### Tool Server

xangi toolはxangiプロセス内のtool-server（HTTP API）に中継します。

- ポートはOS自動割り当て（複数インスタンスでも競合なし）
- xangi本体が起動時に `XANGI_TOOL_SERVER` を子プロセスへ注入
- `xangi tool` は `XANGI_TOOL_SERVER` を使って接続先を解決
- `XANGI_TOOL_SERVER` が無い場合は接続先を推測せずエラー終了（別instanceへの誤接続を防止）
- 現在のチャンネルIDなど、xangi実行時の文脈は `context` としてtool-serverに引き渡されます

複数instanceを同じPCで動かす場合も、各xangiが自分の子プロセスへ異なる `XANGI_TOOL_SERVER` を注入するため混線しません。外部スクリプトから使う場合は、対象instanceの `XANGI_TOOL_SERVER` を明示して実行してください。

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
- `platform`（任意）: `discord`（デフォルト）、`slack`、`telegram`、`web`

成功すると `202 { "ok": true, "triggerId": "trg_..." }` が即座に返ります（ターンの完了は待ちません）。Discord / Slack / Telegramではチャンネルに `⚡ trigger: <source>` のラベルが投稿され、続けてエージェントの応答が流れます。Webでは `web-chat:<sessionId>` と生の`sessionId`のどちらも受け付け、同じWeb会話へ新しいターンが追加されます。

返されたIDから、プラットフォーム共通の実行・配信状態を照会できます。`status` は `accepted`、`running`、`completed`（ターン完了・配信参照なし）、`delivered`、`failed`、`interrupted`（完了前にxangiが再起動）のいずれかです。配信済みの場合はDiscord / Slack / TelegramのメッセージID、またはWebのセッションIDが`delivery`に入ります。直近1000件は`${DATA_DIR}/trigger-receipts.json`へ保存され、再起動後も照会できます。

```bash
curl "$XANGI_TOOL_SERVER/api/trigger/<triggerId>" \
  -H "Authorization: Bearer $XANGI_TRIGGER_TOKEN"
```

### xangi tool で発火する

ローカルのスクリプトからは `xangi tool` でも発火できます（トークン不要、`TRIGGER_ENABLED=true` は必要）:

```bash
xangi tool trigger --channel <チャンネルID> --message "ビルドが終わった。結果を報告して" --source build
xangi tool trigger_status --id <triggerId>
```

`TRIGGER_ENABLED=true` の場合、AIのシステムプロンプトには成功・失敗の両方で終了状態とログを保存してからtriggerする、という安全契約だけを注入します。詳細な引数は `xangi tool help trigger`、具体的な起動・確認方法は各ワークスペースの指示を正本にします。

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
  "discordAutoReplyChannels": {
    "123456789012345678": true
  },
  "slackAutoReplyChannels": {
    "C01234567": true
  },
  "discordCompletionNotifyChannels": {
    "123456789012345678": "mention"
  },
  "discordThreadModeChannels": {
    "123456789012345678": true
  }
}
```

| 設定                              | 説明                                                               | デフォルト |
| --------------------------------- | ------------------------------------------------------------------ | ---------- |
| `discordAutoReplyChannels`        | チャンネルごとのメンションなし応答設定（`true` / `false`）         | なし       |
| `slackAutoReplyChannels`          | Slackチャンネルごとのメンションなし応答設定（`true` / `false`）    | なし       |
| `discordCompletionNotifyChannels` | チャンネルごとの完了通知 override（`off` / `message` / `mention`） | なし       |
| `discordThreadModeChannels`       | チャンネルごとの Discord スレッド返信 override（`true` / `false`） | なし       |

### 設定の確認・変更

| コマンド                                         | 説明                                                                                                 |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `/settings`                                      | 現在の設定を表示                                                                                     |
| `/models [backend]`                              | 利用可能なモデル一覧を表示（省略時は許可された全バックエンド）                                       |
| `/restart`                                       | ボットを再起動（`.env` の `XANGI_SELF_LIFECYCLE` が `restart-only` の場合のみ）                      |
| `/autoreply <on\|off\|default\|show>`            | このチャンネルのメンションなし応答を切替（再起動不要、`settings.json` に永続化）                     |
| `/notify <off\|message\|mention\|default\|show>` | このチャンネルの完了通知を切替（再起動不要、`settings.json` に永続化）                               |
| `/respondtobots`                                 | bot メッセージへの応答を ON/OFF トグル（反応対象は `RESPOND_TO_BOTS` 環境変数で事前指定）            |
| `/threadmode <on\|off\|default\|show>`           | このチャンネルの Discord 発言ごとスレッド返信モードを切替（再起動不要、`settings.json` に永続化）    |
| `/llmmode <agent\|chat\|default\|show>`         | このチャンネルの Local LLM 動作モードを per-channel で切替（`.env` の `CHANNEL_OVERRIDES` に永続化） |
| `/llmeffort <none\|minimal\|low\|medium\|high\|xhigh\|max\|default\|show>` | このチャンネルの Local LLM `reasoning_effort` を切替（`.env` に永続化） |

### バックエンド動的切り替え

チャンネルごとにバックエンド・モデル・effortレベルを切り替えられます。

| コマンド                                                    | 説明                                   |
| ----------------------------------------------------------- | -------------------------------------- |
| `/backend show`                                             | 現在のバックエンド・モデルを表示       |
| `/backend set claude-code`                                  | Claude Codeに切り替え                  |
| `/backend set cursor`                                       | Cursor CLIに切り替え                   |
| `/backend set grok`                                         | Grok CLIに切り替え                     |
| `/backend set antigravity`                                  | Antigravity CLIに切り替え              |
| `/backend set github-copilot`                               | GitHub Copilot CLIに切り替え           |
| `/backend set local-llm --model nemotron-3-nano`            | Local LLM + モデル指定                 |
| `/backend set claude-code --effort high`                    | effort指定付きで切り替え               |
| `/backend set codex --effort max`                           | Codexをmax effortで実行                |
| `/backend set cursor --model claude-opus-4-8 --effort high` | Cursorを明示モデル + high effortで実行 |
| `/backend set grok --effort max`                            | Grokをmax effortで実行                 |
| `/backend set antigravity --effort high`                    | Antigravityをhigh effortで実行         |
| `/backend reset`                                            | デフォルト（.env設定）に戻す           |

切り替え時は自動的に新しいセッションが開始されます（会話履歴は引き継がれません）。
Discord と Slack の両方で利用できます。Slack では App 設定に `/backend` を登録し、
Usage Hint を `show|set <backend> [--model <model>] [--effort <effort>]|reset` にしてください。
設定はチャンネルID単位で `CHANNEL_OVERRIDES` へ永続化され、同じチャンネル内のスレッドにも再起動なしで次のメッセージから反映されます。

`/models [backend]` は Discord、Slack、Web、Telegram、LINE で共通です。引数を省略すると `ALLOWED_BACKENDS` に含まれる全バックエンド、指定するとそのバックエンドだけを表示します。閲覧専用で、現在のバックエンドやモデル設定は変更しません。

`/models` は、各CLIが提供する公式の一覧取得機能から現在のアカウントで利用可能なモデルを動的取得します。Codexは`app-server model/list`、Cursorは`cursor-agent models`、Grokは`grok models`、OpenCodeは`opencode models`、AntigravityはAgy 1.1.12以降の`agy --output-format json models`を使用します。旧Agyが`--output-format`を明示的に拒否する場合は`agy models`へフォールバックし、タブ区切り形式と従来の1列形式を受理します。Local LLMはOllamaの`/api/tags`またはOpenAI互換の`/v1/models`を使用します。Claude CodeやGitHub Copilot CLIのように独立した機械可読の一覧取得コマンドがないバックエンドは「取得非対応」と表示し、モデル名をハードコードで補いません。

Webのスラッシュコマンドパレットでは、`/backend set`でbackendを選ぶと同じ動的取得結果からmodel候補を表示し、modelを選ぶとその組み合わせで利用可能なeffort候補を表示します。Web Project設定のmodel / effort候補も同じ取得結果を使用します。

Discordの`/backend set`でもmodelとeffortはautocomplete候補として表示されます。model候補は選択済みbackendの動的取得結果を使用し、effort候補は選択済みbackend/modelの両方で利用可能な値だけを表示します。

AIへ自然言語でモデルの利用可否を尋ねた場合も、システムプロンプトは回答前に次の読み取り専用コマンドで実測するよう指示します。

```bash
xangi tool models --backend codex
xangi tool models --backend codex --use gpt-5.4 --effort high
```

AIへの自然言語指示から設定を変える場合は、任意のスラッシュコマンド文字列を実行せず、許可された設定だけを扱う `runtime_settings` を使用します。`backend`、`llmmode`、`autoreply`、`notify`、`threadmode`、`replysuggestions`、`respondtobots` の `show` / `set` / `reset` を構造化引数で検証し、ネイティブコマンドと同じ保存経路へ反映します。Discordスレッドでは親チャンネルIDを `--channel` に指定します。

```bash
xangi tool runtime_settings --name autoreply --action set --value on
xangi tool runtime_settings --name backend --action set --backend codex --model gpt-5.4 --effort high
xangi tool runtime_settings --name llmmode --action set --value chat
```

`/restart`、`/stop`、`/new`、`/schedule`、`/skill` などライフサイクルや任意処理を伴うコマンドは対象外です。バックエンド・モデル・effortを変更した場合は、次のturnで古いprovider sessionを再利用しません。

#### 環境変数で制限

```bash
# 切り替え許可バックエンド（未設定=全バックエンド許可）
ALLOWED_BACKENDS=claude-code,codex,cursor,grok,antigravity,github-copilot,opencode,local-llm

# チャンネル別バックエンド設定（JSON）
CHANNEL_OVERRIDES={"チャンネルID":{"backend":"local-llm","model":"nemotron-3-nano"}}
```

#### 永続化

`/backend set` で変更した設定は `.env` の `CHANNEL_OVERRIDES` に自動保存されます。再起動後も設定が維持されます。
Discord スレッド内では、`/backend`、`/llmmode`、`/llmeffort` は親チャンネルの `CHANNEL_OVERRIDES` を読み書きします。通常の会話セッションや実行ロックはスレッドIDで分離したまま、モデル・バックエンド設定だけ親チャンネルから継承します。

Docker環境では `.env` はコンテナ外にあるため、AI（Claude Code等）から変更されることはありません。

### チャンネル別ワークスペース

DiscordとSlackではチャンネルごとに作業ディレクトリを選べます。スレッドは親チャンネルの設定を継承します。設定変更は進行中・既存セッションへ遡って適用されず、`/new`後の新規セッションから反映されます。

| コマンド                                | 説明                                         |
| --------------------------------------- | -------------------------------------------- |
| `/workspace show`                       | チャンネル設定と現在のセッション設定を表示   |
| `/workspace list`                       | 登録済みワークスペースを表示                 |
| `/workspace set <name> <absolute-path>` | 絶対パスを登録し、チャンネルへ設定         |
| `/workspace use <name>`                 | 登録済みワークスペースをチャンネルへ設定     |
| `/workspace reset`                      | 起動時の`WORKSPACE_PATH`へ戻す               |

Discordでは各引数をスラッシュコマンドの入力欄へ指定します。Slack App側にも `/workspace` Slash Commandを追加してください。未設定時はxangi processがアクセスできる既存の任意の絶対パスを登録できます。登録先を限定したい場合だけ`XANGI_WORKSPACE_ALLOWED_ROOTS`へ許可rootを列挙します。登録時は実体パスへ正規化し、xangiのstate directory配下は拒否します。Dockerではコンテナへmount済みのパスだけを切り替えられ、host上の未mountパスへはアクセスできません。

Web UIではProject画面の「Workspaceを追加」から、xangi processがアクセスできる既存の絶対パスを登録できます。登録解除はregistryから項目だけを外し、ディレクトリとファイルを削除しません。default Workspace、Projectまたは既存会話が参照しているWorkspace、Discord / Slack等のチャンネルへ設定済みのWorkspaceは登録解除できません。

#### effort オプション

Claude Code、Codex、OpenCode、Grok、GitHub Copilot CLIでは`low` / `medium` / `high` / `max`、Antigravityでは`low` / `medium` / `high`をチャンネルごとに設定可能です。xangiは各CLIの実引数へeffortを渡します。Cursorでは明示モデルとeffortを指定すると、CLI仕様のparameterized model（例: `claude-opus-4-8[effort=high]`）へ変換します。`auto[effort=...]`はCursor CLIで無効なため、Cursorのeffort設定ではモデルの明示指定が必須です。利用プランが対象モデルに対応しない場合はCursor CLIが実行時にエラーを返します。Local LLMの段階指定はCLI backendの`effort`とは別に`/llmeffort`で設定し、OpenAI互換APIのトップレベル`reasoning_effort`へ送ります。対応値は`none` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`で、接続先が値を実装している必要があります。`default`はチャンネル設定を削除し、`LOCAL_LLM_REASONING_EFFORT`またはprovider既定へ戻します。Antigravityで`max`を指定した場合は設定を保存せずエラーを返します。Claude Codeのpersistentモードでは切り替え時にセッションがリセットされます。

## AIによる自律操作

### 設定変更（ローカル実行時のみ）

AIは `.env` ファイルを編集して設定を変更できます：

```
「このチャンネルでも応答して」
→ AIが `/autoreply` 相当の設定を `settings.json` に保存
```

`/autoreply mode:on|off|default|show` で、このチャンネルのメンションなし応答を稼働中に確認・切替できます（再起動不要、`settings.json` に永続化）。`default` はチャンネル設定を削除し、通常はデフォルトの OFF、スレッド内では親チャンネルの値に戻します。
スレッド内で実行した場合は、親チャンネルではなくそのスレッドを対象にします。スレッドに設定がなければ親チャンネルの値を継承するため、チャンネル全体は OFF のまま特定のスレッドだけ ON にしたり、その逆にしたりできます。
このコマンドを無効にするには `.env` に `ALLOW_AUTOREPLY_COMMAND=false` を設定してください（デフォルト: 有効）。

`/threadmode mode:on|off|default|show` で、このチャンネルの Discord 発言ごとスレッド返信モードを稼働中に確認・切替できます（再起動不要、`settings.json` に永続化）。`default` はチャンネル設定を削除し、全体デフォルトの `DISCORD_REPLY_IN_THREAD` に戻します。
既存スレッド内で受けた発言では、スレッドの元メッセージを `🧵 スレッド元` としてプロンプトに自動追加します。これにより、親チャンネル側の starter message がスレッド履歴に出ない場合でも、最初の話題を文脈として扱えます。
スレッド内のpromptには、親チャンネル名/IDとスレッド名/IDを常に併記します。AIは追加検索なしで、親チャンネルと現在のスレッドを区別して操作できます。
Discord スレッド内では、`/notify` / `/threadmode` とチャンネル topic 注入は親チャンネル設定を対象にします。`/autoreply` はスレッド単位で設定でき、スレッドに設定がない場合のみ親チャンネルの値を継承します。
このコマンドを無効にするには `.env` に `ALLOW_THREAD_MODE_COMMAND=false` を設定してください（デフォルト: 有効）。

`/notify` コマンドで、長い Discord ターン完了時の別メッセージ通知をチャンネルごとに切り替えられます。起動時の `DISCORD_COMPLETION_NOTIFY` はデフォルト値として使われ、チャンネル override は `settings.json` に保存されます。対象は通常の Discord メッセージターンのみで、スケジュール起点ターンは通知しません。

完了表示は全プラットフォームで `✅ 完了（⏱ 1分01秒）` に統一されます。時間は設定で隠せます。通常のLINE / Telegramは既定10秒以上、Discord / Slackは既存のplatform別閾値、Webとscheduleは各結果に表示します。

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

ユースケース: 複数の xangi インスタンス（例: xangi-prod=Claude / xangi-dev=Local LLM）を同じチャンネルに常駐させて、同じプロンプトに対する応答を並べて品質比較する。

#### 制約・既知の制限

- bot メッセージへの応答は **メンション・DM・`/autoreply` で有効化したチャンネル経由** でのみ発火する。bot メッセージだからといってチャンネル全体で勝手に反応する仕様ではない。bot 同士の応答テストを行う場合は対象チャンネルで `/autoreply` を有効化する必要がある。
- `xangi tool discord_send` は通知抑止のため `allowed_mentions: { parse: [] }` 固定で送信する。そのため xangi tool 経由で送信されたメッセージ中の `<@user_id>` / `<@&role_id>` / `@everyone` は受信側の `message.mentions` に含まれない (Discord 公式仕様)。bot 同士のテストでメンション経由のトリガーは現状動かない。
- 上記の `xangi tool discord_send` の mention 抑制を一時的に解除したい場合は別途オプトイン機能の追加が必要（このスキル/機能のスコープ外）。

### メッセージ分割セパレータ

AIの応答テキストに `\n===\n`（前後に改行を含む `===`）が含まれている場合、そこで分割して別メッセージとして送信します。スケジューラー経由の応答だけでなく、DiscordとSlackの直接メッセージでも機能します。1回のLLM応答で複数の独立した投稿を生成したい場合に便利です。

```
📝 ツイート解説1
> ツイート本文...

===
📝 ツイート解説2
> ツイート本文...
```

上記の応答はDiscordまたはSlackに2つの別メッセージとして送信されます。操作ボタンが有効な場合は、最後のメッセージだけに表示されます。

### 再起動の仕組み

`xangi service start|stop|restart|status`と`xangi service autostart enable|disable`はmanaged版とcheckout版で共通です。managed版ではOS service、checkout版ではPM2を操作します。`stop`は自動起動登録を残したまま一時停止し、`start`で再開します。`autostart enable`だけがOSログイン・再起動後の自動起動を登録し、`autostart disable`で解除します。解除しても現在動いているxangiは停止しません。`xangi install`と`service start`は現在のセッションで起動するだけで、自動起動を勝手に有効化しません。checkout版ではcloneの`.env`にある`XANGI_PROCESS_NAME`のプロセスを対象にします。

`xangi service restart`と`xangi tool system_restart`は、再起動要求の前に新しいCLIで本番のWeb Project stateをread-only検証します。利用できないbackendなど、再起動後に問題になる状態を見つけると再起動を中止し、stateファイルは書き換えません。一方、起動時は不正なProject 1件を分離し、利用できないbackend/model/effortだけを無効化して他のProjectとxangi本体を起動します。

`/restart` や `xangi tool system_restart` は、起動中の xangi 自身に graceful shutdown を要求する低レベル操作です。実際に再起動して復帰させるのは、xangiの外側にある Docker / pm2 / systemd などの supervisor です。

現在の会話を処理しているxangi自身を再起動するときは、子プロセスやスケジューラへ遅延委譲せず、`xangi tool system_restart`を直接使います。このコマンドの成功は再起動リクエストの受付を表し、再起動完了は新しいプロセスのstatus・起動時刻・起動ログで確認します。別cloneのサービス操作には、対象cloneの`./bin/xangi service restart`を直接実行して完了を待ちます。

自己再起動の許可は管理者が `.env` の `XANGI_SELF_LIFECYCLE` で設定します。AI が runtime setting で変更するものではありません。停止は xangi 内部からは保証できないため、Docker / pm2 / systemd など外側のライフサイクル管理で行います。

```mermaid
flowchart TD
  User[User or AI] --> Service[xangi service]
  Service --> Supervisor[Docker / pm2 / systemd]
  User --> Cmd[system_restart or /restart]
  Cmd --> Gate{XANGI_SELF_LIFECYCLE}
  Gate -->|off| Deny[Deny]
  Gate -->|restart-only| Graceful[Graceful shutdown]
  Graceful --> Supervisor
  Supervisor --> Start[Start xangi again]
```

- `off`: xangi自身による再起動を拒否
- `restart-only`: xangi自身による再起動だけ許可
- 自己停止は xangi 内部ではなく外側の supervisor / lifecycle manager で実行
- **Docker**: `restart: always` により自動復帰
- **ローカル**: pm2等のプロセスマネージャが必要
- `.env` 変更後は xangi プロセスの再起動が必要

```bash
# pm2での運用例
./bin/xangi service start
./bin/xangi service status
./bin/xangi service restart
./bin/xangi service stop
```

OS 再起動後も自動起動したい場合は、一度だけ明示的に以下を実行します。managed版は`xangi`、checkout版は対象cloneの`./bin/xangi`を使います。

```bash
xangi service start
xangi service autostart enable
```

解除する場合は`xangi service autostart disable`を実行します。managed版ではmacOS LaunchAgentまたはLinux systemd user serviceの自動起動登録だけを追加・削除します。checkout版では有効化時に`pm2 save`と`pm2 startup`、解除時に`pm2 unstartup`を実行します。PM2が`sudo ...`コマンドを表示した場合は、そのコマンドを一度だけ実行してください。

複数 clone を運用する場合は、各 clone のディレクトリで `./bin/xangi service ...` を実行します。PATH から使いたい場合は、単一の `xangi` symlink ではなく `xangi-dev` / `xangi-prod` のような名前付き symlink を使うと対象が明確です。

```bash
ln -sf /home/user/xangi-dev/bin/xangi ~/.local/bin/xangi-dev
ln -sf /home/user/xangi-prod/bin/xangi ~/.local/bin/xangi-prod

xangi-dev service status
xangi-prod service restart
```

`--dir <xangi-dir>` は、PATH 上の `xangi` から別 clone を明示的に操作したい場合の補助オプションです。通常は対象 clone の `./bin/xangi` か名前付き symlink を使ってください。

`ecosystem.config.cjs` は PM2 のアプリ定義ファイルです。`.env` の `XANGI_PROCESS_NAME`（未指定時は `XANGI_INSTANCE_ID` → ディレクトリ名）を PM2 のプロセス名に使い、実行ファイル、`node --env-file=.env` などをまとめて定義します。`./bin/xangi service start` はこの設定を使って PM2 に起動を依頼します。`.cjs` にしているのは、このパッケージが ESM (`"type": "module"`) でも PM2 設定を CommonJS (`module.exports`) として確実に読ませるためです。

### pm2で環境変数を変更する場合

xangiは `node --env-file=.env` で環境変数を読み込みます。環境変数を変更したい場合は **`.env` ファイルを編集してから `./bin/xangi service restart`** してください。

```bash
# 正しい方法: .envを編集してrestart
vim .env  # TIMEOUT_MS=60000 を追加
./bin/xangi service restart
```

> **⚠️ `pm2 restart --update-env` は使わないこと！**
> `--update-env` はシェルの全環境変数をpm2に保存します。複数のxangiインスタンスを動かしている場合、別インスタンスの `DISCORD_TOKEN` 等が混入し、同じbotトークンで二重ログインする原因になります。
> `node --env-file=.env` は既存の環境変数を上書きしないため、pm2が先にセットした値が優先されてしまいます。

## Docker実行

コンテナ隔離環境で実行できます。3つのコンテナが用意されています：

| コンテナ    | Dockerfile       | 用途                                                                    |
| ----------- | ---------------- | ----------------------------------------------------------------------- |
| `xangi`     | `Dockerfile`     | 軽量版（Claude Code / Codex / Cursor CLI / Grok CLI / Antigravity CLI） |
| `xangi-max` | `Dockerfile.max` | フル版（uv + Python対応、Local LLM向け）                                |
| `xangi-gpu` | `Dockerfile.gpu` | GPU版（CUDA + PyTorch、画像生成・音声処理向け）                         |

### Claude Code バックエンド

```bash
docker compose up xangi -d --build

# Claude Code 認証
docker compose exec xangi claude
```

`docker-compose.yml` には `restart: unless-stopped` が設定されています。`docker compose stop` / `docker compose down` で明示停止しない限り、Docker daemon の起動時に xangi コンテナも自動復帰します。OS 再起動後も自動起動したい場合は、ホスト側で Docker daemon 自体の自動起動を有効にしてください。

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
docker compose exec xangi-gpu claude

# GPU確認
docker compose exec xangi-gpu python3 -c "import torch; print(torch.cuda.is_available())"
```

> **💡 ヒント**: `xangi-gpu` は `xangi-max` の上位互換です。GPU/PyTorchが必要なスキル（音声文字起こし、画像生成等）を使う場合はこちらを選択してください。

### Docker操作

```bash
# 停止
docker compose down

# 再起動（.env変更後など）
docker compose up xangi-max -d --force-recreate

# ログ確認
docker compose logs -f xangi-max
```

`docker compose down` はコンテナを明示停止・削除するため、再度 `docker compose up ... -d` するまで自動復帰しません。一時停止だけにしたい場合は `docker compose stop`、再開は `docker compose start` を使えます。

### ワークスペースのマウント

| 環境     | 変数              | 説明                                               |
| -------- | ----------------- | -------------------------------------------------- |
| ローカル | `WORKSPACE_PATH`  | エージェントが直接使うパス                         |
| Docker   | `XANGI_WORKSPACE` | ホスト側のパス（コンテナ内は `/workspace` に固定） |

Docker実行時は `.env` に `XANGI_WORKSPACE` を設定します：

```bash
XANGI_WORKSPACE=/home/user/my-workspace
```

> **⚠️ `WORKSPACE_PATH` は使わないこと。** ホストのシェル環境変数と衝突する可能性があります。

### セキュリティ

- コンテナはホストネットワークに**直接アクセスできません**
- Ollamaコンテナは同じdocker network内で隔離
- AIエージェントへの環境変数はホワイトリスト方式で制限（`DISCORD_TOKEN` 等はアクセス不可）

## Extension連携

外部extensionはWeb UIの「拡張」から追加・管理します。個別extensionの導入方法、設定、保存データ、UI、更新手順はxangi側へ複製せず、各repositoryの文書を正本とします。

managed extensionの状態は`running`、`healthy`、`ready`を別々に表示します。`running`は子processが生存中、`healthy`はhealth endpointが2xx応答、`ready`はその2xx payloadが`ready: false`を明示していない状態です。旧extensionが`ready`を返さない場合はreadyとして扱います。cold start中に初回healthがtimeout、非2xx、または`ready: false`になっても、検証済みの子processは停止せず、後続の`status` / `doctor`で回復を確認できます。`doctor`はreadyになるまで成功しません。

初回起動時も公式catalogのxangi-searchが表示されます。候補表示だけではrepositoryを取得・実行せず、「追加」を選んだ後に公開repositoryをcommitへ固定して検証し、専用のsetup会話を開始します。任意の公開GitHub repository URLを入力する導線と、開発用local manifestの設定も引き続き利用できます。

CLIや配備作業で先にlinkされたextensionには、利用可能な状態でも「セットアップ」が表示されます。選ぶとextensionを停止・再導入せず、repository内のsetup文書を使う専用会話を開きます。setup文書に承認待ちの設定・workspace変更・任意機能がある場合、LLMはそれをgenericな活用案や次回依頼へ先送りせず、重要な差分・影響・選択肢を具体的に提示します。返答待ちの項目は変更せず、未決の間はsetup完了と報告しません。setup、status、doctorの確認に成功した後は、LLMがextensionのREADMEと現在のworkspaceにあるREADME・AGENTS.md・上位directory構成を参照し、利用者の目的や既存workflowに合う活用案を2〜3件提示します。各案には適合理由、最初に依頼する文または操作、得られる結果を含めます。活用案の提示だけではworkspaceや設定を変更せず、自動化・外部送信・定期実行は別途確認してから実行します。

Extensions画面で「削除」を選ぶと、即座に停止・登録解除せず、専用の`Remove: <displayName>`会話を開きます。LLMはrepositoryのsetup文書とREADMEを読み、現在のworkspaceに残るextension固有のhook、skill、`AGENTS.md`ルール、schedule、その他の設定を調べます。変更前に対象path・ID・削除内容・保持内容・影響を具体的に提示し、利用者はworkspace連携も解除するか、workspace変更を残してextensionだけ停止・登録解除するかを選択します。承認後にだけ最小差分でworkspaceを変更し、現在のxangi親processが所有する固定toolで停止・unlink・未登録・runtime停止をまとめて確認します。任意のPATH上のCLIは使いません。結果には完了状態、hook設定が反映される時点、再起動要否を含みます。download済みsource、extension所有data、index、設定、FACTは通常の削除では保持し、完全消去は別の明示確認に分離します。低levelの`DELETE /api/extensions/:id`は自動化と互換性のため停止・unlinkだけを行います。

公開GitHub repositoryから追加し、manifestに`update.prepare`を宣言したextensionには「更新を確認」が表示されます。選ぶとdefault branchの最新commitを確認し、`Update: <displayName>`という専用会話を開きます。会話は現在版と対象commitを説明してから、xangi親processの固定更新toolを実行します。更新toolは対象commitを再確認し、停止、source差し替え、更新準備、再link、起動、`doctor`を順番に行います。途中で失敗した場合は旧sourceへ戻し、更新前に動作中だったextensionを再起動して`doctor`します。permission、capability、entrypoint、agent backend、UI mapping、更新準備commandが増加・変更された場合は更新前に追加承認が必要です。更新成功後は同じ会話で、LLMが更新後のsetup文書・同梱スキルとworkspace側の同名スキル・関連する`AGENTS.md`ルールを比較します。APIや操作手順などに実質的な差分がある場合だけ、理由、対象path、変更概要を提案します。extension更新への承認はworkspace変更の承認を兼ねないため、スキルや`AGENTS.md`は改めて承認されるまで変更しません。local manifestは更新元repositoryを持たないため対象外で、background自動更新も行いません。

更新準備はshell文字列ではなく、実行programと引数を分離して宣言します。xangiは新sourceの最終配置directoryをworking directoryとして、shellを介さず実行します。

```json
{
  "update": {
    "prepare": {
      "command": "uv",
      "args": ["sync", "--frozen", "--extra", "vector"]
    }
  }
}
```

- xangi-search: [README](https://github.com/karaage0703/xangi-search/blob/main/README.md) / [セットアップ](https://github.com/karaage0703/xangi-search/blob/main/XANGI_SETUP.md)

xangiが受け持つ設定項目だけは[.env.example](../.env.example)を参照してください。

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

| オプション                                               | 推奨値                   | 説明                                                                                            |
| -------------------------------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------- |
| `--max-model-len`                                        | `131072`                 | arxiv全文 (~70k tokens)・site-patrol等の長プロンプトを安定処理。65536では論文全文読解が入らない |
| `--kv-cache-dtype`                                       | `fp8`                    | context wide化でKV-cacheが膨張するため fp8 圧縮で吸収。GB10 80GiB クラスで余裕                  |
| `--gpu-memory-utilization`                               | `0.85`                   | 0.6だとKV-cache不足、0.85で安定                                                                 |
| `--max-num-batched-tokens`                               | `--max-model-len` と同値 | バッチング上限                                                                                  |
| `--enable-auto-tool-choice` `--tool-call-parser <model>` | モデル依存               | tool calling有効化。Gemma 4は `gemma4` パーサー                                                 |
| `--speculative-config` (MTP)                             | モデル依存               | MTP drafter利用時に指定。応答速度向上                                                           |

`LOCAL_LLM_NUM_CTX` は xangi 側のクライアント上限。vLLM の `--max-model-len` と揃えないと、xangi 側で先にプロンプト切り詰めて拡大の恩恵を失う。

#### 確認

```bash
# モデル一覧 (vLLM)
curl -s http://localhost:8001/v1/models | jq '.data[] | {id, max_model_len}'

# Discord 上で
/models local-llm  # サーバー側のモデル一覧を表示 (Ollama + vLLM 両対応)
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

```

| 変数                       | 説明                                                             | デフォルト |
| -------------------------- | ---------------------------------------------------------------- | ---------- |
| `LOCAL_LLM_TOOLS`          | ツール実行（exec/read/write/edit/glob/grep/send_file/web_fetch） | `true`     |
| `LOCAL_LLM_SKILLS`         | スキル一覧注入                                                   | `true`     |
| `LOCAL_LLM_XANGI_COMMANDS` | XANGI_COMMANDS注入                                               | `true`     |

`LOCAL_LLM_MODE` でプリセットも使えます（個別設定が優先）：

- `agent`（デフォルト）— tools / skills / xangi_commands ON
- `chat` — 全部 OFF（純粋雑談ボット）

ワークスペースコンテキスト（AGENTS.md等）はどの設定でも注入されます。

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

| エラー                      | メッセージ                                                                    |
| --------------------------- | ----------------------------------------------------------------------------- |
| ECONNREFUSED / fetch failed | LLMサーバーに接続できませんでした。サーバーが起動しているか確認してください。 |
| timeout / aborted           | LLMからの応答がタイムアウトしました。しばらくしてから再試行してください。     |
| 401 / 403                   | LLMサーバーへの認証に失敗しました。APIキーを確認してください。                |
| 429                         | LLMサーバーのレートリミットに達しました。しばらくしてから再試行してください。 |
| 500 / 502 / 503             | LLMサーバーで内部エラーが発生しました。しばらくしてから再試行してください。   |
| その他                      | LLMエラー: （元のエラーメッセージ）                                           |

### 対応モデル例

| モデル             | サイズ | 特徴                           | 備考             |
| ------------------ | ------ | ------------------------------ | ---------------- |
| `gpt-oss:20b`      | 13GB   | MoE、高品質・ツールコール対応  | 推奨             |
| `gpt-oss:120b`     | 65GB   | MoE（アクティブ12B）、最高品質 | 大容量メモリ必要 |
| `nemotron-3-nano`  | 24GB   | Mambaハイブリッド、高速        |                  |
| `nemotron-3-super` | 86GB   | Mambaハイブリッド、高精度      | 大容量メモリ必要 |
| `qwen3.5:9b`       | 6.6GB  | 軽量・Thinking対応             |                  |
| `Qwen3.5-27B-FP8`  | 29GB   | ツールコール高精度、約6tok/s   | vLLM推奨         |

その他Ollama/vLLMで利用可能なモデルに対応しています。

## ワークスペース hooks

エージェントループのライフサイクルに外部プロセスを挟む機構。1つの設定ファイルで、LLM実行前の動的context追加（`UserPromptSubmit`）と、Local LLMのターン終了時検証（`Stop`）をイベント別に設定できる。

- `UserPromptSubmit`: 全バックエンド共通。ユーザーがpromptを送信した後、LLMが処理する前に発火する
- `Stop`: Local LLMのみ。最終応答を検証し、必要なら1回だけ継続ラウンドを促す

### 設定

hooks はデフォルト有効です。ワークスペースに `hooks/hooks.json` を置くだけで動きます（無ければ何もしない no-op）。skills と同じ「置いたら効く」の慣行です。

`UserPromptSubmit`の設定は各turn前、`Stop`は各gate前に再評価します。hookの追加・削除はxangiを再起動せず次のhook eventから反映され、編集中に一時的に不正なJSONになった場合は直前の正常設定を維持します。

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
    "UserPromptSubmit": [
      {
        "id": "workspace-search",
        "exec": {
          "file": "/absolute/path/to/context-adapter",
          "args": []
        },
        "timeoutMs": 5000,
        "maxOutputChars": 12000
      }
    ],
    "Stop": [{ "command": "python3 hooks/check-promise/hook.py", "timeoutMs": 10000 }]
  }
}
```

### UserPromptSubmitの契約

`exec.file`と固定の`exec.args`をshellを介さず実行し、platform adapterが保持するwrapper展開前のユーザー入力をstdin JSONで渡す。ユーザー入力をcommand文字列やargvへ展開しない。

```json
{
  "hook_event_name": "UserPromptSubmit",
  "session_id": "...",
  "cwd": "/path/to/workspace",
  "prompt": "ユーザーが入力した元テキスト",
  "channel_id": "...",
  "platform": "discord"
}
```

exit 0のstdoutを追加contextとして元promptの末尾へ加える。plain textと、Claude Code / Gemini CLI互換の構造化JSONを受け付ける。

```json
{
  "hookSpecificOutput": {
    "additionalContext": "LLMへ渡す追加情報"
  }
}
```

- hookは独立に並列実行し、設定順でcontextを結合する
- stdoutは未信頼の補助データとして区切り、system promptや元promptを置換しない
- timeout、異常終了、空出力、spawn失敗はそのhookだけskipする（フェイルオープン）
- timeoutは既定5秒・上限10秒、LLM投入量はhookごとに既定10,000文字・設定上限50,000文字、全hook合計20,000文字、stdout取り込みは64KBまで
- `RunOptions.userText`が無い内部実行では発火しない

### Stop hookの契約（Claude Code互換）

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

| 変数                  | デフォルト                     | 説明                                          |
| --------------------- | ------------------------------ | --------------------------------------------- |
| `XANGI_HOOKS_ENABLED` | `true`                         | `false` で hooks 機構を無効化（キルスイッチ） |
| `XANGI_HOOKS_FILE`    | `<workspace>/hooks/hooks.json` | hooks 設定ファイルのパス                      |

### オン/オフの制御

- 全体: `XANGI_HOOKS_ENABLED`（既定 `true`。`false` でキルスイッチ、`hooks.json` を残したまま一時停止できる）
- モード連動: ツール無効モード（`chat`）ではゲート自体を自動スキップする。継続ラウンドで LLM がフィードバックに対処する手段（`schedule_add` 等のツール呼び出し）を持たないため
- チャンネル別: `CHANNEL_OVERRIDES` の `localLlmMode` や `/llmmode` でチャンネルを `chat` に切り替えれば、そのチャンネルだけ hooks が無効になる

### 制限

- 対応イベントは `UserPromptSubmit` と `Stop`（`PreToolUse` 等は将来拡張）
- `UserPromptSubmit`は全バックエンド共通、`Stop`は`local-llm`のみ
- `Stop`は複数hookを登録順に直列実行し、最初にblockを返したhookで確定する
- 既存`Stop.command`は互換性のためshell commandとして動く。ユーザー入力を受ける`UserPromptSubmit`では安全な`exec.file + exec.args[]`のみ許可する

## Tool Trajectory Logger

Local LLM の tool 使用挙動 (drift / loop / tool_search 採用ミス) を構造化 jsonl で記録する観測ロガー。既存 `transcript-logger` (会話の正史) とは独立して動き、session restore とは完全分離されている。

### 出力先

```
logs/tool-trajectory/<appSessionId>.jsonl
```

CLI backendではtool名・状態・所要時間だけを共通形式で保存し、command引数とoutput本文は保存しません。Local LLMは従来どおりrunner固有の詳細trajectoryを保存します。

1 line = 1 event。既存 `logs/sessions/<appSessionId>.jsonl` (transcript) とは別ディレクトリで干渉しない。

### 記録される event 種別

| kind            | 何を記録するか                                                                      |
| --------------- | ----------------------------------------------------------------------------------- |
| `session_start` | backend / model / baseUrl / features / logger 設定 (per appSession 1 回)            |
| `tool_call`     | tool_name / args_sanitized / result_truncated / duration_ms / status / round        |
| `tool_search`   | query / candidates_top5 / activated_tools / activated_skills                        |
| `drift_rescue`  | raw_text_head / parsed_name / safety_verdict / executed                             |
| `loop_detected` | loop_kind (exact / similar / idempotent_cache_hit) / signature / action             |
| `runner_event`  | streaming_hold_buffer_drop / context_prune / session_retry / idempotent_cache_store |

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

| env                                    | default          | 説明                                                                             |
| -------------------------------------- | ---------------- | -------------------------------------------------------------------------------- |
| `XANGI_TOOL_TRAJECTORY_LOG`            | `true`           | `false` で完全 no-op、ファイル作成もしない                                       |
| `TOOL_TRAJECTORY_LOG_HASH_SALT`        | (起動毎ランダム) | Discord/LINE ID hash 用の固定 salt。プロセス跨ぎで ID 相関を追いたい場合のみ指定 |
| `TOOL_TRAJECTORY_LOG_MAX_ARGS_CHARS`   | `8192`           | args 切り詰め上限                                                                |
| `TOOL_TRAJECTORY_LOG_MAX_RESULT_CHARS` | `16384`          | tool 結果切り詰め上限                                                            |
| `TOOL_TRAJECTORY_LOG_RETENTION_DAYS`   | (未設定)         | 削除しない。設定時のみ TTL 日数として動作                                        |
| `TOOL_TRAJECTORY_LOG_SIZE_CAP_MB`      | (未設定)         | 上限なし。設定時のみ全体サイズ上限 (MB) として動作                               |

### fail-safe

ロガー書き込みエラーは `console.warn` で出力されるだけで例外を投げない。jsonl 破損・ディスクフル等が起きても runner は落とさない。session restore は `logs/tool-trajectory/` を一切見ないので、このログ側の障害は会話継続に影響しない。

### 設計意図

- 観察対象: Local LLM の多段防御 (loop / 冪等キャッシュ / streaming hold buffer / pseudo tool_call rescue / context prune の 5+1 機構) がどう発火しているか、tool_search の採用結果、drift_rescue の安全判定内訳
- runner 本体には dataset 都合を一切混ぜず、観測ログの生成だけを行う。蓄積データを別形式に変換したい場合は、この jsonl を入力に後段で別途処理する

## セキュリティ

### 環境変数のホワイトリスト

AIエージェント（CLI spawn / Local LLM exec）に渡す環境変数は `src/safe-env.ts` で管理。ホワイトリストに記載された変数のみ渡され、`DISCORD_TOKEN` 等のシークレットはAIからアクセス不可。

**許可される変数:** `PATH`, `HOME`, `USER`, `SHELL`, `LANG`, `LC_*`, `TERM`, `TMPDIR`, `TZ`, `NODE_ENV`, `NODE_PATH`, `WORKSPACE_PATH`, `AGENT_BACKEND`, `AGENT_MODEL`, `SKIP_PERMISSIONS`, `OPENCODE_CONFIG`, `DATA_DIR`, `XANGI_TOOL_SERVER`, `XANGI_CHANNEL_ID`

`ANTHROPIC_API_KEY`、`CURSOR_API_KEY`、`XAI_API_KEY` は通常のホワイトリストには含めず、それぞれ Claude Code / Cursor CLI / Grok CLI の子プロセスにだけ渡されます。

**渡されない変数（例）:** `DISCORD_TOKEN`, `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `LOCAL_LLM_API_KEY`, `GH_TOKEN`

ホワイトリストを変更する場合は `src/safe-env.ts` の `ALLOWED_ENV_KEYS` を編集。

## 環境変数一覧

この節は主要な設定を用途別にまとめたものです。コメント付きの設定例は[`.env.example`](../.env.example)も参照してください。

### 初回履歴先読み（Discord / Slack / Web 共通）

| 変数                       | 説明                                                       | デフォルト |
| -------------------------- | ---------------------------------------------------------- | ---------- |
| `HISTORY_PREFETCH_ENABLED` | providerセッションの初回ターン前に直近会話履歴を先読みする | `true`     |
| `HISTORY_PREFETCH_COUNT`   | 先読みするメッセージ件数（`1`〜`100`）                     | `10`       |

先読みはproviderセッションIDが無い初回だけ実行します。継続ターンは既存providerセッションが会話文脈を持つため再取得しません。`HISTORY_PREFETCH_ENABLED=false` で無効化すると初回履歴を注入しません。システムプロンプトから履歴取得を指示しないため、履歴が必要な運用では先読みを有効にしてください。

プラットフォーム・返信モードごとの取得範囲:

- Discord 通常モード: 現在の発言より前にある同一チャンネルの直近N件
- Discord スレッドモード:
  - 新規作成したスレッド: 過去0件として注入。現在の発言がスレッド元になる
  - 既存スレッド内の初回: 同一スレッド内の直近N件。親チャンネル側のスレッド元は従来どおり別途注入
- Slack 通常モード: `conversations.history` で同一チャンネルの直近N件
- Slack スレッドモード:
  - 新規スレッド: 過去0件
  - 既存スレッド: `conversations.replies` でroot＋現在より前の返信から直近N件
- Web Chat: 同一ペインのsession JSONLから直近N件。新規ペインは過去0件

先読み履歴は引用データ境界内へ入れ、履歴内の命令文をsystem指示として扱わないよう明示します。さらに古い履歴が必要な場合、エージェントは従来のhistoryコマンドを追加実行できます。

### Discord

| 変数                                 | 説明                                                                                           | デフォルト |
| ------------------------------------ | ---------------------------------------------------------------------------------------------- | ---------- |
| `DISCORD_TOKEN`                      | Discord Bot Token                                                                              | **必須**   |
| `DISCORD_ALLOWED_USER`               | 許可ユーザーID（カンマ区切りで複数可、`*`で全員許可）                                          | **必須**   |
| `DISCORD_REPLY_IN_THREAD`            | 返信をチャンネルではなく発言ごとに作成したスレッドへ投稿                                       | `false`    |
| `DISCORD_STREAMING`                  | ストリーミング出力                                                                             | `true`     |
| `DISCORD_SHOW_THINKING`              | 思考過程を表示                                                                                 | `true`     |
| `DISCORD_SHOW_BUTTONS`               | Stop/New/Historyボタン表示                                                                     | `true`     |
| `DISCORD_REPLY_SUGGESTIONS`          | 本人だけに候補を展開する `返信候補` ボタンを表示                                               | `false`    |
| `DISCORD_REPLY_SUGGESTIONS_COUNT`    | 返信候補数（1〜5）                                                                             | `3`        |
| `DISCORD_TOOL_HISTORY_MODE`          | Turn History表示（`button` / `inline` / `off`、env名は互換維持）                               | `button`   |
| `DISCORD_SHOW_TOOL_BUTTON`           | `button` モード時に History ボタン（途中コメント＋ツール履歴）を表示                           | `true`     |
| `DISCORD_SHOW_LIVE_TOOL_USE`         | 実行中だけ raw ツール履歴を表示                                                                | `true`     |
| `TOOL_HISTORY_MAX_LINES`             | 実行中・`inline`互換モードのツール最大行数（`0` 以下で無制限）                                 | `10`       |
| `DISCORD_SHOW_TOOL_USE`              | 互換設定。`false` は `off`、`true` は `inline` として扱う                                      | -          |
| `DISCORD_COMPLETION_NOTIFY`          | 一定時間以上かかった Discord ターン完了時に別メッセージで通知（`off` / `message` / `mention`） | `message`  |
| `DISCORD_COMPLETION_NOTIFY_AFTER_MS` | 完了通知を出す最短経過時間（ms）                                                               | `10000`    |
| `ALLOW_AUTOREPLY_COMMAND`            | `/autoreply` コマンドの有効化                                                                  | `true`     |
| `XANGI_SELF_LIFECYCLE`               | xangi自身による再起動の許可（`off` / `restart-only`）                                          | `off`      |
| `BACKEND_SWITCHING_ENABLED`           | backend・modelの表示／切替機能                                                                  | `true`     |
| `RUNTIME_SETTINGS_ENABLED`            | runtime settingsの表示／変更機能                                                                | `true`     |
| `WORKSPACE_SWITCHING_ENABLED`          | workspaceの表示／切替／Web操作機能                                                              | `true`     |
| `RESPOND_TO_BOTS`                    | 反応対象 bot ID のホワイトリスト（`*` で全 bot）                                               | -          |
| `RESPOND_TO_BOTS_ENABLED`            | bot メッセージ応答機能の ON/OFF（`/respondtobots` で動的切替）                                 | `false`    |
| `RESPOND_TO_BOTS_MAX_CONSECUTIVE`    | 同じ bot との連続応答の上限（0 で無制限）                                                      | `3`        |
| `ALLOW_RESPOND_TO_BOTS_COMMAND`      | `/respondtobots` コマンドの有効化                                                              | `true`     |
| `ALLOW_THREAD_MODE_COMMAND`          | `/threadmode` コマンドの有効化                                                                 | `true`     |
| `ALLOW_LLM_MODE_COMMAND`             | `/llmmode` コマンド（Local LLM 動作モード切替）の有効化                                        | `true`     |
| `INJECT_CHANNEL_TOPIC`               | チャンネルトピックをプロンプトに注入                                                           | `true`     |
| `INJECT_TIMESTAMP`                   | 現在時刻をプロンプトに注入                                                                     | `true`     |

全プラットフォーム共通の完了表示設定:

| 変数                         | 説明                                                   | デフォルト |
| ---------------------------- | ------------------------------------------------------ | ---------- |
| `COMPLETION_SHOW_ELAPSED`    | 完了表示に経過時間を含める                             | `true`     |
| `COMPLETION_NOTIFY_AFTER_MS` | 通常のLINE / Telegramで完了表示を追加する最短時間（ms） | `10000`    |

### AIエージェント

| 変数                            | 説明                                                                                                                    | デフォルト                   |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `AGENT_BACKEND`                 | 組み込み、またはリンク済み拡張が宣言したバックエンドID                                                                  | `claude-code`                |
| `AGENT_MODEL`                   | 使用するモデル                                                                                                          | -                            |
| `WORKSPACE_PATH`                | 作業ディレクトリ（ローカル実行時）                                                                                      | 起動時のカレントディレクトリ |
| `XANGI_WORKSPACE`               | ワークスペースのホスト側パス（Docker実行時）                                                                            | `./workspace`                |
| `SKIP_PERMISSIONS`              | デフォルトで許可スキップ（非対話実行で待ち状態を防ぐため既定有効。明示的に `false` で無効化）                           | `true`                       |
| `TIMEOUT_MS`                    | リクエストの初期タイムアウト（ミリ秒）                                                                                  | `1800000`                    |
| `XANGI_TOOL_SERVER_PORT`        | 内部ツールサーバーの固定ポート。未設定時は前回ポートを再利用（使用中なら自動割り当て）                                  | 前回ポート再利用             |
| `XANGI_CONFIG_STRICT`           | 環境変数の不正値（数値でない・範囲外・enum typo 等）を起動エラーに格上げ。デフォルトは警告 + デフォルト値フォールバック | `false`                      |
| `TIMEOUT_MAX_MS`                | タイムアウト延長の絶対上限（ミリ秒）                                                                                    | `36000000`                   |
| `TIMEOUT_EXTEND_ENABLED`        | 延長ボタン (`[延長]`) の有効/無効                                                                                       | `true`                       |
| `WEB_CHAT_UPLOAD_ACCEPT`        | Web Chat 受信ファイル許可リスト（カンマ区切り、HTML `<input accept>` 互換）                                             | 全許可                       |
| `WEB_CHAT_UPLOAD_MAX_MB`        | Web Chatの1アップロード要求の上限（MiB単位、multipartヘッダを含む）                                                     | `64`                         |
| `WEB_CHAT_DOWNLOAD_ACCEPT`      | Web Chat ダウンロード許可拡張子リスト（`.html,.txt` 等）                                                                | 全許可                       |
| `ALLOWED_BACKENDS`              | `/backend` で切り替え許可するバックエンド（カンマ区切り）。未設定なら全バックエンド許可                                 | 全バックエンド               |
| `CHANNEL_OVERRIDES`             | チャンネル別バックエンド設定（JSON）。Discord スレッドでは親チャンネルIDの設定を継承                                    | -                            |
| `EXTENSION_BACKEND_TIMEOUT_MS`  | 拡張バックエンドへのHTTP要求タイムアウト（ms）                                                                          | `5000`                       |
| `XANGI_PUBLIC_WEB_URL`          | 拡張へ渡す、外部から到達可能なWeb Chatのbase URL                                                                        | 未設定                       |
| `XANGI_EXTENSIONS_FILE`         | extension registryの絶対path（通常は自動決定）                                                                          | `${DATA_DIR}/extensions.json` |
| `XANGI_EXTENSION_DEV_MANIFESTS` | `/extensions`に表示する信頼済みlocal manifestのJSON配列またはOS path区切りリスト                                        | 未設定                       |
| `ANTHROPIC_API_KEY`             | Claude Code backend に渡す Anthropic API key（Claude Code利用時のみ）                                                   | -                            |
| `CLAUDE_CODE_BARE`              | Claude Code に `--bare` を渡し、OAuth/keychain ではなく API key 認証に固定                                              | `false`                      |
| `COPILOT_PERMISSION_MODE`       | `SKIP_PERMISSIONS=false`時のCopilot tool範囲（`read-only` / `workspace-write`）                                         | `read-only`                  |
| `COPILOT_MAX_AI_CREDITS`        | Copilot CLIへ渡す1 sessionのAI credit上限（任意、最小30）                                                               | -                            |
| `CLAUDE_CODE_MAX_BUDGET_USD`    | Claude Code に `--max-budget-usd` を渡し、API呼び出しの上限額を設定                                                     | -                            |
| `OPENCODE_CONFIG`               | OpenCodeへ渡すcustom provider設定ファイルの絶対path                                                                    | -                            |
| `CURSOR_API_KEY`                | Cursor CLI backend に渡す API key（Cursor CLI利用時のみ）                                                               | -                            |
| `CURSOR_FORCE`                  | Cursor CLI に `--force` を渡す（明示的に `false` で無効化）                                                             | `true`                       |
| `CURSOR_TRUST_WORKSPACE`        | Cursor CLI に `--trust` を渡す（明示的に `false` で無効化）                                                             | `true`                       |
| `XAI_API_KEY`                   | Grok CLI backend に渡す API key（Grok CLI利用時のみ。`grok login` 済みなら不要）                                        | -                            |
| `PERSISTENT_MODE`               | 常駐プロセスモード                                                                                                      | `true`                       |
| `MAX_PROCESSES`                 | 同時実行プロセス数の上限                                                                                                | `10`                         |
| `IDLE_TIMEOUT_MS`               | アイドルプロセスの自動終了時間                                                                                          | `1800000`                    |
| `DATA_DIR`                      | データ保存ディレクトリ（スケジュール・セッション等）                                                                    | `WORKSPACE_PATH/.xangi`      |
| `GH_TOKEN`                      | GitHub CLIトークン                                                                                                      | -                            |

### ワークスペース hooks

| 変数                  | 説明                                                                                                                 | デフォルト                     |
| --------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `XANGI_HOOKS_ENABLED` | ワークスペース hooks（[ワークスペース hooks](#ワークスペース-hooks) 参照）。`false` でキルスイッチ                 | `true`                         |
| `XANGI_HOOKS_FILE`    | hooks 設定ファイルのパス                                                                                             | `<workspace>/hooks/hooks.json` |

### WebチャットUI

応答に添付された自己完結HTMLは、外部通信とform送信を止めたsandbox内でインラインプレビューし、元ファイルは別に保存できる。

添付の転送中はPC・スマートフォンともファイル名、複数選択時の順番、進捗率を入力欄の直上に表示する。音声・動画はbyte Range配信に対応し、スマートフォンでもmetadata取得・seek・再生を行える。

| 変数               | 説明                                                                                                                                                                                     | デフォルト |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `WEB_CHAT_ENABLED` | WebチャットUIの有効化。`true` で `http://localhost:<WEB_CHAT_PORT>` を公開                                                                                                               | `false`    |
| `WEB_CHAT_PORT`    | WebチャットUIのポート                                                                                                                                                                    | `18888`    |
| `WEB_CHAT_HOST`    | bindするホスト。`127.0.0.1`は同じ端末だけから到達可能で、別端末から使うにはSSH port forwardingやTailscale Serveが必要。`0.0.0.0`は全インターフェースへ公開する。Web UI自体には認証がない | `0.0.0.0`  |

Web ChatはReact + Viteで、新規会話、セッション検索と段階読込、最大8ペイン、ペイン復元、履歴の段階読込、Markdown、編集・削除・コピー、添付、Stop・タイムアウト延長、返信候補、自走、slash commandとskill GUIを提供する。共通メニューは「チャット / ファイル / 予定 / 監視」で、`/schedules`ではWeb / Discord / Slack / Telegram予定の作成・編集・停止・削除ができる。Web予定は実行ごとに新しい会話を作り、任意のProjectへ所属させられる。セッション名をクリックすると現在のペインで開き、`＋ ペイン`で追加した空ペインにも同じ操作でセッションを表示できる。Web / Discord / Slack由来の各メッセージには`/chat/<appSessionId>#message-<messageId>`形式のリンク操作がある。リンクを開くと対象メッセージへ移動して強調表示し、同じxangiに接続したDiscordまたはSlackへ貼ると、そのメッセージ1件を命令ではない引用データとして参照する。自走ボタンは`INTER_INSTANCE_CHAT_ENABLED=true`のWebセッションだけに表示する。Discordセッションでは`このDiscordで続ける`を選ぶと、Web入力が元のDiscordチャンネル／スレッドへ表示され、同じDiscordセッションの文脈で応答する。添付とWeb専用コマンドは利用できない。`Web会話として分岐`は元の履歴を引き継ぐ独立したWebセッションを作る。Slackセッションは読み取り専用で、Webセッションへの分岐だけを利用できる。

Web ProjectはDiscordのチャンネルに相当する論理的な会話グループで、Projectごとに追加プロンプト、ワークスペース、既定のbackend / model / effortを設定できる。新規会話は作成時のProjectワークスペースを固定し、後からProject設定を変えても既存会話の作業ディレクトリは変わらない。既存のWeb会話を別Projectへ移しても、ワークスペースは安全のため元のスナップショットを維持する。Project設定は次のturnから使われ、会話内の`/backend set`はProject設定より優先する。Project作成時にディレクトリ、Gitリポジトリ、`AGENTS.md`は生成しない。Project定義は`DATA_DIR/web-projects.json`、各会話との関連とワークスペースのスナップショットはセッション情報へ保存する。

同じサーバの `http://localhost:<WEB_CHAT_PORT>/workspace` は、設定済み `WORKSPACE_PATH` のbrowser/editor。ディレクトリを辿り、1 MiB以内のMarkdown・テキスト・JSON/JSONL/YAML/TOML、C/C++・Rust・Go、Astro・Vue・Svelte・Sass系を含む主要コード形式、ログ・diff・patch・TSV・CFGを開いて編集できる。Markdownは編集とプレビューを切り替え、`Ctrl/Cmd+S`でも保存できる。ファイルは名前・更新日時の昇順／降順に並び替えられ、Markdown frontmatterの`tags`で絞り込める。デスクトップではファイル一覧の幅をドラッグまたは矢印キーで変えられ、スマートフォンではファイル一覧とエディタを画面単位で切り替える。Web Chatの回答にあるテキストファイル参照はこの画面の`/workspace?path=...`へ開き、`:12`または`#L12`の行指定があれば編集表示で該当行を選択する。ヘッダーの`rawで開く`から従来の生ファイル配信も利用できる。コードブロックとインラインコード内の`MEDIA:`は説明用テキストとして扱い、メディアへ変換しない。

Chat / Files / Schedules / Monitor / Extensionsは共通ナビゲーションを使う。デスクトップでは左レール、モバイルでは下部ナビゲーションになり、Monitor / Extensions / `表示`は`その他`から開く。端末設定・ライト・ダークの選択はブラウザに保存される。

- hidden path、`.git`、`.xangi`、`.workspace_rag`、依存物、build/coverage成果物、symlinkは一覧・読込・保存のすべてで拒否する
- ファイル作成・削除・rename・Git操作は行わず、既存の表示可能ファイルだけを保存する
- 読込時のSHA-256を保存時に照合し、外部更新があればHTTP 409で停止する。保存は同じdirectory内の一時fileからatomic renameする
- Web UI自体には認証がない。`WEB_CHAT_HOST=0.0.0.0`でLAN公開すると、Workspace画面も同じ範囲から読み書き可能になる

Workspace API:

- `GET /api/workspace/entries?path=<relative-directory>` — 直下の安全なdirectory/file一覧
- `GET /api/workspace/file?path=<relative-file>` — `{path, content, version, size, mtimeMs}`
- `PUT /api/workspace/file` — `{path, content, version}`。競合時は409

同じサーバの `http://localhost:<WEB_CHAT_PORT>/monitor` は読み取り専用のセッション監視ページ。Sessionを「実行中」「入力待ち（継続可能）」「完了」の3列に自動分類し、All / Chat / Webで絞り込める。エラーと中断は入力待ちカードの状態ラベルと色付きドットで区別する。正式な構造化取得口から利用枠を取得できたproviderを、現在のSession有無にかかわらず「AI利用量」に表示し、Codexは共通枠だけを表示する。対象はCodex、GitHub Copilot、Antigravity、Claude Codeで、取得できない値は推定しない。アカウント枠は60秒ごと、Sessionのcontext使用量はturn完了時に更新する。providerカードは折り畳め、不要なproviderは非表示にしてブラウザへ保存できる。カードを選ぶとまず詳細を表示し、バックエンド・モデル・effortと最後に確定したcontext使用量を確認できる。状態、Discord / Slackの会話先、完了ターン数、更新時刻、イベント履歴は常時表示し、チャンネル・スレッド・セッション等の内部IDは折りたたみに格納する。詳細の「会話を開く」から`/chat/<appSessionId>`へ移動する。完了Sessionは直近24時間を表示し、履歴から再開または分岐できる。初回取得後は`GET /api/sessions/stream`のSSEでturn開始・進捗・完了・context更新を受け取るため、セッション一覧を定期ポーリングしない。Codexはapp-server、GitHub Copilotは公式SDK、Antigravityは公式statusline JSONを使用する。Claude CodeのcontextはCLIのresult event、アカウント枠はCLI標準のstream-json制御要求（`get_usage`）を使用する。TUI解析・statusline設定は不要で、モデル呼び出し（枠の消費）も発生しない。この応答形式はCLI側でExperimental扱いのため、形式変更時はClaude Code枠が表示されなくなることがある。APIキー・Bedrock・Vertex経由ではアカウント枠が存在しないため表示されない。

同じサーバの `http://localhost:<WEB_CHAT_PORT>/schedules` は予定管理ページ。`GET /api/schedules`で全プラットフォームの予定とスケジューラ状態を取得し、`POST /api/schedules`でWeb / Discord / Slack / Telegram予定を作成する。Web予定は`projectId`を任意指定でき、実行時に新しいWeb会話を作る。`PATCH /api/schedules/:id`は予定内容または有効状態を変更し、`DELETE /api/schedules/:id`は予定を削除する。

補足: 「AI利用量」の各アカウント枠は、バーの塗りで実使用率を示す。Codexのように期間長を公式データから取得できる枠と、Claude Codeのように枠の定義から期間長が確定する枠では、破線マーカーと数値で期間内の経過時間から求めた「目安」も示す。Claude Codeで表示する対象は5時間枠・週次枠・モデル別週次枠のみで、追加クレジット等の金額情報は表示しない。Antigravityは公式statuslineが期間長を返さず、未使用枠のリセット時刻が動くことがあるため、目安を推定表示しない。

AntigravityをMonitorへ接続するには、Antigravity TUIで `/statusline /path/to/xangi/bin/xangi-antigravity-statusline` を一度実行する。このhelperは公式statusline JSONを`DATA_DIR/antigravity-status.json`へ原子的に保存し、quotaを含まない更新では最後に取得できた公式quotaを保持する。非公開APIや画面解析は行わない。

### スケジューラ

| 変数                | 説明                       | デフォルト |
| ------------------- | -------------------------- | ---------- |
| `SCHEDULER_ENABLED` | スケジューラ有効化         | `true`     |
| `STARTUP_ENABLED`   | スタートアップタスク有効化 | `true`     |

`SCHEDULER_ENABLED=false` は実行・一覧・追加・変更・削除の入口を無効にしますが、`schedules.json` は削除しません。再び `true` にして再起動すると、保存済みの有効な予定を再開します。

### 外部イベントストリーム（pull 型 SSE）

応答ライフサイクル（`turn.started` / `message.delta` / `turn.complete` / `turn.aborted` / `agent.error`）を SSE で配信する。consumer は web-chat サーバの `GET /api/events/stream` に接続して購読する。詳細は [外部イベントストリーム](events.md) を参照。

| 変数                   | 説明                                                                                      | デフォルト |
| ---------------------- | ----------------------------------------------------------------------------------------- | ---------- |
| `XANGI_EVENTS_ENABLED` | `false` で SSE 配信を完全無効化（接続要求は 503）                                         | `true`     |
| `XANGI_INSTANCE_ID`    | 送信元インスタンスの識別子。未指定なら `xangi-<hostname>-<sha1(DATA_DIR)[:6]>` で自動採番 | `auto`     |

### Pet / Device からの入力 (`POST /api/*/inbox`)

`xangi-pet` や Even G2 などの consumer 側 UI からテキストを 1 行投げ込むための書き込み endpoint。`/api/pet/inbox` / `/api/device/inbox` / `/api/terminal/inbox` を提供する。受理されたら 202 が即返り、応答は既存の events SSE 経由で broadcast される。Web Chatの回答候補が有効なら、生成候補は `GET /api/sessions/:id` の `replySuggestions` から取得できる。詳細とリクエスト形式は [外部イベントストリーム#Pet / Device からの入力経路](events.md#pet--device-からの入力経路-post-apiinbox) を参照。

| 変数                         | 説明                                                                                                                                                 | デフォルト |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `XANGI_PET_INBOX_ENABLED`    | `false` で書き込み経路を完全無効化（503 を返す）                                                                                                     | `true`     |
| `XANGI_PET_INBOX_TOKEN`      | 設定時は `Authorization: Bearer <token>` 必須。未設定時は loopback + LAN (RFC1918) + Tailscale (CGNAT 100.64/10) からのみ許可 (グローバル IP は 403) | (未設定)   |
| `XANGI_DEVICE_INBOX_ENABLED` | `false` で device/terminal 書き込み経路を無効化（503 を返す）                                                                                        | `true`     |
| `XANGI_DEVICE_INBOX_TOKEN`   | device/terminal 用 token。未設定時は `XANGI_PET_INBOX_TOKEN` に fallback                                                                             | (未設定)   |

### Even Terminal 互換 API

Even G2 の公式ターミナルモード（`@evenrealities/even-terminal` 互換）から xangi Web Chat サーバを直接 host として使うための API。`/api/prompt` / `/api/events` / `/api/messages` などを提供する。詳細は [外部イベントストリーム#Even Terminal 互換 API](events.md#even-terminal-互換-api) を参照。

Even 側の provider 選択は `claude` / `codex` ラベルとして受け取るだけで、実際の backend は xangi の `AGENT_BACKEND` が決める。Even Terminal 経由だけ別 backend / model / Local LLM mode にしたい場合は `XANGI_EVEN_TERMINAL_BACKEND` / `XANGI_EVEN_TERMINAL_MODEL` / `XANGI_EVEN_TERMINAL_LOCAL_LLM_MODE` を使う。`CHANNEL_OVERRIDES` の `web-chat:<appSessionId>` 個別設定がある場合は、個別設定が専用 default より優先される。

| 変数                                 | 説明                                                                                                           | デフォルト                      |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `XANGI_EVEN_TERMINAL_TOKEN`          | Even Terminal 互換 API 専用 token。未設定時は `XANGI_DEVICE_INBOX_TOKEN` → `XANGI_PET_INBOX_TOKEN` に fallback | (未設定)                        |
| `XANGI_EVEN_TERMINAL_BACKEND`        | Even Terminal 経由だけのbackend default（組み込み、またはリンク済み拡張のbackend ID）                          | `AGENT_BACKEND`                 |
| `XANGI_EVEN_TERMINAL_MODEL`          | Even Terminal 経由だけの model default                                                                         | `AGENT_MODEL` / backend側の既定 |
| `XANGI_EVEN_TERMINAL_LOCAL_LLM_MODE` | Even Terminal 経由だけの Local LLM mode default (`agent` / `chat`)                                             | `LOCAL_LLM_MODE` / `agent`      |

### Terminal / Device セッション (`xangi tool terminal_session`)

`xangi tool terminal_session` は Web Chat セッションを作成し、外部 device / terminal 側が使う inbox URL と thread filter 付き events URL を表示する。Even G2 向けには alias として `xangi tool g2_session` も使える。

```bash
xangi tool terminal_session --base-url http://127.0.0.1:18888 --title "Terminal Session"
xangi tool g2_session --base-url http://127.0.0.1:18888 --title "Even G2 Terminal"
```

### GitHub App認証（オプション）

GitHub App設定があれば、`gh` CLI実行時にインストールトークンを自動生成。PATや `gh auth login` が不要に。

| 変数                          | 説明               |
| ----------------------------- | ------------------ |
| `GITHUB_APP_ID`               | GitHub App ID      |
| `GITHUB_APP_INSTALLATION_ID`  | インストールID     |
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

### OpenCode（`AGENT_BACKEND=opencode` 時）

OpenCode backend は `opencode run --format json --agent build` を使用し、JSONイベントをxangiのストリーミング応答とtool履歴へ変換します。`SKIP_PERMISSIONS=true`（既定）では非対話実行用の`--auto`を渡します。信頼できないworkspaceでは`SKIP_PERMISSIONS=false`を指定してください。

`AGENT_MODEL` はOpenCodeの`provider/model`形式で`--model`へ渡します。チャンネルのeffortは`--variant low|medium|high|max`へ、provider sessionは`--session`へ渡すため、xangiの同一セッションで会話をresumeできます。custom providerでは、使用するeffort名と同じmodel variantをOpenCode設定に定義してください。OpenCodeが終了コード0と同時にJSONの`error`イベントを返す場合も、xangiは成功扱いにせずエラーを通知します。

workspaceの`AGENTS.md`と`.agents/skills`の読み込みはOpenCode自身へ委譲します。custom providerやOpenAI互換endpointを使う場合は、設定ファイルの絶対pathを`OPENCODE_CONFIG`に指定できます。`xangi setup`でOpenAI互換ローカルLLMを選ぶと、この設定ファイルと`low` / `medium` / `high` / `max` variantを自動生成します。

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

非対話実行は `agy --print-timeout <timeout> --output-format json -p ...` です。構造化出力はAgy CLI 1.1.8で正式化され、xangiは1.1.12の実出力でも検証しています。最終JSONの `status`、`response`、`conversation_id` を利用し、`conversation_id` を provider session として返します。`ANTIGRAVITY_PRINT_TIMEOUT` で Agy 自身の print mode タイムアウトを設定できます。未指定時は xangi の実行タイムアウトと同じ値（通常 `1800s`）を使用します。`AGENT_MODEL` が設定されていれば `--model`、provider session があれば `--conversation` を渡します。作業ディレクトリが設定されている場合は、子プロセスの cwd と同じ場所を `--add-dir .` で明示します。

ストリーミングでは `--output-format stream-json` を使用します。`step_update.text_delta` を逐次表示し、`init` / `result` の `conversation_id` を provider session として保持します。tool の `ACTIVE` は進捗として通知します。tool 単体の `ERROR` は agent が回復できるため即座に会話全体を失敗させず、最終 `result` を待ちます。`tool_info.output` と `subagent_info` は互換性のため受理しますが、大容量または機密情報を含み得るtool出力をチャットへそのまま転送せず、子agentのconversation IDで親sessionを上書きしません。

Agy CLI 1.1.2から1.1.7までの先行実装も従来どおり互換対象です。1.1.2が`stream-json`指定を無視してプレーンテキストを返した場合、その出力を最終応答として採用し、プロンプトを再実行しません。`--output-format`を明確に未対応と報告するさらに古いAgyは、旧プレーン出力モードへ一度だけフォールバックします。判定結果はrunner内でキャッシュします。timeout、認証、quota、無効なmodelなど通常の実行エラーでは再実行しません。

Agy CLI 1.1.9以降はprint modeでもslash command・skillを展開します。xangiは各platformのcommand処理を正本にするため、`agy --help`を確認し、対応版には`--disable-slash-commands`を渡します。対応・未対応を確認できた結果はrunner内で保持します。help確認は5秒で打ち切り、timeout・起動失敗・異常終了時はフラグなしで今回の実行を続け、次回リクエストで再確認します。probe中にユーザーがStopした場合は今回の実行自体を中止し、実プロンプトを開始しません。実プロンプトをcapability確認のために再送することはありません。Agy側へ展開を委ねる場合は`ANTIGRAVITY_DISABLE_SLASH_COMMANDS=false`を設定します。

headless実行はMCP初期化完了後に`init`イベントを返します。`Streaming`ログの後、`init`前で長く待つ場合はAgyログとMCP serverの起動状態を確認してください。

Agy が成功終了しても stdout が空の場合、stderr に出力された timeout・quota・認証などの詳細をエラーとして表示します。

`SKIP_PERMISSIONS=true` 既定時は、非対話運用で permission 待ちにならないよう `--dangerously-skip-permissions` を渡します。個人用・信頼済み workspace 前提の設定です。

### GitHub Copilot CLI（`AGENT_BACKEND=github-copilot` 時）

GitHub公式の`copilot`コマンドを別途インストールし、対話画面の`/login`または`COPILOT_GITHUB_TOKEN`で認証します。xangiはCLI本体を同梱せず、`--output-format json --stream on`のJSONLを処理し、`result.sessionId`で会話を再開します。

`SKIP_PERMISSIONS=true`（既定）では、他のCLI backendと同じ非対話agent運用にするため`--yolo`を渡し、全tool・path・URLを許可します。個人用・信頼済みworkspaceだけで使用してください。`SKIP_PERMISSIONS=false`では`COPILOT_PERMISSION_MODE`が有効になり、既定の`read-only`は`view` / `glob` / `grep`だけ、`workspace-write`はさらに`edit` / `create`だけをモデルへ公開します。どちらの制限モードもshell、URL、MCP toolは公開せず、system temp directoryも禁止します。`COPILOT_MAX_AI_CREDITS`を設定するとsession単位のsoft limitをCLIへ渡します（最小30、未設定時は渡しません）。

### Local LLM（`AGENT_BACKEND=local-llm` 時）

| 変数                                    | 説明                                                                         | デフォルト                                                       |
| --------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `LOCAL_LLM_BASE_URL`                    | LLMサーバーURL                                                               | `http://localhost:11434`                                         |
| `LOCAL_LLM_MODE`                        | プリセット（`agent` / `chat`）                                               | `agent`                                                          |
| `LOCAL_LLM_TOOLS`                       | ツール実行                                                                   | `true`                                                           |
| `LOCAL_LLM_SKILLS`                      | スキル一覧注入                                                               | `true`                                                           |
| `LOCAL_LLM_XANGI_COMMANDS`              | XANGI_COMMANDS注入                                                           | `true`                                                           |
| `LOCAL_LLM_MODEL`                       | 使用するモデル名                                                             | -                                                                |
| `LOCAL_LLM_API_KEY`                     | APIキー（vLLM等で必要な場合）                                                | -                                                                |
| `LOCAL_LLM_THINKING`                    | Thinkingモデルの推論を有効にするか                                           | `true`                                                           |
| `LOCAL_LLM_REASONING_EFFORT`            | OpenAI互換APIへ送る既定`reasoning_effort`（チャンネル設定が優先）             | 未指定（provider既定）                                           |
| `LOCAL_LLM_MAX_TOKENS`                  | 最大トークン数（API 呼び出しの max_tokens）                                  | `8192`                                                           |
| `LOCAL_LLM_AGENT_STEPS`                 | 1ターンのagentic iteration上限。未指定/`0`ならモデル終了またはtimeoutまで継続 | 無制限                                                           |
| `LOCAL_LLM_NUM_CTX`                     | コンテキストウィンドウサイズ（Ollama用、context budget 逆算の基準）          | モデルのデフォルト                                               |
| `LOCAL_LLM_TEMPERATURE`                 | サンプリング温度（0 で決定的、agent モードの format drift を抑える時に有効） | モデルのデフォルト                                               |
| `LOCAL_LLM_CONTEXT_MAX_CHARS`           | 履歴の最大文字数（明示優先、未指定なら `LOCAL_LLM_NUM_CTX` から逆算）        | 自動計算                                                         |
| `LOCAL_LLM_SYSTEM_PROMPT_BUDGET_TOKENS` | system prompt が占める想定トークン数（逆算用）                               | `8000`                                                           |
| `LOCAL_LLM_OUTPUT_BUDGET_TOKENS`        | 1 リクエストの最大出力トークン（逆算用）                                     | `4096`                                                           |
| `LOCAL_LLM_SAFETY_MARGIN_TOKENS`        | 安全マージン（逆算用）                                                       | `1000`                                                           |
| `LOCAL_LLM_CONTEXT_KEEP_LAST`           | 直近 N 件のメッセージは削除しない                                            | `10`                                                             |
| `LOCAL_LLM_TOOL_RESULT_MAX_CHARS`       | tool 結果の最大文字数（コンテキスト内）                                      | `4000`                                                           |
| `LOCAL_LLM_MAX_SESSION_MESSAGES`        | セッションの最大メッセージ数                                                 | `50`                                                             |
| `LOCAL_LLM_TOOL_SEARCH_ENABLED`         | tool 遅延ロード機能（`tool_search`）を有効化                                 | `true`                                                           |
| `LOCAL_LLM_TOOL_SEARCH_LIMIT`           | `tool_search` が 1 回で返す最大ツール数                                      | `8`                                                              |
| `LOCAL_LLM_ALWAYS_LOADED_TOOLS`         | 常駐 tool 名（カンマ区切り）。ここに無い tool は deferred 扱い               | `read,write,edit,exec,glob,grep,send_file,web_fetch,tool_search` |
| `EXEC_TIMEOUT_MS`                       | execツールのタイムアウト（ミリ秒）                                           | `120000`                                                         |
| `WEB_FETCH_TIMEOUT_MS`                  | web_fetchツールのタイムアウト（ミリ秒）                                      | `15000`                                                          |
| `LOCAL_LLM_READ_MAX_BYTES`              | readツールのファイルサイズ上限（バイト）                                     | `524288`（512KB）                                                |
| `LOCAL_LLM_READ_JSON_MAX_BYTES`         | readツールでJSONを読むときの上限（バイト）                                   | `5120`（5KB）                                                    |
| `LOCAL_LLM_WRITE_MAX_BYTES`             | writeツールのコンテンツサイズ上限（バイト）                                  | `524288`（512KB）                                                |

### Slack

| 変数 | 説明 |
| ---------------------------------- | ---------------------------------------------------------------------------------- | ------- |
| `SLACK_BOT_TOKEN` | Slack Bot Token（xoxb-...） |
| `SLACK_APP_TOKEN` | Slack App Token（xapp-...） |
| `SLACK_ALLOWED_USER` | 許可ユーザーID |
| `SLACK_AUTO_REPLY_CHANNELS` | メンションなしで応答するチャンネルID |
| `SLACK_REPLY_IN_THREAD` | スレッド返信するか（デフォルト: `true`） |
| `SLACK_REPLY_IN_CHANNELS` | スレッド返信が有効な場合でも、チャンネル直下に返信するチャンネルID（カンマ区切り） |
| `SLACK_COMPLETION_NOTIFY_AFTER_MS` | スレッド返信しないSlackターンで完了通知を出す最短経過時間（ms） | `10000` |
| `SLACK_REPLY_SUGGESTIONS` | 本人だけに候補を展開する `返信候補` ボタンを表示 | `false` |
| `SLACK_REPLY_SUGGESTIONS_COUNT` | 返信候補数（1〜5） | `3` |

## 複数インスタンスの運用

Gitなしmanaged版は、現在1つのOS userにつき1 instanceです。同じuserでinstallerを再実行すると既存instanceの更新・再設定になり、2個目は作りません。別のPCまたは別OS userならhome directory、config、state、workspace、serviceが分離されるため、それぞれ通常のinstall commandを実行できます。同一OS user内のnamed managed instanceは未対応です。

以下はGitのsource checkout、PM2、Dockerを使う開発者向けの複数instance運用です。Gitなしmanaged版へそのまま適用しないでください。

開発用と本番用など、**1台のマシンで xangi を複数同時に動かす**場合は、必ず `DATA_DIR` をインスタンスごとに分けること。デフォルトは `${WORKSPACE_PATH}/.xangi/` で、ここを共有すると `sessions.json` を取り合って書き潰し合い、新しく作ったセッションがもう一方の古い in-memory state で消去される事故が起きる（特に長時間プロセスがメモリ上の古いリストを保持しているとき）。

PM2 で複数起動する場合は、`XANGI_PROCESS_NAME` もインスタンスごとに一意にします。`DATA_DIR` は xangi 内部の状態領域、`XANGI_INSTANCE_ID` はイベントや inter-instance-chat 用の論理 ID、`XANGI_PROCESS_NAME` は PM2 / service 操作用の外側の名前です。通常は `XANGI_PROCESS_NAME` と `XANGI_INSTANCE_ID` を同じ値にしてかまいません。

### 推奨構成

```bash
# 本番
WORKSPACE_PATH=/home/user/ai-assistant-workspace
XANGI_INSTANCE_ID=xangi-prod
XANGI_PROCESS_NAME=xangi-prod
# DATA_DIR は省略 → /home/user/ai-assistant-workspace/.xangi/

# 開発（xangi-dev）
WORKSPACE_PATH=/home/user/ai-assistant-workspace
XANGI_INSTANCE_ID=xangi-dev
XANGI_PROCESS_NAME=xangi-dev
DATA_DIR=/home/user/xangi-dev/.xangi   # ← 明示的に分離
```

`WORKSPACE_PATH` 自体を共有しても OK（スキル・メモリは同じものを使いたい）。**`DATA_DIR` と `XANGI_PROCESS_NAME` を分離**すれば、状態ファイルと PM2 操作対象の衝突を避けられる。

### 起動時の排他制御

`DATA_DIR` は未作成なら起動時に作成され、その後 `proper-lockfile` で排他ロックされる。別の xangi プロセスが同じ `DATA_DIR` をすでに握っている場合や、権限不足などでロックを取得できない場合、sessions/settingsを保護するためxangiは起動を中止する。

```
Error: Another xangi process is using the same dataDir: /path/to/.xangi. Stop the other process or set a separate DATA_DIR.
```

このメッセージが出たら片方を停止するか、`DATA_DIR` を分離して再起動する。ロックを持たないまま外部接続やschedulerを開始することはない。

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

### AI CLIの許可確認

xangi は **デフォルトで AI の許可確認をスキップ**します（`SKIP_PERMISSIONS=true` 相当）。Discord/Slack/Web チャットからの呼び出しは非対話実行のため、許可プロンプトに答える人間がいないとタスクが待ち状態になるからです。

`SKIP_PERMISSIONS` は管理者が `.env` で設定します。チャット利用者が一時的に上書きする `!skip` と `/skip` はありません。

> **⚠️ セキュリティ注意:** 信頼できないワークスペースやマルチユーザー環境では `SKIP_PERMISSIONS=false` を明示し、利用するAI CLI自身のsandbox・permission設定を確認してください。

## トラブルシューティング

### 「Prompt is too long」エラー

**症状:** 特定のチャンネルで全てのメッセージに対して「❌ エラーが発生しました: Prompt is too long」と返される。

**原因:** セッションの会話履歴がClaude Code（Agent SDK）のコンテキスト上限を超えた。通常はAgent SDKが自動でコンテキストを圧縮するが、セッションが異常終了した場合など、状態が壊れて回復できなくなることがある。

**対処法:**

1. 該当チャンネルで `/new` コマンドを実行してセッションをリセットする
2. それでも解消しない場合は、xangiを再起動する（`./bin/xangi service restart`）
