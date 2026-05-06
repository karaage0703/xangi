import { describe, it, expect, vi } from 'vitest';

// child_process.execFile を vi.hoisted でモック
const mockExecFile = vi.hoisted(() => vi.fn());
vi.mock('child_process', () => ({
  execFile: mockExecFile,
}));

// promisify(execFile) は callback スタイルを Promise に変換するので、mock も
// (cmd, args, options, cb) のシグネチャで callback を呼ぶ必要がある
function setExecFileResponses(
  responses: Array<{ args: string[]; result: { stdout?: string; error?: Error } }>
): void {
  mockExecFile.mockImplementation(
    (
      cmd: string,
      args: string[],
      options: unknown,
      cb: (err: Error | null, result: { stdout: string; stderr: string }) => void
    ) => {
      const matched = responses.find((r) => JSON.stringify(r.args) === JSON.stringify(args));
      if (!matched) {
        cb(new Error(`unexpected execFile args: ${cmd} ${args.join(' ')}`), {
          stdout: '',
          stderr: '',
        });
        return;
      }
      if (matched.result.error) {
        cb(matched.result.error, { stdout: '', stderr: '' });
      } else {
        cb(null, { stdout: matched.result.stdout || '', stderr: '' });
      }
    }
  );
}

// dynamic import で mock 後にロード
async function loadModule() {
  return import('../src/access-urls.js');
}

describe('resolveAccessUrls', () => {
  it('Tailscale が利用不可なら localhost のみ返す', async () => {
    setExecFileResponses([
      { args: ['ip', '-4'], result: { error: new Error('command not found') } },
    ]);
    const { resolveAccessUrls } = await loadModule();
    const urls = await resolveAccessUrls(18889);
    expect(urls).toEqual(['http://localhost:18889']);
  });

  it('Tailscale IP のみ取得できれば IP を追加する', async () => {
    setExecFileResponses([
      { args: ['ip', '-4'], result: { stdout: '100.86.210.85\n' } },
      { args: ['status', '--self', '--json'], result: { error: new Error('json failed') } },
    ]);
    const { resolveAccessUrls } = await loadModule();
    const urls = await resolveAccessUrls(18889);
    expect(urls).toEqual(['http://localhost:18889', 'http://100.86.210.85:18889']);
  });

  it('Tailscale IP + hostname 両方取れれば両方含める', async () => {
    setExecFileResponses([
      { args: ['ip', '-4'], result: { stdout: '100.86.210.85\n' } },
      {
        args: ['status', '--self', '--json'],
        result: { stdout: JSON.stringify({ Self: { HostName: 'spark-edbc' } }) },
      },
    ]);
    const { resolveAccessUrls } = await loadModule();
    const urls = await resolveAccessUrls(18889);
    expect(urls).toEqual([
      'http://localhost:18889',
      'http://spark-edbc:18889',
      'http://100.86.210.85:18889',
    ]);
  });

  it('複数 IP（IPv4 のみ）に対応する', async () => {
    setExecFileResponses([
      { args: ['ip', '-4'], result: { stdout: '100.86.210.85\n100.64.0.1\n' } },
      { args: ['status', '--self', '--json'], result: { error: new Error('skip') } },
    ]);
    const { resolveAccessUrls } = await loadModule();
    const urls = await resolveAccessUrls(18889);
    expect(urls).toContain('http://100.86.210.85:18889');
    expect(urls).toContain('http://100.64.0.1:18889');
    expect(urls[0]).toBe('http://localhost:18889');
  });

  it('壊れた IP 文字列は無視する', async () => {
    setExecFileResponses([
      { args: ['ip', '-4'], result: { stdout: 'garbage\nnot-an-ip\n' } },
    ]);
    const { resolveAccessUrls } = await loadModule();
    const urls = await resolveAccessUrls(18889);
    expect(urls).toEqual(['http://localhost:18889']);
  });
});

describe('formatAccessUrls', () => {
  it('label と URL リストを整形する', async () => {
    const { formatAccessUrls } = await loadModule();
    const out = formatAccessUrls('web-chat', [
      'http://localhost:18889',
      'http://spark-edbc:18889',
    ]);
    expect(out).toBe(
      ['[web-chat] Access URLs:', '  - http://localhost:18889', '  - http://spark-edbc:18889'].join(
        '\n'
      )
    );
  });

  it('URL リストが空でもヘッダだけ出る', async () => {
    const { formatAccessUrls } = await loadModule();
    const out = formatAccessUrls('web-chat', []);
    expect(out).toBe('[web-chat] Access URLs:');
  });
});
