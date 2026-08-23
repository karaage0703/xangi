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

  it('does not pass provider credentials to backend CLI processes', () => {
    const previousAnthropic = process.env.ANTHROPIC_API_KEY;
    const previousGemini = process.env.GEMINI_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'anthropic-secret';
    process.env.GEMINI_API_KEY = 'google-secret';

    const env = getSafeEnv();

    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.GEMINI_API_KEY).toBeUndefined();
    if (previousAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousAnthropic;
    if (previousGemini === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousGemini;
  });
});
