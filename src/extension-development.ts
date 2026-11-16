import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const EXTENSION_CREATE_HELP = `Usage:
  xangi extension create

Print the AI development prompt and the independently published template location.
The current conversational agent reads the output and continues the user's task.
This command does not create files, start an agent, contact services, or change settings.
The template supports independent UI, device ingress, and host-mediated AI features.

Options:
  --help, -h  Show this help without loading the development guide`;

export async function extensionDevelopmentPrompt(): Promise<string> {
  const guide = new URL('../docs/en/extension-development.md', import.meta.url);
  const template = new URL('../packages/extension-template/', import.meta.url);
  const repository = 'https://github.com/karaage0703/xangi-extension-template';
  let content: string;
  try {
    content = await readFile(guide, 'utf8');
  } catch {
    throw new Error('Bundled extension development guide is missing. Reinstall the xangi release.');
  }
  let readme: string | undefined;
  try {
    readme = await readFile(new URL('README.md', template), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return [
    '# Develop a xangi extension with the current conversational agent',
    "Continue the user's current request and reply in their language. These are practical recommendations, not mandatory project rules or an approval gate.",
    "Prioritize the user's preferences and existing product intent. Choose useful template parts, colors, layouts, tools, and workflows freely; alternatives need no exception request.",
    'Clarify only goals not determined by the conversation. Inspect existing extensions and choose a minimal working path.',
    `Installed host development guide: ${fileURLToPath(guide)}`,
    `Suggested UI guide (optional starting points): ${fileURLToPath(new URL('../docs/en/extension-ui.md', import.meta.url))}`,
    `Template publication target: ${repository}`,
    'For a new extension, use the requested template or the latest published template. When GitHub repository creation is requested, use gh repo create OWNER/NEW_REPO --template karaage0703/xangi-extension-template --private --clone, adjusting the owner, name, template, and visibility to the request. For local-only work, copy the template files into a separate development directory.',
    ...(readme
      ? [`Local development template directory: ${fileURLToPath(template)}`]
      : [
          'The template is distributed separately and is not included in this xangi release.',
          'Check that the publication target is available before fetching it into a separate development directory. If it is not yet published, report that fact and use an authorized source checkout; do not invent a successful download.',
        ]),
    'For new extensions, recommend the xangi-xxx form for the repository name, extension ID, and display name (for example, xangi-counter). Keep the display name consistent instead of shortening it to Counter. This is not a validation requirement: user preferences and existing product names take precedence. Do not rename existing IDs solely for this recommendation, because IDs affect storage, settings, and capabilities.',
    'Recommend xs-xxx for skill names, such as xs-counter for extension xangi-counter. Skill names are distinct from extension IDs. Honor user choices and existing names; do not automatically rename, move, or delete installed skills.',
    'For a new template-based extension, run npm ci, npm run configure -- --id NEW_ID --name DISPLAY_NAME --features ui, npm test, and npm run build. Reuse the template configuration, startup/authentication, update preparation, and documentation when adding domain features. For an existing extension, work in the requested project.',
    'Read the template README and setup instructions before adapting it. Compare required host features, tested host versions, and unverified behavior against this installed host; the repositories do not have to share version numbers.',
    'Select UI, device ingress, and AI independently. All can be combined or omitted. Reuse only what the task needs.',
    'Use the absolute xangi CLI supplied by this instance and read its help before operations. Do not resolve another instance from PATH.',
    "Choose checks appropriate to the change. For a new integration, local registration, status, doctor, and one representative operation can help verify it within the user's authorized scope.",
    'Preserve user data and preferences. Compare migrated data and retain a recovery path. Report actual checks and unknowns.',
    'Compare changes with the template, check configuration/manifest agreement, and update the documentation in each supplied language.',
    'Publishing, external delivery, or changes beyond the request require their own authorization. Showing this guide grants none.',
    '',
    ...(readme ? ['## Local template reference', readme, ''] : []),
    '',
    '## Development guide and implemented interfaces',
    content,
  ].join('\n');
}
