import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { executeWebCommand, getWebCommandDefinitions } from '../src/web-slash-commands.js';
import { Scheduler } from '../src/scheduler.js';
import { initSettings, clearSettingsCache } from '../src/settings.js';
import type { BackendResolver, ChannelOverride } from '../src/backend-resolver.js';
import type { AgentBackend } from '../src/config.js';

class FakeResolver {
  override: ChannelOverride | undefined;
  cleared = false;

  resolve() {
    return this.override ?? { backend: 'claude-code' as AgentBackend };
  }

  getChannelOverride() {
    return this.override;
  }

  getAllowedBackends(): AgentBackend[] {
    return ['claude-code', 'codex'];
  }

  getAllowedModels(): string[] | undefined {
    return ['gpt-test'];
  }

  isBackendAllowed(backend: AgentBackend): boolean {
    return this.getAllowedBackends().includes(backend);
  }

  isModelAllowed(model: string): boolean {
    return model === 'gpt-test';
  }

  setChannelOverride(_channelId: string, override: ChannelOverride): void {
    this.override = override;
  }

  clearChannelOverride(): void {
    this.override = undefined;
    this.cleared = true;
  }

  setChannelLocalLlmMode(_channelId: string, mode: 'agent' | 'lite' | 'chat' | null): void {
    if (mode === null && this.override) delete this.override.localLlmMode;
    else this.override = { ...(this.override ?? {}), localLlmMode: mode ?? undefined };
  }
}

describe('Web slash command adapter', () => {
  let workdir: string;
  let scheduler: Scheduler;
  let resolver: FakeResolver;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'web-slash-command-'));
    mkdirSync(join(workdir, 'state'), { recursive: true });
    initSettings(join(workdir, 'state'));
    scheduler = new Scheduler(join(workdir, 'state'), { quiet: true });
    resolver = new FakeResolver();
  });

  afterEach(() => {
    scheduler.stopAll();
    clearSettingsCache();
    rmSync(workdir, { recursive: true });
  });

  it('supports quoted skill arguments and rejects names outside the loaded skill catalog', () => {
    const skillDir = join(workdir, 'skills', 'demo');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: demo\ndescription: Demo skill\n---\n');

    const result = executeWebCommand('/skill demo "two words"', { workdir });
    expect(result).toEqual({
      kind: 'chat',
      displayMessage: '/skill demo "two words"',
      message: 'スキル「demo」を実行してください。引数: two words',
    });
    expect(() => executeWebCommand('/skill missing', { workdir })).toThrow(
      'スキル `missing` は見つかりません'
    );
  });

  it('uses /skill without a name to list the current skill catalog', () => {
    const skillDir = join(workdir, 'skills', 'demo');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: demo\ndescription: Demo skill\n---\n');

    expect(executeWebCommand('/skill', { workdir })).toEqual({
      kind: 'skills',
      skills: [{ name: 'demo', description: 'Demo skill' }],
    });
    expect(getWebCommandDefinitions({ workdir }).map((command) => command.name)).not.toContain(
      'skills'
    );
  });

  it('builds nested, dynamic option metadata for the generic Web picker', () => {
    const skillDir = join(workdir, 'skills', 'demo');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: demo\ndescription: Demo skill\n---\n');
    const added = scheduler.add({
      type: 'once',
      runAt: new Date(Date.now() + 60_000).toISOString(),
      message: 'Web option test',
      channelId: 'web-1',
      platform: 'web',
    });

    const commands = getWebCommandDefinitions({
      appSessionId: 'web-1',
      workdir,
      scheduler,
      resolver: resolver as unknown as BackendResolver,
    });

    const skill = commands.find((command) => command.name === 'skill');
    expect(skill?.options?.[0].choices).toContainEqual({
      name: 'demo',
      value: 'demo',
      description: 'Demo skill',
    });

    const backendSet = commands
      .find((command) => command.name === 'backend')
      ?.options?.find((option) => option.name === 'set');
    expect(backendSet?.options?.[0].choices).toEqual([
      { name: 'Claude Code', value: 'claude-code' },
      { name: 'Codex', value: 'codex' },
    ]);
    expect(backendSet?.options?.[1].choices).toEqual([{ name: 'gpt-test', value: 'gpt-test' }]);

    const scheduleRemove = commands
      .find((command) => command.name === 'schedule')
      ?.options?.find((option) => option.name === 'remove');
    expect(scheduleRemove?.options?.[0].choices?.[0].value).toBe(added.id);
  });

  it('stores and resets backend overrides using the Web session context key', () => {
    const context = {
      appSessionId: 'web-1',
      workdir,
      resolver: resolver as unknown as BackendResolver,
    };

    const set = executeWebCommand('/backend set codex --model gpt-test --effort high', context);
    expect(set.kind).toBe('message');
    expect(resolver.override).toEqual({
      backend: 'codex',
      model: 'gpt-test',
      effort: 'high',
    });

    executeWebCommand('/backend reset', context);
    expect(resolver.cleared).toBe(true);
    expect(resolver.override).toBeUndefined();
  });

  it('adds, lists, toggles, and removes schedules scoped to a Web session', () => {
    const context = { appSessionId: 'web-1', workdir, scheduler };
    const added = executeWebCommand('/schedule add 30分後 Webの確認', context);
    expect(added.kind).toBe('message');

    const schedule = scheduler.list(undefined, 'web')[0];
    expect(schedule.channelId).toBe('web-1');
    expect(schedule.message).toBe('Webの確認');

    const listed = executeWebCommand('/schedule list', context);
    expect(listed.kind).toBe('message');
    if (listed.kind === 'message') expect(listed.message).toContain(schedule.id);

    executeWebCommand(`/schedule toggle ${schedule.id}`, context);
    expect(scheduler.list(undefined, 'web')[0].enabled).toBe(false);
    executeWebCommand(`/schedule remove ${schedule.id}`, context);
    expect(scheduler.list(undefined, 'web')).toEqual([]);
  });
});
