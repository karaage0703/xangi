import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createLinkedConversation } from '../src/conversation-creation.js';

const directories: string[] = [];
afterEach(() =>
  directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }))
);
const directory = () => {
  const path = mkdtempSync(join(tmpdir(), 'linked-creation-'));
  directories.push(path);
  return path;
};

it('reuses the created conversation after a lost creation response and rejects a changed payload', async () => {
  const path = directory();
  const create = vi.fn().mockResolvedValue({ sessionId: 'same-session' });
  await createLinkedConversation(path, 'create-request-1', 'project', 'first', create);
  expect(
    await createLinkedConversation(path, 'create-request-1', 'project', 'first', create)
  ).toEqual({ sessionId: 'same-session' });
  await expect(
    createLinkedConversation(path, 'create-request-1', 'project', 'changed', create)
  ).rejects.toThrow('異なる入力');
  expect(create).toHaveBeenCalledTimes(1);
});

it('never blindly repeats uncertain external thread creation', async () => {
  const path = directory();
  const create = vi.fn().mockRejectedValue(new Error('response lost'));
  await expect(
    createLinkedConversation(path, 'create-request-2', 'project', 'first', create)
  ).rejects.toThrow('response lost');
  await expect(
    createLinkedConversation(path, 'create-request-2', 'project', 'first', create)
  ).rejects.toThrow('作成結果');
  expect(create).toHaveBeenCalledTimes(1);
});

it('binds a request ID to the original work channel and Bot', async () => {
  const path = directory();
  const create = vi.fn().mockResolvedValue({ sessionId: 'thread' });
  await createLinkedConversation(
    path,
    'work-channel-change',
    'project',
    'hello',
    create,
    'old-route'
  );
  await expect(
    createLinkedConversation(path, 'work-channel-change', 'project', 'hello', create, 'new-route')
  ).rejects.toMatchObject({ status: 409 });
  expect(create).toHaveBeenCalledOnce();
});
