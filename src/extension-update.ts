import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { ValidationError } from './errors.js';
import {
  inspectPublicGitHubExtension,
  listRemoteExtensionSources,
  preparePublicGitHubExtension,
  type PrepareExtensionRepositoryOptions,
} from './extension-repository.js';
import {
  linkExtension,
  listExtensions,
  loadExtensionManifest,
  runExtensionAction,
  type ExtensionAction,
  type ExtensionActionResult,
  type ExtensionManifest,
  type ExtensionUpdatePreparation,
  type LinkedExtension,
} from './extensions.js';

const execFileAsync = promisify(execFile);

export interface RepositoryExtensionUpdateInfo {
  id: string;
  displayName: string;
  currentVersion: string;
  currentCommitSha: string;
  targetCommitSha: string;
  repositoryUrl: string;
  updateAvailable: boolean;
}

export interface ExtensionUpdateRequest {
  id: string;
  displayName: string;
  prompt: string;
  displayMessage: string;
  info: RepositoryExtensionUpdateInfo;
}

export interface RepositoryExtensionUpdateResult {
  id: string;
  previousVersion: string;
  version: string;
  previousCommitSha: string;
  commitSha: string;
  running: boolean;
  healthy: boolean;
  doctorPassed: true;
  rolledBack: false;
}

interface UpdateDependencies {
  dataDir?: string;
  fetch?: typeof fetch;
  download?: PrepareExtensionRepositoryOptions['download'];
  extract?: PrepareExtensionRepositoryOptions['extract'];
  listLinkedExtensions?: () => Promise<LinkedExtension[]>;
  link?: typeof linkExtension;
  runAction?: (
    linked: LinkedExtension,
    action: ExtensionAction,
    options?: { workspace?: string; timeoutMs?: number }
  ) => Promise<ExtensionActionResult>;
  prepareDependencies?: (root: string, preparation: ExtensionUpdatePreparation) => Promise<void>;
}

function addedValues(before: string[] = [], after: string[] = []): string[] {
  const previous = new Set(before);
  return after.filter((value) => !previous.has(value));
}

function updateApprovalChanges(current: ExtensionManifest, candidate: ExtensionManifest): string[] {
  const currentCapabilities = new Map(current.capabilities.map((item) => [item.id, item]));
  const capabilityChanges = candidate.capabilities.flatMap((item) => {
    const previous = currentCapabilities.get(item.id);
    if (!previous) return [`capability added: ${item.id}`];
    return previous.protocol !== item.protocol || previous.healthPath !== item.healthPath
      ? [`capability changed: ${item.id}`]
      : [];
  });
  const agentBackendChanged =
    current.agentBackend?.id !== candidate.agentBackend?.id ||
    current.agentBackend?.displayName !== candidate.agentBackend?.displayName ||
    current.agentBackend?.capability !== candidate.agentBackend?.capability ||
    current.agentBackend?.path !== candidate.agentBackend?.path;
  const uiChanged =
    current.ui?.capability !== candidate.ui?.capability || current.ui?.path !== candidate.ui?.path;
  const currentPreparation = current.update?.prepare;
  const candidatePreparation = candidate.update?.prepare;
  const preparationChanged =
    currentPreparation?.command !== candidatePreparation?.command ||
    JSON.stringify(currentPreparation?.args ?? []) !==
      JSON.stringify(candidatePreparation?.args ?? []);
  return [
    ...addedValues(current.permissions, candidate.permissions).map(
      (permission) => `permission added: ${permission}`
    ),
    ...capabilityChanges,
    ...(current.entrypoint !== candidate.entrypoint
      ? [`entrypoint changed: ${current.entrypoint} -> ${candidate.entrypoint}`]
      : []),
    ...(agentBackendChanged
      ? [
          `agent backend changed: ${current.agentBackend?.id ?? 'none'} -> ${candidate.agentBackend?.id ?? 'none'}`,
        ]
      : []),
    ...(uiChanged ? ['extension UI mapping changed'] : []),
    ...(preparationChanged
      ? [
          `update preparation changed: ${JSON.stringify(currentPreparation ?? null)} -> ${JSON.stringify(candidatePreparation ?? null)}`,
        ]
      : []),
  ];
}

async function defaultPrepareDependencies(
  root: string,
  preparation: ExtensionUpdatePreparation
): Promise<void> {
  const command = preparation.command.includes('/')
    ? resolve(root, preparation.command)
    : preparation.command;
  await execFileAsync(command, preparation.args, {
    cwd: root,
    env: process.env,
    timeout: 10 * 60_000,
    maxBuffer: 1024 * 1024,
  });
}

export async function inspectExtensionUpdate(
  id: string,
  dependencies: UpdateDependencies = {}
): Promise<RepositoryExtensionUpdateInfo> {
  const linked = await (dependencies.listLinkedExtensions ?? listExtensions)();
  const installed = linked.find((item) => item.id === id);
  if (!installed) throw new ValidationError(`Unknown extension: ${id}`);
  const sources = await listRemoteExtensionSources(dependencies.dataDir);
  const source = sources.find(
    (item) => resolve(item.manifestPath) === resolve(installed.manifestPath)
  );
  if (!source) {
    throw new ValidationError(`${id} is not linked to a managed repository source`);
  }
  const manifest = await loadExtensionManifest(source.manifestPath, { requireEntrypoint: false });
  if (manifest.id !== id)
    throw new ValidationError(`Extension id changed for ${source.manifestPath}`);
  if (!manifest.update) {
    throw new ValidationError(`${id} does not declare an update preparation`);
  }
  const target = await inspectPublicGitHubExtension(source.repositoryUrl, {
    fetch: dependencies.fetch,
  });
  return {
    id,
    displayName: manifest.displayName,
    currentVersion: manifest.version,
    currentCommitSha: source.commitSha,
    targetCommitSha: target.commitSha,
    repositoryUrl: source.repositoryUrl,
    updateAvailable: source.commitSha !== target.commitSha,
  };
}

export async function createExtensionUpdateRequest(
  id: string,
  dependencies: UpdateDependencies = {}
): Promise<ExtensionUpdateRequest> {
  const info = await inspectExtensionUpdate(id, dependencies);
  if (!info.updateAvailable) {
    throw new ValidationError(`${info.displayName} is already up to date (${info.currentVersion})`);
  }
  return {
    id,
    displayName: info.displayName,
    displayMessage: `${info.displayName} の更新を確認します。`,
    info,
    prompt: [
      `${info.displayName}（extension id: ${id}）を確認済みcommitへ更新してください。`,
      `source repository: ${info.repositoryUrl}`,
      `current version: ${info.currentVersion}`,
      `current commit: ${info.currentCommitSha}`,
      `target commit: ${info.targetCommitSha}`,
      '',
      'ユーザーはExtensions画面で更新を明示的に選択済みです。最初に現在版と対象commitを短く説明してください。',
      `その後、任意のgit・shell更新は行わず、xangi tool extension_update --id ${id} --to ${info.targetCommitSha} を実行してください。`,
      '権限・capability・entrypoint・agent backend・UI mapping・更新準備commandの変更でtoolが停止した場合は、差分を示してユーザーへ確認し、明示承認後だけ --accept-manifest-changes true を付けて再実行してください。',
      'toolが失敗した場合はrollback結果を省略せず報告してください。成功時はversion・commit・doctor結果を短く報告してください。',
    ].join('\n'),
  };
}

export async function updateExtension(
  input: {
    id: string;
    expectedCommitSha: string;
    workspace: string;
    acceptManifestChanges?: boolean;
  },
  dependencies: UpdateDependencies = {}
): Promise<RepositoryExtensionUpdateResult> {
  if (!/^[a-f0-9]{40}$/.test(input.expectedCommitSha)) {
    throw new ValidationError('extension_update requires a full 40-character commit SHA');
  }
  const info = await inspectExtensionUpdate(input.id, dependencies);
  if (!info.updateAvailable) {
    throw new ValidationError(`${info.displayName} is already up to date`);
  }
  if (info.targetCommitSha !== input.expectedCommitSha) {
    throw new ValidationError(
      `Extension update target changed: expected ${input.expectedCommitSha}, got ${info.targetCommitSha}`
    );
  }

  const linkedItems = await (dependencies.listLinkedExtensions ?? listExtensions)();
  const linked = linkedItems.find((item) => item.id === input.id);
  if (!linked) throw new ValidationError(`Unknown extension: ${input.id}`);
  const currentManifest = await loadExtensionManifest(linked.manifestPath);
  const runAction = dependencies.runAction ?? runExtensionAction;
  const link = dependencies.link ?? linkExtension;
  const prepareDependencies = dependencies.prepareDependencies ?? defaultPrepareDependencies;
  const currentStatus = await runAction(linked, 'status', { workspace: input.workspace });
  const wasRunning = currentStatus.running === true;
  let candidateStarted = false;
  let activeLinked = linked;
  let finalStatus: ExtensionActionResult | undefined;

  const source = await preparePublicGitHubExtension(info.repositoryUrl, {
    dataDir: dependencies.dataDir,
    fetch: dependencies.fetch,
    download: dependencies.download,
    extract: dependencies.extract,
    expectedCommitSha: input.expectedCommitSha,
    expectedPreviousCommitSha: info.currentCommitSha,
    expectedExtensionId: input.id,
    beforeSwap: async ({ candidateManifest }) => {
      if (!candidateManifest.update) {
        throw new ValidationError(`${input.id} candidate does not declare an update preparation`);
      }
      const changes = updateApprovalChanges(currentManifest, candidateManifest);
      if (changes.length > 0 && !input.acceptManifestChanges) {
        throw new ValidationError(
          `Extension update requires approval for manifest changes:\n${changes.join('\n')}`
        );
      }
      if (wasRunning) await runAction(linked, 'stop', { workspace: input.workspace });
    },
    afterSwap: async ({ source: candidateSource }) => {
      const candidateManifest = await loadExtensionManifest(candidateSource.manifestPath, {
        requireEntrypoint: false,
      });
      if (!candidateManifest.update) {
        throw new Error(`${input.id} candidate does not declare an update preparation`);
      }
      await prepareDependencies(
        dirname(candidateSource.manifestPath),
        candidateManifest.update.prepare
      );
      await loadExtensionManifest(candidateSource.manifestPath);
      if (candidateManifest.id !== input.id) throw new Error('candidate extension id changed');
      activeLinked = await link(candidateSource.manifestPath, { autostart: linked.autostart });
      await runAction(activeLinked, 'start', { workspace: input.workspace, timeoutMs: 30_000 });
      candidateStarted = true;
      finalStatus = await runAction(activeLinked, 'doctor', {
        workspace: input.workspace,
        timeoutMs: 30_000,
      });
      if (!finalStatus.healthy) throw new Error(`${input.id} did not pass doctor after update`);
      if (!wasRunning) {
        await runAction(activeLinked, 'stop', { workspace: input.workspace });
        candidateStarted = false;
        finalStatus = { ...finalStatus, running: false, healthy: false };
      }
    },
    beforeRollback: async () => {
      if (candidateStarted) {
        await runAction(activeLinked, 'stop', { workspace: input.workspace });
        candidateStarted = false;
      }
    },
    afterRollback: async () => {
      activeLinked = await link(linked.manifestPath, { autostart: linked.autostart });
      if (wasRunning) {
        await runAction(activeLinked, 'start', { workspace: input.workspace, timeoutMs: 30_000 });
        const rollbackStatus = await runAction(activeLinked, 'doctor', {
          workspace: input.workspace,
          timeoutMs: 30_000,
        });
        if (!rollbackStatus.healthy) throw new Error(`${input.id} rollback did not pass doctor`);
      }
    },
  });

  const manifest = await loadExtensionManifest(source.manifestPath);
  return {
    id: input.id,
    previousVersion: currentManifest.version,
    version: manifest.version,
    previousCommitSha: info.currentCommitSha,
    commitSha: source.commitSha,
    running: finalStatus?.running === true,
    healthy: finalStatus?.healthy === true,
    doctorPassed: true,
    rolledBack: false,
  };
}
