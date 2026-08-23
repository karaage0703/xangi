import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ALL_AGENT_BACKENDS, type AgentBackend, type EffortLevel } from './config.js';

const PROJECTS_FILE = 'web-projects.json';
const PROJECTS_VERSION = 1;
const MAX_NAME_LENGTH = 80;
const MAX_PROMPT_LENGTH = 20_000;
const MAX_MODEL_LENGTH = 200;
const EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', 'max'];

export interface WebProjectBackendSettings {
  backend?: AgentBackend;
  model?: string;
  effort?: EffortLevel;
}

interface WebProjectBackendInput {
  backend?: AgentBackend | null;
  model?: string | null;
  effort?: EffortLevel | null;
}

export interface WebProject {
  id: string;
  name: string;
  prompt: string;
  backend?: AgentBackend;
  model?: string;
  effort?: EffortLevel;
  /** 新規sessionの既定workspace。既存session snapshotは変更しない。 */
  workspaceId?: string;
  createdAt: string;
  updatedAt: string;
}

interface PersistedWebProjects {
  version: 1;
  projects: WebProject[];
}

export interface WebProjectStateIssue {
  projectId?: string;
  projectName?: string;
  message: string;
  recovery: 'disable-backend-settings' | 'skip-project';
}

export class WebProjectStore {
  private state: PersistedWebProjects;

  constructor(private readonly filePath: string) {
    this.state = this.load();
  }

  static fromDataDir(dataDir: string): WebProjectStore {
    return new WebProjectStore(join(dataDir, PROJECTS_FILE));
  }

  list(): WebProject[] {
    return this.state.projects
      .map((project) => ({ ...project }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  get(id: string): WebProject | undefined {
    const project = this.state.projects.find((candidate) => candidate.id === id);
    return project ? { ...project } : undefined;
  }

  create(
    input: { name: string; prompt?: string; workspaceId?: string } & WebProjectBackendInput
  ): WebProject {
    const name = normalizeName(input.name);
    const prompt = normalizePrompt(input.prompt ?? '');
    const backendSettings = normalizeBackendSettings(input);
    this.assertUniqueName(name);
    const timestamp = new Date().toISOString();
    const project: WebProject = {
      id: randomUUID(),
      name,
      prompt,
      ...backendSettings,
      workspaceId: normalizeWorkspaceId(input.workspaceId),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.state.projects.push(project);
    this.persist();
    return { ...project };
  }

  update(
    id: string,
    input: { name?: string; prompt?: string; workspaceId?: string | null } & WebProjectBackendInput
  ): WebProject {
    const project = this.state.projects.find((candidate) => candidate.id === id);
    if (!project) throw new WebProjectError('Projectが見つかりません', 404);
    const name = input.name === undefined ? project.name : normalizeName(input.name);
    const prompt = input.prompt === undefined ? project.prompt : normalizePrompt(input.prompt);
    const backendSettings =
      input.backend === undefined && input.model === undefined && input.effort === undefined
        ? { backend: project.backend, model: project.model, effort: project.effort }
        : normalizeBackendSettings(input);
    this.assertUniqueName(name, id);
    project.name = name;
    project.prompt = prompt;
    project.backend = backendSettings.backend;
    project.model = backendSettings.model;
    project.effort = backendSettings.effort;
    if (input.workspaceId !== undefined) {
      project.workspaceId = normalizeWorkspaceId(input.workspaceId ?? undefined);
    }
    project.updatedAt = new Date().toISOString();
    this.persist();
    return { ...project };
  }

  remove(id: string): boolean {
    const index = this.state.projects.findIndex((candidate) => candidate.id === id);
    if (index < 0) return false;
    this.state.projects.splice(index, 1);
    this.persist();
    return true;
  }

  private load(): PersistedWebProjects {
    if (!existsSync(this.filePath)) return { version: PROJECTS_VERSION, projects: [] };
    try {
      return parseProjects(readFileSync(this.filePath, 'utf8'), (issue) => {
        const project = issue.projectName || issue.projectId || '(unknown)';
        const action =
          issue.recovery === 'disable-backend-settings'
            ? 'backend/model/effortを無効化して継続します'
            : 'このProjectをスキップして継続します';
        console.warn(
          `[web-projects] Project ${JSON.stringify(project)}: ${issue.message}。${action}`
        );
      });
    } catch (error) {
      throw new Error(
        `Web Project設定を読み込めません: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private assertUniqueName(name: string, excludedId?: string): void {
    const normalized = name.toLocaleLowerCase();
    if (
      this.state.projects.some(
        (project) => project.id !== excludedId && project.name.toLocaleLowerCase() === normalized
      )
    ) {
      throw new WebProjectError('同じ名前のProjectがすでにあります', 409);
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp-${process.pid}`;
    writeFileSync(temporaryPath, `${JSON.stringify(this.state, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    renameSync(temporaryPath, this.filePath);
  }
}

export function validateWebProjectsState(dataDir: string): WebProjectStateIssue[] {
  const filePath = join(dataDir, PROJECTS_FILE);
  if (!existsSync(filePath)) return [];
  const issues: WebProjectStateIssue[] = [];
  try {
    parseProjects(readFileSync(filePath, 'utf8'), (issue) => issues.push(issue));
  } catch (error) {
    issues.push({
      message: error instanceof Error ? error.message : String(error),
      recovery: 'skip-project',
    });
  }
  return issues;
}

export class WebProjectError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

export function prependWebProjectPrompt(project: WebProject | undefined, prompt: string): string {
  if (!project?.prompt.trim()) return prompt;
  return `<web-project-context name=${JSON.stringify(project.name)}>\n${project.prompt}\n</web-project-context>\n\n${prompt}`;
}

function parseProjects(
  raw: string,
  onIssue: (issue: WebProjectStateIssue) => void = () => {}
): PersistedWebProjects {
  const parsed = JSON.parse(raw) as Partial<PersistedWebProjects>;
  if (parsed.version !== PROJECTS_VERSION || !Array.isArray(parsed.projects)) {
    throw new Error('形式が不正です');
  }
  const ids = new Set<string>();
  const names = new Set<string>();
  const projects: WebProject[] = [];
  for (const candidate of parsed.projects) {
    const projectId = candidate && typeof candidate.id === 'string' ? candidate.id : undefined;
    const projectName =
      candidate && typeof candidate.name === 'string' ? candidate.name.trim() : undefined;
    try {
      if (
        !candidate ||
        typeof candidate.id !== 'string' ||
        typeof candidate.name !== 'string' ||
        typeof candidate.prompt !== 'string' ||
        typeof candidate.createdAt !== 'string' ||
        typeof candidate.updatedAt !== 'string'
      ) {
        throw new Error('Project項目が不正です');
      }
      const name = normalizeName(candidate.name);
      const normalizedName = name.toLocaleLowerCase();
      if (ids.has(candidate.id) || names.has(normalizedName)) {
        throw new Error('Project IDまたは名前が重複しています');
      }
      const prompt = normalizePrompt(candidate.prompt);

      let backendSettings: WebProjectBackendSettings = {};
      try {
        backendSettings = normalizeBackendSettings(candidate);
      } catch (error) {
        onIssue({
          projectId: candidate.id,
          projectName: name,
          message: error instanceof Error ? error.message : String(error),
          recovery: 'disable-backend-settings',
        });
      }
      ids.add(candidate.id);
      names.add(normalizedName);
      projects.push({
        id: candidate.id,
        name,
        prompt,
        ...backendSettings,
        workspaceId: normalizeWorkspaceId(candidate.workspaceId),
        createdAt: candidate.createdAt,
        updatedAt: candidate.updatedAt,
      });
    } catch (error) {
      onIssue({
        projectId,
        projectName,
        message: error instanceof Error ? error.message : String(error),
        recovery: 'skip-project',
      });
    }
  }
  return { version: PROJECTS_VERSION, projects };
}

function normalizeName(value: string): string {
  const name = value.trim();
  if (!name) throw new WebProjectError('Project名を入力してください', 400);
  if (name.length > MAX_NAME_LENGTH) {
    throw new WebProjectError(`Project名は${MAX_NAME_LENGTH}文字以内にしてください`, 400);
  }
  if (
    [...name].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  ) {
    throw new WebProjectError('Project名に制御文字は使えません', 400);
  }
  return name;
}

function normalizePrompt(value: string): string {
  const prompt = value.trim();
  if (prompt.length > MAX_PROMPT_LENGTH) {
    throw new WebProjectError(`追加プロンプトは${MAX_PROMPT_LENGTH}文字以内にしてください`, 400);
  }
  return prompt;
}

function normalizeWorkspaceId(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new WebProjectError('workspaceIdが不正です', 400);
  const normalized = value.trim();
  // eslint-disable-next-line no-control-regex
  if (!normalized || normalized.length > 200 || /[\0-\x1f\x7f]/.test(normalized)) {
    throw new WebProjectError('workspaceIdが不正です', 400);
  }
  return normalized;
}

function normalizeBackendSettings(input: WebProjectBackendInput): WebProjectBackendSettings {
  const backend = input.backend || undefined;
  if (backend !== undefined && !ALL_AGENT_BACKENDS.includes(backend)) {
    throw new WebProjectError('Projectのバックエンドが不正です', 400);
  }
  const model = input.model?.trim() || undefined;
  if (model && (model.length > MAX_MODEL_LENGTH || hasControlCharacter(model))) {
    throw new WebProjectError(`モデルIDは${MAX_MODEL_LENGTH}文字以内で入力してください`, 400);
  }
  const effort = input.effort || undefined;
  if (effort !== undefined && !EFFORT_LEVELS.includes(effort)) {
    throw new WebProjectError('Projectのeffortが不正です', 400);
  }
  if (!backend && (model || effort)) {
    throw new WebProjectError('モデルまたはeffortを設定するにはバックエンドが必要です', 400);
  }
  return { backend, model, effort };
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}
