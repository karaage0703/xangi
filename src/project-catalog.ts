import { migrateTeamState } from './team-migration.js';
import {
  normalizeTeam,
  upgradeLegacyTeam,
  teamCallerInstructions,
  teamAgentId,
  defaultTeamAgent,
  DEFAULT_TEAM_AGENT_ID,
  type Team,
  type TeamSnapshot,
} from './teams.js';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  validateProjectCatalogRaw,
  WebProjectStore,
  WebProjectError,
  normalizeName,
  normalizePrompt,
  normalizeBackendSettings,
  normalizeAgentOptions,
  type WebProject,
} from './web-projects.js';

export interface SharedAgent extends WebProject {
  role?: string;
}
export interface SharedProject extends WebProject {
  studioLegacyId?: string;
}
interface Catalog {
  version: 1;
  projectPromptsSeparated?: boolean;
  projects: SharedProject[];
  agents: SharedAgent[];
  teams?: Team[];
}
type Input = Record<string, unknown>;
/** One atomic document keeps projects and reusable agent settings consistent. */
export class ProjectCatalog {
  private state: Catalog;
  private readonly file: string;
  constructor(dataDir: string) {
    this.file = join(dataDir, 'project-catalog.json');
    if (existsSync(this.file)) {
      const raw = readFileSync(this.file, 'utf8');
      const issues = validateProjectCatalogRaw(raw);
      if (issues.length)
        throw new Error(`Invalid project catalog: ${issues.map((i) => i.message).join('; ')}`);
      const state = JSON.parse(raw, migrateTeamState) as Catalog;
      if (state.version !== 1 || !Array.isArray(state.projects) || !Array.isArray(state.agents))
        throw new Error('Invalid project catalog');
      const legacyAgentRoles = new Map(state.agents.map((a) => [a.id, a.role]));
      // Retire the old fields once, retaining their text in the editable instructions.
      let retiredFields = JSON.stringify(state) !== JSON.stringify(JSON.parse(raw));
      for (const [items, field] of [
        [state.projects, 'goal'],
        [state.projects, 'materials'],
        [state.agents, 'expertise'],
        [state.agents, 'role'],
      ] as const) {
        for (const item of items) {
          const record = item as unknown as Record<string, unknown>;
          if (!Object.hasOwn(record, field)) continue;
          const text = typeof record[field] === 'string' ? record[field].trim() : '';
          if (text) item.prompt = [text, item.prompt].filter(Boolean).join('\n\n');
          delete record[field];
          retiredFields = true;
        }
      }
      for (const team of state.teams || []) {
        for (const member of team.members) {
          if (member.role && member.role === legacyAgentRoles.get(member.agentId)) {
            member.role = '';
            retiredFields = true;
          }
        }
        const upgraded = upgradeLegacyTeam(team);
        if (upgraded !== team) {
          Object.assign(team, upgraded);
          retiredFields = true;
        }
        normalizeTeam({ ...team }, state.agents);
      }
      this.state = state;
      if (retiredFields) this.persist(state);
      if (!state.projectPromptsSeparated) {
        // Only repair untouched migration output; never move edited agent instructions.
        for (const legacy of WebProjectStore.fromDataDir(dataDir).list()) {
          const project = state.projects.find((p) => p.id === legacy.id);
          const agent = state.agents.find((a) => a.id === legacy.id);
          if (
            project &&
            agent &&
            !project.prompt &&
            agent.prompt === legacy.prompt &&
            agent.updatedAt === legacy.updatedAt
          ) {
            project.prompt = legacy.prompt;
            agent.prompt = '';
            delete agent.workspaceId;
          }
        }
        state.projectPromptsSeparated = true;
        this.persist(state);
      }
    } else {
      const legacy = WebProjectStore.fromDataDir(dataDir).list();
      this.state = {
        version: 1,
        projectPromptsSeparated: true,
        agents: legacy.map(({ workspaceId: _workspaceId, ...p }) => ({
          ...p,
          prompt: '',
          role: '',
        })),
        projects: legacy.map(({ backend: _backend, model: _model, effort: _effort, ...p }) => ({
          ...p,
        })),
      };
      // Preserve the original web-projects.json unchanged for rollback.
      this.persist(this.state);
    }
  }
  list() {
    return structuredClone(this.state.projects);
  }
  get(id: string) {
    return structuredClone(this.state.projects.find((p) => p.id === id));
  }
  agents() {
    return structuredClone(this.state.agents);
  }
  agent(id: string) {
    return structuredClone(this.state.agents.find((a) => a.id === id));
  }
  private persist(next: Catalog) {
    mkdirSync(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp-${process.pid}`;
    writeFileSync(temporary, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
    renameSync(temporary, this.file);
    this.state = next;
  }
  private unique(items: { id: string; name: string }[], name: string, id: string) {
    if (items.some((x) => x.id !== id && x.name.toLocaleLowerCase() === name.toLocaleLowerCase()))
      throw new WebProjectError('同じ名前がすでにあります', 409);
  }
  saveAgent(input: Input, id: string = randomUUID()): SharedAgent {
    const next = structuredClone(this.state);
    const previous = next.agents.find((a) => a.id === id);
    const merged = { ...previous, ...input };
    const settings = normalizeBackendSettings(
      merged as Parameters<typeof normalizeBackendSettings>[0]
    );
    const agent: SharedAgent = {
      id,
      name: normalizeName(String(merged.name || '')),
      prompt: normalizePrompt([merged.role, merged.prompt].filter(Boolean).join('\n\n')),
      ...settings,
      ...normalizeAgentOptions(merged),
      createdAt: previous?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.unique(next.agents, agent.name, id);
    next.agents = [...next.agents.filter((a) => a.id !== id), agent];
    this.persist(next);
    return structuredClone(agent);
  }
  teams(): Team[] {
    return structuredClone(this.state.teams || []);
  }
  teamAgents(): SharedAgent[] {
    return [defaultTeamAgent(), ...this.agents()];
  }
  team(id: string): Team | undefined {
    return this.teams().find((p) => p.id === id);
  }
  saveTeam(input: Input, id: string = randomUUID()): Team {
    const previous = this.team(id);
    const team: Team = {
      ...normalizeTeam({ ...previous, ...input }, this.agents()),
      id,
      createdAt: previous?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.unique(this.teams(), team.name, id);
    this.persist({ ...this.state, teams: [...this.teams().filter((p) => p.id !== id), team] });
    return structuredClone(team);
  }
  removeTeam(id: string) {
    this.persist({ ...this.state, teams: this.teams().filter((p) => p.id !== id) });
  }
  teamAgent(id: string): SharedAgent | undefined {
    const team = this.team(id);
    if (!team) return undefined;
    const snapshot: TeamSnapshot = {
      ...team,
      agents: team.members.map((m) => {
        const agent =
          m.agentId === DEFAULT_TEAM_AGENT_ID ? defaultTeamAgent() : this.agent(m.agentId);
        if (!agent) throw new WebProjectError('Teamのメンバーが見つかりません', 409);
        return agent;
      }),
    };
    return {
      ...team,
      id: teamAgentId(id),
      role: '',
      prompt: team.leadership === 'caller' ? teamCallerInstructions(snapshot) : '',
      team: snapshot,
    };
  }
  removeAgent(id: string) {
    if (this.teams().some((p) => p.members.some((m) => m.agentId === id)))
      throw new WebProjectError('Teamで使用中のAgentです。先にメンバーから外してください', 409);
    this.persist({ ...this.state, agents: this.state.agents.filter((a) => a.id !== id) });
  }
  importStudio(input: Input) {
    const legacyId = String(input.legacyId || '');
    if (!legacyId || legacyId.length > 200) throw new WebProjectError('移行IDが不正です', 400);
    const existing = this.state.projects.find((p) => p.studioLegacyId === legacyId);
    if (existing) return structuredClone(existing);
    const name = normalizeName(String(input.name || '').slice(0, 80));
    let importedName = name;
    let suffix = 1;
    while (
      this.state.projects.some(
        (p) => p.name.toLocaleLowerCase() === importedName.toLocaleLowerCase()
      )
    )
      importedName = `${name.slice(0, 55)} (Studio ${suffix++})`;
    return this.saveProject({
      ...input,
      studioLegacyId: legacyId,
      name: importedName,
    });
  }
  create(input: Input) {
    return this.saveProject(input);
  }
  update(id: string, input: Input) {
    if (!this.get(id)) throw new WebProjectError('Projectが見つかりません', 404);
    return this.saveProject(input, id);
  }
  private saveProject(input: Input, id: string = randomUUID()): SharedProject {
    const next = structuredClone(this.state);
    const previous = next.projects.find((p) => p.id === id);
    const merged = {
      ...previous,
      ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)),
    };
    const project: SharedProject = {
      id,
      name: normalizeName(String(merged.name || '')),
      prompt: normalizePrompt(String(merged.prompt || '')),
      studioLegacyId:
        previous?.studioLegacyId ||
        (merged.studioLegacyId ? String(merged.studioLegacyId) : undefined),
      createdAt: previous?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.unique(next.projects, project.name, id);
    next.projects = [...next.projects.filter((p) => p.id !== id), project];
    this.persist(next);
    return structuredClone(project);
  }
  remove(id: string) {
    this.persist({ ...this.state, projects: this.state.projects.filter((p) => p.id !== id) });
    return true;
  }
  execution(projectId?: string, agentId?: string, snapshot?: WebProject): WebProject | undefined {
    const project = projectId ? this.get(projectId) : undefined;
    const chosen = agentId;
    const agent = chosen
      ? snapshot ||
        (chosen.startsWith('team:')
          ? this.teamAgent(chosen.slice('team:'.length))
          : this.agent(chosen))
      : undefined;
    if (chosen && !agent) throw new WebProjectError('エージェントが見つかりません', 404);
    if (!project && !agent) return undefined;
    return {
      ...(project || agent!),
      team: agent?.team,
      backend: agent?.backend,
      model: agent?.model,
      effort: agent?.effort,
      workspaceId: agent?.workspaceId || 'default',
      localLlmMode: agent?.localLlmMode,
      localLlmReasoningEffort: agent?.localLlmReasoningEffort,
      prompt: [project?.prompt, agent && 'role' in agent ? agent.role : undefined, agent?.prompt]
        .filter(Boolean)
        .join('\n\n'),
    };
  }
}
