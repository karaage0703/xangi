import { tokenizeCommand, quoteCommandArgument } from '../src/chat-command-input.js';
import { describe, expect, it } from 'vitest';
import { commandHelp, getChatCommands, skillCommandAliases } from '../src/chat-commands.js';
import { buildSlashCommands } from '../src/discord/slash-commands.js';
import type { Config } from '../src/config.js';

const config = { discord: { allowAutoreplyCommand: true, allowThreadModeCommand: true } } as Config;

describe('shared chat command catalog', () => {
  it('generates Discord and Web from the same definitions, retaining Discord-specific controls', () => {
    const discord = buildSlashCommands(config, []);
    const web = getChatCommands('web', config);
    expect(discord).toHaveLength(13);
    expect(web).toHaveLength(11);
    expect(
      discord
        .filter((command) => !['autoreply', 'threadmode'].includes(command.name))
        .map((command) => command.name)
    ).toEqual(web.map((command) => command.name));
    for (const command of web) {
      const registered = discord.find((candidate) => candidate.name === command.name)!;
      expect(registered.description).toBe(command.description);
      expect(registered.options?.map((option) => option.name) || []).toEqual(
        command.options?.map((option) => option.name) || []
      );
    }
    expect(getChatCommands('slack', config).map((command) => command.name)).toEqual(
      discord.filter((command) => command.name !== 'retitle').map((command) => command.name)
    );
  });

  it('keeps help consistent with feature gates and reserved names', () => {
    const disabled = {
      ...config,
      features: { workspaceSwitching: false, runtimeSettings: false, backendSwitching: false },
      scheduler: { enabled: false },
    } as Config;
    const help = commandHelp('discord', disabled);
    for (const name of [
      'workspace',
      'agent',
      'backend',
      'schedule',
      'settings',
      'autoreply',
      'threadmode',
      'restart',
      'models',
    ])
      expect(help).not.toContain(`/${name} `);
    expect(help).toContain('/help');
    expect(commandHelp('discord', config).length).toBeLessThan(2000);
  });

  it('shares quote handling between typed commands and palette choices', () => {
    for (const name of [
      'Second workspace',
      '日本語の作業場所',
      'with"quote',
      "with'apostrophe",
      'with\\backslash',
      'with\ttab',
      'with\nnewline',
    ]) {
      expect(tokenizeCommand(`/workspace use ${quoteCommandArgument(name)}`)).toEqual([
        '/workspace',
        'use',
        name,
      ]);
    }
    expect(tokenizeCommand("/skill demo what's next")).toEqual([
      '/skill',
      'demo',
      "what's",
      'next',
    ]);
    expect(tokenizeCommand('/workspace use "Second work', true)).toEqual([
      '/workspace',
      'use',
      'Second work',
    ]);
    expect(() => tokenizeCommand('/workspace use "Second work')).toThrow('引用符');
  });

  it('omits reserved and ambiguous direct aliases, keeping explicit /skill available', () => {
    const skills = ['new', 'secret', 'backend', 'foo_bar', 'foo-bar', 'Demo Skill', '日本語'].map(
      (name) => ({ name, description: name, path: `/unused/${name}` })
    );
    expect([...skillCommandAliases(skills).keys()]).toEqual(['demo-skill']);
    const commands = buildSlashCommands(config, skills);
    expect(commands.filter((command) => command.name === 'new')).toHaveLength(1);
    expect(commands.map((command) => command.name)).not.toContain('foo-bar');
    expect(commands.map((command) => command.name)).toContain('demo-skill');
    expect(commands.map((command) => command.name)).toContain('skill');
  });
});
