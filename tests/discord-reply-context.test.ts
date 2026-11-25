import { Collection, Events, MessageType, type Client } from 'discord.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { registerDiscordMessageHandlers } from '../src/discord/message-handler.js';
import { createInteractionHandler } from '../src/discord/slash-commands.js';
import * as fileUtils from '../src/file-utils.js';
import {
  clearSessions,
  getActiveSessionId,
  getSessionEntry,
  initSessions,
} from '../src/sessions.js';
import { clearSettingsCache, initSettings } from '../src/settings.js';
import { logPrompt } from '../src/transcript-logger.js';

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'discord-reply-context-'));
  initSessions(workdir);
  initSettings(workdir);
});

afterEach(() => {
  vi.restoreAllMocks();
  clearSessions();
  clearSettingsCache();
  rmSync(workdir, { recursive: true, force: true });
});

const replyUrl = 'https://discord.com/channels/100/200/300';
const repliedImageUrl = 'https://cdn.discordapp.com/attachments/200/301/scene.png';
const currentImageUrl = 'https://cdn.discordapp.com/attachments/200/401/scene.png';

async function receiveReply({
  currentAttachment = true,
  imageFails = false,
  replyMissing = false,
  titleFails = false,
} = {}) {
  const on = vi.fn();
  const edit = vi.fn().mockResolvedValue(undefined);
  const send = vi.fn().mockResolvedValue({ id: 'response', edit });
  const setName = vi.fn().mockResolvedValue(undefined);
  const startThread = vi.fn(async ({ name }) => ({ id: '400', name, send, setName }));
  const runStream = vi.fn(async (_prompt, callbacks) => {
    callbacks.onBackendReady();
    return { result: '確認しました', sessionId: 'provider-session' };
  });
  const run = titleFails
    ? vi.fn().mockRejectedValue(new Error('title unavailable'))
    : vi.fn().mockResolvedValue({ result: 'ネコマンZの続編漫画' });
  const channelMention = { id: '500', name: 'comic' };
  const fetchHistory = vi.fn().mockResolvedValue(
    new Collection([
      [
        '600',
        {
          createdAt: new Date('2026-01-01T00:00:00Z'),
          author: { tag: 'writer' },
          content: '行きて帰し物語',
        },
      ],
    ])
  );
  const client = {
    on,
    user: { id: '700' },
    channels: {
      fetch: vi.fn().mockResolvedValue({ ...channelMention, messages: { fetch: fetchHistory } }),
    },
  };
  const replyAttachments = new Collection([
    ['301', { id: '301', name: 'scene.png', contentType: 'image/png', url: repliedImageUrl }],
    [
      '302',
      {
        id: '302',
        name: 'script.pdf',
        contentType: 'application/pdf',
        url: 'https://example.test/script.pdf',
      },
    ],
  ]);
  const fetchReply = replyMissing
    ? vi.fn().mockRejectedValue(new Error('Unknown Message'))
    : vi.fn().mockResolvedValue({
        url: replyUrl,
        author: { tag: 'writer' },
        content: '前作は「ネコマンZ」です',
        attachments: replyAttachments,
      });
  const download = vi.spyOn(fileUtils, 'downloadFile').mockImplementation(async (url, filename) => {
    if (url === repliedImageUrl && imageFails) throw new Error('attachment unavailable');
    return join(workdir, filename);
  });
  const message = {
    id: '400',
    type: MessageType.Reply,
    guild: { id: '100' },
    channel: { id: '200', name: 'talk', isThread: () => false, messages: { fetch: fetchReply } },
    content: '<@700> この続編を <#500> に投稿して',
    author: { id: 'user', displayName: 'User' },
    attachments: new Collection(
      currentAttachment
        ? [
            [
              '401',
              { id: '401', name: 'scene.png', contentType: 'image/png', url: currentImageUrl },
            ],
          ]
        : []
    ),
    reference: { channelId: '200', messageId: '300', guildId: '100' },
    mentions: { has: () => true, channels: new Collection([['500', channelMention]]) },
    createdTimestamp: Date.now(),
    client,
    startThread,
    react: vi.fn().mockResolvedValue(undefined),
    reactions: { cache: new Collection() },
  };
  registerDiscordMessageHandlers({
    client: client as unknown as Client,
    config: {
      discord: {
        allowedUsers: ['user'],
        replyInThread: true,
        sessionTitleAiOnce: true,
        showButtons: false,
      },
      sessionTitle: { mode: 'ai' },
      agent: { backend: 'claude-code', config: { workdir } },
    },
    agentRunner: { run, runStream },
    workdir,
  } as unknown as Parameters<typeof registerDiscordMessageHandlers>[0]);
  await on.mock.calls.find(([event]) => event === Events.MessageCreate)![1](message);
  expect(runStream).toHaveBeenCalledTimes(1);
  return { prompt: runStream.mock.calls[0][0], download, fetchReply, run, setName };
}

it('mounts the directly replied image for a text-only reply', async () => {
  const { prompt, download } = await receiveReply({ currentAttachment: false });
  expect(download).toHaveBeenCalledOnce();
  expect(download).toHaveBeenCalledWith(repliedImageUrl, 'reply-301-scene.png');
  expect(prompt).toContain(`[Attachment]\n  - ${join(workdir, 'reply-301-scene.png')}`);
});

it('mounts the directly replied image alongside the current attachment in the ordinary prompt', async () => {
  const { prompt, download, fetchReply } = await receiveReply();
  expect(fetchReply).toHaveBeenCalledOnce();
  expect(fetchReply).toHaveBeenCalledWith({ message: '300', force: true });
  expect(download.mock.calls.map(([url]) => url)).toEqual([currentImageUrl, repliedImageUrl]);
  expect(prompt).toContain(replyUrl);
  expect(prompt).toContain('script.pdf');
  expect(prompt).toContain('[Attachment]\n');
  expect(prompt).toContain(`  - ${join(workdir, 'scene.png')}`);
  expect(prompt).toContain(`  - ${join(workdir, 'reply-301-scene.png')}`);
});

it('names the new thread from the current request and reply while preserving history for the answer', async () => {
  const { prompt, run, setName } = await receiveReply();
  expect(prompt).toContain('ネコマンZ');
  expect(prompt).toContain('#comic の最新メッセージ');
  expect(prompt).toContain('行きて帰し物語');
  expect(run).toHaveBeenCalledOnce();
  const [titlePrompt, options] = run.mock.calls[0]!;
  expect(options.internalTask).toBe(true);
  expect(titlePrompt).toContain('この続編を #comic に投稿して');
  expect(titlePrompt).toContain('ネコマンZ');
  expect(titlePrompt).not.toMatch(/行きて帰し物語|最新メッセージ|scene\.png|discord\.com/);
  expect(setName).toHaveBeenCalledWith('ネコマンZの続編漫画');
});

it('keeps the current attachment and source link when the replied image download fails', async () => {
  const { prompt, download } = await receiveReply({ imageFails: true });
  expect(download).toHaveBeenCalledWith(repliedImageUrl, 'reply-301-scene.png');
  expect(prompt).toContain(replyUrl);
  expect(prompt).toContain('取得できなかった返信元画像: scene.png');
  expect(prompt).toContain(`  - ${join(workdir, 'scene.png')}`);
  expect(prompt).not.toContain('reply-301-scene.png');
});

it('still answers when the direct reply was deleted', async () => {
  const { prompt, run, download } = await receiveReply({ replyMissing: true });
  expect(download).toHaveBeenCalledOnce();
  expect(prompt).toContain('[Attachment]');
  expect(run.mock.calls[0]![0]).toContain('この続編を #comic に投稿して');
  expect(run.mock.calls[0]![0]).not.toContain('ネコマンZ');
});

it('keeps a request-based session title when AI naming fails', async () => {
  const { run, setName } = await receiveReply({ titleFails: true });
  expect(run).toHaveBeenCalledOnce();
  expect(setName).not.toHaveBeenCalled();
  expect(getSessionEntry(getActiveSessionId('400')!)?.title).toBe('この続編を #comic に投稿して');
});

it('still regenerates the title from the transcript when explicitly requested', async () => {
  const { setName } = await receiveReply();
  const appSessionId = getActiveSessionId('400')!;
  logPrompt(workdir, appSessionId, '保存された次の依頼');
  const run = vi.fn().mockResolvedValue({ result: '手動で再生成した題名' });
  const handler = createInteractionHandler({
    config: { discord: { allowedUsers: ['user'] }, features: { backendSwitching: false } },
    agentRunner: { run },
    workspaceRegistry: { resolveById: async () => ({ path: workdir }) },
    workdir,
  } as unknown as Parameters<typeof createInteractionHandler>[0]);
  const editReply = vi.fn();
  await handler({
    isAutocomplete: () => false,
    isButton: () => false,
    isChatInputCommand: () => true,
    commandName: 'retitle',
    channelId: '400',
    channel: { isThread: () => true, parentId: '200', setName },
    user: { id: 'user' },
    deferReply: vi.fn(),
    editReply,
  } as never);

  expect(run.mock.calls[0]![0]).toContain('保存された次の依頼');
  expect(setName).toHaveBeenLastCalledWith('手動で再生成した題名');
  expect(getSessionEntry(appSessionId)?.title).toBe('手動で再生成した題名');
  expect(editReply).toHaveBeenCalledWith(expect.stringContaining('手動で再生成した題名'));
});
