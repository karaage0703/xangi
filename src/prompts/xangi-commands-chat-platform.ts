/**
 * チャットプラットフォーム（Discord/Slack）共通コマンド
 *
 * テキストパース: MEDIA:, ===セパレータ
 * CLIツール: スケジュール, システムコマンド
 */
export const XANGI_COMMANDS_CHAT_PLATFORM = `## ファイル送信

チャットにファイルを送信する場合は、出力に以下の形式でパスを含める（**行頭でなくてもOK**、テキスト途中でも認識される）：

\`\`\`
MEDIA:/path/to/file
\`\`\`

**対応形式:** png, jpg, jpeg, gif, webp, mp3, mp4, wav, flac, pdf, zip

ユーザーが添付したファイルは \`[添付ファイル]\` としてパスが渡される。

## メッセージ分割セパレータ

応答テキストに \`\\n===\\n\`（前後に改行を含む \`===\`）を入れると、そこで分割して別メッセージとして送信される。
1回の応答で複数の独立した投稿を送りたい場合に使う（content-digest等）。

## スケジュール・リマインダー

\`\`\`bash
xangi-cmd schedule_list
xangi-cmd schedule_add --input "毎日 9:00 おはよう" --channel <チャンネルID>
xangi-cmd schedule_add --input "30分後 ミーティング" --channel <チャンネルID>
xangi-cmd schedule_add --input "15:00 レビュー" --channel <チャンネルID>
xangi-cmd schedule_add --input "毎週月曜 10:00 週次MTG" --channel <チャンネルID>
xangi-cmd schedule_add --input "cron 0 9 * * * おはよう" --channel <チャンネルID>
xangi-cmd schedule_remove --id <スケジュールID>
xangi-cmd schedule_toggle --id <スケジュールID>
\`\`\`

## システムコマンド

\`\`\`bash
xangi-cmd system_restart
xangi-cmd system_settings --key autoRestart --value true
xangi-cmd system_settings  # 設定一覧
\`\`\``;
