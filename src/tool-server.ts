/**
 * xangi Tool Server — Claude Code向けHTTPエンドポイント
 *
 * xangiプロセス内で起動し、Discord/Schedule/System操作のHTTP APIを提供。
 * Claude CodeはBashツールでxangi-cmdを使ってこのサーバーに問い合わせる。
 *
 * ポートはOS自動割り当て（競合なし）。起動後に
 * process.env.XANGI_TOOL_SERVER に接続先URLを設定し、
 * xangi-cmdを使う子プロセスへ渡す。
 */
import { createServer, type Server } from 'http';
import { discordApi } from './cli/discord-api.js';
import { scheduleCmd } from './cli/schedule-cmd.js';
import { systemCmd } from './cli/system-cmd.js';
import { isGitHubAppEnabled, generateInstallationToken } from './github-auth.js';

let server: Server | null = null;

interface ToolRequest {
  command: string;
  flags: Record<string, string>;
  context?: {
    channelId?: string;
  };
}

/**
 * リクエストボディをパース
 */
async function parseBody(req: import('http').IncomingMessage): Promise<ToolRequest> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString();
  if (!raw) throw new Error('Empty request body');
  return JSON.parse(raw) as ToolRequest;
}

/**
 * コマンドをルーティングして実行
 */
async function executeCommand(
  command: string,
  flags: Record<string, string>,
  context?: ToolRequest['context']
): Promise<string> {
  if (command.startsWith('discord_') || command === 'media_send') {
    return discordApi(command, flags, context);
  } else if (command.startsWith('schedule_')) {
    return scheduleCmd(command, flags);
  } else if (command.startsWith('system_')) {
    return systemCmd(command, flags);
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
}

/**
 * Tool Serverを起動（ポート自動割り当て）
 */
export function startToolServer(): void {
  server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');

    // ヘルスチェック
    if (req.url === '/health') {
      const addr = server?.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      res.writeHead(200);
      res.end(JSON.stringify({ status: 'ok', port }));
      return;
    }

    // GitHub App トークン生成エンドポイント
    if (req.url === '/github-token' && req.method === 'GET') {
      if (!isGitHubAppEnabled()) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'GitHub App is not configured' }));
        return;
      }
      try {
        const token = await generateInstallationToken();
        res.setHeader('Content-Type', 'text/plain');
        res.writeHead(200);
        res.end(token);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[tool-server] GitHub token generation failed: ${message}`);
        res.writeHead(500);
        res.end(JSON.stringify({ error: message }));
      }
      return;
    }

    // ツール実行エンドポイント
    if (req.url === '/api/execute' && req.method === 'POST') {
      try {
        const body = await parseBody(req);
        const { command, flags, context } = body;

        if (!command) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'command is required' }));
          return;
        }

        console.log(`[tool-server] ${command} ${JSON.stringify(flags || {})}`);
        const result = await executeCommand(command, flags || {}, context);

        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, result }));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[tool-server] Error: ${message}`);
        res.writeHead(500);
        res.end(JSON.stringify({ ok: false, error: message }));
      }
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  // ポート0 = OS自動割り当て（競合なし）
  server.listen(0, '0.0.0.0', () => {
    const addr = server!.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const serverUrl = `http://127.0.0.1:${port}`;
    process.env.XANGI_TOOL_SERVER = serverUrl;

    console.log(`[tool-server] Listening on http://0.0.0.0:${port}`);
  });
}

/**
 * Tool Serverを停止
 */
export function stopToolServer(): void {
  if (server) {
    server.close();
    server = null;
    delete process.env.XANGI_TOOL_SERVER;
  }
}
