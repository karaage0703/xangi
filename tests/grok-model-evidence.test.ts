import { describe, expect, it } from 'vitest';
import {
  parseGrokTurnEffort,
  parseGrokTurnModels,
  readGrokTurnEvidence,
} from '../src/grok-model-evidence.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const query = { providerSessionId: 'session-main', cwd: '/work', startedAt: '2026-09-08T15:30:43Z', finishedAt: '2026-09-08T15:31:22Z' };
const event = { type: 'turn_started', ts: '2026-09-08T15:30:55.361Z', session_id: 'session-main', model_id: 'grok-4.6', session_relationship: 'primary' };
describe('Grok native turn model evidence', () => {
  it('reads the native primary turn model and preserves final model order', () => {
    const lines = [event, {...event,model_id:'grok-other'}, event].map((item) => JSON.stringify(item)).join('\n');
    expect(parseGrokTurnModels(lines, query)).toEqual(['grok-other','grok-4.6']);
  });
  it('ignores previous turns, other sessions, subagents, config and partial lines', () => {
    const lines = [{...event,ts:'2026-09-08T15:29:00Z'}, {...event,session_id:'other'}, {...event,session_relationship:'subagent'}, {...event,type:'config'}].map((item) => JSON.stringify(item)).join('\n')+'\n{"type":';
    expect(parseGrokTurnModels(lines, query)).toEqual([]);
    expect(parseGrokTurnModels(JSON.stringify(event), {...query,finishedAt:'invalid'})).toEqual([]);
  });
  it('reads the last valid effort from assistant records only', () => {
    const lines = [
      { type: 'assistant', reasoning_effort: 'medium' },
      { type: 'user', reasoning_effort: 'max' },
      { type: 'assistant', reasoning_effort: 'high' },
    ]
      .map((item) => JSON.stringify(item))
      .join('\n');
    expect(parseGrokTurnEffort(`${lines}\n{"type":`)).toBe('high');
  });
  it('reads only chat history appended during the current turn', async () => {
    const grokHome = mkdtempSync(join(tmpdir(), 'grok-evidence-'));
    try {
      const directory = join(
        grokHome,
        'sessions',
        encodeURIComponent(resolve(query.cwd)),
        query.providerSessionId
      );
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, 'events.jsonl'), `${JSON.stringify(event)}\n`);
      const previous = `${JSON.stringify({ type: 'assistant', reasoning_effort: 'low' })}\n`;
      const current = `${JSON.stringify({ type: 'assistant', reasoning_effort: 'high' })}\n`;
      writeFileSync(join(directory, 'chat_history.jsonl'), previous + current);

      await expect(
        readGrokTurnEvidence({
          ...query,
          grokHome,
          chatHistoryOffset: Buffer.byteLength(previous),
        })
      ).resolves.toEqual({ models: ['grok-4.6'], effort: 'high' });
    } finally {
      rmSync(grokHome, { recursive: true, force: true });
    }
  });
});
