/**
 * 全プラットフォーム共通のxangiコマンド（Discord/Slack/Web）
 */
export const XANGI_COMMANDS_COMMON = `## タイムアウト対策

xangiのデフォルトタイムアウトは5分（300000ms）。
5分以上かかる処理はバックグラウンド実行し、即座に「実行開始した」と応答を返すこと。
長時間処理は \`nohup\` を使うこと。`;
