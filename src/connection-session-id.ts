export function connectionSessionId(connectionId: string, id: string): string {
  return `connection:${encodeURIComponent(connectionId)}:${encodeURIComponent(id)}`;
}

export function connectionSessionRef(
  id: string
): { connectionId: string; sessionId: string } | undefined {
  const parts = id.split(':');
  if (parts.length !== 3 || parts[0] !== 'connection') return;
  try {
    const connectionId = decodeURIComponent(parts[1]),
      sessionId = decodeURIComponent(parts[2]);
    if (!/^[a-zA-Z0-9_-]+$/.test(connectionId) || !/^[a-zA-Z0-9_-]+$/.test(sessionId)) return;
    return { connectionId, sessionId };
  } catch {
    return;
  }
}

export function isSecretConversationId(id: string | null | undefined): boolean {
  return Boolean(id && (connectionSessionRef(id)?.sessionId ?? id).startsWith('secret_'));
}
