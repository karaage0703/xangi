const SESSION_PATH = /^\/chat\/([^/]+)\/?$/;

export function sessionIdFromPathname(pathname: string): string | null {
  const match = pathname.match(SESSION_PATH);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]) || null;
  } catch {
    return null;
  }
}

export function sessionPath(sessionId: string): string {
  return `/chat/${encodeURIComponent(sessionId)}`;
}

export function sessionPermalink(origin: string, sessionId: string): string {
  return `${origin.replace(/\/$/, '')}${sessionPath(sessionId)}`;
}

const MESSAGE_FRAGMENT_PREFIX = 'message-';

export function messageIdFromHash(hash: string): string | null {
  const fragment = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!fragment.startsWith(MESSAGE_FRAGMENT_PREFIX)) return null;
  try {
    return decodeURIComponent(fragment.slice(MESSAGE_FRAGMENT_PREFIX.length)) || null;
  } catch {
    return null;
  }
}

export function messageElementId(messageId: string): string {
  return `${MESSAGE_FRAGMENT_PREFIX}${messageId}`;
}

export function messagePermalink(origin: string, sessionId: string, messageId: string): string {
  return `${sessionPermalink(origin, sessionId)}#${messageElementId(encodeURIComponent(messageId))}`;
}
