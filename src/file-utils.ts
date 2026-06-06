import fs from 'fs';
import path from 'path';
import os from 'os';

const DOWNLOAD_DIR = path.join(
  process.env.DATA_DIR ||
    (process.env.WORKSPACE_PATH
      ? path.join(process.env.WORKSPACE_PATH, '.xangi')
      : path.join(os.homedir(), '.xangi')),
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
 * 相対パスの解決基点となるワークスペースルート。
 * Local LLM/Claude いずれの runner も WORKSPACE_PATH を持つ。未設定時は cwd。
 */
function getWorkspaceRoot(explicit?: string): string {
  return explicit || process.env.WORKSPACE_PATH || process.cwd();
}

function extraAllowedDirs(): string[] {
  const extra = process.env.ATTACHMENT_ALLOWED_DIRS;
  if (!extra) return [];
  return extra
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((d) => path.resolve(d));
}

/**
 * 明示マーカー（MEDIA: / [IMAGE:] / markdown リンク等）で指定されたパスに
 * 添付を許可するルート群（広め）。ワークスペース subtree 全体・添付保存先・一時領域。
 * ここに入っていないパス（例: /etc/passwd、~/.ssh）は弾く＝既存の
 * 「任意絶対パスが素通りで添付されてしまう穴」をここで塞ぐ。
 * ATTACHMENT_ALLOWED_DIRS（カンマ区切り絶対パス）で追加可能。
 */
function getBroadAllowedRoots(workspaceRoot: string): string[] {
  return [workspaceRoot, DOWNLOAD_DIR, os.tmpdir(), '/tmp', ...extraAllowedDirs()];
}

/**
 * 候補文字列を絶対パスに正規化する。クォート/山括弧/file:// を剥がし、
 * 相対パスは workspaceRoot 基準で解決する。
 */
function resolveCandidate(raw: string, workspaceRoot: string): string | null {
  let p = raw.trim();
  // 周辺の引用符・山括弧・開き括弧を除去
  p = p
    .replace(/^['"<(]+/, '')
    .replace(/['">)]+$/, '')
    .trim();
  if (!p) return null;
  if (p.startsWith('file://')) p = p.slice('file://'.length);
  if (!p) return null;
  return path.isAbsolute(p) ? path.resolve(p) : path.resolve(workspaceRoot, p);
}

/**
 * resolved が allowedRoots のいずれかの subtree 内にある「実在ファイル」かを
 * realpath ベースで検査する。realpath を使うことで `..` や symlink による
 * サンドボックス脱出も防ぐ。戻り値は canonical な realpath（重複排除のため）。
 */
function realFileWithinRoots(resolved: string, allowedRoots: string[]): string | null {
  let real: string;
  try {
    real = fs.realpathSync(resolved);
    if (!fs.statSync(real).isFile()) return null;
  } catch {
    return null; // 存在しない / アクセス不可
  }
  for (const root of allowedRoots) {
    let realRoot: string;
    try {
      realRoot = fs.realpathSync(root);
    } catch {
      continue; // ルートが存在しなければスキップ
    }
    if (real === realRoot || real.startsWith(realRoot + path.sep)) {
      return real;
    }
  }
  return null;
}

/**
 * 応答テキストから添付マーカーのファイルパスを抽出する。
 *
 * 対象は明示マーカーのみ: MEDIA: / [IMAGE:|FILE:|VIDEO:|AUDIO:|MEDIA:] / markdown リンク。
 * 相対パスは WORKSPACE_PATH 基準で解決し、候補は allowlist サンドボックス
 * （realpath + broad roots）内の実在ファイルだけを返す。
 */
export function extractFilePaths(text: string, workspaceRootOverride?: string): string[] {
  if (!text) return [];
  const workspaceRoot = getWorkspaceRoot(workspaceRootOverride);
  const broadRoots = getBroadAllowedRoots(workspaceRoot);

  const found = new Set<string>();
  const consider = (raw: string) => {
    const resolved = resolveCandidate(raw, workspaceRoot);
    if (!resolved) return;
    const real = realFileWithinRoots(resolved, broadRoots);
    if (real) found.add(real);
  };

  let match: RegExpExecArray | null;

  // 1) MEDIA:/path/to/file（裸の MEDIA:）
  const mediaPattern = /MEDIA:\s*([^\s\n]+)/g;
  while ((match = mediaPattern.exec(text)) !== null) {
    consider(match[1]);
  }

  // 2) [IMAGE:path] / [FILE:path] / [VIDEO:path] / [AUDIO:path] / [MEDIA:path]
  const bracketPattern = /\[(?:IMAGE|FILE|VIDEO|AUDIO|MEDIA):\s*([^\]\n]+)\]/gi;
  while ((match = bracketPattern.exec(text)) !== null) {
    consider(match[1]);
  }

  // 3) markdown リンク / 画像  ![alt](path) または [label](path)
  const mdLinkPattern = /!?\[[^\]]*\]\(\s*([^)\s]+)\s*\)/g;
  while ((match = mdLinkPattern.exec(text)) !== null) {
    consider(match[1]);
  }

  return [...found];
}

/**
 * 単一パスを「添付してよい実在ファイル」として検証し、canonical な realpath を返す。
 * 検証不可なら null。`attach_file` ツール等、明示的・意図的な添付呼び出しから使う想定なので
 * broad roots（WORKSPACE subtree / 添付保存先 / tmp / ATTACHMENT_ALLOWED_DIRS）で許可する。
 * extractFilePaths と同じサンドボックス（realpath + allowlist）を共有する。
 */
export function resolveAttachmentPath(raw: string, workspaceRootOverride?: string): string | null {
  if (!raw) return null;
  const workspaceRoot = getWorkspaceRoot(workspaceRootOverride);
  const resolved = resolveCandidate(raw, workspaceRoot);
  if (!resolved) return null;
  return realFileWithinRoots(resolved, getBroadAllowedRoots(workspaceRoot));
}

/**
 * テキストから添付マーカー（MEDIA: / 角括弧マーカー / markdown 画像）を除去して
 * 表示用テキストを返す。
 */
export function stripFilePaths(text: string): string {
  return text
    .replace(/MEDIA:\s*[^\s\n]+/g, '')
    .replace(/\[(?:IMAGE|FILE|VIDEO|AUDIO|MEDIA):\s*[^\]\n]+\]/gi, '')
    .replace(/!\[[^\]]*\]\(\s*[^)\s]+\s*\)/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 添付マーカー（MEDIA: / [IMAGE:|FILE:|VIDEO:|AUDIO:|MEDIA:]）が書かれているのに、
 * 指す先が allowlist 内の実在ファイルでない（＝添付対象にならない）ものが残っているかを返す。
 *
 * Local LLM が generate.py 等を実行せず出力ファイル名だけ作文して `MEDIA:...` と書く
 * 「捏造パス（phantom path）」を検出するための関数。markdown リンクと http(s)/data URL は
 * 通常リンク・外部 URL であって添付失敗ではないので対象外。
 */
export function hasUnresolvedMediaMarker(text: string, workspaceRootOverride?: string): boolean {
  if (!text) return false;
  const workspaceRoot = getWorkspaceRoot(workspaceRootOverride);
  const broadRoots = getBroadAllowedRoots(workspaceRoot);
  const patterns = [/MEDIA:\s*([^\s\n]+)/g, /\[(?:IMAGE|FILE|VIDEO|AUDIO|MEDIA):\s*([^\]\n]+)\]/gi];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const raw = match[1].trim();
      // http(s)/data URL は添付対象外なので「生成失敗」ではない（誤検知を防ぐ）
      if (/^(?:https?|data):/i.test(raw)) continue;
      const resolved = resolveCandidate(raw, workspaceRoot);
      if (!resolved) continue;
      if (!realFileWithinRoots(resolved, broadRoots)) return true;
    }
  }
  return false;
}

const DEFAULT_MISSING_MEDIA_NOTICE =
  '⚠️ ファイル（画像など）を生成・添付できませんでした。生成に失敗した可能性があります。もう一度試してください。';

/**
 * 添付できなかったことをユーザに伝える注記。環境変数 `ATTACHMENT_MISSING_NOTICE` で上書き可能。
 */
export function getMissingMediaNotice(): string {
  const custom = process.env.ATTACHMENT_MISSING_NOTICE?.trim();
  return custom && custom.length > 0 ? custom : DEFAULT_MISSING_MEDIA_NOTICE;
}

/**
 * 最終応答テキストから「添付するファイル群」と「表示用テキスト」を組み立てる共通ヘルパ。
 * - テキスト由来パス（extractFilePaths）と構造化 attachments を合算・重複排除
 * - 添付があればマーカーを除去した表示テキストを返す
 * - 添付ゼロでも、実在しないメディアマーカー（捏造パス）が残っている場合は、
 *   マーカーを除去したうえで生成失敗の注記を付け、ユーザが「描いたと言うのに何も出ない」
 *   状態に陥らないようにする
 */
export function buildAttachmentResult(
  result: string,
  structuredAttachments?: string[],
  workspaceRootOverride?: string
): { filePaths: string[]; displayText: string } {
  const filePaths = [
    ...new Set([
      ...extractFilePaths(result, workspaceRootOverride),
      ...(structuredAttachments ?? []),
    ]),
  ];
  if (filePaths.length > 0) {
    return { filePaths, displayText: stripFilePaths(result) };
  }
  if (hasUnresolvedMediaMarker(result, workspaceRootOverride)) {
    const stripped = stripFilePaths(result);
    const notice = getMissingMediaNotice();
    return { filePaths, displayText: stripped ? `${stripped}\n\n${notice}` : notice };
  }
  return { filePaths, displayText: result };
}

/**
 * 添付ファイル情報をプロンプトに追加
 */
export function buildPromptWithAttachments(prompt: string, filePaths: string[]): string {
  if (filePaths.length === 0) return prompt;

  const fileList = filePaths.map((p) => `  - ${p}`).join('\n');
  return `${prompt}\n\n[添付ファイル]\n${fileList}`;
}
