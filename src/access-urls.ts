/**
 * 起動時に表示する Web UI のアクセス URL を解決する。
 *
 * - localhost は必ず含める
 * - tailscale CLI が利用可能なら MagicDNS hostname と Tailscale IP も加える
 * - tailscale が見つからない / オフライン / タイムアウトしたら黙って localhost のみ返す
 */
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const TAILSCALE_TIMEOUT_MS = 2000;

interface TailscaleStatusJson {
  Self?: {
    HostName?: string;
    DNSName?: string;
  };
  MagicDNSSuffix?: string;
}

interface TailscaleInfo {
  ips: string[];
  hostname?: string;
}

/** tailscale CLI から自分の IP と MagicDNS hostname を取得（best-effort）。失敗時 null。 */
async function probeTailscale(): Promise<TailscaleInfo | null> {
  let ips: string[] = [];
  try {
    const { stdout } = await execFileAsync('tailscale', ['ip', '-4'], {
      timeout: TAILSCALE_TIMEOUT_MS,
    });
    ips = stdout
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(s));
  } catch {
    return null;
  }
  if (ips.length === 0) return null;

  let hostname: string | undefined;
  try {
    const { stdout } = await execFileAsync('tailscale', ['status', '--self', '--json'], {
      timeout: TAILSCALE_TIMEOUT_MS,
    });
    const j = JSON.parse(stdout) as TailscaleStatusJson;
    const h = j?.Self?.HostName;
    if (typeof h === 'string' && h.length > 0) hostname = h;
  } catch {
    // hostname なしでも IP だけで十分
  }
  return { ips, hostname };
}

/**
 * 指定 port のアクセス URL 候補を返す（重複なし、localhost を先頭）。
 * 例: ['http://localhost:18889', 'http://spark-edbc:18889', 'http://100.86.210.85:18889']
 */
export async function resolveAccessUrls(port: number): Promise<string[]> {
  const urls: string[] = [`http://localhost:${port}`];
  const ts = await probeTailscale();
  if (!ts) return urls;
  if (ts.hostname) urls.push(`http://${ts.hostname}:${port}`);
  for (const ip of ts.ips) urls.push(`http://${ip}:${port}`);
  return Array.from(new Set(urls));
}

/** 起動ログ用にフォーマット。複数行を返す（caller が console.log するだけで OK） */
export function formatAccessUrls(label: string, urls: string[]): string {
  const lines = [`[${label}] Access URLs:`];
  for (const u of urls) lines.push(`  - ${u}`);
  return lines.join('\n');
}

/** テスト用に inject できる probe 関数（mock 差し替え用） */
export const __test__ = {
  probeTailscale,
};
