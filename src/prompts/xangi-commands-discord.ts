/**
 * Discord操作コマンド（xangi-cmd CLIツール版）
 *
 * Discord固有の操作のみ。スケジュール・システム操作はchat-platform共通。
 */
export const XANGI_COMMANDS_DISCORD = `## セッション再開時の文脈把握（重要）

**最初のメッセージを受け取ったら**、そのチャンネルの過去メッセージを確認して文脈を把握する：

\`\`\`bash
xangi-cmd discord_history --count 10
\`\`\`

- より多く取得: \`--count 50\`（最大100件） / 別チャンネル: \`--channel <チャンネルID>\`
- **セッション再開時は会話の流れが分からないので、返答前に必ずやること**
- **「タイムアウト」「さっきの」など前提のあるメッセージが来たら、自己流で「何の話？」と聞き返さず、まず履歴を取得する**
- 注意: セッション起動直後（メッセージ受信前）にはチャンネル文脈がないので履歴取得しない

## Discord操作

Discord操作は **Bashツールで \`xangi-cmd\` を実行** して行う。

## Discord表示フォーマット

- 番号付き見出しの直下に箇条書きを置く場合は、箇条書きを3スペース以上インデントする
- 悪い例:
  \`\`\`md
  1. 見出し
  - 詳細
  \`\`\`
- 良い例:
  \`\`\`md
  1. 見出し
     - 詳細
  \`\`\`
- インデントしないと、Discordクライアントで詳細行が \`2, 3, 4...\` の番号付きリスト続きに見えることがある

### チャンネル履歴の取得

\`\`\`bash
xangi-cmd discord_history --count <件数> --offset <N>
xangi-cmd discord_history --channel <チャンネルID> --count <件数> --offset <N>
\`\`\`

結果は標準出力に返る（Discordには送信されない）。
件数省略時はデフォルト10件、最大100件。offset で古いメッセージに遡れる。
\`--channel\` を省略した場合、xangi上で実行中なら現在のチャンネルを使う。CLI単体実行では \`--channel\` が必要。

### 別チャンネルにメッセージ送信

\`\`\`bash
xangi-cmd discord_send --channel <チャンネルID> --message "メッセージ内容"
\`\`\`

### チャンネル一覧

\`\`\`bash
xangi-cmd discord_channels --guild <サーバーID>
\`\`\`

### メッセージ検索

\`\`\`bash
xangi-cmd discord_search --channel <チャンネルID> --keyword "キーワード"
\`\`\`

### メッセージ編集

\`\`\`bash
xangi-cmd discord_edit --channel <チャンネルID> --message-id <メッセージID> --content "新しい内容"
\`\`\`

### メッセージ削除

\`\`\`bash
xangi-cmd discord_delete --channel <チャンネルID> --message-id <メッセージID>
\`\`\`

### ファイル送信

\`\`\`bash
xangi-cmd media_send --channel <チャンネルID> --file /path/to/file
\`\`\`

## 自動展開機能（読み取り専用）

- \`https://discord.com/channels/.../...\` リンク → リンク先メッセージの内容を展開
- \`<#channelId>\` → そのチャンネルの最新10件を展開`;
