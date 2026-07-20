import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync('.github/workflows/release-assets.yml', 'utf8');

describe('release asset workflow', () => {
  it('builds every supported native target and publishes only from public xangi', () => {
    for (const runner of ['ubuntu-24.04', 'ubuntu-24.04-arm', 'macos-15-intel', 'macos-15']) {
      expect(workflow).toContain(`runner: ${runner}`);
    }
    expect(workflow.match(/github\.repository == 'karaage0703\/xangi'/g)).toHaveLength(2);
    expect(workflow).toContain('gh release upload');
    expect(workflow).toContain('contents: write');
  });

  it('limits the signing key to the final publishing job', () => {
    const buildJob = workflow.slice(
      workflow.indexOf('  build-bundles:'),
      workflow.indexOf('  publish-assets:')
    );
    const publishJob = workflow.slice(workflow.indexOf('  publish-assets:'));
    expect(buildJob).not.toContain('XANGI_RELEASE_SIGNING_KEY_BASE64');
    expect(publishJob).toContain('secrets.XANGI_RELEASE_SIGNING_KEY_BASE64');
    expect(publishJob).toContain('chmod 0600 "$key_file"');
    expect(publishJob).toContain('trap cleanup EXIT INT TERM');
    expect(publishJob).toContain('rm -f "$key_file" "$public_key"');
  });

  it('publishes the stable bootstrap, target installers, manifests, bundles, and checksums', () => {
    expect(workflow).toContain('cp packaging/bootstrap.sh release-assets/install.sh');
    expect(workflow).toContain('cp packaging/setup-ai-tools.sh release-assets/setup-ai-tools.sh');
    expect(workflow).toContain('xangi-installer-${platform}-${arch}.sh');
    expect(workflow).toContain('xangi-manifest-${platform}-${arch}.json');
    expect(workflow).toContain('(cd release-assets && sha256sum * > SHA256SUMS)');
    expect(workflow).toContain(
      "grep -nE '@[A-Z_]+@' release-assets/*.sh release-assets/*.json"
    );
    expect(workflow).not.toContain("grep -R -nE '@[A-Z_]+@' release-assets");
    expect(workflow).toContain(
      'latest_base="https://github.com/${GITHUB_REPOSITORY}/releases/latest/download"'
    );
    expect(workflow).toContain('--manifest-url "$latest_base/$(basename "$manifest")"');
  });
});
