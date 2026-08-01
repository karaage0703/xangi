import { mkdir } from 'node:fs/promises';
import lockfile from 'proper-lockfile';

export type ReleaseDataDirLock = () => Promise<void>;

interface DataDirLockDependencies {
  ensureDir: (dataDir: string) => Promise<void>;
  lock: (
    dataDir: string,
    options: { stale: number; update: number; retries: number }
  ) => Promise<ReleaseDataDirLock>;
}

const defaultDependencies: DataDirLockDependencies = {
  ensureDir: async (dataDir) => {
    await mkdir(dataDir, { recursive: true });
  },
  lock: (dataDir, options) => lockfile.lock(dataDir, options),
};

function errorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code: unknown }).code)
    : '';
}

export async function acquireDataDirLock(
  dataDir: string,
  dependencies: DataDirLockDependencies = defaultDependencies
): Promise<ReleaseDataDirLock> {
  await dependencies.ensureDir(dataDir);

  try {
    return await dependencies.lock(dataDir, {
      stale: 60_000,
      update: 30_000,
      retries: 0,
    });
  } catch (error) {
    if (errorCode(error) === 'ELOCKED') {
      throw new Error(
        `Another xangi process is using the same dataDir: ${dataDir}. Stop the other process or set a separate DATA_DIR.`,
        { cause: error }
      );
    }
    throw new Error(`Failed to acquire dataDir lock for ${dataDir}`, { cause: error });
  }
}
