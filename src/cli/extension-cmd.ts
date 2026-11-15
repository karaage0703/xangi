import { resolve } from 'node:path';
import type { ExtensionAction } from '../extensions.js';
import { executeExtensionRegistryCommand } from '../extension-registry-command.js';
import { runToolCommand } from './tool-command.js';
import { EXTENSION_CREATE_HELP, extensionDevelopmentPrompt } from '../extension-development.js';

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
  xangi extension create             Print the AI development guide and template location
  xangi extension list
  xangi extension <start|stop|restart> <ID>
  xangi extension <start|stop|restart> --all
  xangi extension <status|doctor> [ID]
  xangi extension link <MANIFEST>
  xangi extension unlink <ID>
  xangi extension update <ID> --to <COMMIT_SHA>

Options:
  --help, -h  Show this help without running an action
  --all       Explicitly select every linked extension for start, stop, or restart

With XANGI_TOOL_SERVER, all registry and runtime operations target that xangi instance.
Without it, link/unlink/list use the local registry for offline setup only.
Connection failures never fall back to a workspace registry.`;

export async function extensionCmd(
  action: string,
  positionals: string[],
  flags: Record<string, string | boolean>
): Promise<string> {
  if (flags.help === true || flags.help === 'true') {
    return action === 'create' ? EXTENSION_CREATE_HELP : EXTENSION_HELP;
  }
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
  if (action === 'create') {
    if (positionals.length || Object.keys(flags).some((key) => !['help', 'h'].includes(key))) {
      throw new Error(
        'extension create only prints guidance; use --help for usage. It accepts no destination or feature flags.'
      );
    }
    return extensionDevelopmentPrompt();
  }
  if (['link', 'unlink', 'list'].includes(action)) {
    const registryFlags: Record<string, string> = { action };
    if (action === 'link') {
      if (!positionals[0]) throw new Error('xangi extension link requires a manifest path');
      // Resolve relative paths in the caller's cwd, not in the host's workspace.
      registryFlags.manifest = resolve(positionals[0]);
      registryFlags.autostart = String(flags.autostart ?? 'true');
    } else if (action === 'unlink') {
      if (!positionals[0]) throw new Error('xangi extension unlink requires an id');
      registryFlags.id = positionals[0];
    }
    if (process.env.XANGI_TOOL_SERVER) {
      return runToolCommand([
        'extension_registry',
        ...Object.entries(registryFlags).flatMap(([key, value]) => [`--${key}`, value]),
      ]);
    }
    return executeExtensionRegistryCommand(registryFlags);
  }
  if (!ACTIONS.has(action as ExtensionAction)) {
    throw new Error(
      'Usage: xangi extension <create|link|unlink|list|start|stop|restart|status|doctor|update>'
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
