import { describe, expect, it } from 'vitest';
import { parseGrokTurnModels } from '../src/grok-model-evidence.js';
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
});
