import {
  linkExtension,
  listExtensions,
  unlinkExtension,
  type ExtensionAction,
} from '../extensions.js';
import { defaultExtensionsFile } from '../extensions.js';
import { runToolCommand } from './tool-command.js';

const ACTIONS = new Set<ExtensionAction>([
  'start',
  'stop',
  'restart',
  'status',
  'doctor',
  'update',
]);

export async function extensionCmd(
  action: string,
  positionals: string[],
  flags: Record<string, string | boolean>
): Promise<string> {
  if (action === 'link') {
    const manifestPath = positionals[0];
    if (!manifestPath) throw new Error('xangi extension link requires a manifest path');
    const linked = await linkExtension(manifestPath, { autostart: flags.autostart !== 'false' });
    return `Linked ${linked.id} (${linked.autostart ? 'autostart' : 'manual start'})`;
  }
  if (action === 'unlink') {
    const id = positionals[0];
    if (!id) throw new Error('xangi extension unlink requires an id');
    return (await unlinkExtension(id)) ? `Unlinked ${id}` : `${id} is not linked`;
  }
  const linked = await listExtensions();
  if (action === 'list') {
    return linked.length
      ? linked
          .map(
            (item) =>
              `${item.id}\t${item.enabled ? 'enabled' : 'disabled'}\t${item.autostart ? 'autostart' : 'manual'}\t${item.manifestPath}`
          )
          .join('\n')
      : `No extensions linked (${defaultExtensionsFile()})`;
  }
  if (!ACTIONS.has(action as ExtensionAction)) {
    throw new Error(
      'Usage: xangi extension <link|unlink|list|start|stop|restart|status|doctor|update>'
    );
  }
  if (!process.env.XANGI_TOOL_SERVER) {
    throw new Error(
      `xangi extension ${action} must target a running xangi instance (XANGI_TOOL_SERVER is not set)`
    );
  }
  if (action !== 'update') {
    return runToolCommand([
      'extension_runtime',
      '--action',
      action,
      ...(positionals[0] ? ['--id', positionals[0]] : []),
    ]);
  }
  const id = positionals[0];
  const target = typeof flags.to === 'string' ? flags.to : undefined;
  if (!id || !target) {
    throw new Error('xangi extension update requires an id and --to <40-character-commit-sha>');
  }
  return runToolCommand([
    'extension_update',
    '--id',
    id,
    '--to',
    target,
    ...(flags['accept-manifest-changes'] === 'true' || flags['accept-manifest-changes'] === true
      ? ['--accept-manifest-changes', 'true']
      : []),
  ]);
}
