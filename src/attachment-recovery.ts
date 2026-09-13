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
      ? '指定したファイルが存在しません。'
      : failure === 'outside_allowed'
        ? '指定した実在ファイルが添付許可パスの外にあります。'
        : '存在しないファイルと、添付許可パス外のファイルが含まれています。';
  return `[xangi ファイル添付エラー]
${reason}
添付できるのは WORKSPACE_PATH 配下または /tmp にある実在ファイルです。
これは1回限りの修正機会です。元の依頼や外部操作をやり直さず、送付するファイルだけを許可パスへ作成・コピーするか正しいパスへ直し、最終回答を返してください。ファイル本体は MEDIA:/absolute/path で指定してください。`;
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
