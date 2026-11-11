import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerSlackCommands } from '../src/slack-commands.js';
import { getChatCommands } from '../src/chat-commands.js';
import { WorkspaceRegistry } from '../src/workspace-registry.js';
import { ProjectCatalog } from '../src/project-catalog.js';
import { registerAgentSelection } from '../src/agent-selection.js';
import { initSettings, clearSettingsCache, loadSettings } from '../src/settings.js';
import { clearSessions, closeActiveSession, createSession, initSessions } from '../src/sessions.js';
import { Scheduler } from '../src/scheduler.js';
import { shouldReplyInSlackThread, slackReplyThread } from '../src/slack.js';
import type { Config } from '../src/config.js';
import type { BackendResolver } from '../src/backend-resolver.js';
import type { AgentRunner } from '../src/agent-runner.js';

describe('Slack shared slash commands', () => {
  let root: string;
  let first: string;
  let second: string;
  let registry: WorkspaceRegistry;
  let scheduler: Scheduler;
  let catalog: ProjectCatalog;
  let config: Config;
  let deps: Parameters<typeof registerSlackCommands>[1];
  let handlers: Map<string, (args: any) => Promise<void>>;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'slack-commands-'));
    first = join(root, 'first');
    second = join(root, 'second');
    for (const [directory, name] of [
      [first, 'from-first'],
      [second, 'from-second'],
    ]) {
      mkdirSync(join(directory, 'skills', name), { recursive: true });
      writeFileSync(
        join(directory, 'skills', name, 'SKILL.md'),
        `---\nname: ${name}\ndescription: Local skill\n---\n`
      );
    }
    const state = join(root, 'state');
    registry = await WorkspaceRegistry.open({ dataDir: state, defaultWorkspacePath: first });
    initSessions(state);
    initSettings(state);
    catalog = new ProjectCatalog(state);
    scheduler = new Scheduler(state, { quiet: true });
    config = {
      features: {},
      agent: { allowedBackends: ['codex'] },
      discord: { allowAutoreplyCommand: true, allowThreadModeCommand: true },
      slack: { allowedUsers: ['U1'], replyInThread: false },
      scheduler: { enabled: true, startupEnabled: true },
    } as Config;
    const resolver = {
      resolve: () => ({ backend: 'codex' }),
      getDefault: () => ({ backend: 'codex' }),
      isBackendSelectable: () => true,
      getSelectableBackends: () => ['codex'],
      getChannelOverride: () => undefined,
    } as unknown as BackendResolver;
    const agentRunner = {
      destroy: vi.fn(),
      getTimeoutState: () => undefined,
    } as unknown as AgentRunner;
    registerAgentSelection(state, { catalog, registry, runner: agentRunner });
    deps = {
      config,
      resolver,
      agentRunner,
      registry,
      scheduler,
      registrationSkills: ['from-first', 'from-second', 'secret'].map((name) => ({
        name,
        path: '/unused',
        description: 'Skill',
      })),
      fallbackSkills: () => [],
      newConversation: vi.fn((channel) => {
        closeActiveSession(channel, 'new');
      }),
      stopConversation: vi.fn(async () => '停止しました'),
      backend: vi.fn(async (_channel, text) => `backend: ${text}`),
      secret: vi.fn(async () => {}),
      runSkill: vi.fn(async () => {}),
    };
    handlers = new Map();
    registerSlackCommands(
      {
        command: (name: string, handler: any) => {
          handlers.set(name, handler);
        },
      } as never,
      deps
    );
  });
  afterEach(() => {
    scheduler.stopAll();
    clearSessions();
    clearSettingsCache();
    rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });
  async function call(name: string, text = '', user = 'U1') {
    const ack = vi.fn(async () => {});
    const respond = vi.fn(async () => {});
    const client = {} as never;
    await handlers.get(name)!({
      command: { command: name, text, channel_id: 'C1', user_id: user, trigger_id: 'trigger' },
      ack,
      respond,
      client,
    });
    return {
      ack,
      respond,
      client,
      text: respond.mock.calls.map(([body]: any) => body.text).join('\n'),
    };
  }

  it('registers the Discord catalog except retitle, with the same direct-alias rules', () => {
    const discord = getChatCommands('discord', config).map((command) => `/${command.name}`);
    expect([...handlers.keys()].filter((name) => !name.startsWith('/from-'))).toEqual(
      discord.filter((name) => name !== '/retitle')
    );
    expect(handlers.has('/retitle')).toBe(false);
    for (const name of ['/models', '/restart', '/delete', '/team', '/extend'])
      expect(handlers.has(name)).toBe(false);
    expect([...handlers.keys()].filter((name) => name === '/secret')).toHaveLength(1);
  });

  it('uses the same native command feature flags as Discord', () => {
    const disabled = {
      ...config,
      discord: { ...config.discord, allowAutoreplyCommand: false, allowThreadModeCommand: false },
    };
    expect(getChatCommands('slack', disabled).map((command) => command.name)).not.toContain(
      'autoreply'
    );
    expect(getChatCommands('slack', disabled).map((command) => command.name)).not.toContain(
      'threadmode'
    );
  });

  it('shows platform-specific help without advertising retired commands', async () => {
    const result = await call('/help');
    expect(result.text).toContain('/workspace');
    expect(result.text).toContain('/stop');
    expect(result.text).toContain('/schedule');
    expect(result.text).toContain('独立したタイトル');
    expect(result.text).not.toContain('/restart');
    expect(result.ack).toHaveBeenCalledOnce();
  });

  it('switches workspace bindings without changing active snapshots and validates direct skills locally', async () => {
    createSession('C1', { platform: 'slack', workspaceId: 'default', workspacePath: first });
    expect((await call('/from-second')).text).toContain('現在のWorkspaceにありません');
    expect(deps.runSkill).not.toHaveBeenCalled();
    expect((await call('/workspace', `set "Second workspace" "${second}"`)).text).toContain(
      '次の /new'
    );
    expect(registry.getBinding('slack', 'C1')).toBe(registry.getByName('Second workspace')!.id);
    expect((await call('/skill')).text).toContain('from-first');
    await call('/new');
    expect((await call('/skill')).text).toContain('from-second');
    const direct = await call('/from-second', '"two words"');
    expect(deps.runSkill).toHaveBeenLastCalledWith(
      'C1',
      'from-second',
      'two words',
      'trigger',
      direct.client
    );
    await call('/skill', 'from-second "two words"');
    expect(deps.runSkill).toHaveBeenCalledTimes(2);
    expect((await call('/workspace', 'list')).text).toContain('Second workspace');
    expect((await call('/workspace', 'status')).text).toContain('既存スレッド');
    await call('/workspace', 'reset');
    expect(registry.getBinding('slack', 'C1')).toBeUndefined();
  });

  it('persists Slack thread mode, applies it to routing, and keeps Discord settings independent', async () => {
    await call('/threadmode', 'on');
    expect(loadSettings().slackThreadModeChannels).toEqual({ C1: true });
    expect(loadSettings().discordThreadModeChannels).toBeUndefined();
    expect(shouldReplyInSlackThread(config.slack, 'C1', loadSettings())).toBe(true);
    clearSettingsCache();
    initSettings(join(root, 'state'));
    expect(loadSettings().slackThreadModeChannels).toEqual({ C1: true });
    expect((await call('/threadmode', 'status')).text).toContain('on');
    await call('/threadmode', 'off');
    expect(shouldReplyInSlackThread(config.slack, 'C1', loadSettings())).toBe(false);
    await call('/threadmode', 'default');
    expect(loadSettings().slackThreadModeChannels).toBeUndefined();
  });

  it('keeps existing thread identities when threadmode is turned off', () => {
    const input = { channelId: 'C1', messageTs: '2.0', sourceThreadTs: '1.0', text: 'hello' };
    expect(slackReplyThread(config.slack, input, { slackThreadModeChannels: { C1: false } })).toBe(
      '1.0'
    );
    expect(
      slackReplyThread(
        config.slack,
        { ...input, sourceThreadTs: undefined },
        { slackThreadModeChannels: { C1: true } }
      )
    ).toBe('2.0');
    expect(
      slackReplyThread(
        config.slack,
        { ...input, sourceThreadTs: undefined, text: '/secret status' },
        { slackThreadModeChannels: { C1: true } }
      )
    ).toBeUndefined();
  });

  it('handles autoreply and shared settings without a new top-level command per setting', async () => {
    await call('/autoreply', 'on');
    expect(loadSettings().slackAutoReplyChannels).toEqual({ C1: true });
    expect((await call('/autoreply', 'status')).text).toContain('on');
    await call('/autoreply', 'default');
    expect(loadSettings().slackAutoReplyChannels).toBeUndefined();
    expect((await call('/settings')).text).toContain('slack');
    await call('/settings', 'replysuggestions off');
    expect(loadSettings().replySuggestionsEnabled).toBe(false);
  });

  it('adds, lists, toggles and removes only Slack schedules', async () => {
    await call('/schedule', 'add 30分後 確認する');
    const schedule = scheduler.list(undefined, 'slack')[0];
    expect(schedule.channelId).toBe('C1');
    expect((await call('/schedule', 'list')).text).toContain('確認する');
    await call('/schedule', `toggle ${schedule.id}`);
    expect(scheduler.get(schedule.id)?.enabled).toBe(false);
    const other = scheduler.add({
      platform: 'discord',
      channelId: '123',
      type: 'once',
      runAt: new Date(Date.now() + 60_000).toISOString(),
      message: 'Other',
    });
    expect((await call('/schedule', `remove ${other.id}`)).text).toContain('見つかりません');
    expect(scheduler.get(other.id)).toBeDefined();
    await call('/schedule', `remove ${schedule.id}`);
    expect(scheduler.get(schedule.id)).toBeUndefined();
  });

  it('uses the existing Agent setting mechanism for list, status, assignment and reset', async () => {
    const agent = catalog.saveAgent({
      name: 'Slack担当',
      prompt: '',
      backend: 'codex',
      workspaceId: 'default',
    });
    expect((await call('/agent', 'list')).text).toContain(agent.id);
    expect((await call('/agent', `set ${agent.id}`)).text).toContain('Slack担当');
    expect((await call('/agent', 'status')).text).toContain('Slack担当');
    expect((await call('/agent', 'reset')).text).toContain('担当なし');
  });

  it('acknowledges controls before calling their existing execution paths', async () => {
    await call('/secret', 'on');
    expect(deps.secret).toHaveBeenCalledOnce();
    await call('/stop');
    expect(deps.stopConversation).toHaveBeenCalledWith('C1');
    await call('/backend', 'models codex');
    expect(deps.backend).toHaveBeenCalledWith('C1', 'models codex');
  });

  it('rejects unauthorized or malformed requests without executing controls', async () => {
    expect((await call('/secret', 'on', 'not-allowed')).text).toContain('許可されていない');
    expect((await call('/secret', 'on private-text')).text).toContain('使い方');
    expect((await call('/stop', 'unexpected')).text).toContain('使い方');
    expect((await call('/threadmode', 'wrong')).text).toContain('使い方');
    expect(deps.secret).not.toHaveBeenCalled();
    expect(deps.stopConversation).not.toHaveBeenCalled();
    config.features.runtimeSettings = false;
    expect((await call('/threadmode', 'on')).text).toContain('無効化');
  });
});
