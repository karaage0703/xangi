/** Tool Server commands for authenticated HTTP communication between xangi instances. */
import { getInterChatConfig, _resetInterChatConfigForTest } from '../inter-instance-chat/index.js';
import { askAgent } from '../inter-instance-chat/directed-request.js';

export async function interChatToolCmd(
  command: string,
  flags: Record<string, string>
): Promise<string> {
  const enabled = process.env.INTER_INSTANCE_CHAT_ENABLED === 'true';
  try {
    if (command === 'inter_chat_ask') {
      if (!enabled) {
        throw new Error(
          'inter_chat_ask requires INTER_INSTANCE_CHAT_ENABLED=true on the running xangi instance'
        );
      }
      const target = flags['to'] || '';
      const text = flags['text'] || flags['message'] || flags['msg'] || '';
      const timeoutSec = Number(flags['timeout'] || '300');
      if (!Number.isFinite(timeoutSec) || timeoutSec < 1 || timeoutSec > 3600) {
        throw new Error('--timeout must be between 1 and 3600 seconds');
      }
      const response = await askAgent(target, text, timeoutSec * 1000);
      return response.text;
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
