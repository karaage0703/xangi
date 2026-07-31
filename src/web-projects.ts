import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const PROJECTS_FILE = 'web-projects.json';
const PROJECTS_VERSION = 1;
const MAX_NAME_LENGTH = 80;
const MAX_PROMPT_LENGTH = 20_000;

export interface WebProject {
  id: string;
  name: string;
  prompt: string;
  createdAt: string;
  updatedAt: string;
}

interface PersistedWebProjects {
  version: 1;
  projects: WebProject[];
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

  create(input: { name: string; prompt?: string }): WebProject {
    const name = normalizeName(input.name);
    const prompt = normalizePrompt(input.prompt ?? '');
    this.assertUniqueName(name);
    const timestamp = new Date().toISOString();
    const project: WebProject = {
      id: randomUUID(),
      name,
      prompt,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.state.projects.push(project);
    this.persist();
    return { ...project };
  }

  update(id: string, input: { name?: string; prompt?: string }): WebProject {
    const project = this.state.projects.find((candidate) => candidate.id === id);
    if (!project) throw new WebProjectError('Projectが見つかりません', 404);
    const name = input.name === undefined ? project.name : normalizeName(input.name);
    const prompt = input.prompt === undefined ? project.prompt : normalizePrompt(input.prompt);
    this.assertUniqueName(name, id);
    project.name = name;
    project.prompt = prompt;
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
      return parseProjects(readFileSync(this.filePath, 'utf8'));
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

function parseProjects(raw: string): PersistedWebProjects {
  const parsed = JSON.parse(raw) as Partial<PersistedWebProjects>;
  if (parsed.version !== PROJECTS_VERSION || !Array.isArray(parsed.projects)) {
    throw new Error('形式が不正です');
  }
  const ids = new Set<string>();
  const names = new Set<string>();
  const projects = parsed.projects.map((candidate) => {
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
    ids.add(candidate.id);
    names.add(normalizedName);
    return {
      id: candidate.id,
      name,
      prompt: normalizePrompt(candidate.prompt),
      createdAt: candidate.createdAt,
      updatedAt: candidate.updatedAt,
    };
  });
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
