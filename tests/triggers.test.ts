import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadTriggers,
  executeTrigger,
  triggersToToolHandlers,
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
        'name: weather\ndescription: "天気を調べる"\nhandler: handler.sh\n'
      );
      writeFileSync(join(triggersDir, 'handler.sh'), 'echo "sunny"');

      const triggers = loadTriggers(tmpDir);
      expect(triggers).toHaveLength(1);
      expect(triggers[0].name).toBe('weather');
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
        'name: weather\ndescription: "天気を調べる"\nhandler: handler.sh\n'
      );
      writeFileSync(
        join(searchDir, 'trigger.yaml'),
        'name: search\ndescription: "Web検索する"\nhandler: handler.sh\n'
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

  describe('executeTrigger', () => {
    it('should execute handler and return stdout', async () => {
      const triggerDir = join(tmpDir, 'test-trigger');
      mkdirSync(triggerDir, { recursive: true });
      writeFileSync(join(triggerDir, 'handler.sh'), '#!/bin/bash\necho "Hello $1"');

      const trigger: Trigger = {
        name: 'test',
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
        description: 'no args',
        handler: 'handler.sh',
        path: triggerDir,
      };

      const result = await executeTrigger(trigger, '', tmpDir);
      expect(result.success).toBe(true);
      expect(result.output.trim()).toBe('no args');
    });
  });

  describe('triggersToToolHandlers', () => {
    it('should convert triggers to tool handlers', () => {
      const triggers: Trigger[] = [
        {
          name: 'weather',
          description: '天気を調べる',
          handler: 'handler.sh',
          path: '/tmp/weather',
        },
      ];

      const handlers = triggersToToolHandlers(triggers, tmpDir);
      expect(handlers).toHaveLength(1);
      expect(handlers[0].name).toBe('weather');
      expect(handlers[0].description).toBe('天気を調べる');
      expect(handlers[0].parameters.properties.args).toBeDefined();
    });

    it('should execute handler via tool handler', async () => {
      const triggerDir = join(tmpDir, 'tool-trigger');
      mkdirSync(triggerDir, { recursive: true });
      writeFileSync(join(triggerDir, 'handler.sh'), '#!/bin/bash\necho "Result: $1"');

      const triggers: Trigger[] = [
        {
          name: 'tool-test',
          description: 'test',
          handler: 'handler.sh',
          path: triggerDir,
        },
      ];

      const handlers = triggersToToolHandlers(triggers, tmpDir);
      const result = await handlers[0].execute({ args: 'hello' }, { workspace: tmpDir });
      expect(result.success).toBe(true);
      expect(result.output.trim()).toBe('Result: hello');
    });
  });
});
