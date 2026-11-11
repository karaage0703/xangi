/** Tool Server commands for authenticated HTTP communication between xangi instances. */
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { getInterChatConfig, _resetInterChatConfigForTest } from '../inter-instance-chat/index.js';
import { exchangeAgentRequest } from '../inter-instance-chat/directed-request.js';

export async function interChatToolCmd(
  command: string,
  flags: Record<string, string>
): Promise<string> {
  try {
    if (command === 'inter_chat_ask' || command === 'inter_chat_status') {
      if (process.env.INTER_INSTANCE_CHAT_ENABLED !== 'true') {
        throw new Error(
          `${command} requires INTER_INSTANCE_CHAT_ENABLED=true on the running xangi instance`
        );
      }
      const target = (flags['to'] || '').trim();
      const id = flags['id'] || (command === 'inter_chat_ask' ? randomUUID() : '');
      if (command === 'inter_chat_status') {
        return JSON.stringify(await exchangeAgentRequest(target, id), null, 2);
      }
      const text = flags['text'] || flags['message'] || flags['msg'] || '';
      const timeoutSec = Number(flags['timeout'] || '300');
      if (!Number.isFinite(timeoutSec) || timeoutSec < 1 || timeoutSec > 3600) {
        throw new Error('--timeout must be between 1 and 3600 seconds');
      }
      const deadline = Date.now() + timeoutSec * 1000;
      let response = await exchangeAgentRequest(
        target,
        id,
        text,
        Math.min(10_000, timeoutSec * 1000)
      );
      if (flags['async'] === 'true') return JSON.stringify(response, null, 2);
      while (response.status === 'queued' || response.status === 'running') {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await delay(Math.min(1_000, remaining));
        const budget = deadline - Date.now();
        if (budget <= 0) break;
        try {
          response = await exchangeAgentRequest(target, id, undefined, Math.min(10_000, budget));
        } catch (caught) {
          return JSON.stringify(
            {
              ...response,
              result_unconfirmed: true,
              retrieval_error: caught instanceof Error ? caught.message : String(caught),
            },
            null,
            2
          );
        }
      }
      if (response.status === 'completed') return response.text || '';
      return JSON.stringify(
        {
          ...response,
          ...(response.status !== 'failed'
            ? { wait_timed_out: true, next: `inter_chat_status --to ${target} --id ${id}` }
            : {}),
        },
        null,
        2
      );
    }

    if (command === 'inter_chat_config') {
      const cfg = getInterChatConfig();
      return [
        '🔧 inter-instance-chat config',
        `  enabled:             ${cfg.enabled}`,
        `  peers:               ${Object.keys(cfg.peers).join(',') || '-'}`,
        `  tokenConfigured:     ${Boolean(cfg.token)}`,
        `  selfInstanceId:      ${cfg.selfInstanceId}`,
        `  selfLabel:           ${cfg.selfLabel}`,
        `  allowedPeers:        ${cfg.allowedPeers?.join(',') || '*'}`,
      ].join('\n');
    }

    throw new Error(`Unknown inter-chat command: ${command}`);
  } finally {
    _resetInterChatConfigForTest();
  }
}
