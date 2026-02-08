import { describe, it, expect } from 'vitest';

/**
 * annotateChannelMentions のテスト用に関数を再実装
 * （元の関数は startDiscord 内のローカル関数のため）
 */
function annotateChannelMentions(text: string): string {
  return text.replace(/<#(\d+)>/g, (match, id) => `${match} [チャンネルID: ${id}]`);
}

/**
 * 表示用テキストからコマンド行を除去する（コードブロック内は残す）
 */
function stripCommandsFromDisplay(text: string): string {
  const lines = text.split('\n');
  const result: string[] = [];
  let inCodeBlock = false;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      result.push(line);
      i++;
      continue;
    }

    if (inCodeBlock) {
      result.push(line);
      i++;
      continue;
    }

    const trimmed = line.trim();

    if (trimmed.startsWith('SYSTEM_COMMAND:')) {
      i++;
      continue;
    }

    const sendMatch = trimmed.match(/^!discord\s+send\s+<#\d+>\s*(.*)/);
    if (sendMatch) {
      i++;
      let inBodyCodeBlock = false;
      while (i < lines.length) {
        const bodyLine = lines[i];
        if (bodyLine.trim().startsWith('```')) {
          inBodyCodeBlock = !inBodyCodeBlock;
        }
        if (
          !inBodyCodeBlock &&
          (bodyLine.trim().startsWith('!discord ') ||
            bodyLine.trim().startsWith('!schedule'))
        ) {
          break;
        }
        i++;
      }
      continue;
    }

    if (trimmed.startsWith('!discord ')) {
      i++;
      continue;
    }

    if (trimmed === '!schedule' || trimmed.startsWith('!schedule ')) {
      i++;
      continue;
    }

    result.push(line);
    i++;
  }

  return result.join('\n').trim();
}

/**
 * コードブロック判定のテスト用
 */
function isInCodeBlock(lines: string[], targetIndex: number): boolean {
  let inCodeBlock = false;
  for (let i = 0; i <= targetIndex; i++) {
    if (lines[i].trim().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
    }
  }
  return inCodeBlock;
}

/**
 * !discord コマンドをテキストから抽出（コードブロック外のみ）
 * !discord send は複数行対応（次の !discord / !schedule コマンド行まで吸収）
 */
function extractDiscordCommands(text: string): string[] {
  const lines = text.split('\n');
  const commands: string[] = [];
  let inCodeBlock = false;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      i++;
      continue;
    }
    if (inCodeBlock) {
      i++;
      continue;
    }

    const trimmed = line.trim();
    const sendMatch = trimmed.match(/^!discord\s+send\s+<#(\d+)>\s*(.*)/);
    if (sendMatch) {
      const firstLineContent = sendMatch[2] ?? '';
      if (firstLineContent.trim() === '') {
        // 暗黙マルチライン: 次のコマンド行まで吸収
        const bodyLines: string[] = [];
        let inBodyCodeBlock = false;
        i++;
        while (i < lines.length) {
          const bodyLine = lines[i];
          if (bodyLine.trim().startsWith('```')) {
            inBodyCodeBlock = !inBodyCodeBlock;
          }
          if (
            !inBodyCodeBlock &&
            (bodyLine.trim().startsWith('!discord ') ||
              bodyLine.trim().startsWith('!schedule'))
          ) {
            break;
          }
          bodyLines.push(bodyLine);
          i++;
        }
        const fullMessage = bodyLines.join('\n').trim();
        if (fullMessage) {
          commands.push(`!discord send <#${sendMatch[1]}> ${fullMessage}`);
        }
        continue;
      } else {
        // 1行目にテキストあり → 続く行も吸収
        const bodyLines2: string[] = [firstLineContent];
        let inBodyCodeBlock2 = false;
        i++;
        while (i < lines.length) {
          const bodyLine = lines[i];
          if (bodyLine.trim().startsWith('```')) {
            inBodyCodeBlock2 = !inBodyCodeBlock2;
          }
          if (
            !inBodyCodeBlock2 &&
            (bodyLine.trim().startsWith('!discord ') ||
              bodyLine.trim().startsWith('!schedule'))
          ) {
            break;
          }
          bodyLines2.push(bodyLine);
          i++;
        }
        const fullMessage2 = bodyLines2.join('\n').trimEnd();
        commands.push(`!discord send <#${sendMatch[1]}> ${fullMessage2}`);
        continue;
      }
    }

    if (trimmed.startsWith('!discord ')) {
      commands.push(trimmed);
    }
    i++;
  }

  return commands;
}

/**
 * Discord の 2000 文字制限に合わせてメッセージを分割する
 */
function chunkDiscordMessage(message: string, limit = 2000): string[] {
  if (message.length <= limit) return [message];

  const chunks: string[] = [];
  let buf = '';

  for (const line of message.split('\n')) {
    if (line.length > limit) {
      if (buf) {
        chunks.push(buf);
        buf = '';
      }
      for (let j = 0; j < line.length; j += limit) {
        chunks.push(line.slice(j, j + limit));
      }
      continue;
    }
    const candidate = buf ? `${buf}\n${line}` : line;
    if (candidate.length > limit) {
      chunks.push(buf);
      buf = line;
    } else {
      buf = candidate;
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

/**
 * テキストから !discord send コマンドを抽出し、残りのテキストを返す
 * スケジューラプロンプトからコマンドを分離するために使用
 */
function extractDiscordSendFromPrompt(text: string): {
  commands: string[];
  remaining: string;
} {
  const lines = text.split('\n');
  const commands: string[] = [];
  const remainingLines: string[] = [];
  let inCodeBlock = false;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      remainingLines.push(line);
      i++;
      continue;
    }

    if (inCodeBlock) {
      remainingLines.push(line);
      i++;
      continue;
    }

    const trimmed = line.trim();
    const sendMatch = trimmed.match(/^!discord\s+send\s+<#(\d+)>\s*(.*)/);
    if (sendMatch) {
      const firstLineContent = sendMatch[2] ?? '';
      if (firstLineContent.trim() === '') {
        const bodyLines: string[] = [];
        let inBodyCodeBlock = false;
        i++;
        while (i < lines.length) {
          const bodyLine = lines[i];
          if (bodyLine.trim().startsWith('```')) {
            inBodyCodeBlock = !inBodyCodeBlock;
          }
          if (
            !inBodyCodeBlock &&
            (bodyLine.trim().startsWith('!discord ') ||
              bodyLine.trim().startsWith('!schedule'))
          ) {
            break;
          }
          bodyLines.push(bodyLine);
          i++;
        }
        const fullMessage = bodyLines.join('\n').trim();
        if (fullMessage) {
          commands.push(`!discord send <#${sendMatch[1]}> ${fullMessage}`);
        }
        continue;
      } else {
        const bodyLines2: string[] = [firstLineContent];
        let inBodyCodeBlock2 = false;
        i++;
        while (i < lines.length) {
          const bodyLine = lines[i];
          if (bodyLine.trim().startsWith('```')) {
            inBodyCodeBlock2 = !inBodyCodeBlock2;
          }
          if (
            !inBodyCodeBlock2 &&
            (bodyLine.trim().startsWith('!discord ') ||
              bodyLine.trim().startsWith('!schedule'))
          ) {
            break;
          }
          bodyLines2.push(bodyLine);
          i++;
        }
        const fullMessage2 = bodyLines2.join('\n').trimEnd();
        commands.push(`!discord send <#${sendMatch[1]}> ${fullMessage2}`);
        continue;
      }
    }

    remainingLines.push(line);
    i++;
  }

  return { commands, remaining: remainingLines.join('\n') };
}

describe('Discord Commands', () => {
  describe('annotateChannelMentions', () => {
    it('should add channel ID annotation', () => {
      const input = '<#1234567890> に投稿して';
      const result = annotateChannelMentions(input);
      expect(result).toBe('<#1234567890> [チャンネルID: 1234567890] に投稿して');
    });

    it('should handle multiple channel mentions', () => {
      const input = '<#111> と <#222> に送って';
      const result = annotateChannelMentions(input);
      expect(result).toBe('<#111> [チャンネルID: 111] と <#222> [チャンネルID: 222] に送って');
    });

    it('should not modify text without channel mentions', () => {
      const input = '普通のテキスト';
      const result = annotateChannelMentions(input);
      expect(result).toBe('普通のテキスト');
    });

    it('should handle empty string', () => {
      const result = annotateChannelMentions('');
      expect(result).toBe('');
    });
  });

  describe('isInCodeBlock', () => {
    it('should detect code block', () => {
      const lines = ['text', '```', 'code', '```', 'text'];
      expect(isInCodeBlock(lines, 0)).toBe(false);
      expect(isInCodeBlock(lines, 2)).toBe(true);
      expect(isInCodeBlock(lines, 4)).toBe(false);
    });

    it('should handle nested code blocks', () => {
      const lines = ['```', 'code1', '```', 'text', '```', 'code2', '```'];
      expect(isInCodeBlock(lines, 1)).toBe(true);
      expect(isInCodeBlock(lines, 3)).toBe(false);
      expect(isInCodeBlock(lines, 5)).toBe(true);
    });
  });

  describe('extractDiscordCommands', () => {
    it('should extract discord commands', () => {
      const text = `!discord send <#123> hello
!discord channels`;
      const commands = extractDiscordCommands(text);
      expect(commands).toEqual([
        '!discord send <#123> hello',
        '!discord channels',
      ]);
    });

    it('should skip commands inside code blocks', () => {
      const text = `コマンド例:
\`\`\`
!discord send <#123> hello
\`\`\`
実際のコマンド:
!discord channels`;
      const commands = extractDiscordCommands(text);
      expect(commands).toEqual(['!discord channels']);
    });

    it('should handle multiple code blocks', () => {
      const text = `\`\`\`
!discord send <#111> skip1
\`\`\`
!discord send <#222> include
!discord channels`;
      const commands = extractDiscordCommands(text);
      expect(commands).toEqual([
        '!discord send <#222> include',
        '!discord channels',
      ]);
    });

    it('should return empty array when no commands', () => {
      const text = '普通のテキスト\n改行あり';
      const commands = extractDiscordCommands(text);
      expect(commands).toEqual([]);
    });

    it('should handle inline code (not block)', () => {
      const text = '`!discord send` はコマンドです\n!discord channels';
      const commands = extractDiscordCommands(text);
      // インラインコードは無視されないが、行頭でないのでマッチしない
      expect(commands).toEqual(['!discord channels']);
    });

    it('should collect multiline message when send has no inline content', () => {
      const text = `!discord send <#123>
今日のニュース
【記事1】タイトル
→ 要点
URL`;
      const commands = extractDiscordCommands(text);
      expect(commands).toEqual([
        '!discord send <#123> 今日のニュース\n【記事1】タイトル\n→ 要点\nURL',
      ]);
    });

    it('should stop multiline collection at next !discord command', () => {
      const text = `!discord send <#123>
1行目
2行目
!discord channels`;
      const commands = extractDiscordCommands(text);
      expect(commands).toEqual([
        '!discord send <#123> 1行目\n2行目',
        '!discord channels',
      ]);
    });

    it('should stop multiline collection at !schedule command', () => {
      const text = `!discord send <#123>
メッセージ本文
!schedule list`;
      const commands = extractDiscordCommands(text);
      expect(commands).toEqual([
        '!discord send <#123> メッセージ本文',
      ]);
    });

    it('should keep single-line send as-is (backward compat)', () => {
      const text = '!discord send <#123> 単一行メッセージ';
      const commands = extractDiscordCommands(text);
      expect(commands).toEqual(['!discord send <#123> 単一行メッセージ']);
    });

    it('should handle multiline with code blocks in body', () => {
      const text = `!discord send <#123>
本文開始
\`\`\`
!discord send <#999> これはコードブロック内
\`\`\`
本文続き
!discord channels`;
      const commands = extractDiscordCommands(text);
      expect(commands).toEqual([
        '!discord send <#123> 本文開始\n```\n!discord send <#999> これはコードブロック内\n```\n本文続き',
        '!discord channels',
      ]);
    });

    it('should handle multiple multiline sends', () => {
      const text = `!discord send <#111>
メッセージ1
!discord send <#222>
メッセージ2`;
      const commands = extractDiscordCommands(text);
      expect(commands).toEqual([
        '!discord send <#111> メッセージ1',
        '!discord send <#222> メッセージ2',
      ]);
    });

    it('should absorb continuation lines even when first line has content', () => {
      const text = `!discord send <#123> 【ニュース1】テストタイトル1
→ テスト要点1
https://example.com/1

【ニュース2】テストタイトル2
→ テスト要点2
https://example.com/2`;
      const commands = extractDiscordCommands(text);
      expect(commands).toEqual([
        '!discord send <#123> 【ニュース1】テストタイトル1\n→ テスト要点1\nhttps://example.com/1\n\n【ニュース2】テストタイトル2\n→ テスト要点2\nhttps://example.com/2',
      ]);
    });

    it('should skip empty multiline send', () => {
      const text = `!discord send <#123>
!discord channels`;
      const commands = extractDiscordCommands(text);
      expect(commands).toEqual(['!discord channels']);
    });
  });

  describe('chunkDiscordMessage', () => {
    it('should return single chunk for short messages', () => {
      const chunks = chunkDiscordMessage('short message', 2000);
      expect(chunks).toEqual(['short message']);
    });

    it('should split long messages at newline boundaries', () => {
      const line = 'A'.repeat(800);
      const message = `${line}\n${line}\n${line}`;
      const chunks = chunkDiscordMessage(message, 2000);
      expect(chunks.length).toBe(2);
      expect(chunks[0]).toBe(`${line}\n${line}`);
      expect(chunks[1]).toBe(line);
      chunks.forEach((c) => expect(c.length).toBeLessThanOrEqual(2000));
    });

    it('should hard-split lines exceeding limit', () => {
      const longLine = 'X'.repeat(5000);
      const chunks = chunkDiscordMessage(longLine, 2000);
      expect(chunks.length).toBe(3);
      expect(chunks[0].length).toBe(2000);
      expect(chunks[1].length).toBe(2000);
      expect(chunks[2].length).toBe(1000);
    });

    it('should handle empty message', () => {
      const chunks = chunkDiscordMessage('', 2000);
      expect(chunks).toEqual(['']);
    });
  });

  describe('stripCommandsFromDisplay', () => {
    it('should remove !discord commands outside code blocks', () => {
      // !discord send は続く行も吸収するため、テキスト後も消える
      const text = `テキスト前\n!discord send <#123> メッセージ\nテキスト後`;
      const result = stripCommandsFromDisplay(text);
      expect(result).toBe('テキスト前');
    });

    it('should keep !discord commands inside code blocks', () => {
      const text = `テキスト前\n\`\`\`\n!discord send <#123> メッセージ\n\`\`\`\nテキスト後`;
      const result = stripCommandsFromDisplay(text);
      expect(result).toBe('テキスト前\n```\n!discord send <#123> メッセージ\n```\nテキスト後');
    });

    it('should remove SYSTEM_COMMAND lines', () => {
      const text = `テキスト\nSYSTEM_COMMAND:setting=value\n続き`;
      const result = stripCommandsFromDisplay(text);
      expect(result).toBe('テキスト\n続き');
    });

    it('should remove !schedule commands outside code blocks', () => {
      const text = `テキスト\n!schedule 5分後 テスト\n続き`;
      const result = stripCommandsFromDisplay(text);
      expect(result).toBe('テキスト\n続き');
    });

    it('should keep !schedule commands inside code blocks', () => {
      const text = `例:\n\`\`\`\n!schedule 5分後 テスト\n\`\`\`\n以上`;
      const result = stripCommandsFromDisplay(text);
      expect(result).toBe('例:\n```\n!schedule 5分後 テスト\n```\n以上');
    });

    it('should remove multiline !discord send and continuation lines', () => {
      // 続く行は次のコマンド行まで吸収されるため、後文も消える
      const text = `前文\n!discord send <#123>\n1行目\n2行目\n後文`;
      const result = stripCommandsFromDisplay(text);
      expect(result).toBe('前文');
    });

    it('should remove single-line send with continuation lines', () => {
      // 続く行は次のコマンド行まで吸収されるため、後文も消える
      const text = `前文\n!discord send <#123> 【ニュース1】タイトル\n→ 要点\nURL\n後文`;
      const result = stripCommandsFromDisplay(text);
      expect(result).toBe('前文');
    });

    it('should stop removal at next command', () => {
      const text = `!discord send <#123>\nメッセージ\n!discord channels\n後文`;
      const result = stripCommandsFromDisplay(text);
      expect(result).toBe('後文');
    });

    it('should handle mixed code blocks and commands', () => {
      // コードブロック内は残し、外のコマンドは続く行も吸収して除去
      const text = `説明:\n\`\`\`\n!discord send <#123> 例文\n\`\`\`\n実行:\n!discord send <#456> 本文\n以上`;
      const result = stripCommandsFromDisplay(text);
      expect(result).toBe('説明:\n```\n!discord send <#123> 例文\n```\n実行:');
    });

    it('should handle empty text', () => {
      const result = stripCommandsFromDisplay('');
      expect(result).toBe('');
    });
  });

  describe('extractDiscordSendFromPrompt', () => {
    it('should extract single-line send command', () => {
      const result = extractDiscordSendFromPrompt('!discord send <#123> テストメッセージ');
      expect(result.commands).toEqual(['!discord send <#123> テストメッセージ']);
      expect(result.remaining.trim()).toBe('');
    });

    it('should extract multiline send command', () => {
      const result = extractDiscordSendFromPrompt('!discord send <#123>\n1行目\n2行目');
      expect(result.commands).toEqual(['!discord send <#123> 1行目\n2行目']);
      expect(result.remaining.trim()).toBe('');
    });

    it('should separate command from remaining text', () => {
      const text = '前文テキスト\n!discord send <#123> メッセージ';
      const result = extractDiscordSendFromPrompt(text);
      expect(result.commands).toEqual(['!discord send <#123> メッセージ']);
      expect(result.remaining.trim()).toBe('前文テキスト');
    });

    it('should handle multiple send commands', () => {
      const text = '!discord send <#111> msg1\n!discord send <#222> msg2';
      const result = extractDiscordSendFromPrompt(text);
      expect(result.commands).toEqual([
        '!discord send <#111> msg1',
        '!discord send <#222> msg2',
      ]);
      expect(result.remaining.trim()).toBe('');
    });

    it('should skip commands inside code blocks', () => {
      const text = '```\n!discord send <#123> コード内\n```\n!discord send <#456> コード外';
      const result = extractDiscordSendFromPrompt(text);
      expect(result.commands).toEqual(['!discord send <#456> コード外']);
      expect(result.remaining).toContain('```');
    });

    it('should return empty commands for text without commands', () => {
      const text = '普通のテキスト\n改行あり';
      const result = extractDiscordSendFromPrompt(text);
      expect(result.commands).toEqual([]);
      expect(result.remaining).toBe('普通のテキスト\n改行あり');
    });

    it('should handle send with continuation and remaining text', () => {
      const text = '指示テキスト\n!discord send <#123>\nメッセージ本文\n追加行\n他の指示';
      const result = extractDiscordSendFromPrompt(text);
      // 後続行は全て吸収される（次のコマンド行まで）
      expect(result.commands).toEqual([
        '!discord send <#123> メッセージ本文\n追加行\n他の指示',
      ]);
      expect(result.remaining.trim()).toBe('指示テキスト');
    });

    it('should handle empty multiline send', () => {
      const text = '!discord send <#123>\n!discord send <#456> msg';
      const result = extractDiscordSendFromPrompt(text);
      expect(result.commands).toEqual(['!discord send <#456> msg']);
    });

    it('should handle empty string', () => {
      const result = extractDiscordSendFromPrompt('');
      expect(result.commands).toEqual([]);
      expect(result.remaining).toBe('');
    });
  });
});
