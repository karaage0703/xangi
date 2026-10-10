import type { AgentRunner, RunOptions, RunResult } from './agent-runner.js';
import { buildAttachmentResult } from './file-utils.js';

export type AttachmentResult = ReturnType<typeof buildAttachmentResult>;

export interface AttachmentRecoveryResult {
  runResult: RunResult;
  attachmentResult: AttachmentResult;
  attempted: boolean;
}

function buildRecoveryPrompt(failure: NonNullable<AttachmentResult['attachmentFailure']>): string {
  const reason =
    failure === 'missing'
      ? 'The specified files do not exist.'
      : failure === 'outside_allowed'
        ? 'The specified existing files are outside the allowed attachment paths.'
        : 'Some files are missing and others are outside the allowed attachment paths.';
  return `[xangi ファイル添付エラー]
${reason}
Only existing files under WORKSPACE_PATH or /tmp can be attached.
This is a single recovery attempt. Do not repeat the original task or external actions. Only create or copy the files to send into an allowed path, or correct their paths, then return the final answer. Specify file attachments as MEDIA:/absolute/path.`;
}

/** 添付検証NGを同じセッションへ一度だけ返す。再帰しないため無限再試行しない。 */
export async function recoverAttachmentOnce(
  runner: AgentRunner,
  runResult: RunResult,
  runOptions: RunOptions,
  workspaceRoot?: string
): Promise<AttachmentRecoveryResult> {
  const first = buildAttachmentResult(runResult.result, runResult.attachments, workspaceRoot);
  if (!first.attachmentFailure) {
    return { runResult, attachmentResult: first, attempted: false };
  }

  try {
    const recovered = await runner.run(buildRecoveryPrompt(first.attachmentFailure), {
      ...runOptions,
      sessionId: runResult.sessionId,
    });
    return {
      runResult: recovered,
      attachmentResult: buildAttachmentResult(
        recovered.result,
        recovered.attachments,
        workspaceRoot
      ),
      attempted: true,
    };
  } catch (error) {
    console.error('[xangi] Attachment recovery failed:', error);
    return { runResult, attachmentResult: first, attempted: true };
  }
}
