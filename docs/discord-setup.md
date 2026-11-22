[English](en/discord-setup.md) | 日本語

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

| Intent                     | 必須     | 説明                         |
| -------------------------- | -------- | ---------------------------- |
| Presence Intent            | 任意     | ユーザーのオンライン状態取得 |
| Server Members Intent      | 任意     | サーバーメンバー情報取得     |
| **Message Content Intent** | **必須** | メッセージ内容の読み取り     |

**⚠️ Message Content Intent を ON にしないとメッセージが読めない！**

## 5. Bot をサーバーに招待

1. 左メニュー **「OAuth2」** → **「URL Generator」**
2. **SCOPES** で選択：
   - ✅ `bot`
   - ✅ `applications.commands`（スラッシュコマンド用）
3. **BOT PERMISSIONS** で選択：
   - ✅ メッセージを送る（Send Messages）
   - ✅ Threadsでメッセージを送る（Send Messages in Threads）
   - ✅ スレッドを管理（Manage Threads。スレッド内の`Close`ボタンで押下者を退出させる場合は必須）
   - ✅ メッセージ履歴を読む（Read Message History）
   - ✅ ファイルを添付（Attach Files。生成ファイルを送信する場合）
   - ✅ リアクションを付ける（Add Reactions）
   - ✅ スラッシュコマンドを使用（Use Slash Commands）
4. 生成された URL をコピー
5. ブラウザで URL を開き、Bot を招待するサーバーを選択

既にBotを招待済みのサーバーで権限を追加した場合は、生成したURLで再認可するか、サーバー設定のBotロール／対象チャンネル権限に直接反映する。URL Generatorでチェックしただけでは、既存Botの権限は更新されない。

## 6. トークンを設定

```bash
xangi settings
```

開いたローカル設定画面のDiscord欄へBotトークンを貼り付けて保存する。AIとの会話や`.env`へトークンを貼り付ける必要はない。

### エージェント専用Bot

接続名は任意の管理ラベルです。空欄ならサービス名（Discord／Slack）を表示します。Bot側の名前は変更しません。 保存後には再起動案内を表示します。今すぐ反映する場合はxangiに「再起動して」と依頼してください。

Web設定の「エージェント」で保存済みの担当を編集し、「Discord・Slackの専用Bot」→「接続を追加」からDiscordを選びます。専用Botのトークンと許可ユーザーIDを入力してください。Botの作成・招待・権限設定は上記と同じです。共通Botや他の接続と同じトークンは登録できません。

追加・変更・無効化・削除はメインのxangi再起動後に反映されます。専用Botは登録した担当に固定され、チャンネルの担当切替では変更できません。担当の指示・AI・作業場所は起動時にコピーされ、既存会話の設定は保持されます。担当設定を変更した場合は再起動後に新しい会話を始めてください。

担当の作業チャンネルとそのスレッドでは、専用Discord Botの `/backend set` で担当Agentのバックエンド・モデル・推論強度を変更できます。`/backend reset` で担当AgentのAI設定を全体設定の継承に戻せます。どちらもメイン側に保存し、次の通常ターンから適用します。`/backend status` で次のターンに使う設定を確認できます。

`/workspace use|set|reset` と、Local LLMの `/settings item:llmmode|llmeffort` の変更もメイン側に保存し、担当Agentの次の通常ターンから適用します。専用Botで `/backend scope:global` が操作する既定値と、`/settings item:respondtobots` は、その専用Botに保存されます。

接続ごとに独立した子ランタイムを使い、履歴・スケジュール・ツールの返信認証を分離します。データは`DATA_DIR/agent-connections/<接続ID>/`へ保持され、セッションの実行状態はメインのモニターとpetsへ共有します。Web UIの共通の会話一覧から履歴を開き、その会話を担当する専用Botへ送信できます。削除しても履歴は消去しません。接続一覧の状態は画面の再読み込みで更新できます。認証情報は`DATA_DIR/agent-connections.json`へ権限600で保存し、APIからは返しません。データディレクトリをGitへ追加しないでください。


### 担当の予定配信

チャンネルの担当Agentに同じサービスの専用Botが有効になっている場合、メインで保持する既存の予定も、その専用Botで実行・投稿します。予定の作り直しや移動は不要です。予定の実行時刻・内容は変更しません。 担当は実行のたびにチャンネル設定から解決するため、担当を変更すると既存予定の次の実行も新しい担当になります。特定のAgent名や予定IDによる個別分岐はありません。

担当の専用Botが未接続・無効の場合や、同じ担当・サービスに複数の専用Botが有効な場合は配信を失敗として扱い、共通Botへ代行しません。予定配信に使う担当・サービスの専用Botは1つにしてください。専用Botには配信先チャンネルを閲覧・投稿する権限が必要です。

source checkoutで詳細設定を行う場合、許可ユーザーIDなど機密ではない値は`.env`へ設定できる。

```bash
# 許可するユーザーID（1人のみ）
DISCORD_ALLOWED_USER=YOUR_DISCORD_USER_ID
```

## 7. 動作確認

```bash
# ビルド
npm run build

# Docker で起動
docker compose up xangi -d --build

# ログ確認
docker compose logs -f xangi
```

Discord サーバーで `/new` や `/skill` を試す、または Bot をメンションして話しかける：

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

`xangi settings`を開き、Discordが「設定済み」になっているか確認する。

### スレッド内の`Close`ボタンで退出できない

Botのロールまたは対象チャンネルで「スレッドの管理」権限を有効にする。権限がない場合、Discord APIは `Missing Access` または `Missing Permissions` を返す。

## セキュリティ注意事項

- **トークンをGitやAIとの会話へ貼り付けない**
- **トークンを公開しない**（漏洩した場合は即座に再生成）
- `DISCORD_ALLOWED_USER` で使用できるユーザーを1人に制限（Claude Code 利用規約遵守）
