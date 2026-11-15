import { isAbsolute } from 'node:path';
import { ValidationError } from './errors.js';
import {
  defaultExtensionsFile,
  linkExtension,
  listExtensions,
  unlinkExtension,
} from './extensions.js';

/** Runs in the owning xangi process, or locally during offline setup. */
export async function executeExtensionRegistryCommand(
  flags: Record<string, string>
): Promise<string> {
  switch (flags.action) {
    case 'list': {
      const linked = await listExtensions();
      return linked.length
        ? linked
            .map(
              (item) =>
                `${item.id}\t${item.enabled ? 'enabled' : 'disabled'}\t${item.autostart ? 'autostart' : 'manual'}\t${item.manifestPath}`
            )
            .join('\n')
        : `No extensions linked (${defaultExtensionsFile()})`;
    }
    case 'link': {
      if (!flags.manifest || !isAbsolute(flags.manifest)) {
        throw new ValidationError('extension_registry link requires an absolute --manifest path');
      }
      if (flags.autostart !== undefined && !['true', 'false'].includes(flags.autostart)) {
        throw new ValidationError('extension_registry --autostart must be true or false');
      }
      const linked = await linkExtension(flags.manifest, {
        autostart: flags.autostart !== 'false',
      });
      return `Linked ${linked.id} (${linked.autostart ? 'autostart' : 'manual start'})`;
    }
    case 'unlink': {
      if (!flags.id) throw new ValidationError('extension_registry unlink requires --id');
      return (await unlinkExtension(flags.id))
        ? `Unlinked ${flags.id}`
        : `${flags.id} is not linked`;
    }
    default:
      throw new ValidationError('extension_registry requires --action list, link, or unlink');
  }
}
