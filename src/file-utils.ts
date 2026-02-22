import fs from 'fs';
import path from 'path';
import os from 'os';

const DOWNLOAD_DIR = path.join(
  process.env.DATA_DIR || path.join(os.homedir(), '.xangi'),
  'media',
  'attachments'
);

// ダウンロードディレクトリを作成
if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

/**
 * URLからファイルをダウンロードして一時ファイルに保存
 */
export async function downloadFile(
  url: string,
  filename: string,
  authHeader?: Record<string, string>
): Promise<string> {
  const sanitized = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const filePath = path.join(DOWNLOAD_DIR, `${Date.now()}_${sanitized}`);

  const headers: Record<string, string> = { ...authHeader };
  const response = await fetch(url, { headers });

  if (!response.ok) {
    throw new Error(`Failed to download file: ${response.status} ${response.statusText}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(filePath, buffer);
  console.log(`[xangi] Downloaded attachment: ${filename} → ${filePath} (${buffer.length} bytes)`);
  return filePath;
}

/**
 * Agent結果からファイルパスを抽出
 * パターン: MEDIA:/path/to/file または [ファイル](/path/to/file)
 */
export function extractFilePaths(text: string): string[] {
  const paths: string[] = [];

  // MEDIA:/path/to/file パターン
  const mediaPattern = /MEDIA:\s*([^\s\n]+)/g;
  let match;
  while ((match = mediaPattern.exec(text)) !== null) {
    const p = match[1].trim();
    if (fs.existsSync(p)) {
      paths.push(p);
    }
  }

  // 絶対パスパターン（画像/音声/動画の拡張子を持つもの）
  const absPathPattern =
    /(?:^|\s)(\/[^\s]+\.(?:png|jpg|jpeg|gif|webp|mp3|mp4|wav|flac|pdf|zip))/gim;
  while ((match = absPathPattern.exec(text)) !== null) {
    const p = match[1].trim();
    if (fs.existsSync(p) && !paths.includes(p)) {
      paths.push(p);
    }
  }

  return paths;
}

/**
 * テキストからファイルパス部分を除去して表示用テキストを返す
 */
export function stripFilePaths(text: string): string {
  return text
    .replace(/MEDIA:\s*[^\s\n]+/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 添付ファイル情報をプロンプトに追加
 */
export function buildPromptWithAttachments(prompt: string, filePaths: string[]): string {
  if (filePaths.length === 0) return prompt;

  const fileList = filePaths.map((p) => `  - ${p}`).join('\n');
  return `${prompt}\n\n[添付ファイル]\n${fileList}`;
}
