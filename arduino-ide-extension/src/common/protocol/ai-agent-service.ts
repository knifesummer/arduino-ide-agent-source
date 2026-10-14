import { JsonRpcServer } from '@theia/core/lib/common/messaging/proxy-factory';

export const AiAgentServicePath = '/services/ai-agent-service';
export const AiAgentService = Symbol('AiAgentService');

export type AiProvider = 'openai' | 'anthropic';
export type AiOpenAiApi = 'chat-completions' | 'responses';
export type AiAuthMode = 'bearer' | 'x-api-key' | 'api-key' | 'none';
export type AiApprovalMode = 'confirm' | 'auto';
export type AiReasoningLevel = 'auto' | 'fast' | 'balanced' | 'deep';
export type AiReasoningKind = 'text' | 'summary';

export interface AiAgentConfig {
  readonly provider: AiProvider;
  readonly openaiApi: AiOpenAiApi;
  readonly authMode: AiAuthMode;
  readonly baseUrl: string;
  readonly customHeaders: string;
  readonly model: string;
  readonly approvalMode: AiApprovalMode;
  readonly reasoningLevel: AiReasoningLevel;
  readonly hasApiKey: boolean;
  readonly systemPrompt?: string | null;
  readonly includeIdeContext?: boolean;
  readonly displayReasoning?: boolean;
}

export interface AiAgentConfigInput {
  readonly provider: AiProvider;
  readonly openaiApi: AiOpenAiApi;
  readonly authMode: AiAuthMode;
  readonly baseUrl: string;
  readonly customHeaders: string;
  readonly model: string;
  readonly approvalMode: AiApprovalMode;
  readonly reasoningLevel: AiReasoningLevel;
  readonly apiKey?: string;
  readonly systemPrompt?: string | null;
  readonly includeIdeContext?: boolean;
  readonly displayReasoning?: boolean;
}

/** A model exposed by the configured provider's model catalogue. */
export interface AiModelInfo {
  readonly id: string;
  readonly label?: string;
  readonly ownedBy?: string;
}

export interface AiChatMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

export interface AiChatRequest {
  readonly messages: AiChatMessage[];
  readonly system?: string;
  /** Stable identifier reused for all requests in one conversation. */
  readonly sessionId?: string;
  readonly requestId?: string;
  readonly tools?: AiToolDefinition[];
}

export interface AiToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface AiToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
  readonly requestId?: string;
}

export interface AiToolResult {
  readonly success: boolean;
  readonly output: string;
}

export interface AiConversationMessage {
  readonly role: 'user' | 'assistant' | 'system';
  readonly content: string;
  readonly reasoning?: string;
  readonly reasoningKind?: AiReasoningKind;
}

export interface AiConversation {
  readonly id: string;
  readonly title: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly messages: AiConversationMessage[];
  readonly draft?: string;
}

export interface AiConversationHistory {
  readonly enabled: boolean;
  readonly conversations: AiConversation[];
  readonly activeId?: string;
}

export type AiAgentEvent = (
  | { readonly type: 'status'; readonly message: string }
  | { readonly type: 'round_start' }
  | { readonly type: 'text_delta'; readonly text: string }
  | {
      readonly type: 'reasoning_delta';
      readonly text: string;
      readonly kind: AiReasoningKind;
    }
  | { readonly type: 'done'; readonly cancelled?: boolean }
  | {
      readonly type: 'error';
      readonly message: string;
      readonly retryable?: boolean;
      readonly status?: number;
    }
) & { readonly requestId?: string };

export interface AiAgentServiceClient {
  onAgentEvent(event: AiAgentEvent): void;
  executeArduinoTool(call: AiToolCall): Promise<AiToolResult>;
}

export interface AiGitStatus {
  readonly isRepository: boolean;
  readonly branch?: string;
  readonly head?: string;
  readonly dirty?: boolean;
}

export interface AiAgentService extends JsonRpcServer<AiAgentServiceClient> {
  getConfig(): Promise<AiAgentConfig>;
  saveConfig(config: AiAgentConfigInput): Promise<AiAgentConfig>;
  listModels(): Promise<AiModelInfo[]>;
  testConnection(): Promise<string>;
  sendMessage(request: AiChatRequest): Promise<void>;
  cancel(): Promise<void>;
  getConversationHistory(): Promise<AiConversationHistory>;
  saveConversation(
    conversation: AiConversation,
    activate?: boolean
  ): Promise<void>;
  setHistoryEnabled(enabled: boolean): Promise<void>;
  deleteConversation(id: string): Promise<void>;
  clearConversationHistory(): Promise<void>;
  getGitStatus(workspacePath: string): Promise<AiGitStatus>;
  createGitCheckpoint(workspacePath: string, message: string): Promise<string>;
  rollbackGitCheckpoint(
    workspacePath: string,
    reference: string
  ): Promise<void>;
  disposeClient(client: AiAgentServiceClient): void;
}
