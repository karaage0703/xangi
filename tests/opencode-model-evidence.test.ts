import { describe, expect, it } from 'vitest';
import { modelsFromOpenCodeExport } from '../src/opencode-model-evidence.js';
const message = (modelID: string, extra = {}) => ({ info: {
  role: 'assistant', sessionID: 'ses_abc', providerID: 'provider', modelID,
  time: { created: 150 }, path: { cwd: '/workspace' }, ...extra,
} });
describe('OpenCode native export evidence', () => {
  it('only retains this request main assistant metadata, not history, summaries, other sessions, or bodies', () => {
    const data = { info: { id: 'ses_abc' }, messages: [
      message('old', { time: { created: 99 } }), message('a'), message('b'),
      message('summary', { summary: true }), message('child', { sessionID: 'other' }),
      message('other-workspace', { path: { cwd: '/other' } }),
      message('future', { time: { created: 201 } }),
      { info: { role: 'user', model: { modelID: 'fake' } } },
    ] };
    expect(modelsFromOpenCodeExport(data, 'ses_abc', 100, 200, '/workspace')).toEqual(['provider/a', 'provider/b']);
    expect(modelsFromOpenCodeExport(data, 'wrong-session', 100, 200)).toEqual([]);
    expect(modelsFromOpenCodeExport('answer model: fake', 'ses_abc', 100, 200)).toEqual([]);
  });
});
