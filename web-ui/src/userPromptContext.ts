export interface UserPromptHookContext {
  id: string;
  text: string;
  truncated: boolean;
}

export interface UserPromptDisplay {
  content: string;
  contexts: UserPromptHookContext[];
}

const HOOK_CONTEXT_BLOCK =
  /^\[USER PROMPT HOOK CONTEXT: ([^\]\n]+)\]\r?\n([\s\S]*?)^\[END USER PROMPT HOOK CONTEXT: ([^\]\n]+)\](?:\r?\n)?/gm;

/** Web表示用に、内部hook contextを通常のユーザー入力から分離する。 */
export function splitUserPromptHookContexts(content: string): UserPromptDisplay {
  const contexts: UserPromptHookContext[] = [];
  const visibleParts: string[] = [];
  let cursor = 0;

  for (const match of content.matchAll(HOOK_CONTEXT_BLOCK)) {
    const index = match.index ?? 0;
    const label = match[1]?.trim() || '';
    const endId = match[3]?.trim() || '';
    const truncated = label.endsWith(' (truncated)');
    const id = truncated ? label.slice(0, -' (truncated)'.length) : label;

    if (!id || id !== endId) continue;
    visibleParts.push(content.slice(cursor, index));
    contexts.push({ id, text: match[2]?.trim() || '', truncated });
    cursor = index + match[0].length;
  }

  if (contexts.length === 0) return { content, contexts };
  visibleParts.push(content.slice(cursor));
  return {
    content: visibleParts.join('').trim(),
    contexts,
  };
}

/** 編集時は内部contextをユーザーへ見せず、元の記録にはそのまま保持する。 */
export function replaceUserPromptVisibleContent(content: string, visibleContent: string): string {
  const firstContext = [...content.matchAll(HOOK_CONTEXT_BLOCK)].find((match) => {
    const label = match[1]?.trim() || '';
    const id = label.endsWith(' (truncated)') ? label.slice(0, -' (truncated)'.length) : label;
    return Boolean(id && id === match[3]?.trim());
  });

  if (!firstContext || firstContext.index === undefined) return visibleContent;
  const internalContext = content.slice(firstContext.index).trimStart();
  const edited = visibleContent.trim();
  return edited ? `${edited}\n\n${internalContext}` : internalContext;
}
