import { createInteractionHandler, buildSlashCommands } from '../src/discord/slash-commands.js';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { ProjectCatalog } from '../src/project-catalog.js';
import { normalizeTeam, DEFAULT_TEAM_AGENT_ID, type TeamSnapshot } from '../src/teams.js';
import {
  registerAgentSelection,
  changeChannelAgent,
  changeChannelTeam,
  removeRegisteredTeam,
  channelAgentSnapshot,
  channelAgent,
} from '../src/agent-selection.js';
import {
  initSessions,
  clearSessions,
  getSessionEntry,
  getActiveSessionId,
  createWebSession,
} from '../src/sessions.js';
import { ensureSessionWithWorkspace } from '../src/session-workspace.js';
import { WorkspaceRegistry } from '../src/workspace-registry.js';
import { AgentRunStore } from '../src/agent-runs.js';
import { logPrompt } from '../src/transcript-logger.js';
import { BackendResolver } from '../src/backend-resolver.js';
import {
  executeTeamTree,
  runTeamTurn,
  registerTeamRunner,
  cancelTeam,
  teamTimeoutState,
} from '../src/team-runner.js';
import { executeRuntimeSettingsCommand } from '../src/runtime-settings-command.js';
import type { AgentRunner, RunResult } from '../src/agent-runner.js';
import type { Config } from '../src/config.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'teams-'));
  initSessions(root);
});
afterEach(() => {
  clearSessions();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});
async function setup() {
  const catalog = new ProjectCatalog(root);
  const registry = await WorkspaceRegistry.open({
    dataDir: join(root, 'state'),
    defaultWorkspacePath: root,
  });
  const agents = [];
  for (const name of ['リーダー', 'サブリーダー', '調査', '実装']) {
    const path = join(root, name);
    mkdirSync(path);
    const workspace = await registry.register(name, path);
    agents.push(
      catalog.saveAgent({
        name,
        role: name,
        prompt: `${name}の指示`,
        backend: 'codex',
        workspaceId: workspace.id,
      })
    );
  }
  const members = agents.map((a) => ({ agentId: a.id, role: a.name }));
  const team = catalog.saveTeam({ leadership: 'caller', name: '開発室', members });
  const runner = {
    destroy: vi.fn(),
    getTimeoutState: vi.fn(() => ({ active: false })),
    cancel: vi.fn(() => true),
    runStream: vi.fn(async () => ({ result: '完了', sessionId: 'provider' })),
  } as unknown as AgentRunner;
  const busy = vi.fn(() => false);
  registerAgentSelection(root, { catalog, registry, runner, busy });
  vi.stubEnv('ALLOWED_BACKENDS', 'codex');
  vi.stubEnv('CHANNEL_OVERRIDES', '{}');
  const config = {
    agent: { backend: 'codex', config: { workdir: root }, allowedBackends: ['codex'] },
    claudeCode: {},
  } as unknown as Config;
  const resolver = new BackendResolver(config);
  const runs = AgentRunStore.fromDataDir(root);
  registerTeamRunner({ registry, runs, resolver });
  return { catalog, registry, agents, members, team, runner, busy, config, resolver, runs };
}
it('persists multiple teams, supports shared Agents, and protects referenced Agents', async () => {
  const f = await setup();
  f.catalog.saveTeam({ leadership: 'caller', name: 'レビュー室', members: f.members.slice(0, 2) });
  expect(new ProjectCatalog(root).teams()).toHaveLength(2);
  expect(() => f.catalog.removeAgent(f.agents[0].id)).toThrow('Teamで使用中');
  expect(() =>
    f.catalog.saveTeam({ leadership: 'caller', name: '開発室', members: f.members })
  ).toThrow('同じ名前');
  expect(JSON.parse(readFileSync(join(root, 'project-catalog.json'), 'utf8')).agents).toHaveLength(
    4
  );
});
it.each(['discord', 'slack'])(
  'rejects %s Team channel assignment without changing the session',
  async (platform) => {
    const f = await setup();
    const opts = { registry: f.registry, platform, contextKey: 'thread', bindingKey: 'channel' };
    const before = await ensureSessionWithWorkspace(opts);
    await expect(
      executeRuntimeSettingsCommand(
        { name: 'team', action: 'set', platform, channelId: 'channel', value: f.team.id },
        { config: f.config, resolver: f.resolver, agentRunner: f.runner }
      )
    ).rejects.toThrow('廃止');
    expect(getActiveSessionId('thread')).toBe(before.appSessionId);
    expect(channelAgent(platform, 'channel')).toBeUndefined();
    await expect(changeChannelTeam(platform, 'channel', f.team.id)).rejects.toThrow('廃止');
    removeRegisteredTeam(f.team.id, f.catalog);
  }
);
it('uses the configured member limit, saves child evidence and emits one final response', async () => {
  const f = await setup();
  f.catalog.saveTeam({ leadership: 'caller', maxConcurrency: 2 }, f.team.id);
  let active = 0,
    peak = 0;
  f.runner.runStream = vi.fn(async (_prompt, _callbacks, options) => {
    active++;
    peak = Math.max(peak, active);
    expect(options?.appSessionId).toBeTruthy();
    expect(getSessionEntry(options!.appSessionId!)?.selectedAgentConfig?.backend).toBe('codex');
    await new Promise((r) => setTimeout(r, 10));
    active--;
    return {
      result: '調査結果',
      sessionId: 'provider',
      usage: { inputTokens: 5, outputTokens: 3 },
    };
  });
  const callbacks = { onComplete: vi.fn(), onText: vi.fn() };
  const result = await runTeamTurn(
    f.runner,
    dispatched(f.catalog.teamAgent(f.team.id)!.team!),
    '依頼',
    callbacks,
    { channelId: 'parent', platform: 'discord', workdir: root }
  );
  expect(peak).toBe(2);
  expect(callbacks.onComplete).toHaveBeenCalledTimes(1);
  expect(result.usage).toMatchObject({ inputTokens: 20, outputTokens: 12 });
  expect(f.runs.list()).toHaveLength(4);
  expect(
    f.runs
      .list()
      .every((r) => r.status === 'succeeded' && r.teamId === f.team.id && r.parentNotifiedAt)
  ).toBe(true);
  expect(result.result).toContain('リーダー');
  expect(result.result).toContain('調査');
});
it('serializes overlapping workspaces, cancels queued members and clears busy state', async () => {
  const f = await setup();
  f.catalog.saveTeam({ leadership: 'caller', serializeWorkspaces: true }, f.team.id);
  f.agents.forEach((a) => f.catalog.saveAgent({ workspaceId: 'default' }, a.id));
  let complete!: (r: RunResult) => void;
  f.runner.runStream = vi.fn(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      })
  );
  const result = runTeamTurn(
    f.runner,
    dispatched(f.catalog.teamAgent(f.team.id)!.team!),
    '依頼',
    {},
    { channelId: 'parent' }
  );
  await vi.waitFor(() => expect(f.runner.runStream).toHaveBeenCalledTimes(1));
  expect(teamTimeoutState('parent', f.runner)?.active).toBe(true);
  expect(cancelTeam('parent', f.runner)).toBe(true);
  complete({ result: '中止', sessionId: '' });
  expect((await result).failed).toBe(true);
  expect(f.runner.runStream).toHaveBeenCalledTimes(1);
  expect(f.runner.cancel).toHaveBeenCalledTimes(1);
  expect(teamTimeoutState('parent', f.runner)).toBeUndefined();
});

it('serializes shared workspaces across channels and honours cancellation while queued', async () => {
  const f = await setup();
  f.catalog.saveTeam(
    { leadership: 'caller', members: f.members.slice(0, 1), serializeWorkspaces: true },
    f.team.id
  );
  const team = dispatched(f.catalog.teamAgent(f.team.id)!.team!);
  let finish!: (r: RunResult) => void;
  f.runner.runStream = vi.fn(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  const first = runTeamTurn(f.runner, team, 'first', {}, { channelId: 'first' });
  await vi.waitFor(() => expect(f.runner.runStream).toHaveBeenCalledTimes(1));
  const second = runTeamTurn(f.runner, team, 'second', {}, { channelId: 'second' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(f.runner.runStream).toHaveBeenCalledTimes(1);
  expect(cancelTeam('second', f.runner)).toBe(true);
  expect((await second).failed).toBe(true);
  finish({ result: 'first finished', sessionId: '' });
  expect((await first).failed).toBe(false);
});

it('cancels a Team during prompt preparation before any child starts', async () => {
  const f = await setup();
  let release!: (prompt: string) => void;
  const prompt = new Promise<string>((resolve) => {
    release = resolve;
  });
  const result = runTeamTurn(
    f.runner,
    dispatched(f.catalog.teamAgent(f.team.id)!.team!),
    'request',
    {},
    { channelId: 'parent' },
    () => prompt
  );
  expect(cancelTeam('parent', f.runner)).toBe(true);
  release('prepared request');
  expect((await result).failed).toBe(true);
  expect(f.runner.runStream).not.toHaveBeenCalled();
});

it('allows the built-in default without registering an Agent and preserves it after reload', () => {
  const catalog = new ProjectCatalog(root);
  const members = [{ agentId: DEFAULT_TEAM_AGENT_ID, role: 'リーダー' }];
  const team = catalog.saveTeam({ leadership: 'caller', name: '普段の担当', members });
  const reloaded = new ProjectCatalog(root);
  expect(reloaded.agents()).toEqual([]);
  expect(reloaded.teamAgents()).toHaveLength(1);
  expect(reloaded.teamAgent(team.id)?.team?.agents[0]).toMatchObject({
    id: DEFAULT_TEAM_AGENT_ID,
    workspaceId: 'default',
  });
  expect(() =>
    reloaded.saveTeam({ leadership: 'caller', name: '重複', members: [...members, ...members] })
  ).toThrow('重複');
});

it('lists and shows Teams without channel assignment commands', async () => {
  const f = await setup();
  const config = { ...f.config, discord: { allowedUsers: ['user'] } } as Config;
  const handler = createInteractionHandler({
    config,
    resolver: f.resolver,
    agentRunner: f.runner as any,
    scheduler: {} as any,
    workdir: root,
    skillsRef: { current: [] },
    workspaceRegistry: f.registry,
    discoverModels: vi.fn().mockResolvedValue({ models: [], status: 'available' }),
  });
  const call = async (action: string, id = f.team.id) => {
    const reply = vi.fn();
    await handler({
      isAutocomplete: () => false,
      isButton: () => false,
      isChatInputCommand: () => true,
      commandName: 'team',
      channelId: 'thread',
      channel: { isThread: () => true, parentId: 'parent' },
      user: { id: 'user' },
      options: { getSubcommand: () => action, getString: () => id },
      reply,
    } as any);
    return reply.mock.calls[0][0].content as string;
  };
  expect(await call('list')).toContain(f.team.id);
  expect(await call('show')).toContain(f.team.name);
  expect(await call('show', 'unknown')).toContain('見つかりません');
  expect(channelAgent('discord', 'parent')).toBeUndefined();
  const command = buildSlashCommands(config, []).find((c) => c.name === 'team')!;
  expect(command.options?.map((o) => o.name)).toEqual(['list', 'show']);
  for (const feature of ['runtimeSettings', 'workspaceSwitching', 'backendSwitching']) {
    expect(
      buildSlashCommands({ ...config, features: { [feature]: false } } as Config, []).some(
        (c) => c.name === 'team'
      )
    ).toBe(false);
  }
});

it('validates, persists and defaults execution settings without changing Agent workspaces', async () => {
  const f = await setup();
  expect(f.team).toMatchObject({ maxConcurrency: 16, serializeWorkspaces: false });
  for (const maxConcurrency of [0, -1, 65, 1.5, '4', null])
    expect(() => f.catalog.saveTeam({ leadership: 'caller', maxConcurrency }, f.team.id)).toThrow(
      '同時実行数'
    );
  expect(() =>
    f.catalog.saveTeam({ leadership: 'caller', serializeWorkspaces: 'false' }, f.team.id)
  ).toThrow('順番待ち');
  f.catalog.saveTeam(
    { leadership: 'caller', maxConcurrency: 4, serializeWorkspaces: true },
    f.team.id
  );
  expect(new ProjectCatalog(root).team(f.team.id)).toMatchObject({
    maxConcurrency: 4,
    serializeWorkspaces: true,
  });
  expect(f.catalog.agents()).toEqual(f.agents);
});

it('defaults legacy snapshots to 16 simultaneous members even in a shared workspace', async () => {
  const f = await setup();
  const agents = Array.from({ length: 20 }, (_, i) =>
    f.catalog.saveAgent({ name: `parallel-${i}`, workspaceId: 'default', backend: 'codex' })
  );
  const saved = f.catalog.saveTeam({
    leadership: 'caller',
    name: '並行調査',
    members: agents.map((a) => ({ agentId: a.id, role: '調査' })),
  });
  const team = dispatched(f.catalog.teamAgent(saved.id)!.team!);
  delete team.maxConcurrency;
  delete team.serializeWorkspaces;
  let active = 0,
    peak = 0;
  f.runner.runStream = vi.fn(async (_p, _c, options) => {
    expect(options?.workdir).toBe(root);
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active--;
    return { result: '完了', sessionId: '' };
  });
  const result = await runTeamTurn(f.runner, team, '調査', {}, { channelId: 'parallel' });
  expect(result.failed).toBe(false);
  expect(peak).toBe(16);
  expect(f.runner.runStream).toHaveBeenCalledTimes(20);
});

it('shares a Team limit across channels, while different Teams have independent limits', async () => {
  const f = await setup();
  f.catalog.saveTeam(
    { leadership: 'caller', maxConcurrency: 1, members: f.members.slice(0, 1) },
    f.team.id
  );
  const team = dispatched(f.catalog.teamAgent(f.team.id)!.team!);
  const releases: Array<() => void> = [];
  f.runner.runStream = vi.fn(
    () => new Promise((resolve) => releases.push(() => resolve({ result: 'ok', sessionId: '' })))
  );
  const first = runTeamTurn(f.runner, team, 'first', {}, { channelId: 'one' });
  await vi.waitFor(() => expect(releases).toHaveLength(1));
  const second = runTeamTurn(f.runner, team, 'second', {}, { channelId: 'two' });
  const other = runTeamTurn(
    f.runner,
    { ...team, id: 'another-team' },
    'other',
    {},
    { channelId: 'three' }
  );
  await vi.waitFor(() => expect(releases).toHaveLength(2));
  expect(f.runner.runStream).toHaveBeenCalledTimes(2);
  expect(cancelTeam('two', f.runner)).toBe(true);
  expect((await second).failed).toBe(true);
  releases.forEach((release) => release());
  await Promise.all([first, other]);
  // No leaked slots remain after completion/cancellation.
  f.runner.runStream = vi.fn(async () => ({ result: 'ok', sessionId: '' }));
  expect((await runTeamTurn(f.runner, team, 'again', {}, { channelId: 'one' })).failed).toBe(false);
});

it('migrates saved group, channel, session and run metadata without changing user text', async () => {
  const f = await setup();
  const snapshot = f.catalog.teamAgent(f.team.id)!;
  const sessionId = createWebSession({
    selectedAgentId: snapshot.id,
    selectedAgentConfig: snapshot,
  });
  const catalogPath = join(root, 'project-catalog.json');
  const oldCatalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
  oldCatalog.parties = oldCatalog.teams;
  delete oldCatalog.teams;
  oldCatalog.parties[0].prompt = 'party: is literal user text';
  writeFileSync(catalogPath, JSON.stringify(oldCatalog));
  writeFileSync(
    join(root, 'channel-agents.json'),
    JSON.stringify({
      [JSON.stringify(['discord', 'existing-channel'])]: `party:${f.team.id}`,
    })
  );
  const sessionsPath = join(root, 'sessions.json');
  const oldSessions = JSON.parse(readFileSync(sessionsPath, 'utf8'));
  const saved = oldSessions.sessions[sessionId];
  saved.selectedAgentId = `party:${f.team.id}`;
  saved.selectedAgentConfig.id = saved.selectedAgentId;
  saved.selectedAgentConfig.party = saved.selectedAgentConfig.team;
  delete saved.selectedAgentConfig.team;
  writeFileSync(sessionsPath, JSON.stringify(oldSessions));
  writeFileSync(
    join(root, 'agent-runs.json'),
    JSON.stringify({
      version: 1,
      runs: [
        {
          id: 'old-run',
          agentId: `party:${f.team.id}`,
          partyId: f.team.id,
          partyTurnId: 'turn',
          partyPhase: 'work',
          status: 'completed',
          task: 'party: is literal user text',
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
    })
  );
  const catalog = new ProjectCatalog(root);
  registerAgentSelection(root, { catalog, registry: f.registry, runner: f.runner });
  initSessions(root);
  expect(catalog.teams()[0].prompt).toBe('party: is literal user text');
  expect(channelAgent('discord', 'existing-channel')).toBeUndefined();
  expect(getSessionEntry(sessionId)?.selectedAgentConfig?.team?.id).toBe(f.team.id);
  expect(getSessionEntry(sessionId)?.selectedAgentId).toBe(`team:${f.team.id}`);
  expect(AgentRunStore.fromDataDir(root).list()[0]).toMatchObject({
    agentId: `team:${f.team.id}`,
    teamId: f.team.id,
    teamTurnId: 'turn',
    teamPhase: 'work',
    task: 'party: is literal user text',
  });
  const persisted = JSON.parse(readFileSync(catalogPath, 'utf8'));
  expect(persisted.parties).toBeUndefined();
  expect(persisted.teams).toHaveLength(1);
  expect(new ProjectCatalog(root).teams()).toEqual(catalog.teams());
  expect(() => removeRegisteredTeam(f.team.id, catalog)).toThrow('使用中');
  expect(() => catalog.execution(undefined, `party:${f.team.id}`)).toThrow();
  const commands = buildSlashCommands({ ...f.config, discord: {} } as Config, []);
  expect(commands.some((c) => c.name === 'team')).toBe(true);
  expect(commands.some((c) => c.name === 'party')).toBe(false);
});

it.each(['discord', 'slack'])(
  'keeps %s Agent settings and rejects duplicate assignments across platforms',
  async (platform) => {
    const f = await setup();
    f.resolver.setChannelOverride('channel', { backend: 'codex', model: 'channel-model' });
    const chosen = f.agents[0];
    await changeChannelAgent(platform, 'channel', chosen.id);
    expect((await channelAgentSnapshot(platform, 'channel')).workspaceId).toBe(chosen.workspaceId);
    await expect(
      changeChannelAgent(platform === 'discord' ? 'slack' : 'discord', 'other', chosen.id)
    ).rejects.toThrow(`現在の設定先: ${platform}`);
    registerAgentSelection(root, { catalog: f.catalog, registry: f.registry, runner: f.runner });
    expect(channelAgent(platform, 'channel')?.id).toBe(chosen.id);
    await changeChannelAgent(platform, 'channel');
    expect(f.resolver.resolve('channel').model).toBe('channel-model');
    await changeChannelAgent(platform, 'other', chosen.id);
    expect(channelAgent(platform, 'other')?.id).toBe(chosen.id);
  }
);
it('releases ambiguous legacy assignments with a backup', async () => {
  const f = await setup();
  writeFileSync(
    join(root, 'channel-agents.json'),
    JSON.stringify({
      '["discord","a"]': f.agents[0].id,
      '["slack","b"]': f.agents[0].id,
      '["discord","c"]': f.agents[1].id,
    })
  );
  registerAgentSelection(root, { catalog: f.catalog, registry: f.registry, runner: f.runner });
  expect(channelAgent('discord', 'a')).toBeUndefined();
  expect(channelAgent('slack', 'b')).toBeUndefined();
  expect(channelAgent('discord', 'c')?.id).toBe(f.agents[1].id);
  expect(
    readFileSync(join(root, 'channel-assignments-before-single-agent.json'), 'utf8')
  ).toContain(f.agents[0].id);
});
it('checks uniqueness again after asynchronous workspace resolution', async () => {
  const f = await setup();
  const results = await Promise.allSettled([
    changeChannelAgent('discord', 'a', f.agents[0].id),
    changeChannelAgent('slack', 'b', f.agents[0].id),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
});

it('starts caller Team members concurrently with no extra leader and preserves separate tasks', async () => {
  const f = await setup();
  const saved = f.catalog.saveTeam({ name: '並列メンバー', members: f.members.slice(0, 3) });
  const team = dispatched(f.catalog.teamAgent(saved.id)!.team!);
  team.assignments = team.members.map((m, i) => ({ agentId: m.agentId, task: `個別仕事${i}` }));
  const parent = createWebSession({ workspacePath: root, workspaceId: 'default' });
  logPrompt(
    root,
    parent,
    'あなたがリーダーです。team runで全メンバーへ依頼してください。古い担当作業'
  );
  team.prompt = '共通指示: 出典を確認';
  const releases: Array<() => void> = [];
  const prompts: string[] = [];
  f.runner.runStream = vi.fn(
    (prompt) =>
      new Promise((resolve) => {
        prompts.push(prompt);
        releases.push(() => resolve({ result: '根拠付き結果', sessionId: '' }));
      })
  );
  const pending = runTeamTurn(
    f.runner,
    team,
    '共通前提: 共和を起点に調べる',
    {},
    { channelId: 'caller', appSessionId: parent, workdir: root }
  );
  await vi.waitFor(() => expect(releases).toHaveLength(3));
  expect(prompts.every((p) => p.includes('共和'))).toBe(true);
  prompts.forEach((p, i) => {
    expect(p).toContain(`個別仕事${i}`);
    expect(p).not.toContain(`個別仕事${(i + 1) % 3}`);
    expect(p).toContain('共通指示: 出典を確認');
    expect(p).not.toContain('あなたがリーダーです');
    expect(p).not.toContain('古い担当作業');
  });
  releases.forEach((r) => r());
  expect((await pending).failed).toBe(false);
  expect(f.runs.list().map((r) => r.teamPhase)).toEqual(['work', 'work', 'work']);
  expect(
    f.runs
      .list()
      .map((r) => r.workPresentation?.assignment)
      .sort()
  ).toEqual(['個別仕事0', '個別仕事1', '個別仕事2']);
  expect(f.runs.list().every((r) => r.workPresentation?.teamName === '並列メンバー')).toBe(true);
});

it('migrates a legacy default leader to the caller without retaining a duplicate leader', async () => {
  const f = await setup();
  const path = join(root, 'project-catalog.json');
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  raw.teams = [
    {
      ...f.team,
      leadership: undefined,
      members: [
        { agentId: DEFAULT_TEAM_AGENT_ID, role: 'leader' },
        { ...f.members[0], reportsTo: DEFAULT_TEAM_AGENT_ID },
      ],
    },
  ];
  writeFileSync(path, JSON.stringify(raw));
  const updated = new ProjectCatalog(root).team(f.team.id)!;
  expect(updated.leadership).toBe('caller');
  expect(updated.members).toEqual([{ ...f.members[0] }]);
});

function dispatched(team: TeamSnapshot): TeamSnapshot {
  return {
    ...team,
    assignments: team.members.map((m) => ({
      agentId: m.agentId,
      task: `${m.role || '調査'}を独立して実施する`,
    })),
  };
}
it('rejects reporting lines and allows an unspecified team assignment', async () => {
  const f = await setup();
  expect(() =>
    f.catalog.saveTeam({
      name: 'invalid',
      members: [{ ...f.members[0], reportsTo: f.members[1].agentId }],
    })
  ).toThrow('報告先');
  expect(
    f.catalog.saveTeam({ name: 'optional', members: [{ agentId: f.members[0].agentId }] })
      .members[0].role
  ).toBe('');
});

it('serializes completed-member continuations using the saved Team concurrency limit', async () => {
  const { reserveTeamContinuation } = await import('../src/team-runner.js');
  const f = await setup();
  f.catalog.saveTeam({ maxConcurrency: 1 }, f.team.id);
  const owner = createWebSession({
    selectedAgentId: `team:${f.team.id}`,
    selectedAgentConfig: f.catalog.teamAgent(f.team.id),
  });
  const run = {
    teamTurnId: 'turn',
    parentContextKey: `web-chat:${owner}`,
    workspacePath: root,
  } as any;
  const releaseFirst = await reserveTeamContinuation(run);
  let secondStarted = false;
  const second = reserveTeamContinuation(run).then((release) => {
    secondStarted = true;
    return release;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(secondStarted).toBe(false);
  releaseFirst();
  const releaseSecond = await second;
  expect(secondStarted).toBe(true);
  releaseSecond();
});
