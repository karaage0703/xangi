import { describe, expect, it } from 'vitest';
import { parseSecretCommand } from '../src/secret-command-parser.js';

describe('standalone secret requests', () => {
  it.each([
    ['シークレットにして', 'on'],
    ['シークレットモードにしてください。', 'on'],
    ['シークレットモードを開始してください', 'on'],
    ['シークレットをオンにして', 'on'],
    ['シークレットを終了して', 'off'],
    ['シークレットモードを解除してください', 'off'],
    ['シークレット解除して', 'off'],
    ['シークレットモードをオフにしてくれる？', 'off'],
    ['今シークレット？', 'status'],
    ['シークレットの状態を教えて', 'status'],
    ['シークレットモードの状態を確認してください', 'status'],
    ['/secret@bot on', 'on'],
    ['/secret off', 'off'],
    ['/secret status', 'status'],
    ['/secret@bot status', 'status'],
    ['/secret', 'status'],
  ])('recognizes %s as %s', (text, mode) => expect(parseSecretCommand(text)).toBe(mode));

  it.each([
    'シークレットにしないで',
    'シークレットを終了しないで',
    '「シークレットにして」',
    'シークレットにして、というコマンドを説明して',
    'シークレットにして\n秘密の本文',
    'シークレットにして。秘密の本文',
    '前にシークレットにしてとお願いした',
    'シークレットにしていい？',
    '/secret on private-content',
    '/secretary on',
    '/secret show',
    '/secret@bot show',
    'シークレット',
    '',
  ])('does not switch for quoted, negative or mixed requests: %s', (text) => {
    expect(parseSecretCommand(text)).toBeUndefined();
  });
});
