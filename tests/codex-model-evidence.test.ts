import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCodexTurnModels, readCodexTurnModels } from '../src/codex-model-evidence.js';

const query = {
  providerSessionId: '01a0811b-1688-72c0-874c-afc5e6eaabeb',
  cwd: '/workspace',
  startedAt: '2026-09-08T13:00:00.000Z',
  finishedAt: '2026-09-08T13:01:00.000Z',
};
const meta = { type: 'session_meta', payload: { id: query.providerSessionId, cwd: query.cwd } };
function context(model: string, timestamp = '2026-09-08T13:00:30.000Z', cwd = query.cwd) {
  return { type: 'turn_context', timestamp, payload: { model, cwd, turn_id: 'turn' } };
}
const lines = (...events: unknown[]) => events.map((event) => JSON.stringify(event)).join('\n');
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('Codex turn model evidence', () => {
  it('recovers distinct observed models only inside this execution interval', () => {
    expect(
      parseCodexTurnModels(
        lines(
          meta,
          context('old', '2026-09-08T12:59:59.999Z'),
          context('astra'),
          context('astra'),
          context('sol'),
          context('future', '2026-09-08T13:01:00.001Z'),
          { type: 'result', modelUsage: { auxiliary: {} } }
        ),
        query
      )
    ).toEqual(['astra', 'sol']);
  });
  it('keeps the latest model last when a turn switches back to an earlier model', () => {
    expect(
      parseCodexTurnModels(lines(meta, context('astra'), context('sol'), context('astra')), query)
    ).toEqual(['sol', 'astra']);
  });
  it('requires exact provider session linkage and working directory', () => {
    expect(parseCodexTurnModels(lines(context('astra')), query)).toEqual([]);
    expect(
      parseCodexTurnModels(
        lines({ ...meta, payload: { ...meta.payload, id: 'other' } }, context('astra')),
        query
      )
    ).toEqual([]);
    expect(parseCodexTurnModels(lines(meta, context('astra', undefined, '/other')), query)).toEqual(
      []
    );
    expect(
      parseCodexTurnModels(
        lines({ ...meta, payload: { ...meta.payload, cwd: '/other' } }, context('astra')),
        query
      )
    ).toEqual([]);
  });
  it('rejects invalid intervals, unknown defaults, missing timestamps, and concatenated sessions', () => {
    const input = lines(meta, context('astra'));
    expect(parseCodexTurnModels(input, { ...query, startedAt: 'invalid' })).toEqual([]);
    expect(parseCodexTurnModels(input, { ...query, finishedAt: '2020-01-01' })).toEqual([]);
    expect(
      parseCodexTurnModels(
        lines(meta, context('default'), context('(default)'), context('astra', 'invalid')),
        query
      )
    ).toEqual([]);
    expect(
      parseCodexTurnModels(
        lines(meta, context('astra'), { ...meta, payload: { ...meta.payload, id: 'other' } }),
        query
      )
    ).toEqual([]);
  });
  it('reads an exact linked rollout and tolerates a partially written final line', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-model-'));
    dirs.push(codexHome);
    const directory = join(codexHome, 'sessions/2026/09/08');
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, `rollout-example-${query.providerSessionId}.jsonl`),
      lines(meta, context('astra')) + '\n{"unfinished"'
    );
    expect(await readCodexTurnModels({ ...query, codexHome })).toEqual(['astra']);
    // UUID creation date keeps a much later resume bounded and discoverable.
    const resumed = {
      ...query,
      startedAt: '2026-12-01T00:00:00Z',
      finishedAt: '2026-12-01T00:01:00Z',
      codexHome,
    };
    await writeFile(
      join(directory, `rollout-example-${query.providerSessionId}.jsonl`),
      lines(meta, context('old'), context('sol', '2026-12-01T00:00:30Z'))
    );
    expect(await readCodexTurnModels(resumed)).toEqual(['sol']);
  });
  it('leaves missing or duplicate evidence unknown', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-model-'));
    dirs.push(codexHome);
    const directory = join(codexHome, 'sessions/2026/09/08');
    await mkdir(directory, { recursive: true });
    expect(await readCodexTurnModels({ ...query, codexHome })).toEqual([]);
    for (const name of ['a', 'b'])
      await writeFile(
        join(directory, `rollout-${name}-${query.providerSessionId}.jsonl`),
        lines(meta, context('astra'))
      );
    expect(await readCodexTurnModels({ ...query, codexHome })).toEqual([]);
  });
});
