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

  it('passes sandbox-owned Codex config and network proxy routes', () => {
    const values = {
      CODEX_HOME: '/var/lib/xangi/codex-home',
      HTTPS_PROXY: 'http://10.200.0.1:3128',
      NO_PROXY: '127.0.0.1,localhost',
      SSL_CERT_FILE: '/etc/openshell-tls/ca-bundle.pem',
    };
    const previous = Object.fromEntries(
      Object.keys(values).map((key) => [key, process.env[key]])
    );
    Object.assign(process.env, values);

    const env = getSafeEnv();

    expect(env).toMatchObject(values);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
});
