// Run only against a dedicated scratch directory, never a live LINE conversation.
import { mkdir, readFile, readdir, appendFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { CodexRunner } from '../dist/codex-cli.js';
const workspace = resolve(process.env.BENCH_WORKSPACE || '');
const output = process.env.BENCH_OUTPUT;
if (!output || !process.env.BENCH_WORKSPACE || !workspace.includes('xangi-codex-benchmark'))
  throw new Error('Dedicated BENCH_WORKSPACE and BENCH_OUTPUT required');
await mkdir(workspace, { recursive: true });
const count = Number(process.env.BENCH_SETS || 10);
const model = process.env.BENCH_MODEL;
const effort = process.env.BENCH_EFFORT || 'medium';
const messages = [
  'これは速度比較用の会話です。ツール・ファイル・外部サービスは使わず、文章だけ返してください。合言葉は「青い傘」です。「了解」とだけ返してください。',
  '合言葉だけ答えてください。ツールは使わないでください。',
  'もう一度、合言葉だけ答えてください。ツールは使わないでください。',
];
async function evidence(id, startedAt) {
  const root = join(homedir(), '.codex/sessions');
  const files = await readdir(root, { recursive: true });
  const name = files.find((n) => n.endsWith(`${id}.jsonl`));
  if (!name) return {};
  const events = (await readFile(join(root, name), 'utf8')).split('\n').flatMap((l) => {
    try {
      return [JSON.parse(l)];
    } catch {
      return [];
    }
  });
  const context = events
    .filter((e) => e.type === 'turn_context' && Date.parse(e.timestamp) >= startedAt)
    .at(-1);
  return {
    preparedMs: context ? Date.parse(context.timestamp) - startedAt : null,
    model: context?.payload.model,
    effort: context?.payload.effort,
  };
}
for (let set = 0; set < count; set++) {
  for (const mode of set % 2 ? ['app-server', 'exec'] : ['exec', 'app-server']) {
    const runner = new CodexRunner({
      model,
      workdir: workspace,
      platform: 'line',
      timeoutMs: 120000,
      skipPermissions: false,
    });
    const channelId = `line:benchmark-${set}-${mode}`;
    let sessionId;
    try {
      if (mode === 'app-server') await runner.warmLineCodex(channelId);
      for (let index = 0; index < messages.length; index++) {
        let tools = 0;
        const timings = {};
        const startedAt = Date.now();
        const result = await runner.runStream(
          messages[index],
          {
            onBackendReady: () => {
              timings.backendReadyMs = Date.now() - startedAt;
            },
            onTraceEvent: (e) => {
              if (e.type === 'tool_started') tools++;
              if (e.type === 'transport_timing') timings[e.stage] = Date.now() - startedAt;
            },
          },
          { channelId, sessionId, effort, codexLineTransport: mode }
        );
        const totalMs = Date.now() - startedAt;
        sessionId = result.sessionId;
        const row = {
          set,
          mode,
          index,
          totalMs,
          tools,
          timings,
          usage: result.usage,
          ...(await evidence(sessionId, startedAt)),
          continuity: index === 0 || result.result.includes('青い傘'),
        };
        await appendFile(output, JSON.stringify(row) + '\n', { mode: 0o600 });
        console.log(
          JSON.stringify({
            set,
            mode,
            index,
            totalMs,
            preparedMs: row.preparedMs,
            model: row.model,
            effort: row.effort,
            tools,
            continuity: row.continuity,
          })
        );
      }
    } finally {
      runner.shutdown();
    }
  }
}
