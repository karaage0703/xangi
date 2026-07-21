#!/usr/bin/env node
import { runConfiguredRuntime } from './runtime-config.js';

const [configPath, stateDir, entrypoint] = process.argv.slice(2);
if (!configPath || !stateDir || !entrypoint) {
  console.error('Usage: runtime-config <setup.json> <state-dir> <runtime-entrypoint>');
  process.exit(2);
}

runConfiguredRuntime(configPath, stateDir, entrypoint).catch((error) => {
  console.error(`Failed to start xangi: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
