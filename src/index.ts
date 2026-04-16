import {
  Client,
  GatewayIntentBits,
  Events,
  REST,
  Routes,
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  Message,
  AutocompleteInteraction,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import { execSync } from 'node:child_process';
import { statSync } from 'node:fs';

import { loadConfig } from './config.js';
import { isGitHubAppEnabled } from './github-auth.js';
import { createAgentRunner, getBackendDisplayName, type AgentRunner } from './agent-runner.js';
import { ClaudeCodeRunner } from './claude-code.js';
import { processManager } from './process-manager.js';
import { loadSkills, formatSkillList, type Skill } from './skills.js';
import { startSlackBot } from './slack.js';
import {
  downloadFile,
  extractFilePaths,
  stripFilePaths,
  buildPromptWithAttachments,
} from './file-utils.js';
import { initSettings, loadSettings, saveSettings, formatSettings } from './settings.js';
import { DISCORD_MAX_LENGTH, DISCORD_SAFE_LENGTH, STREAM_UPDATE_INTERVAL_MS } from './constants.js';
import {
  Scheduler,
  parseScheduleInput,
  formatScheduleList,
  SCHEDULE_SEPARATOR,
  type Platform,
  type ScheduleType,
} from './scheduler.js';
import { initSessions, getSession, setSession, deleteSession } from './sessions.js';
import { join } from 'path';
import { config as dotenvConfig } from 'dotenv';
dotenvConfig({ override: true });

// === Izuna Action Hook (Phase 4) ===
import { execFile } from 'child_process';
import { join as pathJoin } from 'path';
const ACTION_HOOK_RE = /\[ACTION:(\w+)(?:\s*(\{[\s\S]*?\}))?\s*\]?/g;
const ACTION_SCRIPTS_DIR = pathJoin(process.env.HOME || '', '.openclaw/workspace/scripts');
const GATE_RESPONDER_PATH = pathJoin(ACTION_SCRIPTS_DIR, 'gate_responder.py');
const ACTION_EXECUTOR_PATH = pathJoin(ACTION_SCRIPTS_DIR, 'action_executor.py');
const ACTION_ENV = {
  ...process.env,
  PYTHONPATH: '/Users/suguru/Library/Python/3.9/lib/python/site-packages',
};

// === Discord Gate (Phase 4b): L2/L3 confirmation via Discord buttons ===
interface PendingGate {
  actionName: string;
  paramsStr: string;
  hashPrefix: string;
  tier: string;
  token2: string | null;
  channelId: string;
  messageId: string;
  expiresAt: number;
}
const pendingGates = new Map<string, PendingGate>();
// L3 second-step: token2 -> first token
const pendingL3SecondStep = new Map<string, string>();

function execPython(args: string[], timeout = 30000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'python3',
      args,
      {
        timeout,
        cwd: ACTION_SCRIPTS_DIR,
        env: ACTION_ENV,
      },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr || err.message));
          return;
        }
        resolve(stdout);
      }
    );
  });
}

function formatActionResult(actionName: string, parsed: any): string {
  if (parsed.ok) {
    if (actionName === 'calendar_create') {
      return (
        '\u{1f4c5} ' +
        (parsed.event?.summary || '\u4e88\u5b9a') +
        ' \u3092\u767b\u9332\u3057\u307e\u3057\u305f'
      );
    } else if (actionName === 'gmail_draft') {
      return '\u2709\ufe0f \u4e0b\u66f8\u304d\u3092\u4f5c\u6210\u3057\u307e\u3057\u305f';
    } else if (actionName === 'calendar_list') {
      const evts = parsed.events || [];
      return (
        evts.map((e: any) => '- ' + e.start + ' ' + e.summary).join('\n') ||
        '\u4e88\u5b9a\u306a\u3057'
      );
    } else if (actionName === 'script_write') {
      const typeJa: Record<string, string> = {
        character: '\u30ad\u30e3\u30e9\u30af\u30bf\u30fc\u8a2d\u5b9a',
        outline: '\u3042\u3089\u3059\u3058\u30fb\u69cb\u6210',
        scene: '\u30b7\u30fc\u30f3',
        brainstorm: '\u58c1\u6253\u3061\u30e1\u30e2',
      };
      const label = typeJa[parsed.type as string] || parsed.type || 'script';
      const parts: string[] = [
        `\u2705 ${label} (${parsed.chars || 0}\u5b57) \u3092 \`${parsed.file ? String(parsed.file).split('/').pop() : ''}\` \u306b\u4fdd\u5b58\u3057\u307e\u3057\u305f`,
      ];
      if (parsed.file) {
        parts.push(`MEDIA:${parsed.file}`);
      }
      // 全文表示: full_content 優先. splitMessage で 2000 字チャンクに分割される.
      if (parsed.full_content) {
        parts.push('\n---\n' + String(parsed.full_content));
      } else if (parsed.preview) {
        parts.push(
          '\n---\n' +
            String(parsed.preview).slice(0, 500) +
            ' ...(\u672c\u6587\u306f' +
            (parsed.chars || 0) +
            '\u5b57, \u30d5\u30a1\u30a4\u30eb\u3092\u78ba\u8a8d' +
            (parsed.file ? ':\\`' + String(parsed.file).split('/').pop() + '\\`' : '') +
            ')'
        );
      }
      return parts.join('\n');
    } else if (actionName === 'script_list') {
      const files = parsed.files || [];
      if (files.length === 0)
        return '\ud83d\udcc1 \u30d7\u30ed\u30b8\u30a7\u30af\u30c8\u5185\u306b\u30d5\u30a1\u30a4\u30eb\u306a\u3057';
      const lines = files.map(
        (f: { path: string; chars: number; mtime: string }) =>
          `- \`${f.path}\` (${f.chars}\u5b57, ${f.mtime})`
      );
      return (
        `\ud83d\udcc1 **\u30d5\u30a1\u30a4\u30eb\u4e00\u89a7** (${parsed.project || 'manga'}, ${files.length}\u4ef6)\n` +
        lines.join('\n')
      );
    } else if (actionName === 'script_read') {
      const content = parsed.content || '';
      const fname = parsed.file ? String(parsed.file).split('/').pop() : '';
      const preview = content.slice(0, 500);
      const truncated =
        content.length > 500
          ? '\n\n...(\u4ee5\u4e0b\u7701\u7565, \u5168\u4f53 ' +
            parsed.chars +
            '\u5b57, \u6dfb\u4ed8\u53c2\u7167)'
          : '';
      const media = parsed.file ? `\nMEDIA:${parsed.file}` : '';
      return `\ud83d\udcc4 **${fname}**${media}\n\n${preview}${truncated}`;
    } else if (actionName === 'discord_admin') {
      const msg = parsed.message || `\u2705 ${actionName}`;
      const url = parsed.url ? `\n\ud83d\udd17 ${parsed.url}` : '';
      return msg + url;
    } else {
      return '\u2705 ' + actionName + ' \u5b8c\u4e86';
    }
  } else {
    return '\u26a0\ufe0f ' + actionName + ': ' + (parsed.error || '\u30a8\u30e9\u30fc');
  }
}

/** Gate 承認ボタン (L2) */
function createGateButtons(token: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`gate_approve_${token}`)
      .setLabel('\u2705 \u627f\u8a8d')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`gate_deny_${token}`)
      .setLabel('\u274c \u62d2\u5426')
      .setStyle(ButtonStyle.Danger)
  );
}

/** Gate L3: 拒否ボタンのみ (承認はテキスト "YES" 入力) */
function createL3GateButtons(token: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`gate_deny_${token}`)
      .setLabel('\u274c \u62d2\u5426')
      .setStyle(ButtonStyle.Danger)
  );
}

/** gate_responder.py respond を呼ぶ */
async function respondToGate(
  token: string,
  hashPrefix: string | null,
  answer: string
): Promise<{ ok: boolean; reason: string }> {
  try {
    const args = [GATE_RESPONDER_PATH, 'respond', '--token', token, '--answer', answer];
    if (hashPrefix) {
      args.push('--hash', hashPrefix);
    }
    const result = await execPython(args, 10000);
    return JSON.parse(result);
  } catch (err: any) {
    return { ok: false, reason: err.message };
  }
}

/** Gate 承認後にアクション実行 (--skip-gate) */
async function executeGatedAction(actionName: string, paramsStr: string): Promise<string> {
  try {
    const result = await execPython(
      [ACTION_EXECUTOR_PATH, '--action', actionName, '--params', paramsStr, '--skip-gate'],
      180000
    );
    const parsed = JSON.parse(result);
    return formatActionResult(actionName, parsed);
  } catch (err: any) {
    return '\u26a0\ufe0f ' + actionName + ': ' + err.message;
  }
}

/** 期限切れ gate をクリーンアップ */
function cleanupExpiredGates(): void {
  const now = Date.now();
  for (const [token, gate] of pendingGates) {
    if (now > gate.expiresAt) {
      pendingGates.delete(token);
      if (gate.token2) pendingL3SecondStep.delete(gate.token2);
    }
  }
}

async function processIzunaActions(
  text: string,
  channelId: string,
  sendFn: (
    content: string,
    components?: ActionRowBuilder<ButtonBuilder>[]
  ) => Promise<Message | null>
): Promise<{ cleanText: string; actionMessages: string[] }> {
  cleanupExpiredGates();
  const matches = [...text.matchAll(ACTION_HOOK_RE)];
  if (matches.length === 0) return { cleanText: text, actionMessages: [] };
  const cleanText = text.replace(ACTION_HOOK_RE, '').trim();
  const actionMessages: string[] = [];
  for (const m of matches.slice(0, 1)) {
    const actionName = m[1];
    const paramsStr = m[2] || '{}';
    try {
      // Step 1: Gate tier 判定
      const gateResult = await execPython([
        ACTION_EXECUTOR_PATH,
        '--action',
        actionName,
        '--params',
        paramsStr,
        '--check-gate',
      ]);
      const gateInfo = JSON.parse(gateResult);

      if (gateInfo.needs_gate) {
        // L2/L3: Discord 確認 UI を表示
        const tierLabel =
          gateInfo.tier === 'L3_double_confirm'
            ? '\u{1f534} L3 \u4e8c\u91cd\u78ba\u8a8d'
            : '\u{1f7e0} L2 \u5916\u90e8\u52b9\u679c';
        const preview = (gateInfo.preview || '').slice(0, 300);
        const gateMsg = `${tierLabel}\n**Action:** \`${actionName}\`\n\`\`\`json\n${preview}\n\`\`\`\n`;

        let fullMsg: string;
        let components: ActionRowBuilder<ButtonBuilder>[];
        if (gateInfo.tier === 'L3_double_confirm') {
          fullMsg =
            gateMsg +
            '\u26a0\ufe0f **L3 \u4e8c\u91cd\u78ba\u8a8d**: \u627f\u8a8d\u3059\u308b\u306b\u306f `YES` \u3068\u5165\u529b\u3057\u3066\u304f\u3060\u3055\u3044 (5\u5206\u4ee5\u5185)';
          components = [createL3GateButtons(gateInfo.token)];
        } else {
          fullMsg =
            gateMsg +
            '\u627f\u8a8d\u307e\u305f\u306f\u62d2\u5426\u3057\u3066\u304f\u3060\u3055\u3044 (5\u5206\u4ee5\u5185)';
          components = [createGateButtons(gateInfo.token)];
        }

        const sentMsg = await sendFn(fullMsg, components);

        // Pending gate 登録
        pendingGates.set(gateInfo.token, {
          actionName,
          paramsStr,
          hashPrefix: gateInfo.hash_prefix,
          tier: gateInfo.tier,
          token2: gateInfo.token2 || null,
          channelId,
          messageId: sentMsg?.id || '',
          expiresAt: Date.now() + 5 * 60 * 1000,
        });
        if (gateInfo.token2) {
          pendingL3SecondStep.set(gateInfo.token2, gateInfo.token);
        }
        console.log(
          `[gate] Pending ${gateInfo.tier} gate: ${gateInfo.token.slice(0, 12)}... action=${actionName}`
        );
        actionMessages.push(`\u23f3 ${actionName}: \u627f\u8a8d\u5f85\u3061`);
      } else if (gateInfo.decision === 'deny') {
        actionMessages.push(
          `\u{1f6ab} ${actionName}: \u30b2\u30fc\u30c8\u62d2\u5426 \u2014 ${gateInfo.reason}`
        );
      } else {
        // L0/L1: gate 不要 -> 直接実行
        const result = await execPython(
          [ACTION_EXECUTOR_PATH, '--action', actionName, '--params', paramsStr],
          180000
        );
        const parsed = JSON.parse(result);
        actionMessages.push(formatActionResult(actionName, parsed));
      }
    } catch (err: any) {
      actionMessages.push('\u26a0\ufe0f ' + actionName + ': ' + err.message);
    }
  }
  return { cleanText, actionMessages };
}

// === Izuna Worker Direct Execution (Phase 8) ===
// dispatch.py が worker track + agent を特定した場合、LLM をスキップして直接実行する

interface DispatchResult {
  track: string | null;
  agent: string | null;
  mode: string;
  blast_radius?: string;
  reason?: string;
}

/** Worker 簡易クエリの判定キーワード */
const WORKER_AUTO_EXEC_PATTERNS: Record<string, { action: string; keywords: string[] }> = {
  'mail-agent': {
    action: 'trigger_mail',
    keywords: ['確認', 'check', 'チェック', '未読', 'unread', '見て'],
  },
  'calendar-agent': {
    action: 'calendar_list',
    keywords: ['確認', 'check', 'today', '今日', '予定', '一覧', 'リスト'],
  },
  'notion-manager': {
    action: 'notion_tasks',
    keywords: ['タスク', 'tasks', '一覧', '確認', 'リスト'],
  },
};

/**
 * Worker タスクの直接実行を試行する。
 * 成功した場合はフォーマット済みテキストを返す。実行不要/失敗時は null。
 */
async function tryWorkerDirectExec(
  dispatch: DispatchResult,
  rawPrompt: string
): Promise<string | null> {
  if (dispatch.track !== 'worker' || !dispatch.agent) return null;

  const pattern = WORKER_AUTO_EXEC_PATTERNS[dispatch.agent];
  if (!pattern) return null;

  // キーワードマッチ: 簡易クエリ（確認/check系）のみ直接実行
  const promptLower = rawPrompt.toLowerCase();
  const isSimpleQuery = pattern.keywords.some((kw) => promptLower.includes(kw.toLowerCase()));
  if (!isSimpleQuery) return null;

  console.log(`[izuna-worker-exec] Direct executing: ${dispatch.agent} → ${pattern.action}`);

  try {
    if (pattern.action === 'trigger_mail') {
      // メール確認: trigger_mail.py を直接実行
      const result = await new Promise<string>((resolve, reject) => {
        execFile(
          'python3',
          [pathJoin(ACTION_SCRIPTS_DIR, 'trigger_mail.py')],
          {
            timeout: 15000,
            cwd: ACTION_SCRIPTS_DIR,
            env: {
              ...process.env,
              PYTHONPATH: '/Users/suguru/Library/Python/3.9/lib/python/site-packages',
            },
          },
          (err, stdout, stderr) => {
            if (err) {
              reject(new Error(stderr || err.message));
              return;
            }
            resolve(stdout);
          }
        );
      });
      return result.trim() || '未読メールはありません。';
    }

    if (pattern.action === 'calendar_list' || pattern.action === 'notion_tasks') {
      // action_executor.py 経由で実行
      const result = await new Promise<string>((resolve, reject) => {
        execFile(
          'python3',
          [
            pathJoin(ACTION_SCRIPTS_DIR, 'action_executor.py'),
            '--action',
            pattern.action,
            '--params',
            '{}',
          ],
          {
            timeout: 15000,
            cwd: ACTION_SCRIPTS_DIR,
            env: {
              ...process.env,
              PYTHONPATH: '/Users/suguru/Library/Python/3.9/lib/python/site-packages',
            },
          },
          (err, stdout, stderr) => {
            if (err) {
              reject(new Error(stderr || err.message));
              return;
            }
            resolve(stdout);
          }
        );
      });

      const parsed = JSON.parse(result);
      if (!parsed.ok) return null; // LLM にフォールバック

      if (pattern.action === 'calendar_list') {
        const events = parsed.events || [];
        if (events.length === 0) return '📅 今後の予定はありません。';
        const lines = events.map(
          (e: { start: string; summary: string }) => `- ${e.start}  ${e.summary}`
        );
        return `📅 **予定一覧**\n${lines.join('\n')}`;
      }

      if (pattern.action === 'notion_tasks') {
        const tasks = parsed.tasks || [];
        if (tasks.length === 0) return '📋 タスクはありません。';
        const lines = tasks.map(
          (t: { title?: string; status?: string; name?: string }) =>
            `- ${t.title || t.name || '(無題)'}${t.status ? ` [${t.status}]` : ''}`
        );
        return `📋 **タスク一覧**\n${lines.join('\n')}`;
      }
    }
  } catch (err) {
    console.error(
      `[izuna-worker-exec] Direct exec failed (fallback to LLM):`,
      err instanceof Error ? err.message : err
    );
    return null; // LLM にフォールバック
  }

  return null;
}

// === Izuna Dev Agent Spawning (Phase 9) ===
// dispatch.py が dev track を特定した場合、Claude Code を対象リポにスコープしてスポーン

/** Dev エージェント → リポジトリパスのマッピング */
const DEV_AGENT_REPOS: Record<string, string> = {
  'dmat-keychain-agent': pathJoin(process.env.HOME || '', 'projects/dmat-keychain'),
  'koereq-agent': pathJoin(process.env.HOME || '', 'projects/koereq'),
  'nurseai-agent': pathJoin(process.env.HOME || '', 'projects/nurseai'),
  'hayabusa-agent': pathJoin(process.env.HOME || '', 'projects/hayabusa'),
};

/**
 * Dev タスクに対して Claude Code をスポーンし、結果を返す。
 * 対象リポが見つからない場合は null（LLM フォールバック）。
 */
async function spawnDevAgent(
  dispatch: DispatchResult,
  prompt: string,
  channelId: string,
  config: ReturnType<typeof loadConfig>
): Promise<string | null> {
  if (dispatch.track !== 'dev' || !dispatch.agent) return null;

  const repoPath = DEV_AGENT_REPOS[dispatch.agent];
  if (!repoPath) {
    console.warn(`[izuna-dev-agent] Unknown dev agent: ${dispatch.agent}`);
    return null;
  }

  // リポジトリの存在チェック
  try {
    const { statSync } = await import('fs');
    if (!statSync(repoPath).isDirectory()) {
      console.warn(`[izuna-dev-agent] Repo not found: ${repoPath}`);
      return null;
    }
  } catch {
    console.warn(`[izuna-dev-agent] Repo not accessible: ${repoPath}`);
    return null;
  }

  console.log(`[izuna-dev-agent] Spawning Claude Code for ${dispatch.agent} in ${repoPath}`);

  // Claude Code を対象リポにスコープしてワンショット実行
  const devRunner = new ClaudeCodeRunner({
    model: config.agent.config.model,
    timeoutMs: config.agent.config.timeoutMs ?? 300000,
    workdir: repoPath,
    skipPermissions: config.agent.config.skipPermissions ?? false,
    platform: config.agent.platform,
  });

  const devPrompt = `[Dev Agent: ${dispatch.agent}]\n[Repo: ${repoPath}]\n[Blast Radius: ${dispatch.blast_radius || 'unknown'}]\n\n${prompt}`;

  const result = await devRunner.run(devPrompt, { channelId });
  return result.result;
}

// === Phase 10: Magika Guard Hook ===
// パッケージインストールやファイル添付時にセキュリティチェックを実行

const INSTALL_KEYWORDS = [
  'install',
  'インストール',
  'pip install',
  'npm install',
  'brew install',
  '追加',
  '入れて',
  '使いたい',
  'add dependency',
  'require',
  'import',
];

/** インストール系キーワードがメッセージに含まれるか判定 */
function containsInstallKeyword(text: string): boolean {
  const lower = text.toLowerCase();
  return INSTALL_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()));
}

/** メッセージからパッケージマネージャとパッケージ名を抽出 */
function extractPackageInfo(text: string): { manager: string; packageName: string } | null {
  const patterns: { re: RegExp; manager: string }[] = [
    { re: /pip\s+install\s+([a-zA-Z0-9_.-]+)/i, manager: 'pip' },
    { re: /npm\s+install\s+([a-zA-Z0-9@/_.-]+)/i, manager: 'npm' },
    { re: /brew\s+install\s+([a-zA-Z0-9_.-]+)/i, manager: 'brew' },
    { re: /yarn\s+add\s+([a-zA-Z0-9@/_.-]+)/i, manager: 'yarn' },
    { re: /pnpm\s+add\s+([a-zA-Z0-9@/_.-]+)/i, manager: 'pnpm' },
    { re: /cargo\s+add\s+([a-zA-Z0-9_.-]+)/i, manager: 'cargo' },
    { re: /gem\s+install\s+([a-zA-Z0-9_.-]+)/i, manager: 'gem' },
  ];
  for (const { re, manager } of patterns) {
    const m = text.match(re);
    if (m) return { manager, packageName: m[1] };
  }
  return null;
}

/** magika_guard.py scan でファイルをチェック */
async function checkWithMagika(
  target: string,
  expectedType?: string
): Promise<{
  verdict: string;
  reason: string | null;
  detected_type: string;
}> {
  return new Promise((resolve) => {
    const args = ['magika_guard.py', 'scan', target];
    if (expectedType) args.push('--expected', expectedType);
    execFile(
      'python3',
      args,
      { timeout: 15000, cwd: ACTION_SCRIPTS_DIR, env: ACTION_ENV },
      (err, stdout) => {
        if (err) {
          resolve({ verdict: 'error', reason: err.message, detected_type: 'unknown' });
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch {
          resolve({ verdict: 'error', reason: 'parse error', detected_type: 'unknown' });
        }
      }
    );
  });
}

/** magika_guard.py check-package でパッケージをチェック */
async function checkPackageWithMagika(
  manager: string,
  packageName: string
): Promise<{
  verdict: string;
  reason: string | null;
  details: any;
}> {
  return new Promise((resolve) => {
    execFile(
      'python3',
      ['magika_guard.py', 'check-package', manager, packageName],
      { timeout: 30000, cwd: ACTION_SCRIPTS_DIR, env: ACTION_ENV },
      (err, stdout) => {
        if (err) {
          resolve({ verdict: 'error', reason: err.message, details: {} });
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch {
          resolve({ verdict: 'error', reason: 'parse error', details: {} });
        }
      }
    );
  });
}

/** Magika verdict をユーザー向けメッセージに変換（safe は null = 表示なし） */
function formatMagikaVerdict(verdict: string, reason: string | null, label: string): string | null {
  if (verdict === 'safe') return null;
  if (verdict === 'blocked') {
    return `\u{1f6ab} **セキュリティブロック** [${label}]: ${reason || '安全性を確認できませんでした'}`;
  }
  if (verdict === 'suspicious') {
    return `\u26a0\ufe0f **セキュリティ警告** [${label}]: ${reason || '注意が必要です'}`;
  }
  // error or unknown
  return null;
}

/** LLM応答内のインストールコマンドを抽出して全パッケージ情報を返す */
function extractInstallCommandsFromResponse(
  text: string
): { manager: string; packageName: string }[] {
  const results: { manager: string; packageName: string }[] = [];
  const patterns: { re: RegExp; manager: string }[] = [
    { re: /pip\s+install\s+([a-zA-Z0-9_.-]+)/gi, manager: 'pip' },
    { re: /npm\s+install\s+([a-zA-Z0-9@/_.-]+)/gi, manager: 'npm' },
    { re: /brew\s+install\s+([a-zA-Z0-9_.-]+)/gi, manager: 'brew' },
    { re: /yarn\s+add\s+([a-zA-Z0-9@/_.-]+)/gi, manager: 'yarn' },
    { re: /pnpm\s+add\s+([a-zA-Z0-9@/_.-]+)/gi, manager: 'pnpm' },
    { re: /cargo\s+add\s+([a-zA-Z0-9_.-]+)/gi, manager: 'cargo' },
    { re: /gem\s+install\s+([a-zA-Z0-9_.-]+)/gi, manager: 'gem' },
  ];
  for (const { re, manager } of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const pkgName = m[1];
      if (!results.some((r) => r.manager === manager && r.packageName === pkgName)) {
        results.push({ manager, packageName: pkgName });
      }
    }
  }
  return results;
}

// === Izuna Topic Router (Phase 5) ===
const TOPIC_CHANNELS: Record<string, string> = {
  mail: '1492838930213503069',
  'dev-izuna': '1492838995024150588',
  schedule: '1492839063059693568',
  'harness-gate': '1492839143636734013',
  'audit-log': '1492839299933278289',
  sns: '1492839607924953259',
  'dev-dmatkc': '1492839921335930940',
};

const TOPIC_KEYWORDS: Record<string, string[]> = {
  mail: [
    '\u30e1\u30fc\u30eb',
    'mail',
    '\u9001\u4fe1',
    '\u8fd4\u4fe1',
    'draft',
    '\u4e0b\u66f8\u304d',
  ],
  schedule: [
    '\u4e88\u5b9a',
    '\u30ab\u30ec\u30f3\u30c0\u30fc',
    '\u4f1a\u8b70',
    'MTG',
    '\u9762\u8ac7',
    '\u660e\u65e5',
    '\u4eca\u9031',
  ],
  'dev-izuna': [
    '\u30b3\u30fc\u30c9',
    '\u30ea\u30dd',
    'commit',
    'PR',
    'bug',
    '\u5b9f\u88c5',
    '\u4fee\u6b63',
    'koereq',
    'nurseai',
  ],
  'dev-dmatkc': ['dmat', 'DMAT', '\u30ad\u30fc\u30db\u30eb\u30c0\u30fc', 'EC\u30b5\u30a4\u30c8'],
  sns: ['\u6295\u7a3f', 'SNS', 'X', 'Qiita', '\u30d6\u30ed\u30b0'],
};

function classifyTopic(userMsg: string, botResp: string): { topic: string; channelId: string } {
  const combined = (userMsg + ' ' + botResp).toLowerCase();

  // ACTION marker check
  const actionMatch = botResp.match(/\[ACTION:(\w+)/);
  if (actionMatch) {
    const actionMap: Record<string, string> = {
      calendar_create: 'schedule',
      calendar_list: 'schedule',
      calendar_delete: 'schedule',
      gmail_draft: 'mail',
      gmail_context: 'mail',
      mail_process: 'mail',
    };
    const topic = actionMap[actionMatch[1]];
    if (topic && TOPIC_CHANNELS[topic]) {
      return { topic, channelId: TOPIC_CHANNELS[topic] };
    }
  }

  // Keyword match
  let bestTopic = '';
  let bestScore = 0;
  for (const [topic, keywords] of Object.entries(TOPIC_KEYWORDS)) {
    const score = keywords.filter((kw) => combined.includes(kw.toLowerCase())).length;
    if (score > bestScore) {
      bestScore = score;
      bestTopic = topic;
    }
  }

  if (bestTopic && bestScore > 0 && TOPIC_CHANNELS[bestTopic]) {
    return { topic: bestTopic, channelId: TOPIC_CHANNELS[bestTopic] };
  }
  return { topic: 'general', channelId: '' };
}

/** メッセージを指定文字数で分割（カスタムセパレータ対応、デフォルトは行単位） */
function splitMessage(text: string, maxLength: number, separator: string = '\n'): string[] {
  const chunks: string[] = [];
  const blocks = text.split(separator);
  let current = '';
  for (const block of blocks) {
    const sep = current ? separator : '';
    if (current.length + sep.length + block.length > maxLength) {
      if (current) chunks.push(current.trim());
      // 単一ブロックがmaxLengthを超える場合は行単位でフォールバック
      if (block.length > maxLength) {
        const lines = block.split('\n');
        current = '';
        for (const line of lines) {
          if (current.length + line.length + 1 > maxLength) {
            if (current) chunks.push(current.trim());
            current = line;
          } else {
            current += (current ? '\n' : '') + line;
          }
        }
      } else {
        current = block;
      }
    } else {
      current += sep + block;
    }
  }
  if (current) chunks.push(current.trim());
  return chunks;
}

/** スケジュール一覧をDiscord向けに分割する */
function splitScheduleContent(content: string, maxLength: number): string[] {
  const sep = '\n' + SCHEDULE_SEPARATOR + '\n';
  const chunks = splitMessage(content, maxLength, sep);
  return chunks.map((c) => c.replaceAll(SCHEDULE_SEPARATOR, ''));
}

/** スケジュールタイプに応じたラベルを生成 */
function getTypeLabel(
  type: ScheduleType,
  options: { expression?: string; runAt?: string; channelInfo?: string }
): string {
  const channelInfo = options.channelInfo || '';
  switch (type) {
    case 'cron':
      return `🔄 繰り返し: \`${options.expression}\`${channelInfo}`;
    case 'startup':
      return `🚀 起動時に実行${channelInfo}`;
    case 'once':
    default:
      return `⏰ 実行時刻: ${new Date(options.runAt!).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}${channelInfo}`;
  }
}

// チャンネルごとの最後に送信したボットメッセージID
const lastSentMessageIds = new Map<string, string>();

/** 処理中に表示するStopボタン */
function createStopButton(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('xangi_stop').setLabel('Stop').setStyle(ButtonStyle.Secondary)
  );
}

/** 完了後に表示するNew Sessionボタン */
function createCompletedButtons(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('xangi_new').setLabel('New').setStyle(ButtonStyle.Secondary)
  );
}

/**
 * ツール入力の要約を生成（Discord表示用）
 */
function formatToolInput(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case 'Read':
      return input.file_path ? `: ${String(input.file_path).split('/').slice(-2).join('/')}` : '';
    case 'Edit':
    case 'Write':
      return input.file_path ? `: ${String(input.file_path).split('/').slice(-2).join('/')}` : '';
    case 'Bash': {
      if (!input.command) return '';
      const cmd = String(input.command);
      const cmdDisplay = `: \`${cmd.slice(0, 60)}${cmd.length > 60 ? '...' : ''}\``;
      const ghBadge = cmd.startsWith('gh ') && isGitHubAppEnabled() ? ' 🔑App' : '';
      return cmdDisplay + ghBadge;
    }
    case 'Glob':
      return input.pattern ? `: ${String(input.pattern)}` : '';
    case 'Grep':
      return input.pattern ? `: ${String(input.pattern)}` : '';
    case 'WebFetch':
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

import { fileURLToPath } from 'node:url';
const __ESM_FILE = fileURLToPath(import.meta.url);
const __ESM_DIR = pathJoin(__ESM_FILE, '..');

function getGitShortSha(): string {
  try {
    return execSync('git rev-parse HEAD', { cwd: pathJoin(__ESM_DIR, '..') })
      .toString()
      .trim()
      .slice(0, 7);
  } catch {
    return 'unknown';
  }
}

function assertDistFresh(): void {
  const srcDir = pathJoin(__ESM_DIR, '..', 'src');
  const srcIndex = pathJoin(srcDir, 'index.ts');
  const distIndex = __ESM_FILE;
  const gitSha = getGitShortSha();
  try {
    const srcStat = statSync(srcIndex);
    const distStat = statSync(distIndex);
    if (srcStat.mtimeMs > distStat.mtimeMs) {
      const delta = Math.round((srcStat.mtimeMs - distStat.mtimeMs) / 1000);
      console.error(
        '[FATAL] dist stale: src/index.ts is ' +
          delta +
          's newer than dist/index.js. Run npm run build and restart. git=' +
          gitSha
      );
      process.exit(1);
    }
    console.log(
      '[startup] build check OK: git=' +
        gitSha +
        ' dist=' +
        new Date(distStat.mtimeMs).toISOString() +
        ' src=' +
        new Date(srcStat.mtimeMs).toISOString()
    );
  } catch (e) {
    console.error('[startup] build check skipped (dev mode?):', (e as Error).message);
  }
}

async function main() {
  assertDistFresh();
  const config = loadConfig();

  // 許可リストのチェック（"*" で全員許可、カンマ区切りで複数ユーザー対応）
  const discordAllowed = config.discord.allowedUsers || [];
  const slackAllowed = config.slack.allowedUsers || [];

  if (config.discord.enabled && discordAllowed.length === 0) {
    console.error('[xangi] Error: DISCORD_ALLOWED_USER must be set (use "*" to allow everyone)');
    process.exit(1);
  }
  if (config.slack.enabled && slackAllowed.length === 0) {
    console.error('[xangi] Error: SLACK_ALLOWED_USER must be set (use "*" to allow everyone)');
    process.exit(1);
  }

  if (discordAllowed.includes('*')) {
    console.log('[xangi] Discord: All users are allowed');
  } else {
    console.log(`[xangi] Discord: Allowed users: ${discordAllowed.join(', ')}`);
  }
  if (slackAllowed.includes('*')) {
    console.log('[xangi] Slack: All users are allowed');
  } else if (slackAllowed.length > 0) {
    console.log(`[xangi] Slack: Allowed users: ${slackAllowed.join(', ')}`);
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  // エージェントランナーを作成
  const agentRunner = createAgentRunner(config.agent.backend, config.agent.config, {
    platform: config.agent.platform,
  });
  const backendName = getBackendDisplayName(config.agent.backend);
  console.log(
    `[xangi] Using ${backendName} as agent backend (platform: ${config.agent.platform ?? 'all'})`
  );

  // スキルを読み込み
  const workdir = config.agent.config.workdir || process.cwd();
  let skills: Skill[] = loadSkills(workdir);
  console.log(`[xangi] Loaded ${skills.length} skills from ${workdir}`);

  // 設定を初期化
  initSettings(workdir);
  const initialSettings = loadSettings();
  console.log(`[xangi] Settings loaded: autoRestart=${initialSettings.autoRestart}`);

  // スケジューラを初期化（ワークスペースの .xangi を使用）
  const dataDir = process.env.DATA_DIR || join(workdir, '.xangi');
  const scheduler = new Scheduler(dataDir);

  // セッション永続化を初期化
  initSessions(dataDir);

  // GitHub認証を初期化
  const { initGitHubAuth } = await import('./github-auth.js');
  initGitHubAuth();

  // スラッシュコマンド定義
  const commands: ReturnType<SlashCommandBuilder['toJSON']>[] = [
    new SlashCommandBuilder().setName('new').setDescription('新しいセッションを開始する').toJSON(),
    new SlashCommandBuilder().setName('stop').setDescription('実行中のタスクを停止する').toJSON(),
    new SlashCommandBuilder()
      .setName('skills')
      .setDescription('利用可能なスキル一覧を表示')
      .toJSON(),
    new SlashCommandBuilder()
      .setName('skill')
      .setDescription('スキルを実行する')
      .addStringOption((option) =>
        option.setName('name').setDescription('スキル名').setRequired(true).setAutocomplete(true)
      )
      .addStringOption((option) => option.setName('args').setDescription('引数').setRequired(false))
      .toJSON(),
    new SlashCommandBuilder().setName('settings').setDescription('現在の設定を表示する').toJSON(),
    new SlashCommandBuilder().setName('restart').setDescription('ボットを再起動する').toJSON(),
    new SlashCommandBuilder()
      .setName('skip')
      .setDescription('許可確認をスキップしてメッセージを実行')
      .addStringOption((option) =>
        option.setName('message').setDescription('実行するメッセージ').setRequired(true)
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName('schedule')
      .setDescription('スケジュール管理')
      .addSubcommand((sub) =>
        sub
          .setName('add')
          .setDescription('スケジュールを追加')
          .addStringOption((opt) =>
            opt
              .setName('input')
              .setDescription('例: "30分後 ミーティング" / "毎日 9:00 おはよう"')
              .setRequired(true)
          )
      )
      .addSubcommand((sub) => sub.setName('list').setDescription('スケジュール一覧を表示'))
      .addSubcommand((sub) =>
        sub
          .setName('remove')
          .setDescription('スケジュールを削除')
          .addStringOption((opt) =>
            opt.setName('id').setDescription('スケジュールID').setRequired(true)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName('toggle')
          .setDescription('スケジュールの有効/無効を切り替え')
          .addStringOption((opt) =>
            opt.setName('id').setDescription('スケジュールID').setRequired(true)
          )
      )
      .toJSON(),
  ];

  // 各スキルを個別のスラッシュコマンドとして追加
  for (const skill of skills) {
    // Discordコマンド名は小文字英数字とハイフンのみ（最大32文字）
    const cmdName = skill.name
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 32);

    if (cmdName) {
      commands.push(
        new SlashCommandBuilder()
          .setName(cmdName)
          .setDescription(skill.description.slice(0, 100) || `${skill.name}スキルを実行`)
          .addStringOption((option) =>
            option.setName('args').setDescription('引数（任意）').setRequired(false)
          )
          .toJSON()
      );
    }
  }

  // スラッシュコマンド登録
  client.once(Events.ClientReady, async (c) => {
    console.log(`[xangi] Ready! Logged in as ${c.user.tag}`);

    const rest = new REST({ version: '10' }).setToken(config.discord.token);
    try {
      // ギルドコマンドとして登録（即時反映）
      const guilds = c.guilds.cache;
      console.log(`[xangi] Found ${guilds.size} guilds`);

      for (const [guildId, guild] of guilds) {
        await rest.put(Routes.applicationGuildCommands(c.user.id, guildId), {
          body: commands,
        });
        console.log(`[xangi] ${commands.length} slash commands registered for: ${guild.name}`);
      }

      // グローバルコマンドをクリア（重複防止）
      await rest.put(Routes.applicationCommands(c.user.id), { body: [] });
      console.log('[xangi] Cleared global commands');
    } catch (error) {
      console.error('[xangi] Failed to register slash commands:', error);
    }
  });

  // スラッシュコマンド処理
  client.on(Events.InteractionCreate, async (interaction) => {
    // オートコンプリート処理
    if (interaction.isAutocomplete()) {
      await handleAutocomplete(interaction, skills);
      return;
    }

    // ボタンインタラクション処理
    if (interaction.isButton()) {
      const channelId = interaction.channelId;
      // 許可チェック
      if (
        !config.discord.allowedUsers?.includes('*') &&
        !config.discord.allowedUsers?.includes(interaction.user.id)
      ) {
        await interaction.reply({ content: '許可されていないユーザーです', ephemeral: true });
        return;
      }

      if (interaction.customId === 'xangi_stop') {
        const stopped = processManager.stop(channelId) || agentRunner.cancel?.(channelId) || false;
        await interaction.deferUpdate().catch(() => {});
        if (!stopped) {
          await interaction.followUp({
            content: '実行中のタスクがありません',
            ephemeral: true,
          });
        }
        return;
      }

      if (interaction.customId === 'xangi_new') {
        deleteSession(channelId);
        agentRunner.destroy?.(channelId);
        // ボタンを消してメッセージを更新
        await interaction
          .update({
            components: [],
          })
          .catch(() => {});
        await interaction
          .followUp({ content: '🆕 新しいセッションを開始しました', ephemeral: true })
          .catch(() => {});
        return;
      }

      // === Gate approval/deny buttons (Phase 4b) ===
      if (interaction.customId.startsWith('gate_approve_')) {
        const token = interaction.customId.replace('gate_approve_', '');
        const gate = pendingGates.get(token);
        if (!gate) {
          await interaction.reply({
            content:
              '\u26a0\ufe0f \u30b2\u30fc\u30c8\u304c\u671f\u9650\u5207\u308c\u307e\u305f\u306f\u5b58\u5728\u3057\u307e\u305b\u3093',
            ephemeral: true,
          });
          return;
        }
        await interaction.deferUpdate().catch(() => {});

        // gate_responder に "ok" を送る
        const resp = await respondToGate(token, gate.hashPrefix, 'ok');
        if (!resp.ok) {
          await interaction.followUp({
            content: `\u274c \u30b2\u30fc\u30c8\u627f\u8a8d\u5931\u6557: ${resp.reason}`,
            ephemeral: true,
          });
          pendingGates.delete(token);
          return;
        }

        // L3 の場合は二重確認が必要 (テキスト "YES" 待ち) — L2 のみここで実行
        if (gate.tier === 'L3_double_confirm') {
          // L3 は approve ボタンなし (テキスト入力で "YES")
          pendingGates.delete(token);
          return;
        }

        // L2: 承認成功 → アクション実行
        console.log(`[gate] L2 approved: ${token.slice(0, 12)}... action=${gate.actionName}`);
        const resultMsg = await executeGatedAction(gate.actionName, gate.paramsStr);
        pendingGates.delete(token);

        // ボタンを消してメッセージ更新
        await interaction.editReply({ components: [] }).catch(() => {});
        await interaction.followUp({ content: resultMsg }).catch(() => {});

        // harness-gate チャンネルにログ送信
        try {
          const gateChannelId = TOPIC_CHANNELS['harness-gate'];
          if (gateChannelId) {
            const gateChannel = await (interaction.client as any).channels
              .fetch(gateChannelId)
              .catch(() => null);
            if (gateChannel && 'send' in gateChannel) {
              await (gateChannel as any)
                .send(
                  `\u2705 **Gate L2 \u627f\u8a8d**: \`${gate.actionName}\` by ${interaction.user.tag}\n${resultMsg}`
                )
                .catch(() => {});
            }
          }
        } catch {
          /* ignore logging errors */
        }
        return;
      }

      if (interaction.customId.startsWith('gate_deny_')) {
        const token = interaction.customId.replace('gate_deny_', '');
        const gate = pendingGates.get(token);
        if (!gate) {
          await interaction.reply({
            content:
              '\u26a0\ufe0f \u30b2\u30fc\u30c8\u304c\u671f\u9650\u5207\u308c\u307e\u305f\u306f\u5b58\u5728\u3057\u307e\u305b\u3093',
            ephemeral: true,
          });
          return;
        }
        await interaction.deferUpdate().catch(() => {});

        // gate_responder に "no" を送る
        await respondToGate(token, null, 'no');
        console.log(`[gate] Denied: ${token.slice(0, 12)}... action=${gate.actionName}`);

        pendingGates.delete(token);
        if (gate.token2) pendingL3SecondStep.delete(gate.token2);

        // ボタンを消して拒否メッセージ
        await interaction.editReply({ components: [] }).catch(() => {});
        await interaction
          .followUp({
            content: `\u274c ${gate.actionName}: \u62d2\u5426\u3055\u308c\u307e\u3057\u305f`,
          })
          .catch(() => {});

        // harness-gate チャンネルにログ
        try {
          const gateChannelId = TOPIC_CHANNELS['harness-gate'];
          if (gateChannelId) {
            const gateChannel = await (interaction.client as any).channels
              .fetch(gateChannelId)
              .catch(() => null);
            if (gateChannel && 'send' in gateChannel) {
              await (gateChannel as any)
                .send(
                  `\u274c **Gate \u62d2\u5426**: \`${gate.actionName}\` by ${interaction.user.tag}`
                )
                .catch(() => {});
            }
          }
        } catch {
          /* ignore logging errors */
        }
        return;
      }

      // 未知のボタン → 何もせずACK
      await interaction.deferUpdate().catch(() => {});
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    // 許可リストチェック（"*" で全員許可）
    if (
      !config.discord.allowedUsers?.includes('*') &&
      !config.discord.allowedUsers?.includes(interaction.user.id)
    ) {
      await interaction.reply({ content: '許可されていないユーザーです', ephemeral: true });
      return;
    }

    const channelId = interaction.channelId;

    if (interaction.commandName === 'new') {
      deleteSession(channelId);
      agentRunner.destroy?.(channelId);
      await interaction.reply('🆕 新しいセッションを開始しました');
      return;
    }

    if (interaction.commandName === 'stop') {
      const stopped = processManager.stop(channelId) || agentRunner.cancel?.(channelId) || false;
      if (stopped) {
        await interaction.reply('🛑 タスクを停止しました');
      } else {
        await interaction.reply({ content: '実行中のタスクはありません', ephemeral: true });
      }
      return;
    }

    if (interaction.commandName === 'settings') {
      const settings = loadSettings();
      await interaction.reply(formatSettings(settings));
      return;
    }

    if (interaction.commandName === 'skip') {
      const skipMessage = interaction.options.getString('message', true);
      await interaction.deferReply();

      try {
        const sessionId = getSession(channelId);

        // ワンショットのClaudeCodeRunnerを使用（skipPermissionsを確実に反映するため）
        const skipRunner = new ClaudeCodeRunner(config.agent.config);
        const runResult = await skipRunner.run(skipMessage, {
          skipPermissions: true,
          sessionId,
          channelId,
        });

        setSession(channelId, runResult.sessionId);

        // ファイルパスを抽出して添付送信
        const filePaths = extractFilePaths(runResult.result);
        const displayText =
          filePaths.length > 0 ? stripFilePaths(runResult.result) : runResult.result;
        const cleanText = stripCommandsFromDisplay(displayText);

        const chunks = splitMessage(cleanText, DISCORD_SAFE_LENGTH);
        await interaction.editReply(chunks[0] || '✅');
        if (chunks.length > 1 && 'send' in interaction.channel!) {
          const channel = interaction.channel as unknown as {
            send: (content: string) => Promise<unknown>;
          };
          for (let i = 1; i < chunks.length; i++) {
            await channel.send(chunks[i]);
          }
        }

        // ファイル添付送信
        if (filePaths.length > 0 && interaction.channel && 'send' in interaction.channel) {
          try {
            await (
              interaction.channel as unknown as {
                send: (options: { files: { attachment: string }[] }) => Promise<unknown>;
              }
            ).send({
              files: filePaths.map((fp) => ({ attachment: fp })),
            });
            console.log(`[xangi] Sent ${filePaths.length} file(s) via /skip`);
          } catch (err) {
            console.error('[xangi] Failed to send files via /skip:', err);
          }
        }

        // SYSTEM_COMMAND処理
        handleSettingsFromResponse(runResult.result);

        // !discord コマンド処理
        if (interaction.channel) {
          const fakeMessage = { channel: interaction.channel } as Message;
          await handleDiscordCommandsInResponse(runResult.result, fakeMessage);
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        let errorDetail: string;
        if (errorMsg.includes('timed out')) {
          errorDetail = `⏱️ タイムアウトしました`;
        } else if (errorMsg.includes('Process exited unexpectedly')) {
          errorDetail = `💥 AIプロセスが予期せず終了しました`;
        } else if (errorMsg.includes('Circuit breaker')) {
          errorDetail = '🔌 AIプロセスが一時停止中です';
        } else {
          errorDetail = `❌ エラー: ${errorMsg.slice(0, 200)}`;
        }
        await interaction.editReply(errorDetail).catch(() => {});
      }
      return;
    }

    if (interaction.commandName === 'restart') {
      const settings = loadSettings();
      if (!settings.autoRestart) {
        await interaction.reply('⚠️ 自動再起動が無効です。先に有効にしてください。');
        return;
      }
      await interaction.reply('🔄 再起動します...');
      setTimeout(() => process.exit(0), 1000);
      return;
    }

    if (interaction.commandName === 'schedule') {
      await handleScheduleCommand(interaction, scheduler, config.scheduler);
      return;
    }

    if (interaction.commandName === 'skills') {
      // スキルを再読み込み
      skills = loadSkills(workdir);
      await interaction.reply(formatSkillList(skills));
      return;
    }

    if (interaction.commandName === 'skill') {
      await handleSkill(interaction, agentRunner, config, channelId);
      return;
    }

    // 個別スキルコマンドの処理
    const matchedSkill = skills.find((s) => {
      const cmdName = s.name
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 32);
      return cmdName === interaction.commandName;
    });

    if (matchedSkill) {
      await handleSkillCommand(interaction, agentRunner, config, channelId, matchedSkill.name);
      return;
    }
  });

  // Discordリンクからメッセージ内容を取得する関数
  async function fetchDiscordLinkContent(text: string): Promise<string> {
    const linkRegex = /https?:\/\/(?:www\.)?discord\.com\/channels\/(\d+)\/(\d+)\/(\d+)/g;
    const matches = [...text.matchAll(linkRegex)];

    if (matches.length === 0) return text;

    let result = text;
    for (const match of matches) {
      const [fullUrl, , channelId, messageId] = match;
      try {
        const channel = await client.channels.fetch(channelId);
        if (channel && 'messages' in channel) {
          const fetchedMessage = await channel.messages.fetch(messageId);
          const author = fetchedMessage.author.tag;
          const content = fetchedMessage.content || '(添付ファイルのみ)';
          const attachmentInfo =
            fetchedMessage.attachments.size > 0
              ? `\n[添付: ${fetchedMessage.attachments.map((a) => a.name).join(', ')}]`
              : '';

          const quotedContent = `\n---\n📎 引用メッセージ (${author}):\n${content}${attachmentInfo}\n---\n`;
          result = result.replace(fullUrl, quotedContent);
          console.log(`[xangi] Fetched linked message from channel ${channelId}`);
        }
      } catch (err) {
        console.error(`[xangi] Failed to fetch linked message: ${fullUrl}`, err);
        // 取得失敗時はリンクをそのまま残す
      }
    }

    return result;
  }

  // 返信元メッセージを取得してプロンプトに追加する関数
  async function fetchReplyContent(message: Message): Promise<string | null> {
    if (!message.reference?.messageId) return null;

    try {
      const channel = message.channel;
      if (!('messages' in channel)) return null;

      const repliedMessage = await channel.messages.fetch(message.reference.messageId);
      const author = repliedMessage.author.tag;
      const content = repliedMessage.content || '(添付ファイルのみ)';
      const attachmentInfo =
        repliedMessage.attachments.size > 0
          ? `\n[添付: ${repliedMessage.attachments.map((a) => a.name).join(', ')}]`
          : '';

      console.log(`[xangi] Fetched reply-to message from ${author}`);
      return `\n---\n💬 返信元 (${author}):\n${content}${attachmentInfo}\n---\n`;
    } catch (err) {
      console.error(`[xangi] Failed to fetch reply-to message:`, err);
      return null;
    }
  }

  /**
   * メッセージコンテンツ内のチャンネルメンション <#ID> を無害化する
   * fetchChannelMessages() による意図しない二重展開を防ぐ
   */
  function sanitizeChannelMentions(content: string): string {
    return content.replace(/<#(\d+)>/g, '#$1');
  }

  // チャンネルメンションから最新メッセージを取得する関数
  async function fetchChannelMessages(text: string): Promise<string> {
    const channelMentionRegex = /<#(\d+)>/g;
    const matches = [...text.matchAll(channelMentionRegex)];

    if (matches.length === 0) return text;

    let result = text;
    for (const match of matches) {
      const [fullMention, channelId] = match;
      try {
        const channel = await client.channels.fetch(channelId);
        if (channel && 'messages' in channel) {
          const messages = await channel.messages.fetch({ limit: 10 });
          const channelName = 'name' in channel ? channel.name : 'unknown';

          const messageList = messages
            .reverse()
            .map((m) => {
              const time = m.createdAt.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
              const content = sanitizeChannelMentions(m.content || '(添付ファイルのみ)');
              return `[${time}] ${m.author.tag}: ${content}`;
            })
            .join('\n');

          const expandedContent = `\n---\n📺 #${channelName} の最新メッセージ:\n${messageList}\n---\n`;
          result = result.replace(fullMention, expandedContent);
          console.log(`[xangi] Fetched messages from channel #${channelName}`);
        }
      } catch (err) {
        console.error(`[xangi] Failed to fetch channel messages: ${channelId}`, err);
      }
    }

    return result;
  }

  /**
   * チャンネルメンション <#ID> にチャンネルID注釈を追加
   * 例: <#123456> → <#123456> [チャンネルID: 123456]
   */
  function annotateChannelMentions(text: string): string {
    return text.replace(/<#(\d+)>/g, (match, id) => `${match} [チャンネルID: ${id}]`);
  }

  /**
   * Discord の 2000 文字制限に合わせてメッセージを分割する
   */
  function chunkDiscordMessage(message: string, limit = DISCORD_MAX_LENGTH): string[] {
    if (message.length <= limit) return [message];

    const chunks: string[] = [];
    let buf = '';

    for (const line of message.split('\n')) {
      if (line.length > limit) {
        // 1行が limit 超え → バッファをフラッシュしてハードスプリット
        if (buf) {
          chunks.push(buf);
          buf = '';
        }
        for (let j = 0; j < line.length; j += limit) {
          chunks.push(line.slice(j, j + limit));
        }
        continue;
      }
      const candidate = buf ? `${buf}\n${line}` : line;
      if (candidate.length > limit) {
        chunks.push(buf);
        buf = line;
      } else {
        buf = candidate;
      }
    }
    if (buf) chunks.push(buf);
    return chunks;
  }

  // Discordコマンドを処理する関数
  // feedback: true の場合、response をDiscordに送信せずエージェントに再注入する
  async function handleDiscordCommand(
    text: string,
    sourceMessage?: Message,
    fallbackChannelId?: string
  ): Promise<{ handled: boolean; response?: string; feedback?: boolean }> {
    // !discord send <#channelId> message (複数行対応)
    const sendMatch = text.match(/^!discord\s+send\s+<#(\d+)>\s+(.+)$/s);
    if (sendMatch) {
      const [, channelId, content] = sendMatch;
      try {
        const channel = await client.channels.fetch(channelId);
        if (channel && 'send' in channel) {
          const typedChannel = channel as {
            send: (options: {
              content: string;
              allowedMentions: { parse: never[] };
            }) => Promise<unknown>;
          };
          // 2000文字制限に合わせて分割送信
          const chunks = chunkDiscordMessage(content);
          for (const chunk of chunks) {
            await typedChannel.send({
              content: chunk,
              allowedMentions: { parse: [] },
            });
          }
          const channelName = 'name' in channel ? channel.name : 'unknown';
          console.log(`[xangi] Sent message to #${channelName} (${chunks.length} chunk(s))`);
          return { handled: true, response: `✅ #${channelName} にメッセージを送信しました` };
        }
      } catch (err) {
        console.error(`[xangi] Failed to send message to channel: ${channelId}`, err);
        return { handled: true, response: `❌ チャンネルへの送信に失敗しました` };
      }
    }

    // !discord channels
    if (text.match(/^!discord\s+channels$/)) {
      if (!sourceMessage) {
        return {
          handled: true,
          response: '⚠️ channels コマンドはスケジューラーからは使用できません',
        };
      }
      try {
        const guild = sourceMessage.guild;
        if (guild) {
          const channels = guild.channels.cache
            .filter((c) => c.type === 0) // テキストチャンネルのみ
            .map((c) => `- #${c.name} (<#${c.id}>)`)
            .join('\n');
          return { handled: true, response: `📺 チャンネル一覧:\n${channels}` };
        }
      } catch (err) {
        console.error(`[xangi] Failed to list channels`, err);
        return { handled: true, response: `❌ チャンネル一覧の取得に失敗しました` };
      }
    }

    // !discord history [件数] [offset:N] [チャンネルID]
    const historyMatch = text.match(
      /^!discord\s+history(?:\s+(\d+))?(?:\s+offset:(\d+))?(?:\s+<#(\d+)>)?$/
    );
    if (historyMatch) {
      const count = Math.min(parseInt(historyMatch[1] || '10', 10), 100);
      const offset = parseInt(historyMatch[2] || '0', 10);
      const targetChannelId = historyMatch[3];
      try {
        let targetChannel;
        if (targetChannelId) {
          targetChannel = await client.channels.fetch(targetChannelId);
        } else if (sourceMessage) {
          targetChannel = sourceMessage.channel;
        } else if (fallbackChannelId) {
          targetChannel = await client.channels.fetch(fallbackChannelId);
        }

        if (targetChannel && 'messages' in targetChannel) {
          let beforeId: string | undefined;

          // offset指定時: まずoffset分のメッセージを取得してスキップ
          if (offset > 0) {
            const skipMessages = await targetChannel.messages.fetch({ limit: offset });
            if (skipMessages.size > 0) {
              beforeId = skipMessages.lastKey();
            }
          }

          const fetchOptions: { limit: number; before?: string } = { limit: count };
          if (beforeId) {
            fetchOptions.before = beforeId;
          }
          const messages = await targetChannel.messages.fetch(fetchOptions);
          const channelName = 'name' in targetChannel ? targetChannel.name : 'unknown';

          const rangeStart = offset;
          const rangeEnd = offset + messages.size;
          const messageList = messages
            .reverse()
            .map((m) => {
              const time = m.createdAt.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
              const content = sanitizeChannelMentions(
                (m.content || '(添付ファイルのみ)').slice(0, 200)
              );
              const attachments =
                m.attachments.size > 0
                  ? '\n' + m.attachments.map((a) => `  📎 ${a.name} ${a.url}`).join('\n')
                  : '';
              return `[${time}] (ID:${m.id}) ${m.author.tag}: ${content}${attachments}`;
            })
            .join('\n');

          const offsetLabel =
            offset > 0 ? `${rangeStart}〜${rangeEnd}件目` : `最新${messages.size}件`;
          console.log(
            `[xangi] Fetched ${messages.size} history messages from #${channelName} (offset: ${offset})`
          );
          return {
            handled: true,
            feedback: true,
            response: `📺 #${channelName} のチャンネル履歴（${offsetLabel}）:\n${messageList}`,
          };
        }

        if (!sourceMessage && !targetChannelId && !fallbackChannelId) {
          return {
            handled: true,
            feedback: true,
            response:
              '⚠️ history コマンドはチャンネルIDを指定してください（例: !discord history 20 <#123>）',
          };
        }
        return { handled: true, feedback: true, response: '❌ チャンネルが見つかりません' };
      } catch (err) {
        console.error(`[xangi] Failed to fetch history`, err);
        return { handled: true, feedback: true, response: '❌ 履歴の取得に失敗しました' };
      }
    }

    // !discord search <keyword>
    const searchMatch = text.match(/^!discord\s+search\s+(.+)$/);
    if (searchMatch) {
      if (!sourceMessage) {
        return {
          handled: true,
          response: '⚠️ search コマンドはスケジューラーからは使用できません',
        };
      }
      const [, keyword] = searchMatch;
      try {
        // 現在のチャンネルで検索
        const channel = sourceMessage.channel;
        if ('messages' in channel) {
          const messages = await channel.messages.fetch({ limit: 100 });
          const matched = messages.filter((m) =>
            m.content.toLowerCase().includes(keyword.toLowerCase())
          );
          if (matched.size > 0) {
            const results = matched
              .first(10)
              ?.map((m) => {
                const time = m.createdAt.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
                return `[${time}] ${m.author.tag}: ${sanitizeChannelMentions(m.content.slice(0, 200))}`;
              })
              .join('\n');
            return {
              handled: true,
              feedback: true,
              response: `🔍 「${keyword}」の検索結果 (${matched.size}件):\n${results}`,
            };
          }
        }
        return {
          handled: true,
          feedback: true,
          response: `🔍 「${keyword}」に一致するメッセージが見つかりませんでした`,
        };
      } catch (err) {
        console.error(`[xangi] Failed to search messages`, err);
        return { handled: true, response: `❌ 検索に失敗しました` };
      }
    }

    // !discord delete <messageId or link>
    const deleteMatch = text.match(/^!discord\s+delete\s+(.+)$/);
    if (deleteMatch) {
      const arg = deleteMatch[1].trim();

      try {
        let messageId: string;
        let targetChannelId: string | undefined;

        // メッセージリンクからチャンネルIDとメッセージIDを抽出
        const linkMatch = arg.match(/discord\.com\/channels\/\d+\/(\d+)\/(\d+)/);
        if (linkMatch) {
          targetChannelId = linkMatch[1];
          messageId = linkMatch[2];
        } else if (/^\d+$/.test(arg)) {
          messageId = arg;
        } else {
          return {
            handled: true,
            feedback: true,
            response: '❌ 無効な形式です。メッセージIDまたはリンクを指定してください',
          };
        }

        // リンクからチャンネルIDが取れた場合はそのチャンネルを使う、なければ現在のチャンネル
        let channel;
        if (targetChannelId) {
          channel = await client.channels.fetch(targetChannelId);
        } else if (sourceMessage) {
          channel = sourceMessage.channel;
        } else if (fallbackChannelId) {
          channel = await client.channels.fetch(fallbackChannelId);
        }

        if (channel && 'messages' in channel) {
          const msg = await channel.messages.fetch(messageId);
          // 自分のメッセージのみ削除可能
          if (msg.author.id !== client.user?.id) {
            return {
              handled: true,
              feedback: true,
              response: '❌ 自分のメッセージのみ削除できます',
            };
          }
          await msg.delete();
          const deletedChannelId =
            targetChannelId || sourceMessage?.channel.id || fallbackChannelId;
          console.log(`[xangi] Deleted message ${messageId} in channel ${deletedChannelId}`);
          return { handled: true, feedback: true, response: '🗑️ メッセージを削除しました' };
        }
        return {
          handled: true,
          feedback: true,
          response: '❌ このチャンネルではメッセージを削除できません',
        };
      } catch (err) {
        console.error(`[xangi] Failed to delete message:`, err);
        return { handled: true, feedback: true, response: '❌ メッセージの削除に失敗しました' };
      }
    }

    // !discord edit <messageId or link> <newContent>
    const editMatch = text.match(/^!discord\s+edit\s+(\S+)\s+([\s\S]+)$/);
    if (editMatch) {
      const arg = editMatch[1].trim();
      const newContent = editMatch[2].trim();

      if (!newContent) {
        return {
          handled: true,
          feedback: true,
          response: '❌ 編集後のメッセージ内容を指定してください',
        };
      }

      try {
        let messageId: string;
        let targetChannelId: string | undefined;

        if (arg === 'last') {
          // 直前の自分のメッセージを編集
          const currentChannelId = sourceMessage?.channel.id || fallbackChannelId;
          if (!currentChannelId) {
            return {
              handled: true,
              feedback: true,
              response: '❌ チャンネルが特定できません',
            };
          }
          const lastId = lastSentMessageIds.get(currentChannelId);
          if (!lastId) {
            return {
              handled: true,
              feedback: true,
              response:
                '❌ 直前のメッセージが見つかりません（このセッションでまだ送信していない可能性があります）',
            };
          }
          messageId = lastId;
        } else {
          // メッセージリンクからチャンネルIDとメッセージIDを抽出
          const linkMatch = arg.match(/discord\.com\/channels\/\d+\/(\d+)\/(\d+)/);
          if (linkMatch) {
            targetChannelId = linkMatch[1];
            messageId = linkMatch[2];
          } else if (/^\d+$/.test(arg)) {
            messageId = arg;
          } else {
            return {
              handled: true,
              feedback: true,
              response: '❌ 無効な形式です。メッセージID、リンク、または last を指定してください',
            };
          }
        }

        // リンクからチャンネルIDが取れた場合はそのチャンネルを使う、なければ現在のチャンネル
        let channel;
        if (targetChannelId) {
          channel = await client.channels.fetch(targetChannelId);
        } else if (sourceMessage) {
          channel = sourceMessage.channel;
        } else if (fallbackChannelId) {
          channel = await client.channels.fetch(fallbackChannelId);
        }

        if (channel && 'messages' in channel) {
          const msg = await channel.messages.fetch(messageId);
          // 自分のメッセージのみ編集可能
          if (msg.author.id !== client.user?.id) {
            return {
              handled: true,
              feedback: true,
              response: '❌ 自分のメッセージのみ編集できます',
            };
          }
          await msg.edit(newContent);
          const editedChannelId = targetChannelId || sourceMessage?.channel.id || fallbackChannelId;
          console.log(`[xangi] Edited message ${messageId} in channel ${editedChannelId}`);
          return { handled: true, feedback: true, response: '✏️ メッセージを編集しました' };
        }
        return {
          handled: true,
          feedback: true,
          response: '❌ このチャンネルではメッセージを編集できません',
        };
      } catch (err) {
        console.error(`[xangi] Failed to edit message:`, err);
        return { handled: true, feedback: true, response: '❌ メッセージの編集に失敗しました' };
      }
    }

    return { handled: false };
  }

  /**
   * AIの応答から !discord コマンドを検知して実行
   * コードブロック内のコマンドは無視する
   * !discord send は複数行メッセージに対応（次の !discord / !schedule コマンド行まで吸収）
   * feedback: true のコマンド結果はDiscordに送信せずフィードバック配列に収集して返す
   */
  async function handleDiscordCommandsInResponse(
    text: string,
    sourceMessage?: Message,
    fallbackChannelId?: string
  ): Promise<string[]> {
    const lines = text.split('\n');
    let inCodeBlock = false;
    let i = 0;
    const feedbackResults: string[] = [];

    while (i < lines.length) {
      const line = lines[i];

      // コードブロックの開始/終了を追跡
      if (line.trim().startsWith('```')) {
        inCodeBlock = !inCodeBlock;
        i++;
        continue;
      }

      // コードブロック内はスキップ
      if (inCodeBlock) {
        i++;
        continue;
      }

      const trimmed = line.trim();

      // !discord send の複数行対応
      const sendMatch = trimmed.match(/^!discord\s+send\s+<#(\d+)>\s*(.*)/);
      if (sendMatch) {
        const firstLineContent = sendMatch[2] ?? '';

        if (firstLineContent.trim() === '') {
          // 本文が空 → 次の !discord / !schedule コマンド行まで吸収（暗黙マルチライン）
          const bodyLines: string[] = [];
          let inBodyCodeBlock = false;
          i++;
          while (i < lines.length) {
            const bodyLine = lines[i];
            if (bodyLine.trim().startsWith('```')) {
              inBodyCodeBlock = !inBodyCodeBlock;
            }
            // コードブロック外で次のコマンド行が来たら吸収終了
            if (
              !inBodyCodeBlock &&
              (bodyLine.trim().startsWith('!discord ') || bodyLine.trim().startsWith('!schedule'))
            ) {
              break;
            }
            bodyLines.push(bodyLine);
            i++;
          }
          const fullMessage = bodyLines.join('\n').trim();
          if (fullMessage) {
            const commandText = `!discord send <#${sendMatch[1]}> ${fullMessage}`;
            console.log(
              `[xangi] Processing discord command from response: ${commandText.slice(0, 50)}...`
            );
            const result = await handleDiscordCommand(
              commandText,
              sourceMessage,
              fallbackChannelId
            );
            if (result.handled && result.response) {
              if (result.feedback) {
                feedbackResults.push(result.response);
              } else if (sourceMessage) {
                const channel = sourceMessage.channel;
                if (
                  'send' in channel &&
                  typeof (channel as { send?: unknown }).send === 'function'
                ) {
                  await (channel as { send: (content: string) => Promise<unknown> }).send(
                    result.response
                  );
                }
              }
            }
          }
          continue; // i は既に次のコマンド行を指している
        } else {
          // 1行目にテキストあり → 続く行も吸収（次のコマンド行まで）
          const bodyLines: string[] = [firstLineContent];
          let inBodyCodeBlock2 = false;
          i++;
          while (i < lines.length) {
            const bodyLine = lines[i];
            if (bodyLine.trim().startsWith('```')) {
              inBodyCodeBlock2 = !inBodyCodeBlock2;
            }
            if (
              !inBodyCodeBlock2 &&
              (bodyLine.trim().startsWith('!discord ') || bodyLine.trim().startsWith('!schedule'))
            ) {
              break;
            }
            bodyLines.push(bodyLine);
            i++;
          }
          const fullMessage = bodyLines.join('\n').trimEnd();
          const commandText = `!discord send <#${sendMatch[1]}> ${fullMessage}`;
          console.log(
            `[xangi] Processing discord command from response: ${commandText.slice(0, 50)}...`
          );
          const result = await handleDiscordCommand(commandText, sourceMessage, fallbackChannelId);
          if (result.handled && result.response) {
            if (result.feedback) {
              feedbackResults.push(result.response);
            } else if (sourceMessage) {
              const channel = sourceMessage.channel;
              if ('send' in channel && typeof (channel as { send?: unknown }).send === 'function') {
                await (channel as { send: (content: string) => Promise<unknown> }).send(
                  result.response
                );
              }
            }
          }
          continue;
        }
      }

      // !discord edit の複数行対応
      const editMatch = trimmed.match(/^!discord\s+edit\s+(\S+)\s*([\s\S]*)/);
      if (editMatch) {
        const editTarget = editMatch[1];
        const firstLineContent = editMatch[2] ?? '';
        const bodyLines: string[] = firstLineContent ? [firstLineContent] : [];
        let inEditCodeBlock = false;
        i++;
        while (i < lines.length) {
          const bodyLine = lines[i];
          if (bodyLine.trim().startsWith('```')) {
            inEditCodeBlock = !inEditCodeBlock;
          }
          if (
            !inEditCodeBlock &&
            (bodyLine.trim().startsWith('!discord ') || bodyLine.trim().startsWith('!schedule'))
          ) {
            break;
          }
          bodyLines.push(bodyLine);
          i++;
        }
        const fullContent = bodyLines.join('\n').trim();
        if (fullContent) {
          const commandText = `!discord edit ${editTarget} ${fullContent}`;
          console.log(
            `[xangi] Processing discord edit from response: ${commandText.slice(0, 50)}...`
          );
          const result = await handleDiscordCommand(commandText, sourceMessage, fallbackChannelId);
          if (result.handled && result.response) {
            if (result.feedback) {
              feedbackResults.push(result.response);
            } else if (sourceMessage) {
              const channel = sourceMessage.channel;
              if ('send' in channel && typeof (channel as { send?: unknown }).send === 'function') {
                await (channel as { send: (content: string) => Promise<unknown> }).send(
                  result.response
                );
              }
            }
          }
        }
        continue;
      }

      // その他の !discord コマンド（channels, search, history, delete）
      if (trimmed.startsWith('!discord ')) {
        console.log(`[xangi] Processing discord command from response: ${trimmed.slice(0, 50)}...`);
        const result = await handleDiscordCommand(trimmed, sourceMessage, fallbackChannelId);
        if (result.handled && result.response) {
          if (result.feedback) {
            feedbackResults.push(result.response);
          } else if (sourceMessage) {
            const channel = sourceMessage.channel;
            if ('send' in channel && typeof (channel as { send?: unknown }).send === 'function') {
              await (channel as { send: (content: string) => Promise<unknown> }).send(
                result.response
              );
            }
          }
        }
      }

      // !schedule コマンド（引数なしでもlist表示、sourceMessage必須）
      if (sourceMessage && (trimmed === '!schedule' || trimmed.startsWith('!schedule '))) {
        console.log(
          `[xangi] Processing schedule command from response: ${trimmed.slice(0, 50)}...`
        );
        await executeScheduleFromResponse(trimmed, sourceMessage, scheduler, config.scheduler);
      }

      i++;
    }

    return feedbackResults;
  }

  // Discord APIエラーでプロセスが落ちないようにハンドリング
  client.on('error', (error) => {
    console.error('[xangi] Discord client error:', error.message);
  });

  // チャンネル単位の処理中ロック
  const processingChannels = new Set<string>();

  // メッセージ処理
  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;

    const isMentioned = message.mentions.has(client.user!);
    const isDM = !message.guild;
    const isAutoReplyAll = config.discord.autoReplyAll === true;
    const isAutoReplyChannel =
      isAutoReplyAll || (config.discord.autoReplyChannels?.includes(message.channel.id) ?? false);

    if (!isMentioned && !isDM && !isAutoReplyChannel) return;

    // 同じチャンネルで処理中なら無視（メンション時は除く）
    if (!isMentioned && processingChannels.has(message.channel.id)) {
      console.log(`[xangi] Skipping message in busy channel: ${message.channel.id}`);
      return;
    }

    if (
      !config.discord.allowedUsers?.includes('*') &&
      !config.discord.allowedUsers?.includes(message.author.id)
    ) {
      console.log(`[xangi] Unauthorized user: ${message.author.id} (${message.author.tag})`);
      return;
    }

    let prompt = message.content
      .replace(/<@[!&]?\d+>/g, '') // ユーザーメンションのみ削除（チャンネルメンションは残す）
      .replace(/\s+/g, ' ')
      .trim();

    // === Gate L3 "YES" text handler (Phase 4b) ===
    if (prompt.trim().toUpperCase() === 'YES') {
      // L3 二重確認: channelId に紐づく pending L3 gate を検索
      let matchedToken: string | null = null;
      let matchedGate: PendingGate | null = null;
      for (const [token, gate] of pendingGates) {
        if (
          gate.channelId === message.channel.id &&
          gate.tier === 'L3_double_confirm' &&
          gate.token2
        ) {
          matchedToken = token;
          matchedGate = gate;
          break;
        }
      }
      if (matchedToken && matchedGate) {
        // Step 1: first token に "ok" を送る
        const resp1 = await respondToGate(matchedToken, matchedGate.hashPrefix, 'ok');
        if (!resp1.ok) {
          if ('send' in message.channel) {
            await (message.channel as any).send(
              `\u274c L3 \u30b2\u30fc\u30c8\u627f\u8a8d\u5931\u6557 (step 1): ${resp1.reason}`
            );
          }
          pendingGates.delete(matchedToken);
          if (matchedGate.token2) pendingL3SecondStep.delete(matchedGate.token2);
          return;
        }
        // Step 2: token2 に "yes" を送る
        const resp2 = await respondToGate(matchedGate.token2!, null, 'yes');
        if (!resp2.ok) {
          if ('send' in message.channel) {
            await (message.channel as any).send(
              `\u274c L3 \u30b2\u30fc\u30c8\u627f\u8a8d\u5931\u6557 (step 2): ${resp2.reason}`
            );
          }
          pendingGates.delete(matchedToken);
          pendingL3SecondStep.delete(matchedGate.token2!);
          return;
        }
        // Step 3: アクション実行
        console.log(
          `[gate] L3 double-confirmed: ${matchedToken.slice(0, 12)}... action=${matchedGate.actionName}`
        );
        const resultMsg = await executeGatedAction(matchedGate.actionName, matchedGate.paramsStr);
        pendingGates.delete(matchedToken);
        pendingL3SecondStep.delete(matchedGate.token2!);

        if ('send' in message.channel) {
          await (message.channel as any).send(resultMsg);
        }
        // ゲートメッセージのボタンを消す
        try {
          if (matchedGate.messageId) {
            const gateMsg = await message.channel.messages
              .fetch(matchedGate.messageId)
              .catch(() => null);
            if (gateMsg && gateMsg.editable) {
              await gateMsg.edit({ components: [] }).catch(() => {});
            }
          }
        } catch {
          /* ignore */
        }

        // harness-gate チャンネルにログ
        try {
          const gateChannelId = TOPIC_CHANNELS['harness-gate'];
          if (gateChannelId) {
            const gateChannel = await (message.client as any).channels
              .fetch(gateChannelId)
              .catch(() => null);
            if (gateChannel && 'send' in gateChannel) {
              await (gateChannel as any)
                .send(
                  `\u2705 **Gate L3 \u4e8c\u91cd\u627f\u8a8d**: \`${matchedGate.actionName}\` by ${message.author.tag}\n${resultMsg}`
                )
                .catch(() => {});
            }
          }
        } catch {
          /* ignore */
        }
        return;
      }
    }

    // スキップ設定（返信元追加やリンク展開の前に判定する）
    // !skip プレフィックスで一時的にスキップモードにできる
    let skipPermissions = config.agent.config.skipPermissions ?? false;

    if (prompt.startsWith('!skip')) {
      skipPermissions = true;
      prompt = prompt.replace(/^!skip\s*/, '').trim();
    }

    // !discord コマンドの処理
    if (prompt.startsWith('!discord')) {
      const result = await handleDiscordCommand(prompt, message);
      if (result.handled) {
        if (result.feedback && result.response) {
          // feedback結果はエージェントのコンテキストに注入
          // → 元のコマンドと結果を合わせてプロンプトに流す
          prompt = `ユーザーが「${prompt}」を実行しました。以下がその結果です。この情報を踏まえてユーザーに返答してください。\n\n${result.response}`;
          // processPromptに流す（下に続く）
        } else {
          if (result.response && 'send' in message.channel) {
            await message.channel.send(result.response);
          }
          return;
        }
      }
    }

    // !schedule コマンドの処理
    if (prompt.startsWith('!schedule')) {
      await handleScheduleMessage(message, prompt, scheduler, config.scheduler);
      return;
    }

    // Discordリンクからメッセージ内容を取得
    prompt = await fetchDiscordLinkContent(prompt);

    // 返信元メッセージを取得してプロンプトに追加
    const replyContent = await fetchReplyContent(message);
    if (replyContent) {
      prompt = replyContent + prompt;
    }

    // チャンネルメンションにID注釈を追加（展開前に実行）
    prompt = annotateChannelMentions(prompt);

    // チャンネルメンションから最新メッセージを取得
    prompt = await fetchChannelMessages(prompt);

    // 添付ファイルをダウンロード
    const attachmentPaths: string[] = [];
    if (message.attachments.size > 0) {
      for (const [, attachment] of message.attachments) {
        try {
          const filePath = await downloadFile(attachment.url, attachment.name || 'file');
          attachmentPaths.push(filePath);
        } catch (err) {
          console.error(`[xangi] Failed to download attachment: ${attachment.name}`, err);
        }
      }
    }

    // テキストも添付もない場合はスキップ
    if (!prompt && attachmentPaths.length === 0) return;

    // === Phase 10C: Magika Guard — 添付ファイルスキャン ===
    const magikaAttachmentWarnings: string[] = [];
    if (attachmentPaths.length > 0) {
      for (const filePath of attachmentPaths) {
        try {
          const scanResult = await checkWithMagika(filePath);
          console.log(`[magika-guard] scan ${filePath}: ${scanResult.verdict}`);
          if (scanResult.verdict === 'blocked') {
            const msg = formatMagikaVerdict(
              scanResult.verdict,
              scanResult.reason,
              filePath.split('/').pop() || filePath
            );
            if (msg) magikaAttachmentWarnings.push(msg);
          } else if (scanResult.verdict === 'suspicious') {
            const msg = formatMagikaVerdict(
              scanResult.verdict,
              scanResult.reason,
              filePath.split('/').pop() || filePath
            );
            if (msg) magikaAttachmentWarnings.push(msg);
          }
        } catch (err) {
          console.error(`[magika-guard] scan error for ${filePath}:`, err);
        }
      }
    }

    // ブロックされた添付がある場合はユーザーに通知して処理中断
    const blockedAttachments = magikaAttachmentWarnings.filter((w) => w.includes('\u{1f6ab}'));
    if (blockedAttachments.length > 0) {
      await message.reply(blockedAttachments.join('\n'));
      return;
    }
    // 疑わしい添付は警告をプロンプトコンテキストに追加
    if (magikaAttachmentWarnings.length > 0) {
      await message.reply(magikaAttachmentWarnings.join('\n'));
    }

    // 添付ファイル情報をプロンプトに追加
    prompt = buildPromptWithAttachments(
      prompt || '添付ファイルを確認してください',
      attachmentPaths
    );

    const channelId = message.channel.id;

    // チャンネルトピック（概要）をプロンプトに注入
    if (config.discord.injectChannelTopic !== false) {
      const channel = message.channel;
      if ('topic' in channel && channel.topic) {
        prompt += `\n\n[チャンネルルール（必ず従うこと）]\n${channel.topic}`;
      }
    }

    // タイムスタンプをプロンプトの先頭に注入
    if (config.discord.injectTimestamp !== false) {
      const d = new Date();
      const now = d.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
      const day = d.toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo', weekday: 'short' });
      prompt = `[現在時刻: ${now}(${day})]\n${prompt}`;
    }

    processingChannels.add(channelId);
    try {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const _result = await processPrompt(
        message,
        agentRunner,
        prompt,
        skipPermissions,
        channelId,
        config
      );

      // [DISABLED] Discord-side command re-processing.
      // Trigger feedback is handled inside runner.ts (lite mode).
      // Re-enabling causes duplicate messages.
    } finally {
      processingChannels.delete(channelId);
    }
  });

  // Discordボットを起動
  if (config.discord.enabled) {
    await client.login(config.discord.token);
    console.log('[xangi] Discord bot started');

    // スケジューラにDiscord送信関数を登録
    scheduler.registerSender('discord', async (channelId, msg) => {
      const channel = await client.channels.fetch(channelId);
      if (channel && 'send' in channel) {
        await (channel as { send: (content: string) => Promise<unknown> }).send(msg);
      }
    });

    // スケジューラにエージェント実行関数を登録
    scheduler.registerAgentRunner('discord', async (prompt, channelId) => {
      const channel = await client.channels.fetch(channelId);
      if (!channel || !('send' in channel)) {
        throw new Error(`Channel not found: ${channelId}`);
      }

      // プロンプト内の !discord send コマンドを先に直接実行
      // （AIに渡すとコマンドが応答に含まれず実行されないため）
      const promptCommands = extractDiscordSendFromPrompt(prompt);
      for (const cmd of promptCommands.commands) {
        console.log(`[scheduler] Executing discord command from prompt: ${cmd.slice(0, 80)}...`);
        await handleDiscordCommand(cmd, undefined, channelId);
      }

      // !discord send 以外のテキストが残っていればAIに渡す
      const remainingPrompt = promptCommands.remaining.trim();
      if (!remainingPrompt) {
        // コマンドのみのプロンプトだった場合、AIは不要
        console.log('[scheduler] Prompt contained only discord commands, skipping agent');
        return promptCommands.commands.map((c) => `✅ ${c.slice(0, 50)}`).join('\n');
      }

      // 処理中メッセージを送信
      const thinkingMsg = await (
        channel as {
          send: (content: string) => Promise<{ edit: (content: string) => Promise<unknown> }>;
        }
      ).send('🤔 考え中...');

      try {
        // タイムスタンプをプロンプトの先頭に注入
        let agentPrompt = remainingPrompt;
        if (config.discord.injectTimestamp !== false) {
          const d = new Date();
          const now = d.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
          const day = d.toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo', weekday: 'short' });
          agentPrompt = `[現在時刻: ${now}(${day})]\n${agentPrompt}`;
        }

        // スケジューラーは毎回新規セッション（stateless）
        // 会話の文脈継続は不要で、古いセッションIDによるresume失敗を防ぐ
        const { result, sessionId: newSessionId } = await agentRunner.run(agentPrompt, {
          skipPermissions: config.agent.config.skipPermissions ?? false,
          sessionId: undefined,
          channelId,
        });

        // スケジューラーのセッションは scheduler スコープで保存
        setSession(channelId, newSessionId, 'scheduler');

        // AI応答内の !discord コマンドを処理（sourceMessage なし、channelIdをフォールバック）
        const feedbackResults = await handleDiscordCommandsInResponse(result, undefined, channelId);

        // フィードバック結果があればエージェントに再注入
        if (feedbackResults.length > 0) {
          const feedbackPrompt = `あなたが実行したコマンドの結果が返ってきました。この情報を踏まえて、元の会話の文脈に沿ってユーザーに返答してください。\n\n${feedbackResults.join('\n\n')}`;
          console.log(
            `[scheduler] Re-injecting ${feedbackResults.length} feedback result(s) to agent`
          );
          // フィードバックは直前のスケジューラーセッションを使う（同一タスク内の文脈継続）
          const feedbackSession = getSession(channelId);
          const feedbackRun = await agentRunner.run(feedbackPrompt, {
            skipPermissions: config.agent.config.skipPermissions ?? false,
            sessionId: feedbackSession,
            channelId,
          });
          setSession(channelId, feedbackRun.sessionId, 'scheduler');
          // 再注入後の応答にもコマンドがあれば処理
          await handleDiscordCommandsInResponse(feedbackRun.result, undefined, channelId);
        }

        // 結果を送信
        const filePaths = extractFilePaths(result);
        const displayText = filePaths.length > 0 ? stripFilePaths(result) : result;

        // === セパレータで明示的に分割（content-digest等で複数投稿を1応答に含める用途）
        // LLMが前後に空白や余分な改行を入れることがあるため、正規表現で緩くマッチ
        const SEPARATOR_REGEX = /\n\s*===\s*\n/;
        const messageParts = SEPARATOR_REGEX.test(displayText)
          ? displayText
              .split(SEPARATOR_REGEX)
              .map((p) => p.trim())
              .filter(Boolean)
          : [displayText];

        // 最初のパートは既存のthinkingMsgを編集して送信
        const firstChunks = splitMessage(messageParts[0], DISCORD_SAFE_LENGTH);
        await thinkingMsg.edit(firstChunks[0] || '✅');
        // 最後に送信したメッセージIDを記録（スケジューラー経由）
        if ('id' in thinkingMsg) {
          lastSentMessageIds.set(channelId, (thinkingMsg as { id: string }).id);
        }
        const ch = channel as { send: (content: string) => Promise<unknown> };
        // 最初のパートの残りチャンク
        for (let i = 1; i < firstChunks.length; i++) {
          await ch.send(firstChunks[i]);
        }
        // 2つ目以降のパートは新規メッセージとして送信
        for (let p = 1; p < messageParts.length; p++) {
          const chunks = splitMessage(messageParts[p], DISCORD_SAFE_LENGTH);
          for (const chunk of chunks) {
            await ch.send(chunk);
          }
        }

        if (filePaths.length > 0) {
          await (
            channel as { send: (options: { files: { attachment: string }[] }) => Promise<unknown> }
          ).send({
            files: filePaths.map((fp) => ({ attachment: fp })),
          });
        }

        return result;
      } catch (error) {
        if (error instanceof Error && error.message === 'Request cancelled by user') {
          await thinkingMsg.edit('🛑 タスクを停止しました');
        } else {
          const errorMsg = error instanceof Error ? error.message : String(error);
          let errorDetail: string;
          if (errorMsg.includes('timed out')) {
            errorDetail = `⏱️ タイムアウトしました`;
          } else if (errorMsg.includes('Process exited unexpectedly')) {
            errorDetail = `💥 AIプロセスが予期せず終了しました`;
          } else if (errorMsg.includes('Circuit breaker')) {
            errorDetail = '🔌 AIプロセスが一時停止中です';
          } else {
            errorDetail = `❌ エラー: ${errorMsg.slice(0, 200)}`;
          }
          await thinkingMsg.edit(errorDetail);
        }
        throw error;
      }
    });
  }

  // Slackボットを起動
  if (config.slack.enabled) {
    await startSlackBot({
      config,
      agentRunner,
      skills,
      reloadSkills: () => {
        skills = loadSkills(workdir);
        return skills;
      },
      scheduler,
    });
    console.log('[xangi] Slack bot started');
  }

  if (!config.discord.enabled && !config.slack.enabled) {
    console.error(
      '[xangi] No chat platform enabled. Set DISCORD_TOKEN or SLACK_BOT_TOKEN/SLACK_APP_TOKEN'
    );
    process.exit(1);
  }

  // スケジューラの全ジョブを開始
  scheduler.startAll(config.scheduler);

  // シャットダウン時にスケジューラを停止
  const shutdown = () => {
    console.log('[xangi] Shutting down scheduler...');
    scheduler.stopAll();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function handleAutocomplete(
  interaction: AutocompleteInteraction,
  skills: Skill[]
): Promise<void> {
  const focusedValue = interaction.options.getFocused().toLowerCase();

  const filtered = skills
    .filter(
      (skill) =>
        skill.name.toLowerCase().includes(focusedValue) ||
        skill.description.toLowerCase().includes(focusedValue)
    )
    .slice(0, 25) // Discord制限: 最大25件
    .map((skill) => ({
      name: `${skill.name} - ${skill.description.slice(0, 50)}`,
      value: skill.name,
    }));

  await interaction.respond(filtered);
}

async function handleSkill(
  interaction: ChatInputCommandInteraction,
  agentRunner: AgentRunner,
  config: ReturnType<typeof loadConfig>,
  channelId: string
) {
  const skillName = interaction.options.getString('name', true);
  const args = interaction.options.getString('args') || '';
  const skipPermissions = config.agent.config.skipPermissions ?? false;

  await interaction.deferReply();

  try {
    const prompt = `スキル「${skillName}」を実行してください。${args ? `引数: ${args}` : ''}`;
    const sessionId = getSession(channelId);
    const { result, sessionId: newSessionId } = await agentRunner.run(prompt, {
      skipPermissions,
      sessionId,
      channelId,
    });

    setSession(channelId, newSessionId);
    const chunks = splitMessage(result, DISCORD_SAFE_LENGTH);
    await interaction.editReply(chunks[0] || '✅');
    for (let i = 1; i < chunks.length; i++) {
      await interaction.followUp(chunks[i]);
    }
  } catch (error) {
    console.error('[xangi] Error:', error);
    await interaction.editReply('エラーが発生しました');
  }
}

async function handleSkillCommand(
  interaction: ChatInputCommandInteraction,
  agentRunner: AgentRunner,
  config: ReturnType<typeof loadConfig>,
  channelId: string,
  skillName: string
) {
  const args = interaction.options.getString('args') || '';
  const skipPermissions = config.agent.config.skipPermissions ?? false;

  await interaction.deferReply();

  try {
    const prompt = `スキル「${skillName}」を実行してください。${args ? `引数: ${args}` : ''}`;
    const sessionId = getSession(channelId);
    const { result, sessionId: newSessionId } = await agentRunner.run(prompt, {
      skipPermissions,
      sessionId,
      channelId,
    });

    setSession(channelId, newSessionId);
    const chunks = splitMessage(result, DISCORD_SAFE_LENGTH);
    await interaction.editReply(chunks[0] || '✅');
    for (let i = 1; i < chunks.length; i++) {
      await interaction.followUp(chunks[i]);
    }
  } catch (error) {
    console.error('[xangi] Error:', error);
    await interaction.editReply('エラーが発生しました');
  }
}

/**
 * テキストから !discord send コマンドを抽出し、残りのテキストを返す
 * スケジューラプロンプトからコマンドを分離するために使用
 * コードブロック内のコマンドは無視する
 */
function extractDiscordSendFromPrompt(text: string): {
  commands: string[];
  remaining: string;
} {
  const lines = text.split('\n');
  const commands: string[] = [];
  const remainingLines: string[] = [];
  let inCodeBlock = false;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      remainingLines.push(line);
      i++;
      continue;
    }

    if (inCodeBlock) {
      remainingLines.push(line);
      i++;
      continue;
    }

    const trimmed = line.trim();
    const sendMatch = trimmed.match(/^!discord\s+send\s+<#(\d+)>\s*(.*)/);
    if (sendMatch) {
      const firstLineContent = sendMatch[2] ?? '';
      if (firstLineContent.trim() === '') {
        // 暗黙マルチライン: 次のコマンド行まで吸収
        const bodyLines: string[] = [];
        let inBodyCodeBlock = false;
        i++;
        while (i < lines.length) {
          const bodyLine = lines[i];
          if (bodyLine.trim().startsWith('```')) {
            inBodyCodeBlock = !inBodyCodeBlock;
          }
          if (
            !inBodyCodeBlock &&
            (bodyLine.trim().startsWith('!discord ') || bodyLine.trim().startsWith('!schedule'))
          ) {
            break;
          }
          bodyLines.push(bodyLine);
          i++;
        }
        const fullMessage = bodyLines.join('\n').trim();
        if (fullMessage) {
          commands.push(`!discord send <#${sendMatch[1]}> ${fullMessage}`);
        }
        continue;
      } else {
        // 1行目にテキストあり → 続く行も吸収
        const bodyLines2: string[] = [firstLineContent];
        let inBodyCodeBlock2 = false;
        i++;
        while (i < lines.length) {
          const bodyLine = lines[i];
          if (bodyLine.trim().startsWith('```')) {
            inBodyCodeBlock2 = !inBodyCodeBlock2;
          }
          if (
            !inBodyCodeBlock2 &&
            (bodyLine.trim().startsWith('!discord ') || bodyLine.trim().startsWith('!schedule'))
          ) {
            break;
          }
          bodyLines2.push(bodyLine);
          i++;
        }
        const fullMessage2 = bodyLines2.join('\n').trimEnd();
        commands.push(`!discord send <#${sendMatch[1]}> ${fullMessage2}`);
        continue;
      }
    }

    remainingLines.push(line);
    i++;
  }

  return { commands, remaining: remainingLines.join('\n') };
}

/**
 * 表示用テキストからコマンド行を除去する（コードブロック内は残す）
 * SYSTEM_COMMAND:, !discord, !schedule で始まる行を除去
 * !discord send の複数行メッセージ（続く行）も除去
 */
function stripCommandsFromDisplay(text: string): string {
  const lines = text.split('\n');
  const result: string[] = [];
  let inCodeBlock = false;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      result.push(line);
      i++;
      continue;
    }

    if (inCodeBlock) {
      result.push(line);
      i++;
      continue;
    }

    const trimmed = line.trim();

    // SYSTEM_COMMAND: 行を除去
    if (trimmed.startsWith('SYSTEM_COMMAND:')) {
      i++;
      continue;
    }

    // !discord send の複数行対応: コマンド行と続く行を除去
    const sendMatch = trimmed.match(/^!discord\s+send\s+<#\d+>\s*(.*)/);
    if (sendMatch) {
      // 続く行も除去（次のコマンド行まで）
      i++;
      let inBodyCodeBlock = false;
      while (i < lines.length) {
        const bodyLine = lines[i];
        if (bodyLine.trim().startsWith('```')) {
          inBodyCodeBlock = !inBodyCodeBlock;
        }
        if (
          !inBodyCodeBlock &&
          (bodyLine.trim().startsWith('!discord ') || bodyLine.trim().startsWith('!schedule'))
        ) {
          break;
        }
        i++;
      }
      continue;
    }

    // その他の !discord コマンド行を除去
    if (trimmed.startsWith('!discord ')) {
      i++;
      continue;
    }

    // !schedule コマンド行を除去
    if (trimmed === '!schedule' || trimmed.startsWith('!schedule ')) {
      i++;
      continue;
    }

    result.push(line);
    i++;
  }

  return result.join('\n').trim();
}

async function processPrompt(
  message: Message,
  agentRunner: AgentRunner,
  prompt: string,
  skipPermissions: boolean,
  channelId: string,
  config: ReturnType<typeof loadConfig>
): Promise<string | null> {
  let replyMessage: Message | null = null;
  const toolHistory: string[] = []; // ツール実行履歴（stop時にも参照するため関数スコープ）
  let lastStreamedText = ''; // エラー時に途中テキストを残すため関数スコープ
  try {
    // チャンネル・ユーザー情報をプロンプトに付与
    const channelName =
      'name' in message.channel ? (message.channel as { name: string }).name : null;
    const userInfo = `[発言者: ${message.author.displayName ?? message.author.username} (ID: ${message.author.id})]`;
    if (channelName) {
      prompt = `[プラットフォーム: Discord]\n[チャンネル: #${channelName} (ID: ${channelId})]\n${userInfo}\n${prompt}`;
    } else {
      prompt = `${userInfo}\n${prompt}`;
    }

    console.log(`[xangi] Processing message in channel ${channelId}`);

    // === Izuna Dispatch (Phase 7+8+9): Track A/B 事前振り分け + 直接実行 + Dev Agent ===
    let dispatch: DispatchResult | null = null;
    try {
      const dispatchResult = await new Promise<string>((resolve, reject) => {
        execFile(
          'python3',
          [
            pathJoin(ACTION_SCRIPTS_DIR, 'dispatch.py'),
            prompt.replace(/\[.*?\]\n/g, '').trim(), // メタデータ除去
          ],
          { timeout: 3000, cwd: ACTION_SCRIPTS_DIR },
          (err, stdout, stderr) => {
            if (err) {
              reject(new Error(stderr || err.message));
              return;
            }
            resolve(stdout);
          }
        );
      });
      dispatch = JSON.parse(dispatchResult) as DispatchResult;
      if (dispatch.track && dispatch.agent) {
        console.log(`[izuna-dispatch] ${dispatch.track}/${dispatch.agent} (${dispatch.mode})`);
      }
    } catch (err) {
      console.error(
        '[izuna-dispatch] error (fallback to LLM):',
        err instanceof Error ? err.message : err
      );
    }

    // === Phase 8: Worker 直接実行（LLM スキップ）===
    if (dispatch?.track === 'worker' && dispatch.agent) {
      try {
        const directResult = await tryWorkerDirectExec(dispatch, prompt);
        if (directResult) {
          console.log(
            `[izuna-worker-exec] Direct result for ${dispatch.agent} (${directResult.length} chars)`
          );
          await message.react('⚡').catch(() => {});
          await message.reply(directResult.slice(0, DISCORD_MAX_LENGTH));
          // Memory Hook: 直接実行の結果も記録
          try {
            const content = `[user] ${prompt.slice(0, 300)}\n[worker-direct] ${directResult.slice(0, 500)}`;
            execFile(
              'python3',
              [
                pathJoin(ACTION_SCRIPTS_DIR, 'memory_curator.py'),
                'record',
                '--agent',
                'izuna',
                '--type',
                'worker_exec',
                '--content',
                content,
                '--source-type',
                'discord',
                '--session-id',
                channelId,
              ],
              { timeout: 5000, cwd: ACTION_SCRIPTS_DIR },
              (err) => {
                if (err) console.error('[izuna-memory] worker-exec record error:', err);
              }
            );
          } catch {
            /* ignore */
          }
          return directResult;
        }
      } catch (err) {
        console.error(
          '[izuna-worker-exec] error (fallback to LLM):',
          err instanceof Error ? err.message : err
        );
      }
    }

    // === Phase 9: Dev Agent スポーン（Claude Code を対象リポで実行）===
    if (dispatch?.track === 'dev' && dispatch.agent) {
      try {
        await message.react('🔧').catch(() => {});
        const devReply = await message.reply(
          `🔧 ${dispatch.agent} を起動中... (repo スコープ実行)`
        );
        const devResult = await spawnDevAgent(dispatch, prompt, channelId, config);
        if (devResult) {
          console.log(`[izuna-dev-agent] Result for ${dispatch.agent} (${devResult.length} chars)`);
          const chunks = splitMessage(devResult, DISCORD_SAFE_LENGTH);
          await devReply.edit(chunks[0] || '完了');
          if ('send' in message.channel && chunks.length > 1) {
            const channel = message.channel as unknown as {
              send: (content: string) => Promise<unknown>;
            };
            for (let i = 1; i < chunks.length; i++) {
              await channel.send(chunks[i]);
            }
          }
          // Memory Hook
          try {
            const content = `[user] ${prompt.slice(0, 300)}\n[dev-agent:${dispatch.agent}] ${devResult.slice(0, 500)}`;
            execFile(
              'python3',
              [
                pathJoin(ACTION_SCRIPTS_DIR, 'memory_curator.py'),
                'record',
                '--agent',
                dispatch.agent,
                '--type',
                'dev_task',
                '--content',
                content,
                '--source-type',
                'discord',
                '--session-id',
                channelId,
              ],
              { timeout: 5000, cwd: ACTION_SCRIPTS_DIR },
              (err) => {
                if (err) console.error('[izuna-memory] dev-agent record error:', err);
              }
            );
          } catch {
            /* ignore */
          }
          return devResult;
        }
        // dev agent が null を返した場合 → LLM フォールバック
        await devReply
          .edit('🔧 Dev agent のリポが見つかりません。LLM で処理します...')
          .catch(() => {});
      } catch (err) {
        console.error(
          '[izuna-dev-agent] error (fallback to LLM):',
          err instanceof Error ? err.message : err
        );
      }
    }

    // Dispatch hint を LLM プロンプトに注入（直接実行できなかった場合のフォールバック）
    if (dispatch?.track && dispatch?.agent) {
      const dispatchHint = `\n[DISPATCH: track=${dispatch.track}, agent=${dispatch.agent}, mode=${dispatch.mode}, blast=${dispatch.blast_radius || 'unknown'}]`;
      prompt = prompt + dispatchHint;
    }

    // === Phase 10A: Magika Guard — インストールキーワード事前チェック ===
    if (containsInstallKeyword(prompt)) {
      const pkgInfo = extractPackageInfo(prompt);
      if (pkgInfo) {
        try {
          console.log(
            `[magika-guard] Pre-check package: ${pkgInfo.manager}/${pkgInfo.packageName}`
          );
          const pkgResult = await checkPackageWithMagika(pkgInfo.manager, pkgInfo.packageName);
          console.log(`[magika-guard] Package verdict: ${pkgResult.verdict}`);
          if (pkgResult.verdict === 'blocked') {
            const blockMsg = formatMagikaVerdict(
              pkgResult.verdict,
              pkgResult.reason,
              `${pkgInfo.manager}:${pkgInfo.packageName}`
            );
            if (blockMsg) {
              await message.reply(blockMsg);
              return null;
            }
          } else if (pkgResult.verdict === 'suspicious') {
            const warnMsg = formatMagikaVerdict(
              pkgResult.verdict,
              pkgResult.reason,
              `${pkgInfo.manager}:${pkgInfo.packageName}`
            );
            if (warnMsg) {
              await message.reply(warnMsg);
              prompt += `\n[MAGIKA_WARNING: ${pkgInfo.manager}:${pkgInfo.packageName} — ${pkgResult.reason || 'suspicious'}]`;
            }
          }
        } catch (err) {
          console.error(
            '[magika-guard] pre-check error:',
            err instanceof Error ? err.message : err
          );
        }
      }
    }

    await message.react('👀').catch(() => {});

    const sessionId = getSession(channelId);
    const useStreaming = config.discord.streaming ?? true;
    const showThinking = config.discord.showThinking ?? true;

    // !skip プレフィックスの場合、ワンショットランナーを使用
    // （persistent-runner はプロセス起動時の権限設定を変えられないため）
    const defaultSkip = config.agent.config.skipPermissions ?? false;
    const needsSkipRunner = skipPermissions && !defaultSkip;
    const runner: AgentRunner = needsSkipRunner
      ? new ClaudeCodeRunner(config.agent.config)
      : agentRunner;

    if (needsSkipRunner) {
      console.log(`[xangi] Using one-shot skip runner for channel ${channelId}`);
    }

    // 最初のメッセージを送信
    const showButtons = config.discord.showButtons ?? true;
    replyMessage = await message.reply({
      content: '🤔 考え中.',
      ...(showButtons && { components: [createStopButton()] }),
    });

    let result: string;
    let newSessionId: string;

    if (useStreaming && showThinking && !needsSkipRunner) {
      // ストリーミング + 思考表示モード（persistent-runner のみ）
      let lastUpdateTime = 0;
      let pendingUpdate = false;
      let firstTextReceived = false;

      // 最初のテキストが届くまで考え中アニメーション
      let dotCount = 1;
      const thinkingInterval = setInterval(() => {
        if (firstTextReceived) return;
        dotCount = (dotCount % 3) + 1;
        const dots = '.'.repeat(dotCount);
        const toolDisplay = toolHistory.length > 0 ? '\n' + toolHistory.slice(-5).join('\n') : '';
        replyMessage!.edit(`🤔 考え中${dots}${toolDisplay}`).catch(() => {});
      }, 1000);

      let streamResult: { result: string; sessionId: string };
      try {
        streamResult = await agentRunner.runStream(
          prompt,
          {
            onText: (_chunk, fullText) => {
              lastStreamedText = fullText;
              if (!firstTextReceived) {
                firstTextReceived = true;
                clearInterval(thinkingInterval);
              }
              const now = Date.now();
              if (now - lastUpdateTime >= STREAM_UPDATE_INTERVAL_MS && !pendingUpdate) {
                pendingUpdate = true;
                lastUpdateTime = now;
                replyMessage!
                  .edit((fullText + ' ▌').slice(0, DISCORD_MAX_LENGTH))
                  .catch((err) => {
                    console.error('[xangi] Failed to edit message:', err.message);
                  })
                  .finally(() => {
                    pendingUpdate = false;
                  });
              }
            },
            onToolUse: (toolName, toolInput) => {
              // ツール実行履歴に追加
              const inputSummary = formatToolInput(toolName, toolInput);
              toolHistory.push(`🔧 ${toolName}${inputSummary}`);
              if (!firstTextReceived) {
                const toolDisplay = toolHistory.slice(-5).join('\n');
                replyMessage!.edit(`🤔 考え中...\n${toolDisplay}`).catch(() => {});
              }
            },
          },
          { skipPermissions, sessionId, channelId }
        );
      } finally {
        clearInterval(thinkingInterval);
      }
      result = streamResult.result;
      newSessionId = streamResult.sessionId;
    } else {
      // 非ストリーミング or ワンショットskipランナー
      let dotCount = 1;
      const thinkingInterval = setInterval(() => {
        dotCount = (dotCount % 3) + 1;
        const dots = '.'.repeat(dotCount);
        replyMessage!.edit(`🤔 考え中${dots}`).catch(() => {});
      }, 1000);

      try {
        const runResult = await runner.run(prompt, { skipPermissions, sessionId, channelId });
        result = runResult.result;
        newSessionId = runResult.sessionId;
      } finally {
        clearInterval(thinkingInterval);
      }
    }

    setSession(channelId, newSessionId);
    console.log(
      `[xangi] Response length: ${result.length}, session: ${newSessionId.slice(0, 8)}...`
    );

    // === Phase 10B: Magika Guard — LLM応答内のインストールコマンドチェック ===
    try {
      const responsePackages = extractInstallCommandsFromResponse(result);
      if (responsePackages.length > 0) {
        const warnings: string[] = [];
        for (const pkg of responsePackages) {
          try {
            console.log(
              `[magika-guard] Post-check package in response: ${pkg.manager}/${pkg.packageName}`
            );
            const pkgResult = await checkPackageWithMagika(pkg.manager, pkg.packageName);
            console.log(`[magika-guard] Response package verdict: ${pkgResult.verdict}`);
            const msg = formatMagikaVerdict(
              pkgResult.verdict,
              pkgResult.reason,
              `${pkg.manager}:${pkg.packageName}`
            );
            if (msg) warnings.push(msg);
          } catch (err) {
            console.error(
              `[magika-guard] post-check error for ${pkg.manager}:${pkg.packageName}:`,
              err
            );
          }
        }
        if (warnings.length > 0) {
          result += '\n\n' + warnings.join('\n');
        }
      }
    } catch (err) {
      console.error('[magika-guard] post-response check error:', err);
    }

    // === Izuna Action Hook (Phase 4): アクションマーカー検出・実行 ===
    let izunaActionMessages: string[] = [];
    try {
      const gateSendFn = async (
        content: string,
        components?: ActionRowBuilder<ButtonBuilder>[]
      ): Promise<Message | null> => {
        if ('send' in message.channel) {
          return (await (message.channel as any).send({
            content,
            components: components || [],
          })) as Message;
        }
        return null;
      };
      const actionResult = await processIzunaActions(result, channelId, gateSendFn);
      if (actionResult.actionMessages.length > 0) {
        result = actionResult.cleanText;
        izunaActionMessages = actionResult.actionMessages;
        console.log('[xangi] Action executed:', izunaActionMessages);
      }
    } catch (err) {
      console.error('[xangi] action_hook error:', err);
    }

    // ファイルパスを抽出して添付送信
    const filePaths = extractFilePaths(result);
    const displayText = filePaths.length > 0 ? stripFilePaths(result) : result;

    // SYSTEM_COMMAND: 行と !discord / !schedule コマンド行を表示テキストから除去
    // コードブロック内のコマンドは残す（表示用テキストなので消さない）
    const cleanText = stripCommandsFromDisplay(displayText);

    // === セパレータで明示的に分割（content-digest等で複数投稿を1応答に含める用途）
    // LLMが前後に空白や余分な改行を入れることがあるため、正規表現で緩くマッチ
    const SEPARATOR_REGEX = /\n\s*===\s*\n/;
    const messageParts = SEPARATOR_REGEX.test(cleanText)
      ? cleanText
          .split(SEPARATOR_REGEX)
          .map((p) => p.trim())
          .filter(Boolean)
      : [cleanText];

    // 最初のパートは既存のreplyMessageを編集して送信
    const firstChunks = splitMessage(messageParts[0], DISCORD_SAFE_LENGTH);
    await replyMessage!.edit({
      content: firstChunks[0] || '✅',
      ...(showButtons && { components: [createCompletedButtons()] }),
    });
    // 最後に送信したメッセージIDを記録
    if (replyMessage) {
      lastSentMessageIds.set(message.channel.id, replyMessage.id);
    }
    if ('send' in message.channel) {
      const channel = message.channel as unknown as {
        send: (content: string) => Promise<unknown>;
      };
      // 最初のパートの残りチャンク
      for (let i = 1; i < firstChunks.length; i++) {
        await channel.send(firstChunks[i]);
      }
      // 2つ目以降のパートは新規メッセージとして送信
      for (let p = 1; p < messageParts.length; p++) {
        const chunks = splitMessage(messageParts[p], DISCORD_SAFE_LENGTH);
        for (const chunk of chunks) {
          await channel.send(chunk);
        }
      }
    }

    // AIの応答から SYSTEM_COMMAND: を検知して実行
    handleSettingsFromResponse(result);

    if (filePaths.length > 0 && 'send' in message.channel) {
      try {
        await (
          message.channel as unknown as {
            send: (options: { files: { attachment: string }[] }) => Promise<unknown>;
          }
        ).send({
          files: filePaths.map((fp) => ({ attachment: fp })),
        });
        console.log(`[xangi] Sent ${filePaths.length} file(s) to Discord`);
      } catch (err) {
        console.error('[xangi] Failed to send files:', err);
      }
    }

    // === Izuna Action Results (Phase 4): アクション結果を追加メッセージで送信 ===
    if (izunaActionMessages.length > 0 && 'send' in message.channel) {
      const actionChannel = message.channel as unknown as {
        send: (content: string) => Promise<unknown>;
      };
      for (const actionMsg of izunaActionMessages) {
        // Discord 2000 字 limit 対応: splitMessage で分割送信
        const actChunks = splitMessage(actionMsg, DISCORD_SAFE_LENGTH);
        for (const chunk of actChunks) {
          await actionChannel
            .send(chunk)
            .catch((e: any) => console.error('[xangi] action send error:', e));
        }
      }

      // === Izuna Topic Router (Phase 5): 話題別チャンネルにログ転送 ===
      try {
        const topicResult = classifyTopic(prompt, result);
        if (topicResult.channelId && topicResult.topic !== 'general') {
          const topicChannel = await (message.client as any).channels
            .fetch(topicResult.channelId)
            .catch(() => null);
          if (topicChannel && 'send' in topicChannel) {
            const logMsg = `**[${topicResult.topic}]**\n> ${prompt.slice(0, 150)}\n\n${result
              .replace(/\[ACTION:\w+(?:\s+\{[^\]]*\})?\]/g, '')
              .trim()
              .slice(0, 400)}`;
            await (topicChannel as any)
              .send(logMsg)
              .catch((e: any) => console.error('[xangi] topic route error:', e));
          }
        }
      } catch (err) {
        console.error('[xangi] topic router error:', err);
      }
    }

    // === Izuna Memory Hook (Phase 6): L1記憶にDiscordメッセージ + 応答を記録 ===
    try {
      const cleanResp = result.replace(ACTION_HOOK_RE, '').trim().slice(0, 500);
      const content = `[user] ${prompt.slice(0, 300)}\n[assistant] ${cleanResp}`;
      execFile(
        'python3',
        [
          pathJoin(ACTION_SCRIPTS_DIR, 'memory_curator.py'),
          'record',
          '--agent',
          'izuna',
          '--type',
          'conversation',
          '--content',
          content,
          '--source-type',
          'discord',
          '--session-id',
          message.channel.id,
        ],
        { timeout: 5000, cwd: ACTION_SCRIPTS_DIR },
        (err, _stdout, stderr) => {
          if (err) console.error('[izuna-memory] L1 record error:', stderr || err.message);
          else console.log('[izuna-memory] L1 recorded');
        }
      );
    } catch (err) {
      console.error('[izuna-memory] hook error:', err);
    }

    // AIの応答を返す（!discord コマンド処理用）
    return result;
  } catch (error) {
    if (error instanceof Error && error.message === 'Request cancelled by user') {
      console.log('[xangi] Request cancelled by user');
      const toolDisplay = toolHistory.length > 0 ? '\n' + toolHistory.join('\n') + '\n' : '';
      const prefix = lastStreamedText ? lastStreamedText + '\n\n' : '';
      await replyMessage
        ?.edit({
          content: `${prefix}🛑 停止しました${toolDisplay}`.slice(0, DISCORD_MAX_LENGTH),
          components: [],
        })
        .catch(() => {});
      return null;
    }
    console.error('[xangi] Error:', error);

    // エラーの種類を判別して詳細メッセージを生成
    const errorMsg = error instanceof Error ? error.message : String(error);
    let errorDetail: string;
    if (errorMsg.includes('timed out')) {
      errorDetail = `⏱️ タイムアウトしました（${Math.round((config.agent.config.timeoutMs ?? 300000) / 1000)}秒）`;
    } else if (errorMsg.includes('Process exited unexpectedly')) {
      errorDetail = `💥 AIプロセスが予期せず終了しました: ${errorMsg}`;
    } else if (errorMsg.includes('Circuit breaker')) {
      errorDetail =
        '🔌 AIプロセスが連続でクラッシュしたため一時停止中です。しばらくしてから再試行してください';
    } else {
      errorDetail = `❌ エラーが発生しました: ${errorMsg.slice(0, 200)}`;
    }

    // エラー詳細を表示（途中のテキスト・ツール履歴を残す）
    const toolDisplay = toolHistory.length > 0 ? '\n' + toolHistory.join('\n') : '';
    const prefix = lastStreamedText ? lastStreamedText + '\n\n' : '';
    const errorMessage = `${prefix}${errorDetail}${toolDisplay}`.slice(0, DISCORD_MAX_LENGTH);
    if (replyMessage) {
      await replyMessage.edit({ content: errorMessage, components: [] }).catch(() => {});
    } else {
      await message.reply(errorMessage).catch(() => {});
    }

    // エラー後にエージェントへ自動フォローアップ（タイムアウト・サーキットブレーカー時は除く）
    // タイムアウト時のフォローアップは壊れたセッションにさらに負荷をかけるだけで、
    // 再びタイムアウト→Circuit breaker発動→チャンネルが長時間ロックされる原因になる
    if (!errorMsg.includes('Circuit breaker') && !errorMsg.includes('timed out')) {
      try {
        console.log('[xangi] Sending error follow-up to agent');
        const sessionId = getSession(channelId);
        if (sessionId) {
          const followUpPrompt =
            '先ほどの処理がエラー（タイムアウト等）で中断されました。途中まで行った作業内容と現在の状況を簡潔に報告してください。';
          const followUpResult = await agentRunner.run(followUpPrompt, {
            skipPermissions,
            sessionId,
            channelId,
          });
          if (followUpResult.result) {
            setSession(channelId, followUpResult.sessionId);
            const followUpText = followUpResult.result.slice(0, DISCORD_SAFE_LENGTH);
            if ('send' in message.channel) {
              await (
                message.channel as unknown as {
                  send: (content: string) => Promise<unknown>;
                }
              ).send(`📋 **エラー前の作業報告:**\n${followUpText}`);
            }
          }
        }
      } catch (followUpError) {
        console.error('[xangi] Error follow-up failed:', followUpError);
      }
    }

    return null;
  } finally {
    // 👀 リアクションを削除
    await message.reactions.cache
      .find((r) => r.emoji.name === '👀')
      ?.users.remove(message.client.user?.id)
      .catch((err) => {
        console.error('[xangi] Failed to remove 👀 reaction:', err.message || err);
      });
  }
}

/**
 * AIの応答から SYSTEM_COMMAND: を検知して実行
 * 形式: SYSTEM_COMMAND:restart / SYSTEM_COMMAND:set key=value
 */
function handleSettingsFromResponse(text: string): void {
  const commands = text.match(/^SYSTEM_COMMAND:(.+)$/gm);
  if (!commands) return;

  for (const cmd of commands) {
    const action = cmd.replace('SYSTEM_COMMAND:', '').trim();

    if (action === 'restart') {
      const settings = loadSettings();
      if (!settings.autoRestart) {
        console.log('[xangi] Restart requested but autoRestart is disabled');
        continue;
      }
      console.log('[xangi] Restart requested by agent, restarting in 1s...');
      setTimeout(() => process.exit(0), 1000);
      return;
    }

    const setMatch = action.match(/^set\s+(\w+)=(.*)/);
    if (setMatch) {
      const [, key, value] = setMatch;
      if (key === 'autoRestart') {
        const enabled = value === 'true';
        saveSettings({ autoRestart: enabled });
        console.log(`[xangi] autoRestart ${enabled ? 'enabled' : 'disabled'} by agent`);
      }
    }
  }
}

// ─── Schedule Handlers ──────────────────────────────────────────────

async function handleScheduleCommand(
  interaction: ChatInputCommandInteraction,
  scheduler: Scheduler,
  schedulerConfig?: { enabled: boolean; startupEnabled: boolean }
): Promise<void> {
  const subcommand = interaction.options.getSubcommand();
  const channelId = interaction.channelId;

  switch (subcommand) {
    case 'add': {
      const input = interaction.options.getString('input', true);
      const parsed = parseScheduleInput(input);
      if (!parsed) {
        await interaction.reply({
          content:
            '❌ 入力を解析できませんでした\n\n' +
            '**対応フォーマット:**\n' +
            '• `30分後 メッセージ` — 相対時間\n' +
            '• `15:00 メッセージ` — 時刻指定\n' +
            '• `毎日 9:00 メッセージ` — 毎日定時\n' +
            '• `毎週月曜 10:00 メッセージ` — 週次\n' +
            '• `cron 0 9 * * * メッセージ` — cron式',
          ephemeral: true,
        });
        return;
      }

      try {
        const targetChannel = parsed.targetChannelId || channelId;
        const schedule = scheduler.add({
          ...parsed,
          channelId: targetChannel,
          platform: 'discord' as Platform,
        });

        const channelInfo = parsed.targetChannelId ? ` → <#${parsed.targetChannelId}>` : '';
        const typeLabel = getTypeLabel(schedule.type, {
          expression: schedule.expression,
          runAt: schedule.runAt,
          channelInfo,
        });

        await interaction.reply(
          `✅ スケジュールを追加しました\n\n${typeLabel}\n📝 ${schedule.message}\n🆔 \`${schedule.id}\``
        );
      } catch (error) {
        await interaction.reply({
          content: `❌ ${error instanceof Error ? error.message : 'エラーが発生しました'}`,
          ephemeral: true,
        });
      }
      return;
    }

    case 'list': {
      // 全スケジュールを表示（チャンネルでフィルタしない）
      const schedules = scheduler.list();
      const content = formatScheduleList(schedules, schedulerConfig);
      if (content.length <= DISCORD_MAX_LENGTH) {
        await interaction.reply(content.replaceAll(SCHEDULE_SEPARATOR, ''));
      } else {
        const chunks = splitScheduleContent(content, DISCORD_SAFE_LENGTH);
        await interaction.reply(chunks[0]);
        for (let i = 1; i < chunks.length; i++) {
          await interaction.followUp(chunks[i]);
        }
      }
      return;
    }

    case 'remove': {
      const id = interaction.options.getString('id', true);
      const removed = scheduler.remove(id);
      await interaction.reply(
        removed ? `🗑️ スケジュール \`${id}\` を削除しました` : `❌ ID \`${id}\` が見つかりません`
      );
      return;
    }

    case 'toggle': {
      const id = interaction.options.getString('id', true);
      const schedule = scheduler.toggle(id);
      if (schedule) {
        const status = schedule.enabled ? '✅ 有効' : '⏸️ 無効';
        await interaction.reply(`${status} に切り替えました: \`${id}\``);
      } else {
        await interaction.reply(`❌ ID \`${id}\` が見つかりません`);
      }
      return;
    }
  }
}

async function handleScheduleMessage(
  message: Message,
  prompt: string,
  scheduler: Scheduler,
  schedulerConfig?: { enabled: boolean; startupEnabled: boolean }
): Promise<void> {
  const args = prompt.replace(/^!schedule\s*/, '').trim();
  const channelId = message.channel.id;

  // !schedule (引数なし) or !schedule list → 一覧（全件表示）
  if (!args || args === 'list') {
    const schedules = scheduler.list();
    const content = formatScheduleList(schedules, schedulerConfig);
    if (content.length <= DISCORD_MAX_LENGTH) {
      await message.reply(content.replaceAll(SCHEDULE_SEPARATOR, ''));
    } else {
      const chunks = splitScheduleContent(content, DISCORD_SAFE_LENGTH);
      for (const chunk of chunks) {
        await message.reply(chunk);
      }
    }
    return;
  }

  // !schedule remove <id|番号> [番号2] [番号3] ...
  if (args.startsWith('remove ') || args.startsWith('delete ') || args.startsWith('rm ')) {
    const parts = args.split(/\s+/).slice(1).filter(Boolean);
    if (parts.length === 0) {
      await message.reply('使い方: `!schedule remove <ID または 番号> [番号2] ...`');
      return;
    }

    const schedules = scheduler.list();
    const deletedIds: string[] = [];
    const errors: string[] = [];

    // 番号を大きい順にソート（削除時のずれを防ぐ）
    const targets = parts
      .map((p) => {
        const num = parseInt(p, 10);
        if (!isNaN(num) && num > 0 && !p.startsWith('sch_')) {
          if (num > schedules.length) {
            errors.push(`番号 ${num} は範囲外`);
            return null;
          }
          return { index: num, id: schedules[num - 1].id };
        }
        return { index: 0, id: p };
      })
      .filter((t): t is { index: number; id: string } => t !== null)
      .sort((a, b) => b.index - a.index); // 大きい番号から削除

    for (const target of targets) {
      if (scheduler.remove(target.id)) {
        deletedIds.push(target.id);
      } else {
        errors.push(`ID ${target.id} が見つからない`);
      }
    }

    const remaining = scheduler.list();
    let response = '';
    if (deletedIds.length > 0) {
      response += `✅ ${deletedIds.length}件削除しました\n\n`;
    }
    if (errors.length > 0) {
      response += `⚠️ エラー: ${errors.join(', ')}\n\n`;
    }
    response += formatScheduleList(remaining, schedulerConfig);
    // 2000文字制限対応
    if (response.length <= DISCORD_MAX_LENGTH) {
      await message.reply(response.replaceAll(SCHEDULE_SEPARATOR, ''));
    } else {
      const chunks = splitScheduleContent(response, DISCORD_SAFE_LENGTH);
      for (const chunk of chunks) {
        await message.reply(chunk);
      }
    }
    return;
  }

  // !schedule toggle <id|番号>
  if (args.startsWith('toggle ')) {
    const idOrIndex = args.split(/\s+/)[1];
    if (!idOrIndex) {
      await message.reply('使い方: `!schedule toggle <ID または 番号>`');
      return;
    }

    let targetId = idOrIndex;
    const indexNum = parseInt(idOrIndex, 10);
    if (!isNaN(indexNum) && indexNum > 0 && !idOrIndex.startsWith('sch_')) {
      const schedules = scheduler.list(channelId);
      if (indexNum > schedules.length) {
        await message.reply(`❌ 番号 ${indexNum} は範囲外です（1〜${schedules.length}）`);
        return;
      }
      targetId = schedules[indexNum - 1].id;
    }

    const schedule = scheduler.toggle(targetId);
    if (schedule) {
      const status = schedule.enabled ? '✅ 有効化' : '⏸️ 無効化';
      const all = scheduler.list(channelId);
      const listContent = formatScheduleList(all, schedulerConfig).replaceAll(
        SCHEDULE_SEPARATOR,
        ''
      );
      await message.reply(`${status}しました: ${targetId}\n\n${listContent}`);
    } else {
      await message.reply(`❌ ID \`${targetId}\` が見つかりません`);
    }
    return;
  }

  // !schedule add <input> or !schedule <input> (addなしでも追加)
  const input = args.startsWith('add ') ? args.replace(/^add\s+/, '') : args;
  const parsed = parseScheduleInput(input);
  if (!parsed) {
    await message.reply(
      '❌ 入力を解析できませんでした\n\n' +
        '**対応フォーマット:**\n' +
        '• `!schedule 30分後 メッセージ`\n' +
        '• `!schedule 15:00 メッセージ`\n' +
        '• `!schedule 毎日 9:00 メッセージ`\n' +
        '• `!schedule 毎週月曜 10:00 メッセージ`\n' +
        '• `!schedule cron 0 9 * * * メッセージ`\n' +
        '• `!schedule list` / `!schedule remove <ID>`'
    );
    return;
  }

  try {
    const targetChannel = parsed.targetChannelId || channelId;
    const schedule = scheduler.add({
      ...parsed,
      channelId: targetChannel,
      platform: 'discord' as Platform,
    });

    const channelInfo = parsed.targetChannelId ? ` → <#${parsed.targetChannelId}>` : '';
    const typeLabel = getTypeLabel(schedule.type, {
      expression: schedule.expression,
      runAt: schedule.runAt,
      channelInfo,
    });

    await message.reply(
      `✅ スケジュールを追加しました\n\n${typeLabel}\n📝 ${schedule.message}\n🆔 \`${schedule.id}\``
    );
  } catch (error) {
    await message.reply(`❌ ${error instanceof Error ? error.message : 'エラーが発生しました'}`);
  }
}

/**
 * AI応答内の !schedule コマンドを実行
 */
async function executeScheduleFromResponse(
  text: string,
  sourceMessage: Message,
  scheduler: Scheduler,
  schedulerConfig?: { enabled: boolean; startupEnabled: boolean }
): Promise<void> {
  const args = text.replace(/^!schedule\s*/, '').trim();
  const channelId = sourceMessage.channel.id;
  const channel = sourceMessage.channel;

  // list コマンド（全件表示）
  if (!args || args === 'list') {
    const schedules = scheduler.list();
    const content = formatScheduleList(schedules, schedulerConfig);
    if ('send' in channel) {
      const sendFn = (channel as { send: (content: string) => Promise<unknown> }).send.bind(
        channel
      );
      // 2000文字制限対応: 分割送信
      if (content.length <= DISCORD_MAX_LENGTH) {
        await sendFn(content.replaceAll(SCHEDULE_SEPARATOR, ''));
      } else {
        const chunks = splitScheduleContent(content, DISCORD_SAFE_LENGTH);
        for (const chunk of chunks) {
          await sendFn(chunk);
        }
      }
    }
    return;
  }

  // remove コマンド（複数対応）
  if (args.startsWith('remove ') || args.startsWith('delete ') || args.startsWith('rm ')) {
    const parts = args.split(/\s+/).slice(1).filter(Boolean);
    if (parts.length === 0) return;

    const schedules = scheduler.list();
    const deletedIds: string[] = [];

    // 番号を大きい順にソート（削除時のずれを防ぐ）
    const targets = parts
      .map((p) => {
        const num = parseInt(p, 10);
        if (!isNaN(num) && num > 0 && !p.startsWith('sch_')) {
          if (num > schedules.length) return null;
          return { index: num, id: schedules[num - 1].id };
        }
        return { index: 0, id: p };
      })
      .filter((t): t is { index: number; id: string } => t !== null)
      .sort((a, b) => b.index - a.index);

    for (const target of targets) {
      if (scheduler.remove(target.id)) {
        deletedIds.push(target.id);
      }
    }

    if ('send' in channel && deletedIds.length > 0) {
      const remaining = scheduler.list();
      const content = `✅ ${deletedIds.length}件削除しました\n\n${formatScheduleList(remaining, schedulerConfig)}`;
      const sendFn = (channel as { send: (content: string) => Promise<unknown> }).send.bind(
        channel
      );
      if (content.length <= DISCORD_MAX_LENGTH) {
        await sendFn(content.replaceAll(SCHEDULE_SEPARATOR, ''));
      } else {
        const chunks = splitScheduleContent(content, DISCORD_SAFE_LENGTH);
        for (const chunk of chunks) {
          await sendFn(chunk);
        }
      }
    }
    return;
  }

  // toggle コマンド
  if (args.startsWith('toggle ')) {
    const idOrIndex = args.split(/\s+/)[1];
    if (!idOrIndex) return;

    let targetId = idOrIndex;
    const indexNum = parseInt(idOrIndex, 10);
    if (!isNaN(indexNum) && indexNum > 0 && !idOrIndex.startsWith('sch_')) {
      const schedules = scheduler.list(channelId);
      if (indexNum > schedules.length) {
        if ('send' in channel) {
          await (channel as { send: (content: string) => Promise<unknown> }).send(
            `❌ 番号 ${indexNum} は範囲外です（1〜${schedules.length}）`
          );
        }
        return;
      }
      targetId = schedules[indexNum - 1].id;
    }

    const schedule = scheduler.toggle(targetId);
    if ('send' in channel) {
      if (schedule) {
        const status = schedule.enabled ? '✅ 有効化' : '⏸️ 無効化';
        const all = scheduler.list(channelId);
        const listContent = formatScheduleList(all, schedulerConfig).replaceAll(
          SCHEDULE_SEPARATOR,
          ''
        );
        await (channel as { send: (content: string) => Promise<unknown> }).send(
          `${status}しました: ${targetId}\n\n${listContent}`
        );
      } else {
        await (channel as { send: (content: string) => Promise<unknown> }).send(
          `❌ ID \`${targetId}\` が見つかりません`
        );
      }
    }
    return;
  }

  const input = args.startsWith('add ') ? args.replace(/^add\s+/, '') : args;
  const parsed = parseScheduleInput(input);
  if (!parsed) {
    console.log(`[xangi] Failed to parse schedule input: ${input}`);
    return;
  }

  try {
    const targetChannel = parsed.targetChannelId || channelId;
    const schedule = scheduler.add({
      ...parsed,
      channelId: targetChannel,
      platform: 'discord' as Platform,
    });

    const channelInfo = parsed.targetChannelId ? ` → <#${parsed.targetChannelId}>` : '';
    const typeLabel = getTypeLabel(schedule.type, {
      expression: schedule.expression,
      runAt: schedule.runAt,
      channelInfo,
    });

    if ('send' in channel) {
      await (channel as { send: (content: string) => Promise<unknown> }).send(
        `✅ スケジュールを追加しました\n\n${typeLabel}\n📝 ${schedule.message}\n🆔 \`${schedule.id}\``
      );
    }
  } catch (error) {
    console.error('[xangi] Failed to add schedule from response:', error);
  }
}

main().catch(console.error);
