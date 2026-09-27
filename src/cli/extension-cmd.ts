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
const MUTATING_ACTIONS = new Set(['start', 'stop', 'restart']);
const EXTENSION_HELP = `Usage:
  xangi extension list
  xangi extension <start|stop|restart> <ID>
  xangi extension <start|stop|restart> --all
  xangi extension <status|doctor> [ID]
  xangi extension link <MANIFEST>
  xangi extension unlink <ID>
  xangi extension update <ID> --to <COMMIT_SHA>

Options:
  --help, -h  Show this help without running an action
  --all       Explicitly select every linked extension for start, stop, or restart`;

export async function extensionCmd(
  action: string,
  positionals: string[],
  flags: Record<string, string | boolean>
): Promise<string> {
  if (flags.help === true || flags.help === 'true') return EXTENSION_HELP;
  const all = flags.all === true || flags.all === 'true';
  if (all && positionals[0]) {
    throw new Error('xangi extension accepts either an ID or --all, not both');
  }
  if (all && !['start', 'stop', 'restart', 'status', 'doctor'].includes(action)) {
    throw new Error(`xangi extension ${action} does not support --all`);
  }
  if (MUTATING_ACTIONS.has(action) && !positionals[0] && !all) {
    throw new Error(`xangi extension ${action} requires an ID or explicit --all`);
  }
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
      ...(all ? ['--all', 'true'] : []),
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
