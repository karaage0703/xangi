import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type FavoriteAction = 'add' | 'remove' | 'up' | 'down';

export function parseFavoriteAction(input: unknown): { id: string; action: FavoriteAction } {
  if (!input || typeof input !== 'object') throw new Error('操作を指定してください');
  const { id, action } = input as Record<string, unknown>;
  if (
    typeof id !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id) ||
    typeof action !== 'string' ||
    !['add', 'remove', 'up', 'down'].includes(action)
  ) {
    throw new Error('お気に入りの操作が不正です');
  }
  return { id, action: action as FavoriteAction };
}

export class ExtensionFavorites {
  constructor(private readonly filePath: string) {}

  list(): string[] {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const value: unknown = JSON.parse(raw);
    if (
      !Array.isArray(value) ||
      value.length > 100 ||
      value.some(
        (id) => typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id)
      ) ||
      new Set(value).size !== value.length
    )
      throw new Error('お気に入り設定を読み込めません');
    return value;
  }

  update(id: string, action: FavoriteAction): string[] {
    parseFavoriteAction({ id, action });
    const ids = this.list();
    const index = ids.indexOf(id);
    if (action === 'add' && index < 0) {
      if (ids.length >= 100) throw new Error('お気に入りは100件まで登録できます');
      ids.push(id);
    }
    if (action === 'remove' && index >= 0) ids.splice(index, 1);
    const next = index + (action === 'up' ? -1 : 1);
    if ((action === 'up' || action === 'down') && index >= 0 && next >= 0 && next < ids.length) {
      [ids[index], ids[next]] = [ids[next], ids[index]];
    }
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(ids) + '\n', { mode: 0o600 });
    renameSync(temporary, this.filePath);
    return ids;
  }
}
