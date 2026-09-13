import { RemoteWorkerNode, loadRemoteWorkerNodeConfig } from '../remote-worker/node.js';
import { platform } from 'node:os';
import { installLinuxWorker, manageLinuxWorker } from '../remote-worker/systemd.js';
import { installMacWorker, manageMacWorker } from '../remote-worker/install.js';

export async function workerCmd(
  action: string,
  flags: Record<string, string | boolean>
): Promise<string> {
  if (action === 'install') {
    const pair = typeof flags.pair === 'string' ? flags.pair : '';
    const workspace = typeof flags.workspace === 'string' ? flags.workspace : process.cwd();
    if (!pair) throw new Error('xangi worker install requires --pair');
    return platform() === 'linux'
      ? installLinuxWorker(pair, workspace)
      : installMacWorker(pair, workspace);
  }
  if (['start', 'stop', 'restart', 'status', 'uninstall'].includes(action)) {
    const manage = platform() === 'linux' ? manageLinuxWorker : manageMacWorker;
    return manage(action as 'start' | 'stop' | 'restart' | 'status' | 'uninstall');
  }
  if (action !== 'run') {
    return 'Usage: xangi worker <install|run|start|stop|restart|status|uninstall>';
  }
  const configPath = typeof flags.config === 'string' ? flags.config : '';
  if (!configPath) throw new Error('xangi worker run requires --config');
  const node = new RemoteWorkerNode(loadRemoteWorkerNodeConfig(configPath));
  node.start();
  const shutdown = () => {
    node.stop();
    process.exitCode = 0;
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return `Remote worker started: ${configPath}`;
}
