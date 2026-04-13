/**
 * 危険コマンド検知 + Discord/Slack承認フロー
 *
 * パターンは approval-patterns.json から読み込み。
 * APPROVAL_ENABLED=true で有効化（デフォルト無効）。
 */
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

/** 危険コマンドのパターン定義 */
export interface DangerPattern {
  command: string;
  description: string;
  category: string;
}

/**
 * approval-patterns.json からパターンを読み込み
 */
function loadPatternsFromFile(): DangerPattern[] {
  const paths = [
    join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'approval-patterns.json'),
    join(dirname(fileURLToPath(import.meta.url)), 'approval-patterns.json'),
  ];
  for (const filePath of paths) {
    try {
      const raw = readFileSync(filePath, 'utf-8');
      return JSON.parse(raw) as DangerPattern[];
    } catch {
      // next path
    }
  }
  console.warn('[approval] Failed to load approval-patterns.json, using empty patterns');
  return [];
}

/** 機密ファイルパターン（Write/Edit検知用） */
const SENSITIVE_FILE_PATTERNS = /\.env$|credentials|\.pem$|\.key$/;

/** 有効なパターンリスト */
let activePatterns: DangerPattern[] = loadPatternsFromFile();

/** 承認機能の有効/無効（デフォルト無効） */
let approvalEnabled = false;

/**
 * 承認機能を有効/無効化
 */
export function setApprovalEnabled(enabled: boolean): void {
  approvalEnabled = enabled;
  if (enabled && activePatterns.length === 0) {
    activePatterns = loadPatternsFromFile();
  }
  console.log(`[approval] ${enabled ? `Enabled (${activePatterns.length} patterns)` : 'Disabled'}`);
}

/**
 * 承認機能が有効かどうか
 */
export function isApprovalEnabled(): boolean {
  return approvalEnabled;
}

/**
 * パターンを再読み込み
 */
export function reloadPatterns(): void {
  activePatterns = loadPatternsFromFile();
  console.log(`[approval] Reloaded ${activePatterns.length} patterns`);
}

/**
 * 現在のパターンリストを取得
 */
export function getDangerPatterns(): DangerPattern[] {
  return [...activePatterns];
}

export interface DangerousCommand {
  command: string;
  matches: string[];
}

/**
 * コマンドが危険かどうか判定
 */
export function detectDangerousCommand(input: string): DangerousCommand | null {
  if (!approvalEnabled) return null;
  const lower = input.toLowerCase();
  const matches: string[] = [];
  for (const { command: cmd, description } of activePatterns) {
    if (lower.includes(cmd.toLowerCase())) {
      matches.push(description);
    }
  }
  return matches.length > 0 ? { command: input, matches } : null;
}

/**
 * ツール呼び出しが危険かどうか判定
 */
export function detectDangerousTool(
  toolName: string,
  toolInput: Record<string, unknown>
): DangerousCommand | null {
  if (!approvalEnabled) return null;
  if (toolName === 'Bash' && toolInput.command) {
    return detectDangerousCommand(String(toolInput.command));
  }
  if ((toolName === 'Write' || toolName === 'Edit') && toolInput.file_path) {
    const filePath = String(toolInput.file_path);
    if (SENSITIVE_FILE_PATTERNS.test(filePath)) {
      return { command: `${toolName}: ${filePath}`, matches: ['機密ファイルの変更'] };
    }
  }
  return null;
}

// --- 承認キュー ---

interface PendingApproval {
  id: string;
  channelId: string;
  danger: DangerousCommand;
  resolve: (approved: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pendingApprovals = new Map<string, PendingApproval>();

const APPROVAL_TIMEOUT_MS = 120_000; // 2分

let approvalCounter = 0;

/**
 * 承認リクエストを作成し、ユーザーの応答を待つ
 */
export function requestApproval(
  channelId: string,
  danger: DangerousCommand,
  sendApprovalMessage: (approvalId: string, danger: DangerousCommand) => void
): Promise<boolean> {
  return new Promise((resolve) => {
    const id = `approval_${++approvalCounter}`;

    const timer = setTimeout(() => {
      pendingApprovals.delete(id);
      console.log(`[approval] Timeout: ${id} (auto-denied)`);
      resolve(false);
    }, APPROVAL_TIMEOUT_MS);

    pendingApprovals.set(id, { id, channelId, danger, resolve, timer });
    sendApprovalMessage(id, danger);
  });
}

/**
 * 承認/拒否の応答を処理
 */
export function resolveApproval(approvalId: string, approved: boolean): boolean {
  const pending = pendingApprovals.get(approvalId);
  if (!pending) return false;

  clearTimeout(pending.timer);
  pendingApprovals.delete(approvalId);
  console.log(`[approval] ${approved ? 'Approved' : 'Denied'}: ${approvalId}`);
  pending.resolve(approved);
  return true;
}
