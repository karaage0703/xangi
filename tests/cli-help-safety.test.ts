import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runCliInProcess } from './helpers/cli-in-process.js';
import { settingsCmd } from '../src/cli/settings-cmd.js';
import { installCmd } from '../src/cli/install-cmd.js';
import { uninstallCmd } from '../src/cli/uninstall-cmd.js';
import { updateCmd } from '../src/cli/update-cmd.js';
import { doctorCmd } from '../src/cli/doctor-cmd.js';
import { rescueCmd } from '../src/cli/rescue-cmd.js';
import {
  applyGuidedSetup,
  completeGuidedSetup,
  guidedSetupCmd,
} from '../src/setup/guided-onboarding.js';

vi.mock('../src/cli/settings-cmd.js');
vi.mock('../src/cli/install-cmd.js');
vi.mock('../src/cli/uninstall-cmd.js');
vi.mock('../src/cli/update-cmd.js');
vi.mock('../src/cli/doctor-cmd.js');
vi.mock('../src/cli/rescue-cmd.js');
vi.mock('../src/setup/guided-onboarding.js');

afterEach(() => vi.clearAllMocks());

describe('CLI help safety', () => {
  const commands = [
    [],
    ['settings'],
    ['install'],
    ['uninstall', '--purge', '--yes'],
    ['update', '--managed'],
    ['doctor'],
    ['rescue'],
    ['setup'],
    ['setup', '--complete'],
    ['setup', '--apply'],
    ['worker', 'install'],
    ['worker', 'run'],
    ['worker', 'restart'],
    ['service', 'restart'],
    ['restart'],
    ['service', 'autostart', 'enable'],
    ['extension', 'restart', '--all'],
  ];
  it.each(commands.flatMap((args) => ['--help', '-h'].map((flag) => [...args, flag])))(
    'prints help before actions or managed configuration writes: %j',
    async (...args) => {
      const dir = mkdtempSync(join(tmpdir(), 'xangi-help-'));
      try {
        const stdout = await runCliInProcess(args, {
          XANGI_SKIP_ENV_FILE: 'false',
          XANGI_INSTALLATION_KIND: 'managed',
          XDG_CONFIG_HOME: join(dir, 'config'),
          XDG_DATA_HOME: join(dir, 'data'),
          XDG_STATE_HOME: join(dir, 'state'),
        });
        expect(stdout).toContain('Usage:');
        if (args[0] === 'settings') expect(stdout).toContain('xangi settings');
        for (const handler of [
          settingsCmd,
          installCmd,
          uninstallCmd,
          updateCmd,
          doctorCmd,
          rescueCmd,
          applyGuidedSetup,
          completeGuidedSetup,
          guidedSetupCmd,
        ]) {
          expect(handler).not.toHaveBeenCalled();
        }
        expect(existsSync(join(dir, 'config'))).toBe(false);
        expect(existsSync(join(dir, 'data'))).toBe(false);
        expect(existsSync(join(dir, 'state'))).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  );
});
