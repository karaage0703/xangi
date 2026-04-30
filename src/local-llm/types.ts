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

export interface LLMChatOptions {
  tools?: LLMTool[];
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
  signal?: AbortSignal;
  /** Discord channel id — claude バックエンドの session ルックアップに使う。Hayabusa は無視 */
  channelId?: string;
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
