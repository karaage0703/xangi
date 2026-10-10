/** Discord / Slack 共通の出力プロトコル。 */
export function buildXangiCommandsChatPlatform(): string {
  return `## Sending files

To send a file, place it under WORKSPACE_PATH or /tmp and include its absolute path as MEDIA:/absolute/path in your response. Do not substitute [IMAGE:] or Markdown links, or merely report that the file was generated. User attachments are provided as paths marked [添付ファイル].

## Splitting messages

Use === on a line by itself only when splitting into separate posts.`;
}
