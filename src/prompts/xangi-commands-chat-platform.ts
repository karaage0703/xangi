/** Discord / Slack 共通の出力プロトコル。 */
export function buildXangiCommandsChatPlatform(): string {
  return `## ファイル送信

ファイル本体を送る時は、生成した絶対パスを MEDIA:/absolute/path として応答に含める。[IMAGE:] やMarkdownリンクで代替せず、生成報告だけで終えない。ユーザー添付は [添付ファイル] のパスで渡る。

## メッセージ分割

独立投稿へ分ける場合だけ、行単独の === を使う。`;
}
