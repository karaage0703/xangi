import { join } from 'node:path';
import { validateWebProjectsState } from './web-projects.js';

export interface RuntimeStateValidationOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export function resolveRuntimeDataDir(options: RuntimeStateValidationOptions = {}): string {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const workspacePath = env.WORKSPACE_PATH || cwd;
  return env.DATA_DIR || join(workspacePath, '.xangi');
}

export function validateRuntimeState(options: RuntimeStateValidationOptions = {}): string[] {
  const env = options.env ?? process.env;
  if (env.WEB_CHAT_ENABLED !== 'true') return [];
  const dataDir = resolveRuntimeDataDir(options);
  return validateWebProjectsState(dataDir).map((issue) => {
    const project = issue.projectName || issue.projectId || '(unknown)';
    return `web-projects.json: Project ${JSON.stringify(project)}: ${issue.message}`;
  });
}

export function assertRuntimeStateCanStart(options: RuntimeStateValidationOptions = {}): void {
  const issues = validateRuntimeState(options);
  if (issues.length === 0) return;
  throw new Error(
    [
      '再起動前のstate検証に失敗しました。再起動は実行していません。',
      ...issues.map((issue) => `- ${issue}`),
    ].join('\n')
  );
}
