/** Shared configuration for authenticated HTTP requests between xangi instances. */
import { resolveInstanceId } from '../events-emitter.js';

export interface InterChatConfig {
  enabled: boolean;
  /** Map from instance_id to the peer xangi HTTP origin. */
  peers: Record<string, string>;
  /** Bearer token shared by the inter-instance HTTP API. */
  token: string;
  selfInstanceId: string;
  /** Display label. Defaults to selfInstanceId. */
  selfLabel: string;
  /** Allowed inbound instance IDs. null permits every peer holding the shared token. */
  allowedPeers: string[] | null;
}

let cachedConfig: InterChatConfig | null = null;

export function getInterChatConfig(): InterChatConfig {
  if (cachedConfig) return cachedConfig;
  const enabled = process.env.INTER_INSTANCE_CHAT_ENABLED === 'true';
  const removedTransport = process.env.INTER_INSTANCE_CHAT_TRANSPORT?.trim();
  if (removedTransport && removedTransport !== 'http') {
    console.warn(
      `[inter-instance-chat] INTER_INSTANCE_CHAT_TRANSPORT=${removedTransport} is no longer supported; configure authenticated HTTP peers instead`
    );
  }
  const peers = parsePeerOrigins(process.env.INTER_INSTANCE_CHAT_PEERS);
  const token = process.env.INTER_INSTANCE_CHAT_TOKEN?.trim() || '';
  const { id: selfInstanceId } = resolveInstanceId();
  const selfLabel = process.env.XANGI_INSTANCE_LABEL?.trim() || selfInstanceId;
  const allowedPeersRaw = process.env.INTER_INSTANCE_CHAT_ALLOWED_PEERS;
  const allowedPeerValues = allowedPeersRaw
    ?.split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const allowedPeers =
    !allowedPeersRaw?.trim() || allowedPeerValues?.includes('*')
      ? null
      : Array.from(new Set(allowedPeerValues));

  cachedConfig = {
    enabled,
    peers,
    token,
    selfInstanceId,
    selfLabel,
    allowedPeers,
  };
  return cachedConfig;
}

function parsePeerOrigins(raw: string | undefined): Record<string, string> {
  if (!raw?.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') return {};
    const peers: Record<string, string> = {};
    for (const [instanceId, value] of Object.entries(parsed)) {
      if (!/^[\w.-]+$/.test(instanceId) || typeof value !== 'string') continue;
      try {
        const url = new URL(value.trim());
        if (
          (url.protocol !== 'http:' && url.protocol !== 'https:') ||
          url.username ||
          url.password ||
          (url.pathname !== '/' && url.pathname !== '') ||
          url.search ||
          url.hash
        ) {
          continue;
        }
        peers[instanceId] = url.toString().replace(/\/$/, '');
      } catch {
        // Invalid entries are ignored; inter_chat_config makes the resolved set visible.
      }
    }
    return peers;
  } catch {
    return {};
  }
}

/** Whether this configured peer may send directed requests to this instance. */
export function isPeerAllowed(instanceId: string, config = getInterChatConfig()): boolean {
  return config.allowedPeers === null || config.allowedPeers.includes(instanceId);
}

/** Clear the configuration cache (tests only). */
export function _resetInterChatConfigForTest(): void {
  cachedConfig = null;
}
