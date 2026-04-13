import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadTriggers,
  matchTrigger,
  executeTrigger,
  buildTriggersPrompt,
} from '../src/local-llm/triggers.js';
import type { Trigger } from '../src/local-llm/triggers.js';

describe('triggers', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `xangi-triggers-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('loadTriggers', () => {
    it('should return empty array when triggers/ does not exist', () => {
      const triggers = loadTriggers(tmpDir);
      expect(triggers).toEqual([]);
    });

    it('should load valid trigger definitions', () => {
      const triggersDir = join(tmpDir, 'triggers', 'weather');
      mkdirSync(triggersDir, { recursive: true });
      writeFileSync(
        join(triggersDir, 'trigger.yaml'),
        'name: weather\ntrigger: "!weather"\ndescription: "天気を調べる"\nhandler: handler.sh\n'
      );
      writeFileSync(join(triggersDir, 'handler.sh'), 'echo "sunny"');

      const triggers = loadTriggers(tmpDir);
      expect(triggers).toHaveLength(1);
      expect(triggers[0].name).toBe('weather');
      expect(triggers[0].trigger).toBe('!weather');
      expect(triggers[0].description).toBe('天気を調べる');
      expect(triggers[0].handler).toBe('handler.sh');
      expect(triggers[0].path).toBe(triggersDir);
    });

    it('should load multiple triggers', () => {
      const weatherDir = join(tmpDir, 'triggers', 'weather');
      const searchDir = join(tmpDir, 'triggers', 'search');
      mkdirSync(weatherDir, { recursive: true });
      mkdirSync(searchDir, { recursive: true });

      writeFileSync(
        join(weatherDir, 'trigger.yaml'),
        'name: weather\ntrigger: "!weather"\ndescription: "天気を調べる"\nhandler: handler.sh\n'
      );
      writeFileSync(
        join(searchDir, 'trigger.yaml'),
        'name: search\ntrigger: "!search"\ndescription: "Web検索する"\nhandler: handler.sh\n'
      );

      const triggers = loadTriggers(tmpDir);
      expect(triggers).toHaveLength(2);
    });

    it('should skip directories without trigger.yaml', () => {
      const emptyDir = join(tmpDir, 'triggers', 'empty');
      mkdirSync(emptyDir, { recursive: true });

      const triggers = loadTriggers(tmpDir);
      expect(triggers).toEqual([]);
    });

    it('should skip trigger.yaml with missing required fields', () => {
      const badDir = join(tmpDir, 'triggers', 'bad');
      mkdirSync(badDir, { recursive: true });
      writeFileSync(join(badDir, 'trigger.yaml'), 'name: bad\n');

      const triggers = loadTriggers(tmpDir);
      expect(triggers).toEqual([]);
    });
  });

  describe('matchTrigger', () => {
    const triggers: Trigger[] = [
      {
        name: 'weather',
        trigger: '!weather',
        description: '天気を調べる',
        handler: 'handler.sh',
        path: '/tmp/weather',
      },
      {
        name: 'search',
        trigger: '!search',
        description: 'Web検索する',
        handler: 'handler.sh',
        path: '/tmp/search',
      },
    ];

    it('should match trigger without args', () => {
      const result = matchTrigger('!weather', triggers);
      expect(result).not.toBeNull();
      expect(result!.trigger.name).toBe('weather');
      expect(result!.args).toBe('');
    });

    it('should match trigger with args', () => {
      const result = matchTrigger('!weather 名古屋', triggers);
      expect(result).not.toBeNull();
      expect(result!.trigger.name).toBe('weather');
      expect(result!.args).toBe('名古屋');
    });

    it('should match trigger with multiple args', () => {
      const result = matchTrigger('!search Claude Code 使い方', triggers);
      expect(result).not.toBeNull();
      expect(result!.trigger.name).toBe('search');
      expect(result!.args).toBe('Claude Code 使い方');
    });

    it('should match trigger in multiline text', () => {
      const text = '天気を調べますね。\n!weather 東京\nお待ちください。';
      const result = matchTrigger(text, triggers);
      expect(result).not.toBeNull();
      expect(result!.trigger.name).toBe('weather');
      expect(result!.args).toBe('東京');
    });

    it('should return null when no match', () => {
      const result = matchTrigger('こんにちは', triggers);
      expect(result).toBeNull();
    });

    it('should return null for empty triggers', () => {
      const result = matchTrigger('!weather', []);
      expect(result).toBeNull();
    });

    it('should not match partial trigger words', () => {
      const result = matchTrigger('!weathering', triggers);
      expect(result).toBeNull();
    });

    it('should match first trigger when multiple could match', () => {
      const result = matchTrigger('!weather 東京\n!search test', triggers);
      expect(result).not.toBeNull();
      expect(result!.trigger.name).toBe('weather');
    });
  });

  describe('executeTrigger', () => {
    it('should execute handler and return stdout', async () => {
      const triggerDir = join(tmpDir, 'test-trigger');
      mkdirSync(triggerDir, { recursive: true });
      writeFileSync(join(triggerDir, 'handler.sh'), '#!/bin/bash\necho "Hello $1"');

      const trigger: Trigger = {
        name: 'test',
        trigger: '!test',
        description: 'test',
        handler: 'handler.sh',
        path: triggerDir,
      };

      const result = await executeTrigger(trigger, 'World', tmpDir);
      expect(result.success).toBe(true);
      expect(result.output.trim()).toBe('Hello World');
    });

    it('should return error on script failure', async () => {
      const triggerDir = join(tmpDir, 'fail-trigger');
      mkdirSync(triggerDir, { recursive: true });
      writeFileSync(join(triggerDir, 'handler.sh'), '#!/bin/bash\nexit 1');

      const trigger: Trigger = {
        name: 'fail',
        trigger: '!fail',
        description: 'fail',
        handler: 'handler.sh',
        path: triggerDir,
      };

      const result = await executeTrigger(trigger, '', tmpDir);
      expect(result.success).toBe(false);
    });

    it('should handle empty args', async () => {
      const triggerDir = join(tmpDir, 'noargs-trigger');
      mkdirSync(triggerDir, { recursive: true });
      writeFileSync(join(triggerDir, 'handler.sh'), '#!/bin/bash\necho "no args"');

      const trigger: Trigger = {
        name: 'noargs',
        trigger: '!noargs',
        description: 'no args',
        handler: 'handler.sh',
        path: triggerDir,
      };

      const result = await executeTrigger(trigger, '', tmpDir);
      expect(result.success).toBe(true);
      expect(result.output.trim()).toBe('no args');
    });
  });

  describe('buildTriggersPrompt', () => {
    it('should return empty string for empty triggers', () => {
      expect(buildTriggersPrompt([])).toBe('');
    });

    it('should build prompt with trigger descriptions', () => {
      const triggers: Trigger[] = [
        {
          name: 'weather',
          trigger: '!weather',
          description: '天気を調べる',
          handler: 'handler.sh',
          path: '/tmp',
        },
        {
          name: 'search',
          trigger: '!search',
          description: 'Web検索する',
          handler: 'handler.sh',
          path: '/tmp',
        },
      ];

      const prompt = buildTriggersPrompt(triggers);
      expect(prompt).toContain('!weather');
      expect(prompt).toContain('天気を調べる');
      expect(prompt).toContain('!search');
      expect(prompt).toContain('Web検索する');
      expect(prompt).toContain('トリガーコマンド');
    });
  });
});
