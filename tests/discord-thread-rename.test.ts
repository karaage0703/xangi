import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { discordApi } from '../src/cli/discord-api.js';
import { getActiveSessionId, updateSessionTitle } from '../src/sessions.js';

vi.mock('../src/sessions.js', () => ({
  getActiveSessionId: vi.fn(),
  updateSessionTitle: vi.fn(),
}));

describe('discord_thread_rename', () => {
  const fetchMock = vi.fn();
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  beforeEach(() => {
    vi.stubEnv('DISCORD_TOKEN', 'test-token');
    vi.stubGlobal('fetch', fetchMock);
    vi.resetAllMocks();
    vi.mocked(getActiveSessionId).mockReturnValue('session');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it.each([10, 11, 12])('renames thread type %s and syncs its session title', async (type) => {
    fetchMock
      .mockResolvedValueOnce(reply({ id: '123', type, name: 'old' }))
      .mockResolvedValueOnce(reply({ id: '123', type, name: '新しい名前' }));
    const result = await discordApi(
      'discord_thread_rename',
      { name: ' 新しい名前 ' },
      { channelId: '123' }
    );
    expect(fetchMock.mock.calls[1][0]).toBe('https://discord.com/api/v10/channels/123');
    expect(fetchMock.mock.calls[1][1]).toMatchObject({
      method: 'PATCH',
      body: JSON.stringify({ name: '新しい名前' }),
    });
    expect(result).toContain('新しい名前');
    expect(updateSessionTitle).toHaveBeenCalledWith('session', '新しい名前');
  });

  it.each(['', '   ', 'a'.repeat(101)])(
    'rejects invalid names before contacting Discord',
    async (name) => {
      await expect(discordApi('discord_thread_rename', { channel: '123', name })).rejects.toThrow(
        '1–100'
      );
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it('rejects non-thread channels without a PATCH', async () => {
    fetchMock.mockResolvedValueOnce(reply({ id: '123', type: 0, name: 'general' }));
    await expect(
      discordApi('discord_thread_rename', { channel: '123', name: 'new' })
    ).rejects.toThrow('must be a Discord thread');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(updateSessionTitle).not.toHaveBeenCalled();
  });

  it('honors the explicit channel and leaves session state unchanged on denied rename', async () => {
    fetchMock
      .mockResolvedValueOnce(reply({ id: '456', type: 11 }))
      .mockResolvedValueOnce(reply({ message: 'Missing Permissions' }, 403));
    await expect(
      discordApi('discord_thread_rename', { channel: '456', name: 'new' }, { channelId: '123' })
    ).rejects.toThrow('403');
    expect(fetchMock.mock.calls[1][0]).toContain('/channels/456');
    expect(updateSessionTitle).not.toHaveBeenCalled();
  });

  it('does not claim success for a mismatched API response', async () => {
    fetchMock
      .mockResolvedValueOnce(reply({ id: '123', type: 11 }))
      .mockResolvedValueOnce(reply({ id: '123', name: 'old' }));
    await expect(
      discordApi('discord_thread_rename', { channel: '123', name: 'new' })
    ).rejects.toThrow('unexpected');
    expect(updateSessionTitle).not.toHaveBeenCalled();
  });

  it('reports successful rename separately from failed local title sync', async () => {
    fetchMock
      .mockResolvedValueOnce(reply({ id: '123', type: 11 }))
      .mockResolvedValueOnce(reply({ id: '123', name: 'new' }));
    vi.mocked(updateSessionTitle).mockImplementationOnce(() => {
      throw new Error('disk failure');
    });
    const result = await discordApi('discord_thread_rename', { channel: '123', name: 'new' });
    expect(result).toContain('変更しました');
    expect(result).toContain('同期に失敗');
  });
});
