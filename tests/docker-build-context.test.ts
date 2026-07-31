import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const dockerfiles = [
  'docker/Dockerfile',
  'docker/Dockerfile.max',
  'docker/Dockerfile.gpu',
];

describe('Docker build context', () => {
  it.each(dockerfiles)('%s includes the React web build inputs', (dockerfile) => {
    const source = readFileSync(dockerfile, 'utf8');

    expect(source).toContain('COPY vite.config.ts ./');
    expect(source).toContain('COPY web-ui/ ./web-ui/');
    expect(source.indexOf('COPY vite.config.ts ./')).toBeLessThan(
      source.indexOf('RUN npm run build')
    );
    expect(source.indexOf('COPY web-ui/ ./web-ui/')).toBeLessThan(
      source.indexOf('RUN npm run build')
    );
  });
});
