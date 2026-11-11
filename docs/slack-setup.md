[English](en/slack-setup.md) | 日本語

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

### Manifest で作成する場合（任意）

Slack App の作成時に **「From an app manifest」** を選ぶと、Socket Mode / Event Subscriptions / OAuth scopes をまとめて設定できます。手動設定を減らしたい場合は以下を貼り付けてください。

```yaml
display_information:
  name: xangi
  description: AI CLI assistant for Slack
  background_color: '#2f3136'
features:
  bot_user:
    display_name: xangi
    always_online: false
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - channels:history
      - channels:read
      - chat:write
      - files:read
      - files:write
      - groups:history
      - groups:read
      - im:history
      - im:read
      - im:write
      - reactions:read
      - reactions:write
settings:
  event_subscriptions:
    bot_events:
      - app_mention
      - message.channels
      - message.groups
      - message.im
      - reaction_added
  interactivity:
    is_enabled: true
  org_deploy_enabled: false
  socket_mode_enabled: true
  token_rotation_enabled: false
```

manifest を使った場合でも、App-Level Token（`connections:write`）の作成、ワークスペースへのインストール、Bot User OAuth Token / App Token のコピーは必要です。スラッシュコマンドは環境差を避けるため manifest には含めず、必要な場合だけ Step 6 で手動登録してください。

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

| Event              | 説明                               | 用途                       |
| ------------------ | ---------------------------------- | -------------------------- |
| `app_mention`      | メンションされた時                 | 必須                       |
| `reaction_added`   | 削除用リアクションが追加された時   | リアクション削除を使う場合 |
| `message.im`       | DM を受け取った時                  | DM対応時                   |
| `message.channels` | パブリックチャンネルのメッセージ   | メンションなし応答時       |
| `message.groups`   | プライベートチャンネルのメッセージ | メンションなし応答時       |

⚠️ **`SLACK_AUTO_REPLY_CHANNELS` を使う場合は `message.channels` / `message.groups` が必要です**

## 5. OAuth & Permissions 設定

1. 左メニュー **「OAuth & Permissions」** をクリック
2. **「Scopes」** → **「Bot Token Scopes」** で以下を追加：

| Scope               | 説明                                 | 用途                              |
| ------------------- | ------------------------------------ | --------------------------------- |
| `app_mentions:read` | メンションの読み取り                 | 必須                              |
| `chat:write`        | メッセージ送信                       | 必須                              |
| `files:read`        | ファイルの読み取り                   | 添付ファイル対応時                |
| `files:write`       | ファイルのアップロード               | 生成ファイルの送信時              |
| `reactions:read`    | リアクションイベントの読み取り       | リアクション削除を使う場合        |
| `reactions:write`   | リアクション追加（👀など）           | 必須                              |
| `im:history`        | DM の履歴読み取り                    | DM対応時                          |
| `im:read`           | DM の読み取り                        | DM対応時                          |
| `im:write`          | DM の送信                            | DM対応時                          |
| `channels:read`     | パブリックチャンネル情報の読み取り   | `xangi tool slack_channels` 使用時 |
| `groups:read`       | プライベートチャンネル情報の読み取り | `xangi tool slack_channels` 使用時 |
| `channels:history`  | パブリックチャンネルの履歴読み取り   | メンションなし応答時              |
| `groups:history`    | プライベートチャンネルの履歴読み取り | メンションなし応答時              |

### User Token Scopes（任意）

本人名義で操作する場合は、**OAuth & Permissions → User Token Scopes** に用途に応じた権限を追加します。Bot Token Scopes とは別に設定します。

| 用途 | User Token Scope | Slack公式API仕様 |
| --- | --- | --- |
| 本人名義のメッセージ投稿 | `chat:write` | [chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage/) |
| 本人名義でパブリックチャンネルをAPI作成する場合のみ | `channels:write` | [conversations.create](https://docs.slack.dev/reference/methods/conversations.create/) |
| Slack ListsのAPI読み取り | `lists:read` | [slackLists.items.list](https://docs.slack.dev/reference/methods/slackLists.items.list/) |
| Slack ListsのAPI作成・更新 | `lists:write` | [slackLists.create](https://docs.slack.dev/reference/methods/slackLists.create/) / [slackLists.update](https://docs.slack.dev/reference/methods/slackLists.update/) |

本人名義の投稿だけなら `chat:write` を追加します。`channels:write` は投稿の必須権限ではありません。チャンネル作成・Slack Listsの行は、それらのAPIを別途利用する場合の権限です。必要な用途の権限だけを追加し、変更後は本人がアプリを再認可してUser OAuth Tokenを取得し直してください。本人名義投稿の設定手順は[Step 8](#本人名義の投稿任意)を参照してください。

権限やイベントを追加・変更した後は、左メニュー **「Install App」** からアプリをワークスペースへ再インストールしてください。再インストールしないと `reaction_added` や `reactions:read` が有効になりません。

## 6. スラッシュコマンド登録（オプション）

Slackのネイティブコマンドを使う場合は、App管理の **Slash Commands → Create New Command** で以下を登録します。xangi側の受付・ヘルプ・有効条件はDiscordと同じ共通定義から作ります。Socket Modeの受信コードを更新するだけでは、Slack App側のコマンド登録は追加・削除されません。

| Command | Usage Hint | 用途 |
| --- | --- | --- |
| `/secret` | `on\|off\|status` | シークレット会話 |
| `/new` | | 新しい会話 |
| `/stop` | | 実行停止 |
| `/skill` | `[name] [args]` | 現在のWorkspaceのスキル一覧・実行 |
| `/settings` | `[item] [value]` | 共通の設定操作 |
| `/agent` | `list\|status\|set <id>\|reset` | 会話担当の確認・切替 |
| `/workspace` | `status\|list\|use <name>\|set <name> <path>\|reset` | 作業場所の確認・切替 |
| `/backend` | `status\|models [type]\|set <type> [--model model] [--effort effort] [--scope channel\|global]\|reset` | AI・モデル・effort |
| `/schedule` | `add <input>\|list\|remove <id>\|toggle <id>` | Slack向け予定の管理 |
| `/help` | | 有効な操作の一覧 |
| `/autoreply` | `status\|on\|off\|default` | メンションなし応答 |
| `/threadmode` | `status\|on\|off\|default` | 返信をスレッドへ送る設定 |

`ALLOW_AUTOREPLY_COMMAND`と`ALLOW_THREAD_MODE_COMMAND`はDiscord・Slack両方のネイティブ登録に適用します。無効化された操作は`/help`にも出しません。

既存Appから移行する場合、`/models`・`/restart`・`/delete`の登録を削除し、不足している上記コマンドを追加してください。モデル一覧は`/backend models`、再起動は管理用CLI、投稿削除は既存の削除リアクションを使います。`/team`・`/extend`は登録しません。

個別スキルは`/<スキル名>`の同名コマンドをApp側にも登録すれば直接実行できます。予約語・衝突する名前や未登録のスキルは`/skill name args`を使います。候補と実行は現在の会話のWorkspaceで検証し、起動時に登録済みWorkspaceから読み込んだaliasだけを直接受付します。

例外は`/retitle`です。Slackのスレッドは親メッセージと返信で構成され、Discordのような独立したスレッド名の再生成には対応しません。また、[Slack公式仕様](https://docs.slack.dev/interactivity/implementing-slash-commands/)ではアプリ独自のネイティブコマンドをスレッド内で呼べず、payloadにもthread IDがありません。そのため`/new`・Workspace・Agent設定はチャンネルを対象にし、既存スレッドの履歴と作業場所は保持します。停止対象が複数ある場合は対象スレッドの停止ボタンを使います。

登録を増やさずに使う場合は従来どおり通常のメンション・自然文依頼を使えます。`@xangi /backend ...`を専用コマンドとして受理する機能は追加していません。

## 7. ワークスペースにインストール

1. 左メニュー **「Install App」** をクリック
2. **「Install to Workspace」** をクリック
3. 権限を確認して **「許可する」**
4. 表示された **Bot User OAuth Token（xoxb-...）をコピー**

## 8. トークンを設定

```bash
xangi settings
```

開いたローカル設定画面のSlack欄へBot Token（xoxb-...）、App Token（xapp-...）、許可ユーザーIDを入力して保存する。複数ユーザーはカンマ区切り、全員を許可する場合は`*`を指定する。

source checkoutで詳細設定を行う場合は、同じ許可ユーザーIDや他の詳細値を`.env`へ設定できる。

```bash
# 許可するユーザー ID（Slack の User ID）
SLACK_ALLOWED_USER=U01234567

# 任意: 特定チャンネルだけスレッドではなくチャンネル直下に返信
SLACK_REPLY_IN_CHANNELS=C01234567

# 任意: `:wastebasket:` / `:x:` リアクションで bot 投稿を削除（デフォルト有効）
SLACK_REACTION_DELETE_ENABLED=true
SLACK_DELETE_REACTIONS=wastebasket,x
```

> Slackのみで使用する場合は、`xangi settings`のDiscord欄を未設定のままにします。

### 本人名義の投稿（任意）

通常の返信とCLI操作はBot名義です。本人から依頼された投稿だけ、`slack_send --as user` で保存済みユーザーの名義を選べます。Botの権限追加だけでは本人名義にはなりません。[SlackのUser token仕様](https://docs.slack.dev/authentication/tokens/#user-tokens)と[chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage/)に従い、User Token Scopes の `chat:write` を使います。

1. Slack App の **OAuth & Permissions → User Token Scopes** に `chat:write` を追加します。
2. 投稿する本人が対象ワークスペースでアプリを再認可し、**User OAuth Token** を取得します。Bot User OAuth Token と取り違えないでください。
3. `xangi settings` の **本人名義投稿用User OAuthトークン** に保存します。既存の専用シークレット領域（ファイル権限0600）を使い、保存済みの値は画面に表示しません。ソース実行では `SLACK_USER_TOKEN` でも指定でき、環境変数の値が優先されます。トークンをチャットやCLI引数に貼り付けないでください。
4. 次回のxangi起動後、本人が許可した内容・投稿先を確認して実行します。

```bash
xangi tool slack_send --as user --channel C01234567 --message "お知らせです"
xangi tool slack_send --as user --channel C01234567 --thread-ts 1719876543.000100 --message "スレッドへの追記"
```

本人名義で投稿したメッセージの修正・削除にも `slack_edit --as user` / `slack_delete --as user` を使います。`--as` の省略または `--as bot` は従来のBotトークンです。ユーザートークンが未設定・期限切れ・失効・権限不足の場合はエラーとなり、Bot名義へ切り替えて再送しません。履歴やチャンネル一覧は引き続きBot権限を使い、`--as` は受け付けません。

この設定はインスタンスにつき1ユーザーです。tool-serverを呼び出せる利用者・エージェントは、そのユーザー名義で操作できるため、本人の専用インスタンスで利用してください。本人の明示依頼がある操作にだけ `--as user` を指定してください。ユーザートークンをAI CLIの環境変数へ渡す必要はありません。通常のBot返信・イベント受信には引き続きBot/Appトークンが必要です。

OAuthコールバック・複数ユーザー連携・トークン自動更新は扱いません。トークンローテーションを有効にしたアプリでは期限切れ前にアクセストークンを更新して保存し、xangiの次回起動時に読み込みます。対象チャンネルへの参加・投稿権限も本人側で必要です。

## 9. 動作確認

```bash
# ビルド
npm run build

# Docker で起動
docker compose up xangi -d --build

# ログ確認
docker compose logs -f xangi
```

Slack で以下を試す：

- Bot をメンション: `@xangi こんにちは！`
- DM を送信
- `/new` コマンド
- `/skill` コマンド
- bot 投稿に `:wastebasket:` または `:x:` リアクションを付けて削除

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

`xangi settings`を開き、Slackの2項目が「設定済み」になっているか確認。

### DM で反応しない

1. OAuth Scopes に `im:history`, `im:read` があるか確認
2. Event Subscriptions で `message.im` が設定されているか確認

## チャンネルへの Bot 招待

Bot をチャンネルで使うには、チャンネルに招待する必要があります：

```
/invite @xangi
```

## セキュリティ注意事項

- **トークンをGitやAIとの会話へ貼り付けない**
- **トークンを公開しない**（漏洩した場合は Slack App 設定で再生成）
- `SLACK_ALLOWED_USER` で使用できるユーザーを1人に制限（Claude Code 利用規約遵守）

## 参考リンク

- [Slack API Documentation](https://api.slack.com/docs)
- [Bolt for JavaScript](https://slack.dev/bolt-js/)
- [Socket Mode](https://api.slack.com/apis/connections/socket)
