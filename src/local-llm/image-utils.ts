/**
 * 画像処理ユーティリティ（Local LLMマルチモーダル対応）
 */
import fs from 'fs';
import path from 'path';

/** サポートする画像拡張子 */
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);

/** 拡張子→MIMEタイプのマッピング */
const MIME_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/**
 * ファイルパスが画像ファイルかどうかを判定
 */
export function isImageFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}

/**
 * ファイル拡張子からMIMEタイプを取得
 */
export function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

/**
 * 画像ファイルをbase64エンコードして読み込む
 * @returns base64エンコードされた画像データ、またはファイルが存在しない/読めない場合はnull
 */
export function encodeImageToBase64(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) {
      console.warn(`[local-llm] Image file not found: ${filePath}`);
      return null;
    }

    const buffer = fs.readFileSync(filePath);
    return buffer.toString('base64');
  } catch (err) {
    console.warn(
      `[local-llm] Failed to read image file: ${filePath}: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}

/**
 * プロンプトから「[添付ファイル]」セクションのファイルパスを抽出
 * @returns { imagePaths: 画像ファイルパス[], otherPaths: 非画像ファイルパス[], cleanPrompt: 添付ファイルセクションを除去したプロンプト }
 */
export function extractAttachmentPaths(prompt: string): {
  imagePaths: string[];
  otherPaths: string[];
  cleanPrompt: string;
} {
  const imagePaths: string[] = [];
  const otherPaths: string[] = [];

  // [添付ファイル] セクションを検出
  const attachmentMatch = prompt.match(/\n\n\[添付ファイル\]\n([\s\S]*?)$/);
  if (!attachmentMatch) {
    return { imagePaths, otherPaths, cleanPrompt: prompt };
  }

  const fileListText = attachmentMatch[1];
  const cleanPrompt = prompt.slice(0, attachmentMatch.index).trim();

  // 各行からファイルパスを抽出（ "  - /path/to/file" 形式）
  const lines = fileListText.split('\n');
  for (const line of lines) {
    const pathMatch = line.match(/^\s+-\s+(.+)$/);
    if (pathMatch) {
      const filePath = pathMatch[1].trim();
      if (isImageFile(filePath)) {
        imagePaths.push(filePath);
      } else {
        otherPaths.push(filePath);
      }
    }
  }

  return { imagePaths, otherPaths, cleanPrompt };
}
