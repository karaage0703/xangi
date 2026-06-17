import { isGitHubAppEnabled } from '../github-auth.js';
import { capToolLines } from '../stream-session.js';

/**
 * ツール入力の要約を生成（Discord表示用）
 */
export function formatToolInput(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case 'Read':
    case 'read':
      return input.file_path || input.path
        ? `: ${String(input.file_path || input.path)
            .split('/')
            .slice(-2)
            .join('/')}`
        : '';
    case 'Edit':
    case 'Write':
      return input.file_path ? `: ${String(input.file_path).split('/').slice(-2).join('/')}` : '';
    case 'Bash':
    case 'exec': {
      const cmdKey = input.command || input.cmd;
      if (!cmdKey) return '';
      const cmd = String(cmdKey);
      // 60 文字だと codex/grok 等のラッパーコマンドが本文に入る前に切れる。
      // 観測性を上げるため 200 文字まで表示。Discord 1 メッセージ 2000 字制限内で十分。
      // 環境変数 XANGI_TOOL_DISPLAY_MAX で上書き可能。
      const maxLen = parseInt(process.env.XANGI_TOOL_DISPLAY_MAX ?? '200', 10);
      const cmdDisplay = `: \`${cmd.slice(0, maxLen)}${cmd.length > maxLen ? '...' : ''}\``;
      const ghBadge = cmd.startsWith('gh ') && isGitHubAppEnabled() ? ' 🔑App' : '';
      return cmdDisplay + ghBadge;
    }
    case 'Glob':
      return input.pattern ? `: ${String(input.pattern)}` : '';
    case 'Grep':
      return input.pattern ? `: ${String(input.pattern)}` : '';
    case 'WebFetch':
    case 'web_fetch':
      return input.url ? `: ${String(input.url).slice(0, 60)}` : '';
    case 'Agent':
      return input.description ? `: ${String(input.description)}` : '';
    case 'Skill':
      return input.skill ? `: ${String(input.skill)}` : '';
    default:
      // MCPツール (mcp__server__tool 形式)
      if (toolName.startsWith('mcp__')) {
        const parts = toolName.split('__');
        const server = parts[1] || '';
        const tool = parts[2] || '';
        return ` (${server}/${tool})`;
      }
      return '';
  }
}

export function appendToolHistory(text: string, toolHistory: string[], suffix = ''): string {
  if (toolHistory.length === 0) return `${text}${suffix}`;
  const base = text.trimEnd();
  // 長時間ターンでツール行が際限なく伸びないよう最新 N 行に cap する
  // (StreamSession 側で cap 済みのリストはそのまま通る)
  const toolDisplay = capToolLines(toolHistory).join('\n');
  return `${toolDisplay}${base ? `\n\n${base}` : ''}${suffix}`;
}

export function formatInternalContextCommand(command: string): string | null {
  const normalized = command.replace(/\s+/g, ' ');

  if (/(^|["'\s])xangi-cmd discord_history\b/.test(normalized)) {
    return '🔧 Discord履歴確認';
  }
  if (/\b(?:127\.0\.0\.1|localhost):7890\/search\b/.test(normalized)) {
    return '🔧 workspace-RAG検索';
  }
  const memoryMatch = normalized.match(/\bmemory\/(20\d{6}\.md)\b/);
  if (memoryMatch) {
    return `🔧 Memory参照: ${memoryMatch[1]}`;
  }
  if (/\bAGENTS\.md\b/.test(normalized)) {
    return '🔧 AGENTS参照';
  }
  if (/\bMEMORY\.md\b/.test(normalized)) {
    return '🔧 MEMORY参照';
  }
  if (/\bknowledge\/lessons_archive\.md\b/.test(normalized)) {
    return '🔧 教訓参照';
  }
  const skillMatch = normalized.match(/\bskills\/([^"'`\s]+)\/SKILL\.md\b/);
  if (skillMatch) {
    return `🔧 Skill参照: ${skillMatch[1]}`;
  }
  return null;
}

export function formatFinalCommandSummary(command: string): string {
  const normalized = command.replace(/\s+/g, ' ').trim();
  const shellMatch = normalized.match(/^\/bin\/bash -lc (?:"([^"]*)"|'([^']*)')$/);
  const unwrapped = shellMatch ? shellMatch[1] || shellMatch[2] || normalized : normalized;
  const maxLen = 80;
  return unwrapped.length > maxLen ? `${unwrapped.slice(0, maxLen)}...` : unwrapped;
}

export function addToolHistory(
  toolHistory: string[],
  toolName: string,
  toolInput: Record<string, unknown>
): boolean {
  let line: string | null = null;
  if (toolName === 'Bash' || toolName === 'exec') {
    const command = toolInput.command || toolInput.cmd;
    if (command) {
      const commandString = String(command);
      line =
        formatInternalContextCommand(commandString) ||
        `🔧 ${toolName}実行: \`${formatFinalCommandSummary(commandString)}\``;
    }
  }
  if (!line) {
    const inputSummary = formatToolInput(toolName, toolInput);
    line = `🔧 ${toolName}${inputSummary}`;
  }
  if (toolHistory.includes(line)) return false;
  toolHistory.push(line);
  return true;
}
