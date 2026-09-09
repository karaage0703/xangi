import { randomBytes } from 'node:crypto';
import { chmod, mkdir, open, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export async function writePrivateJsonFile(path: string, value: unknown): Promise<void> {
  const directory = dirname(path);
  const temporary = join(
    directory,
    `.${basename(path)}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let temporaryCreated = false;
  try {
    const file = await open(temporary, 'wx', 0o600);
    temporaryCreated = true;
    try {
      await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    temporaryCreated = false;
    await chmod(path, 0o600);
  } finally {
    if (temporaryCreated) await unlink(temporary).catch(() => undefined);
  }
}
