import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunner, RunResult } from '../src/agent-runner.js';
import { recoverAttachmentOnce } from '../src/attachment-recovery.js';

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import('fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'xangi-attachment-recovery-'));
  roots.push(root);
  return root;
}

function result(text: string, sessionId = 'session-1'): RunResult {
  return { result: text, sessionId };
}

describe('recoverAttachmentOnce', () => {
  it('does not call the runner when the attachment is valid', async () => {
    const root = workspace();
    const output = join(root, 'output.png');
    writeFileSync(output, 'png');
    const run = vi.fn();

    const recovered = await recoverAttachmentOnce(
      { run } as unknown as AgentRunner,
      result(`MEDIA:${output}`),
      {},
      root
    );

    expect(run).not.toHaveBeenCalled();
    expect(recovered.attempted).toBe(false);
    expect(recovered.attachmentResult.filePaths).toEqual([output]);
  });

  it('feeds an outside-path error back once and accepts the corrected path', async () => {
    const root = workspace();
    const outside = mkdtempSync(join(process.env.HOME ?? tmpdir(), 'xangi-outside-'));
    roots.push(outside);
    const outsideFile = join(outside, 'image.png');
    const corrected = join(root, 'image.png');
    writeFileSync(outsideFile, 'png');
    writeFileSync(corrected, 'png');
    const run = vi.fn().mockResolvedValue(result(`MEDIA:${corrected}`, 'session-2'));

    const recovered = await recoverAttachmentOnce(
      { run } as unknown as AgentRunner,
      result(`MEDIA:${outsideFile}`),
      { channelId: 'channel-1' },
      root
    );

    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toContain('添付許可パスの外');
    expect(run.mock.calls[0][0]).toContain('1回限り');
    expect(run.mock.calls[0][1]).toMatchObject({
      channelId: 'channel-1',
      sessionId: 'session-1',
    });
    expect(recovered.attachmentResult.filePaths).toEqual([corrected]);
  });

  it('never retries a second time when the corrected answer is still invalid', async () => {
    const root = workspace();
    const missing = join(root, 'missing.png');
    const run = vi.fn().mockResolvedValue(result(`MEDIA:${missing}`, 'session-2'));

    const recovered = await recoverAttachmentOnce(
      { run } as unknown as AgentRunner,
      result(`MEDIA:${missing}`),
      {},
      root
    );

    expect(run).toHaveBeenCalledTimes(1);
    expect(recovered.attempted).toBe(true);
    expect(recovered.attachmentResult.attachmentFailure).toBe('missing');
    expect(recovered.attachmentResult.displayText).toContain('ファイルが存在しません');
  });

  it('falls back to the original warning when the one recovery call fails', async () => {
    const root = workspace();
    const missing = join(root, 'missing.png');
    const run = vi.fn().mockRejectedValue(new Error('backend unavailable'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const recovered = await recoverAttachmentOnce(
      { run } as unknown as AgentRunner,
      result(`MEDIA:${missing}`),
      {},
      root
    );

    expect(run).toHaveBeenCalledTimes(1);
    expect(recovered.attachmentResult.displayText).toContain('ファイルが存在しません');
    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
  });

  it('reports rejected structured attachments too', async () => {
    const root = workspace();
    const outside = mkdtempSync(join(process.env.HOME ?? tmpdir(), 'xangi-structured-'));
    roots.push(outside);
    const outsideFile = join(outside, 'image.png');
    mkdirSync(join(root, 'outputs'));
    const corrected = join(root, 'outputs', 'image.png');
    writeFileSync(outsideFile, 'png');
    writeFileSync(corrected, 'png');
    const run = vi.fn().mockResolvedValue({
      ...result('修正済み', 'session-2'),
      attachments: [corrected],
    });

    const recovered = await recoverAttachmentOnce(
      { run } as unknown as AgentRunner,
      { ...result('生成済み'), attachments: [outsideFile] },
      {},
      root
    );

    expect(run).toHaveBeenCalledTimes(1);
    expect(recovered.attachmentResult.filePaths).toEqual([corrected]);
  });
});
