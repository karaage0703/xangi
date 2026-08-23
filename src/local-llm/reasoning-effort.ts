export const LOCAL_LLM_REASONING_EFFORTS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

export type LocalLlmReasoningEffort = (typeof LOCAL_LLM_REASONING_EFFORTS)[number];
