import { afterEach, describe, expect, it } from 'vitest';
import { getSafeEnv } from '../src/safe-env.js';

const previousExtensionsFile = process.env.XANGI_EXTENSIONS_FILE;

afterEach(() => {
  if (previousExtensionsFile === undefined) delete process.env.XANGI_EXTENSIONS_FILE;
  else process.env.XANGI_EXTENSIONS_FILE = previousExtensionsFile;
});

describe('safe agent environment', () => {
  it('passes the current xangi instance extension registry path', () => {
    process.env.XANGI_EXTENSIONS_FILE = '/tmp/xangi-instance/extensions.json';
    expect(getSafeEnv().XANGI_EXTENSIONS_FILE).toBe('/tmp/xangi-instance/extensions.json');
  });
});
