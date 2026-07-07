const { existsSync, readFileSync } = require('fs');
const { basename, join } = require('path');

function readDotEnv(filePath) {
  if (!existsSync(filePath)) {
    return {};
  }

  const env = {};
  for (const rawLine of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) {
      continue;
    }

    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[match[1]] = value;
  }
  return env;
}

const dotEnv = readDotEnv(join(__dirname, '.env'));
const appName =
  process.env.XANGI_PROCESS_NAME ||
  dotEnv.XANGI_PROCESS_NAME ||
  process.env.XANGI_INSTANCE_ID ||
  dotEnv.XANGI_INSTANCE_ID ||
  basename(__dirname) ||
  'xangi';

module.exports = {
  apps: [
    {
      name: appName,
      script: 'dist/index.js',
      cwd: __dirname,
      interpreter: 'node',
      node_args: '--env-file=.env',
      instances: 1,
      exec_mode: 'fork',
    },
  ],
};
