export interface LLMImageContent {
  /** base64-encoded image data (without data URI prefix) */
  base64: string;
  /** MIME type (e.g., "image/jpeg", "image/png") */
  mimeType: string;
}

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: LLMToolCall[];
  toolCallId?: string;
  /** Attached images for multimodal messages */
  images?: LLMImageContent[];
}

export interface LLMToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface LLMTool {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, { type: string; description?: string; enum?: string[] }>;
    required?: string[];
  };
}

/**
 * OpenAI 互換 API の tool_choice。
 * - 'auto' (default): tool を呼ぶかは LLM が判断
 * - 'none': tool 呼ばずテキストで応答（最終応答などで指定）
 * - 'required': 必ず tool を呼ぶ
 * - { type: 'function', function: { name } }: 特定 tool を強制
 */
export type LLMToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | { type: 'function'; function: { name: string } };

export interface LLMChatOptions {
  tools?: LLMTool[];
  toolChoice?: LLMToolChoice;
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
  signal?: AbortSignal;
}

export interface LLMChatResponse {
  content: string;
  toolCalls?: LLMToolCall[];
  finishReason: 'stop' | 'tool_calls' | 'length';
}

export interface ToolContext {
  workspace: string;
  userId?: string;
  channelId?: string;
  /**
   * tool_search 経由で deferred tool をアクティブ化するためのコールバック。
   * 呼ぶと指定 tool の schema が次ターン以降の LLM リクエストに含まれる。
   */
  activateTools?: (names: string[]) => void;
  /**
   * tool-trajectory-logger に tool_search 結果を記録するためのフック。
   * tool_search ハンドラから候補一覧と activate 結果を流し込む。
   * runner.ts でロガー有効時のみセットされる (無効時は undefined)。
   */
  trajectoryLogToolSearch?: (event: {
    query: string;
    candidates: Array<{ name: string; type: 'tool' | 'skill'; score: number }>;
    activated_tools: string[];
    activated_skills?: string[];
  }) => void;
}

/** tool_search 用カタログエントリ（name + description のみ、schema は含まない） */
export interface ToolCatalogEntry {
  name: string;
  description: string;
}

export interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
}

export interface ToolHandler {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, { type: string; description?: string; enum?: string[] }>;
    required?: string[];
  };
  execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}
