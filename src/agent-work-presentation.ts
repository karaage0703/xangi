import { stripPromptMetadata, stripUserPromptHookContexts } from './session-title.js';

/** Presentation data stays separate from the full execution prompt and its history. */
export interface AgentWorkPresentation {
  assignment: string;
  teamName?: string;
}

export function formatAgentWork(
  task: string,
  agentName: string,
  presentation?: AgentWorkPresentation
): { title: string; text: string } {
  const assignment = stripUserPromptHookContexts(
    stripPromptMetadata(presentation?.assignment ?? task)
  ).trim();
  const firstSentence = (assignment.split(/[\n。！？]/u)[0] || '依頼された作業')
    .replace(/^\s*(?:#{1,6}\s+|[-*]\s+|\d+[.)]\s+)/u, '')
    .replace(/https?:\/\/\S+/gu, '')
    .replace(/(?:を担当|してください|して下さい|をお願いします|を調べて|してほしい)[。\s]*$/u, '')
    .replace(/\s+/gu, ' ')
    .trim();
  const chars = Array.from(firstSentence || '依頼された作業');
  const title = chars.length > 36 ? `${chars.slice(0, 35).join('')}…` : chars.join('');
  // Keep code/structured multiline requests intact; prose becomes one sentence per bullet.
  const details = assignment.includes('```')
    ? assignment
    : assignment
        .split(/\r?\n|(?<=[。！？])\s*/u)
        .map((line) => line.trim().replace(/^(?:[-*]\s+|\d+[.)]\s+)/u, ''))
        .filter(Boolean)
        .map((line) => `- ${line}`)
        .join('\n');
  const team = presentation?.teamName ? ` ｜ チーム: ${presentation.teamName}` : '';
  return {
    title,
    text: `**${title}**\n担当: ${agentName}${team}\n\n**今回の作業**\n${details || '- 依頼された作業を進めます。'}\n\nこのスレッドに返信すると、追加指示できます。作業中の指示は現在の応答後に反映します。`,
  };
}
