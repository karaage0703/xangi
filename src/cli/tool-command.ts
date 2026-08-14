import { assertRuntimeStateCanStart } from '../runtime-state-validation.js';

export interface ToolCommandEnvironment {
  XANGI_TOOL_SERVER?: string;
  XANGI_CHANNEL_ID?: string;
  XANGI_DEFAULT_CHANNEL?: string;
  DATA_DIR?: string;
  WORKSPACE_PATH?: string;
  WEB_CHAT_ENABLED?: string;
}

interface ToolServerResponse {
  ok?: boolean;
  result?: string;
  error?: string;
}

export interface ParsedToolCommand {
  command: string;
  flags: Record<string, string>;
}

export function parseToolCommandArgs(args: string[]): ParsedToolCommand {
  const command = args[0] || 'help';
  const flags: Record<string, string> = {};
  const positionals: string[] = [];

  for (let index = 1; index < args.length; index++) {
    const argument = args[index];
    if (!argument.startsWith('--')) {
      positionals.push(argument);
      continue;
    }

    const key = argument.slice(2);
    const next = args[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next;
      index++;
    } else {
      flags[key] = 'true';
    }
  }

  if (command === 'help' && positionals[0] && flags.topic === undefined) {
    flags.topic = positionals[0];
  }

  return { command, flags };
}

export async function runToolCommand(
  args: string[],
  options: {
    env?: ToolCommandEnvironment;
    fetchImpl?: typeof fetch;
  } = {}
): Promise<string> {
  const env = options.env ?? process.env;
  const serverUrl = env.XANGI_TOOL_SERVER;
  const { command, flags } = parseToolCommandArgs(args);

  if (command === 'system_restart') {
    assertRuntimeStateCanStart({ env: env as NodeJS.ProcessEnv });
  }

  if (!serverUrl) {
    throw new Error(
      `XANGI_TOOL_SERVER is not set. "${command}" must run from an agent started by xangi; the target instance is never guessed.`
    );
  }

  const channelId = env.XANGI_CHANNEL_ID || env.XANGI_DEFAULT_CHANNEL;
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(`${serverUrl}/api/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        command,
        flags,
        context: channelId ? { channelId } : {},
      }),
    });
  } catch (error) {
    throw new Error(
      `tool-serverへ接続できません (${serverUrl}): ${error instanceof Error ? error.message : String(error)}`
    );
  }

  let body: ToolServerResponse;
  try {
    body = (await response.json()) as ToolServerResponse;
  } catch {
    throw new Error(`tool-server returned an invalid response (status ${response.status})`);
  }

  if (!body.ok) {
    throw new Error(body.error || `tool-server returned status ${response.status}`);
  }
  return body.result ?? '';
}
