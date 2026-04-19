/**
 * Triggers — chatモードでマジックワードによる機能発動
 *
 * ワークスペースの triggers/ ディレクトリから trigger.yaml を読み込み、
 * LLM応答テキストからトリガーワードを検出して handler スクリプトを実行する。
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { parse as parseYaml } from 'yaml';

const EXEC_TIMEOUT_MS = parseInt(process.env.EXEC_TIMEOUT_MS ?? '120000', 10);

export interface Trigger {
  name: string;
  description: string;
  handler: string;
  /** trigger.yaml が存在するディレクトリの絶対パス */
  path: string;
}

/**
 * ワークスペースの triggers/ ディレクトリをスキャンして trigger 定義を読み込む。
 * triggers/ が存在しない場合は空配列を返す。
 */
export function loadTriggers(workdir: string): Trigger[] {
  const triggersDir = join(workdir, 'triggers');
  if (!existsSync(triggersDir) || !statSync(triggersDir).isDirectory()) {
    return [];
  }

  const triggers: Trigger[] = [];
  let entries: string[];
  try {
    entries = readdirSync(triggersDir);
  } catch {
    return [];
  }

  for (const entry of entries) {
    const entryPath = join(triggersDir, entry);
    if (!statSync(entryPath).isDirectory()) continue;

    const yamlPath = join(entryPath, 'trigger.yaml');
    if (!existsSync(yamlPath)) continue;

    try {
      const content = readFileSync(yamlPath, 'utf-8');
      const parsed = parseYaml(content) as Record<string, unknown>;

      if (!parsed.name || !parsed.handler) {
        console.warn(`[triggers] Invalid trigger.yaml in ${entry}: missing required fields`);
        continue;
      }

      triggers.push({
        name: String(parsed.name),
        description: String(parsed.description || ''),
        handler: String(parsed.handler),
        path: entryPath,
      });

      console.log(`[triggers] Loaded: ${parsed.name}`);
    } catch (err) {
      console.warn(
        `[triggers] Failed to parse ${yamlPath}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  return triggers;
}

/**
 * トリガーの handler スクリプトを実行して結果を返す。
 * handler はワークスペースルートを cwd として実行される。
 */
export function executeTrigger(
  trigger: Trigger,
  args: string,
  workdir: string
): Promise<{ success: boolean; output: string }> {
  const handlerPath = join(trigger.path, trigger.handler);

  return new Promise((resolve) => {
    const argv = args ? args.split(/\s+/) : [];
    execFile(
      'bash',
      [handlerPath, ...argv],
      {
        cwd: workdir,
        timeout: EXEC_TIMEOUT_MS,
        env: { ...process.env },
      },
      (error, stdout, stderr) => {
        if (error) {
          const errMsg = stderr || error.message;
          console.error(`[triggers] Handler ${trigger.name} failed: ${errMsg}`);
          resolve({ success: false, output: `Error: ${errMsg}` });
        } else {
          resolve({ success: true, output: stdout });
        }
      }
    );
  });
}

/**
 * トリガーをToolHandlerに変換する（ツールモード用）。
 * LLMがfunction callingでトリガーを呼び出せるようにする。
 */
export function triggersToToolHandlers(
  triggers: Trigger[],
  workdir: string
): import('./types.js').ToolHandler[] {
  return triggers.map((t) => ({
    name: t.name,
    description: t.description || `Execute ${t.name} trigger`,
    parameters: {
      type: 'object' as const,
      properties: {
        args: { type: 'string', description: 'Arguments to pass to the trigger handler' },
      },
      required: [] as string[],
    },
    async execute(
      args: Record<string, unknown>,
      _context: import('./types.js').ToolContext
    ): Promise<import('./types.js').ToolResult> {
      const triggerArgs = String(args.args || '');
      const result = await executeTrigger(t, triggerArgs, workdir);
      return {
        success: result.success,
        output: result.output,
        error: result.success ? undefined : result.output,
      };
    },
  }));
}
