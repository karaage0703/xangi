/** Parse arguments without shell expansion; the palette also accepts unfinished quotes while typing. */
export function tokenizeCommand(input: string, allowIncompleteQuotes = false): string[] {
  const tokens: string[] = [];
  let token = '';
  let quote = '';
  let started = false;
  for (let index = 0; index < input.length; index++) {
    const character = input[index];
    if (quote) {
      if (character === quote) quote = '';
      else if (quote === '"' && character === '\\' && ['"', '\\'].includes(input[index + 1]))
        token += input[++index];
      else token += character;
    } else if ((character === '"' || character === "'") && (!started || token.endsWith('='))) {
      quote = character;
      started = true;
    } else if (/\s/.test(character)) {
      if (started) tokens.push(token);
      token = '';
      started = false;
    } else {
      token += character;
      started = true;
    }
  }
  if (quote && !allowIncompleteQuotes) throw new Error('引用符を閉じてください');
  if (started) tokens.push(token);
  return tokens;
}

export function quoteCommandArgument(value: string): string {
  return /[\s"'\\]/.test(value)
    ? '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
    : value;
}
