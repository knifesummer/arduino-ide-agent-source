import React from '@theia/core/shared/react';
import {
  inject,
  injectable,
  postConstruct,
} from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { nls } from '@theia/core/lib/common/nls';
import {
  AiAgentConfig,
  AiAgentConfigInput,
  AiAgentService,
  AiAuthMode,
  AiChatMessage,
  AiModelInfo,
  AiOpenAiApi,
  AiReasoningLevel,
  AiToolCall,
  AiToolResult,
  AiConversation,
  AiReasoningKind,
} from '../../common/protocol/ai-agent-service';
import { AiAgentPanel, resolveConversationTitle } from './ai-agent-panel';
import { AiAgentClientImpl } from './ai-agent-client';
import { AI_ARDUINO_TOOLS, AiAgentTools } from './ai-agent-tools';
import { AI_AGENT_TEMPLATES, AiAgentTemplate } from './ai-agent-templates';
import { WorkspaceService } from '../theia/workspace/workspace-service';
import { buildAiAgentSystemPrompt } from '../../common/ai-agent-prompt';
import {
  AiAgentPromptSettings,
  PromptSettingsValue,
} from './ai-agent-prompt-settings';
import {
  detectArduinoAction,
  PendingArduinoAction,
  shouldAutoApplyArduinoCode,
} from '../../common/ai-agent-intent';

interface DisplayMessage {
  readonly role: 'user' | 'assistant' | 'system';
  content: string;
  reasoning?: string;
  reasoningKind?: AiReasoningKind;
}

type AiConversationRecord = AiConversation;

const AI_AGENT_HISTORY_KEY = 'arduino-ai-agent.conversations.v1';
const AI_AGENT_HISTORY_ENABLED_KEY = 'arduino-ai-agent.history-enabled';

function createSessionId(): string {
  const random = globalThis.crypto?.randomUUID?.();
  return random
    ? `ses_${random.replace(/-/g, '')}`
    : `ses_${Date.now().toString(16)}`;
}

const defaultConfig: AiAgentConfig = {
  provider: 'openai',
  openaiApi: 'chat-completions',
  authMode: 'bearer',
  baseUrl: 'https://opencode.ai/zen/go/v1',
  customHeaders: '',
  model: 'deepseek-v4.1-flash',
  approvalMode: 'confirm',
  reasoningLevel: 'auto',
  hasApiKey: false,
};

@injectable()
export class AiAgentWidget extends ReactWidget {
  static readonly ID = 'arduino-ai-agent-widget';
  static readonly LABEL = nls.localize('arduino/aiAgent/title', 'AI 助手');

  @inject(AiAgentService)
  protected readonly service: AiAgentService;

  @inject(AiAgentClientImpl)
  protected readonly client: AiAgentClientImpl;

  @inject(AiAgentTools)
  protected readonly tools: AiAgentTools;

  @inject(WorkspaceService)
  protected readonly workspaceService: WorkspaceService;

  @inject(FileService)
  protected readonly fileService: FileService;

  protected config: AiAgentConfig = { ...defaultConfig };
  protected apiKey = '';
  protected draft = '';
  protected status = '准备就绪';
  protected pending = false;
  protected showSettings = true;
  protected messages: DisplayMessage[] = [];
  protected checkpoint: string | undefined;
  protected models: AiModelInfo[] = [];
  protected loadingModels = false;
  protected codeApplying = false;
  protected composer: HTMLTextAreaElement | undefined;
  protected sessionId = createSessionId();
  protected conversationCreatedAt = Date.now();
  protected selectedPreset = 'custom';
  protected historyEnabled = true;
  protected historyRecords: AiConversationRecord[] = [];
  protected selectedHistoryId = '';
  protected pendingAction: PendingArduinoAction | undefined;
  protected autoCodeAuthorized = false;
  protected toolCallUsed = false;
  protected persistTimer: number | undefined;
  protected historyReady = false;
  protected toolRunning = false;
  protected configSaving = false;
  protected contextLabel = '当前草图';
  protected activeRequestId: string | undefined;
  protected requestAssistant: DisplayMessage | undefined;
  protected persistQueue: Promise<void> = Promise.resolve();

  constructor() {
    super();
    this.id = AiAgentWidget.ID;
    this.title.label = AiAgentWidget.LABEL;
    this.title.caption = 'Arduino AI Agent';
    this.title.iconClass = 'codicon codicon-sparkle';
    this.title.closable = true;
    this.addClass('arduino-ai-agent-widget');
  }

  @postConstruct()
  protected init(): void {
    void this.restoreHistory();
    this.client.toolHandler = (call) => this.executeArduinoTool(call);
    this.toDispose.push(
      this.client.onDidReceiveEvent((event) => {
        if (event.requestId && event.requestId !== this.activeRequestId) {
          return;
        }
        if (event.type === 'text_delta' || event.type === 'reasoning_delta') {
          if (!this.requestAssistant) {
            this.requestAssistant = { role: 'assistant', content: '' };
            this.messages.push(this.requestAssistant);
          }
          if (event.type === 'reasoning_delta') {
            this.requestAssistant.reasoning = (
              (this.requestAssistant.reasoning || '') + event.text
            ).slice(0, 500_000);
            this.requestAssistant.reasoningKind = event.kind;
            this.status = '正在思考…';
          } else {
            this.requestAssistant.content += event.text;
            this.status = '正在生成';
          }
        } else if (event.type === 'status') {
          this.status = event.message;
        } else if (event.type === 'round_start') {
          if (
            this.requestAssistant?.content ||
            this.requestAssistant?.reasoning
          ) {
            this.requestAssistant = undefined;
          }
          this.status = '模型正在处理 Arduino 操作…';
        } else if (event.type === 'done') {
          void this.finishRequest(Boolean(event.cancelled));
        } else if (event.type === 'error') {
          this.pending = false;
          this.pendingAction = undefined;
          this.status = event.message;
          const last = this.messages[this.messages.length - 1];
          if (last?.role === 'assistant' && !last.content) {
            last.content = `请求失败：${event.message}`;
          } else if (!last || last.role !== 'assistant') {
            this.messages.push({
              role: 'assistant',
              content: `请求失败：${event.message}`,
            });
          }
        }
        this.schedulePersistHistory();
        this.update();
      })
    );
    this.service.setClient(this.client);
    this.service
      .getConfig()
      .then((config) => {
        this.config = config;
        this.showSettings = !config.hasApiKey;
        this.update();
      })
      .catch((error) => {
        this.status = error instanceof Error ? error.message : String(error);
        this.update();
      });
    void this.tools
      .getContext()
      .then((context) => {
        this.contextLabel =
          [context.sketchName, context.boardName, context.port?.address]
            .filter(Boolean)
            .join(' · ') || '当前草图';
        this.update();
      })
      .catch(() => undefined);
  }

  protected render(): React.ReactNode {
    return (
      <AiAgentPanel
        messages={this.messages}
        conversations={this.historyRecords}
        activeId={this.selectedHistoryId}
        status={this.status}
        pending={this.pending}
        busy={
          this.pending ||
          this.codeApplying ||
          this.toolRunning ||
          this.configSaving
        }
        ready={this.historyReady}
        historyEnabled={this.historyEnabled}
        draft={this.draft}
        contextLabel={this.contextLabel}
        config={this.config}
        models={this.models}
        showSettings={this.showSettings}
        settings={this.renderSettings()}
        checkpoint={this.checkpoint}
        onSettings={(visible) => {
          this.showSettings = visible;
          this.update();
        }}
        onNew={() => this.newConversation()}
        onSelect={(id) => this.loadConversation(id)}
        onRename={(id, title) => {
          void this.renameConversation(id, title);
        }}
        onDelete={(id) => {
          void this.deleteConversation(id);
        }}
        onHistoryEnabled={(enabled) => {
          void this.setHistoryEnabled(enabled);
        }}
        onDraft={(value) => {
          this.draft = value;
          this.schedulePersistHistory();
          this.update();
        }}
        onSend={() => {
          void this.submit();
        }}
        onStop={() => {
          void this.service.cancel();
        }}
        onModel={(model) => {
          void this.saveQuickConfig({ model });
        }}
        onReasoning={(reasoningLevel) => {
          void this.saveQuickConfig({ reasoningLevel });
        }}
        onPermission={(approvalMode) => {
          void this.saveQuickConfig({ approvalMode });
        }}
        onTemplate={(id) => {
          const template = AI_AGENT_TEMPLATES.find((item) => item.id === id);
          if (template) this.applyTemplate(template);
        }}
        onTool={(name) => {
          if (name === 'upload' || name === 'burn_bootloader') {
            void this.runHardwareTool(
              name,
              name === 'upload' ? '上传草图' : '烧录引导程序'
            );
          } else {
            void this.runTool(name);
          }
        }}
        onApply={(code) => {
          if (code) {
            void this.applyCode(code);
          } else {
            void this.applyLatestAssistantCode(false);
          }
        }}
        onCheckpoint={() => {
          void this.createCheckpoint();
        }}
        onRollback={() => {
          void this.rollbackCheckpoint();
        }}
        composerRef={(node) => {
          this.composer = node || undefined;
        }}
      />
    );
  }

  protected renderSettings(): React.ReactNode {
    return (
      <fieldset className="arduino-ai-agent-settings" disabled={this.pending}>
        <legend className="arduino-ai-agent-section-title">连接设置</legend>
        <label>
          接口预设
          <select
            value={this.selectedPreset}
            onChange={(event) => this.applyPreset(event.target.value)}
          >
            <option value="custom">自定义（第三方 / 中转站）</option>
            <option value="openai">OpenAI 官方</option>
            <option value="opencode-go">OpenCode Go</option>
            <option value="anthropic">Anthropic 官方</option>
          </select>
          <span className="arduino-ai-agent-model-hint">
            预设只填写连接参数，API Key 仍由你自己提供
          </span>
        </label>
        <label>
          协议格式
          <select
            value={this.config.provider}
            onChange={(event) => {
              const provider = event.target.value as AiAgentConfig['provider'];
              this.config = {
                ...this.config,
                provider,
                authMode: provider === 'anthropic' ? 'x-api-key' : 'bearer',
                baseUrl:
                  provider === 'anthropic'
                    ? 'https://api.anthropic.com/v1'
                    : 'https://api.openai.com/v1',
                model:
                  provider === 'anthropic'
                    ? 'claude-3-5-sonnet-latest'
                    : 'gpt-4o-mini',
              };
              this.models = [];
              this.update();
            }}
          >
            <option value="openai">OpenAI 兼容接口</option>
            <option value="anthropic">Anthropic Messages</option>
          </select>
        </label>
        {this.config.provider === 'openai' ? (
          <label>
            OpenAI API 类型
            <select
              value={this.config.openaiApi}
              onChange={(event) => {
                this.config = {
                  ...this.config,
                  openaiApi: event.target.value as AiOpenAiApi,
                };
                this.update();
              }}
            >
              <option value="chat-completions">Chat Completions</option>
              <option value="responses">Responses API</option>
            </select>
          </label>
        ) : null}
        <label>
          API Key 认证方式
          <select
            value={this.config.authMode}
            onChange={(event) => {
              this.config = {
                ...this.config,
                authMode: event.target.value as AiAuthMode,
              };
              this.update();
            }}
          >
            <option value="bearer">Authorization: Bearer</option>
            <option value="x-api-key">x-api-key</option>
            <option value="api-key">api-key</option>
            <option value="none">不自动发送 API Key</option>
          </select>
        </label>
        <label>
          接口地址（Base URL）
          <input
            value={this.config.baseUrl}
            onChange={(event) => {
              this.config = { ...this.config, baseUrl: event.target.value };
              this.models = [];
              this.update();
            }}
            placeholder="https://api.openai.com/v1"
          />
          <span className="arduino-ai-agent-model-hint">
            支持官方、第三方提供商和中转站；可填写完整的 /v1 地址
          </span>
        </label>
        <label>
          模型
          <div className="arduino-ai-agent-model-row">
            <input
              list="arduino-ai-agent-model-options"
              value={this.config.model}
              onChange={(event) => {
                this.config = { ...this.config, model: event.target.value };
                this.update();
              }}
              placeholder="模型名称"
            />
            <button
              className="theia-button secondary"
              disabled={this.loadingModels}
              onClick={() => this.pullModels()}
              title="从当前 Base URL 拉取模型目录"
            >
              {this.loadingModels ? '拉取中…' : '拉取模型'}
            </button>
          </div>
          <datalist id="arduino-ai-agent-model-options">
            {this.models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label || model.ownedBy || model.id}
              </option>
            ))}
          </datalist>
          {this.models.length > 0 ? (
            <span className="arduino-ai-agent-model-hint">
              已发现 {this.models.length} 个模型，可直接选择
            </span>
          ) : null}
        </label>
        <label>
          额外请求头（可选）
          <textarea
            className="arduino-ai-agent-custom-headers"
            value={this.config.customHeaders}
            onChange={(event) => {
              this.config = {
                ...this.config,
                customHeaders: event.target.value,
              };
              this.update();
            }}
            placeholder={'每行一个，例如：\nX-Custom-Header: value'}
            rows={3}
          />
          <span className="arduino-ai-agent-model-hint">
            OpenCode Go 会自动发送稳定的 x-opencode-session，无需手填
          </span>
        </label>
        <label>
          API Key{' '}
          {this.config.hasApiKey ? (
            <span className="arduino-ai-agent-key-set">已保存</span>
          ) : null}
          <input
            type="password"
            value={this.apiKey}
            onChange={(event) => {
              this.apiKey = event.target.value;
              this.update();
            }}
            placeholder={
              this.config.hasApiKey
                ? '留空以保留已保存的 Key'
                : '只保存在系统凭据中'
            }
          />
        </label>
        <label>
          思考等级
          <select
            value={this.config.reasoningLevel}
            onChange={(event) => {
              this.config = {
                ...this.config,
                reasoningLevel: event.target.value as AiReasoningLevel,
              };
              this.update();
            }}
          >
            <option value="auto">自动（由模型决定）</option>
            <option value="fast">快速（low）</option>
            <option value="balanced">平衡（medium）</option>
            <option value="deep">深度（high）</option>
          </select>
        </label>
        <label className="agent-setting-checkbox">
          <input
            type="checkbox"
            checked={this.config.displayReasoning !== false}
            onChange={(event) => {
              this.config = {
                ...this.config,
                displayReasoning: event.target.checked,
              };
              this.update();
            }}
          />
          请求并显示思考内容
        </label>
        <span className="arduino-ai-agent-model-hint">
          展示接口返回的思考文本或推理摘要；模型不返回时只显示回答。开启可能增加耗时与用量。
        </span>
        <AiAgentPromptSettings
          systemPrompt={this.config.systemPrompt ?? null}
          includeIdeContext={this.config.includeIdeContext !== false}
          disabled={this.pending || this.configSaving}
          onSave={(value) => this.savePromptSettings(value)}
        />
        <label>
          Agent 权限
          <select
            value={this.config.approvalMode}
            onChange={(event) => {
              this.config = {
                ...this.config,
                approvalMode: event.target
                  .value as AiAgentConfig['approvalMode'],
              };
              this.update();
            }}
          >
            <option value="confirm">关键动作确认</option>
            <option value="auto">全自动执行</option>
          </select>
        </label>
        <div className="arduino-ai-agent-settings-actions">
          <button className="theia-button" onClick={() => this.saveConfig()}>
            保存配置
          </button>
          <button
            className="theia-button secondary"
            onClick={() => this.testConnection()}
          >
            测试连接
          </button>
        </div>
      </fieldset>
    );
  }

  protected async saveConfig(): Promise<boolean> {
    try {
      const input: AiAgentConfigInput = {
        provider: this.config.provider,
        baseUrl: this.config.baseUrl,
        model: this.config.model,
        openaiApi: this.config.openaiApi,
        authMode: this.config.authMode,
        customHeaders: this.config.customHeaders,
        approvalMode: this.config.approvalMode,
        reasoningLevel: this.config.reasoningLevel,
        systemPrompt: this.config.systemPrompt ?? null,
        includeIdeContext: this.config.includeIdeContext !== false,
        displayReasoning: this.config.displayReasoning !== false,
        ...(this.apiKey.trim() ? { apiKey: this.apiKey } : {}),
      };
      this.config = await this.service.saveConfig(input);
      this.apiKey = '';
      this.status = '配置已保存';
      this.update();
      return true;
    } catch (error) {
      this.status = error instanceof Error ? error.message : String(error);
      this.update();
      return false;
    }
  }

  protected applyTemplate(template: AiAgentTemplate): void {
    if (this.pending) {
      return;
    }
    this.draft = template.prompt;
    this.showSettings = false;
    this.status = `已载入模板：${template.title}`;
    this.update();
    window.requestAnimationFrame(() => {
      const composer =
        this.composer ||
        this.node.querySelector<HTMLTextAreaElement>(
          '.arduino-ai-agent-composer textarea'
        );
      if (composer) {
        composer.value = this.draft;
        composer.focus();
      }
    });
  }

  protected async savePromptSettings(
    value: PromptSettingsValue
  ): Promise<boolean> {
    this.configSaving = true;
    this.update();
    try {
      const saved = await this.service.getConfig();
      const updated = await this.service.saveConfig({ ...saved, ...value });
      this.config = {
        ...this.config,
        systemPrompt: updated.systemPrompt,
        includeIdeContext: updated.includeIdeContext,
      };
      this.status = '提示词已保存';
      return true;
    } catch (error) {
      this.status = formatError(error);
      return false;
    } finally {
      this.configSaving = false;
      this.update();
    }
  }

  protected async testConnection(): Promise<void> {
    if (!(await this.saveConfig())) {
      return;
    }
    this.status = '正在测试连接…';
    this.update();
    try {
      const result = await this.service.testConnection();
      this.status = `连接成功：${result}`;
    } catch (error) {
      this.status = error instanceof Error ? error.message : String(error);
    }
    this.update();
  }

  protected async pullModels(): Promise<void> {
    this.loadingModels = true;
    this.status = '正在拉取模型目录…';
    this.update();
    try {
      if (!(await this.saveConfig())) {
        return;
      }
      this.models = await this.service.listModels();
      if (!this.config.model.trim() && this.models[0]) {
        this.config = { ...this.config, model: this.models[0].id };
      }
      this.status = `已拉取 ${this.models.length} 个模型，请选择后保存配置`;
    } catch (error) {
      this.status = error instanceof Error ? error.message : String(error);
    } finally {
      this.loadingModels = false;
      this.update();
    }
  }

  protected async submit(): Promise<void> {
    const content = (this.composer?.value ?? this.draft).trim();
    if (
      !content ||
      this.pending ||
      this.codeApplying ||
      this.toolRunning ||
      !this.historyReady
    ) {
      return;
    }
    this.draft = '';
    if (this.composer) {
      this.composer.value = '';
    }
    this.pendingAction = detectArduinoAction(content);
    this.autoCodeAuthorized = shouldAutoApplyArduinoCode(content);
    this.toolCallUsed = false;
    this.activeRequestId = createSessionId();
    this.pending = true;
    this.status = '准备请求…';
    this.messages.push({ role: 'user', content });
    this.requestAssistant = { role: 'assistant', content: '' };
    this.messages.push(this.requestAssistant);
    this.schedulePersistHistory();
    this.update();
    const messages: AiChatMessage[] = this.messages
      .filter(
        (message): message is DisplayMessage & { role: 'user' | 'assistant' } =>
          message.role === 'user' || message.role === 'assistant'
      )
      .filter((message) => message.content.length > 0)
      .map((message) => ({ role: message.role, content: message.content }));
    try {
      this.status =
        this.config.includeIdeContext === false
          ? '准备发送消息…'
          : '正在读取工程和板卡上下文…';
      this.update();
      const system = await this.buildAgentSystemPrompt();
      await this.service.sendMessage({
        messages,
        sessionId: this.sessionId,
        requestId: this.activeRequestId,
        tools: AI_ARDUINO_TOOLS,
        system,
      });
    } catch (error) {
      this.pending = false;
      this.status = error instanceof Error ? error.message : String(error);
      this.update();
    }
  }

  protected async buildAgentSystemPrompt(): Promise<string> {
    if (this.config.includeIdeContext === false) {
      return buildAiAgentSystemPrompt({
        approvalMode: this.config.approvalMode,
        systemPrompt: this.config.systemPrompt,
        includeIdeContext: false,
      });
    }
    const [context, sketch] = await Promise.all([
      this.tools.getContext().catch((error) => {
        this.status = `板卡上下文读取失败：${formatError(error)}`;
        return undefined;
      }),
      this.tools.readSketch().catch((error) => {
        this.status = `草图读取失败，将继续请求：${formatError(error)}`;
        return undefined;
      }),
    ]);
    if (context) {
      this.contextLabel =
        [context.sketchName, context.boardName, context.port?.address]
          .filter(Boolean)
          .join(' · ') || '当前草图';
    }
    return buildAiAgentSystemPrompt({
      approvalMode: this.config.approvalMode,
      systemPrompt: this.config.systemPrompt,
      includeIdeContext: this.config.includeIdeContext,
      context,
      sketch,
      recentOperations: this.messages
        .filter((message) => message.role === 'system')
        .map((message) => message.content),
    });
  }

  protected async applyLatestAssistantCode(auto: boolean): Promise<void> {
    if (this.pending || this.codeApplying) {
      return;
    }
    const assistant = auto
      ? this.requestAssistant
      : [...this.messages]
          .reverse()
          .find(
            (message) => message.role === 'assistant' && message.content.trim()
          );
    const code = assistant
      ? extractArduinoCode(assistant.content, auto)
      : undefined;
    if (!code) {
      if (!auto) {
        this.status = '最近的 AI 回复没有找到完整 Arduino 代码块。';
        this.messages.push({
          role: 'system',
          content: '未应用代码：请先让 AI 输出完整的 ```cpp 代码块。',
        });
        this.update();
      }
      return;
    }
    this.codeApplying = true;
    this.status = auto ? '正在自动写入当前 .ino…' : '正在写入当前 .ino…';
    this.update();
    try {
      const result = await this.tools.writeSketch(code);
      this.messages.push({
        role: 'system',
        content: `代码已实时写入当前草图：${JSON.stringify(result)}`,
      });
      this.status = '代码已实时写入当前 .ino';
    } catch (error) {
      this.status = error instanceof Error ? error.message : String(error);
      this.messages.push({
        role: 'system',
        content: `写入失败：${this.status}`,
      });
    } finally {
      this.codeApplying = false;
      this.update();
    }
  }

  protected applyPreset(preset: string): void {
    this.selectedPreset = preset;
    if (preset === 'opencode-go') {
      this.config = {
        ...this.config,
        provider: 'openai',
        openaiApi: 'chat-completions',
        authMode: 'bearer',
        baseUrl: 'https://opencode.ai/zen/go/v1',
        model: 'deepseek-v4.1-flash',
      };
    } else if (preset === 'openai') {
      this.config = {
        ...this.config,
        provider: 'openai',
        openaiApi: 'chat-completions',
        authMode: 'bearer',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o-mini',
      };
    } else if (preset === 'anthropic') {
      this.config = {
        ...this.config,
        provider: 'anthropic',
        authMode: 'x-api-key',
        baseUrl: 'https://api.anthropic.com/v1',
        model: 'claude-3-5-sonnet-latest',
      };
    }
    this.models = [];
    this.update();
  }

  protected async finishRequest(cancelled: boolean): Promise<void> {
    this.pending = false;
    this.status = cancelled ? '已停止当前请求' : '已完成';
    if (cancelled) {
      this.pendingAction = undefined;
      this.autoCodeAuthorized = false;
      this.schedulePersistHistory();
      this.update();
      return;
    }
    if (
      this.config.approvalMode === 'auto' &&
      !this.toolCallUsed &&
      this.autoCodeAuthorized
    ) {
      await this.applyLatestAssistantCode(true);
    }
    const action = this.pendingAction;
    this.pendingAction = undefined;
    if (action && !this.toolCallUsed) {
      if (this.config.approvalMode === 'auto') {
        await this.runTool(action.name, action.input);
      } else {
        this.messages.push({
          role: 'system',
          content: `检测到“${action.label}”操作。当前权限模式要求你点击对应按钮确认执行。`,
        });
      }
    }
    this.toolCallUsed = false;
    this.autoCodeAuthorized = false;
    this.schedulePersistHistory();
    this.update();
  }

  protected async runHardwareTool(
    name: 'upload' | 'burn_bootloader',
    label: string
  ): Promise<void> {
    const message =
      name === 'burn_bootloader'
        ? '烧录引导程序会重写开发板引导区，确认继续吗？'
        : '确认编译并上传当前草图到已选择的开发板吗？';
    if (
      typeof window !== 'undefined' &&
      window.confirm &&
      !window.confirm(message)
    ) {
      return;
    }
    await this.runTool(name, {});
    this.status = `${label}操作结束`;
    this.update();
  }

  protected async runTool(
    name: string,
    input: Record<string, unknown> = {}
  ): Promise<void> {
    if (this.toolRunning || this.codeApplying || this.pending) return;
    this.toolRunning = true;
    this.status = `正在执行 ${name}…`;
    this.messages.push({ role: 'system', content: `工具：${name}` });
    this.update();
    try {
      const result = await this.tools.execute(name, input);
      this.messages.push({
        role: 'system',
        content: JSON.stringify(result, null, 2),
      });
      this.status = `${name} 完成`;
    } catch (error) {
      this.status = error instanceof Error ? error.message : String(error);
      this.messages.push({
        role: 'system',
        content: `工具失败：${this.status}`,
      });
    }
    this.schedulePersistHistory();
    this.toolRunning = false;
    this.update();
  }

  protected async executeArduinoTool(call: AiToolCall): Promise<AiToolResult> {
    if (!this.pending || call.requestId !== this.activeRequestId) {
      return { success: false, output: '请求已结束，未执行操作。' };
    }
    this.toolCallUsed = true;
    this.toolRunning = true;
    const destructive =
      call.name === 'upload' || call.name === 'burn_bootloader';
    if (
      destructive &&
      this.config.approvalMode === 'confirm' &&
      typeof window !== 'undefined' &&
      window.confirm &&
      !window.confirm(
        call.name === 'burn_bootloader'
          ? 'AI 请求烧录引导程序，会重写开发板引导区，确认继续吗？'
          : 'AI 请求上传当前草图到开发板，确认继续吗？'
      )
    ) {
      const output = '用户取消了这次硬件写入操作。';
      this.messages.push({ role: 'system', content: output });
      this.update();
      this.toolRunning = false;
      return { success: false, output };
    }
    this.status = `正在执行 ${call.name}…`;
    this.messages.push({
      role: 'system',
      content: `模型调用工具：${call.name}`,
    });
    this.update();
    try {
      const result = await this.tools.execute(call.name, call.input);
      const output = JSON.stringify(result, null, 2).slice(0, 240_000);
      this.messages.push({ role: 'system', content: output });
      this.status = `${call.name} 完成`;
      this.schedulePersistHistory();
      this.update();
      return { success: true, output };
    } catch (error) {
      const output = error instanceof Error ? error.message : String(error);
      this.messages.push({ role: 'system', content: `工具失败：${output}` });
      this.status = output;
      this.schedulePersistHistory();
      this.update();
      return { success: false, output };
    } finally {
      this.toolRunning = false;
      this.update();
    }
  }

  protected async restoreHistory(): Promise<void> {
    try {
      let history = await this.service.getConversationHistory();
      if (!history.conversations.length) {
        // Migrate readable legacy local history without removing the original.
        try {
          const raw = window.localStorage.getItem(AI_AGENT_HISTORY_KEY);
          const legacy = raw ? JSON.parse(raw) : undefined;
          if (Array.isArray(legacy)) {
            for (const record of legacy.filter(isConversationRecord)) {
              await this.service.saveConversation(record);
            }
            if (
              window.localStorage.getItem(AI_AGENT_HISTORY_ENABLED_KEY) ===
              'false'
            ) {
              await this.service.setHistoryEnabled(false);
            }
            history = await this.service.getConversationHistory();
          }
        } catch {
          // Migration failure must not replace a readable disk history.
        }
      }
      this.historyEnabled = history.enabled;
      this.historyRecords = [...history.conversations].sort(
        (a, b) => b.updatedAt - a.updatedAt
      );
      const active = this.historyRecords.find(
        (record) => record.id === history.activeId
      );
      if (active) {
        this.restoreConversation(active);
      }
    } catch (error) {
      this.historyEnabled = false;
      this.status = '历史读取失败：' + formatError(error);
    } finally {
      this.historyReady = true;
      this.update();
    }
  }

  protected persistHistory(): void {
    if (
      !this.historyEnabled ||
      !this.historyReady ||
      (!this.messages.length && !this.draft.trim())
    ) {
      return;
    }
    const now = Date.now();
    const id = this.selectedHistoryId || this.sessionId;
    const previous = this.historyRecords.find((record) => record.id === id);
    const firstUser = this.messages.find((message) => message.role === 'user');
    const record: AiConversationRecord = {
      id,
      title: resolveConversationTitle(previous?.title, firstUser?.content),
      createdAt: previous?.createdAt || this.conversationCreatedAt,
      updatedAt: now,
      draft: this.composer?.value ?? this.draft,
      messages: this.messages.map((message) => ({ ...message })),
    };
    this.selectedHistoryId = id;
    this.historyRecords = [
      record,
      ...this.historyRecords.filter((item) => item.id !== id),
    ];
    this.persistQueue = this.persistQueue
      .then(() => this.service.saveConversation(record))
      .catch((error) => {
        this.status = '历史保存失败：' + formatError(error);
        this.update();
      });
  }

  protected schedulePersistHistory(): void {
    if (!this.historyEnabled || !this.historyReady) return;
    if (this.persistTimer !== undefined) window.clearTimeout(this.persistTimer);
    this.persistTimer = window.setTimeout(
      () => {
        this.persistTimer = undefined;
        this.persistHistory();
        this.update();
      },
      this.pending ? 500 : 250
    );
  }

  protected async setHistoryEnabled(enabled: boolean): Promise<void> {
    if (!enabled) this.persistHistory();
    await this.persistQueue;
    try {
      await this.service.setHistoryEnabled(enabled);
      this.historyEnabled = enabled;
      if (enabled) this.persistHistory();
      this.status = enabled
        ? '对话将保存在本机'
        : '已停止保存新对话，已有历史仍可查看';
    } catch (error) {
      this.status = formatError(error);
    }
    this.update();
  }

  protected newConversation(): void {
    if (
      this.pending ||
      this.codeApplying ||
      this.toolRunning ||
      !this.historyReady
    )
      return;
    this.persistHistory();
    this.messages = [];
    this.selectedHistoryId = '';
    this.sessionId = createSessionId();
    this.conversationCreatedAt = Date.now();
    this.pendingAction = undefined;
    this.requestAssistant = undefined;
    this.activeRequestId = undefined;
    this.toolCallUsed = false;
    this.draft = '';
    if (this.composer) this.composer.value = '';
    this.status = '新对话';
    this.update();
  }

  protected restoreConversation(record: AiConversationRecord): void {
    this.messages = record.messages.map((message) => ({ ...message }));
    this.selectedHistoryId = record.id;
    this.sessionId = record.id;
    this.conversationCreatedAt = record.createdAt;
    this.pendingAction = undefined;
    this.requestAssistant = undefined;
    this.activeRequestId = undefined;
    this.toolCallUsed = false;
    this.draft = record.draft || '';
    if (this.composer) this.composer.value = this.draft;
  }

  protected loadConversation(id: string): void {
    if (
      this.pending ||
      this.codeApplying ||
      this.toolRunning ||
      !this.historyReady
    )
      return;
    const record = this.historyRecords.find((item) => item.id === id);
    if (!record) return;
    this.persistHistory();
    this.restoreConversation(record);
    this.status = '已打开：' + record.title;
    this.update();
  }

  protected async renameConversation(id: string, title: string): Promise<void> {
    const record = this.historyRecords.find((item) => item.id === id);
    if (!record || !title.trim()) return;
    await this.persistQueue;
    try {
      const renamed = { ...record, title: title.trim().slice(0, 80) };
      await this.service.saveConversation(renamed, false);
      this.historyRecords = this.historyRecords.map((item) =>
        item.id === id ? renamed : item
      );
      this.status = '对话已重命名';
    } catch (error) {
      this.status = formatError(error);
    }
    this.update();
  }

  protected async deleteConversation(id: string): Promise<void> {
    if (this.pending || this.codeApplying || this.toolRunning) return;
    if (this.persistTimer !== undefined) {
      window.clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    await this.persistQueue;
    try {
      await this.service.deleteConversation(id);
      this.historyRecords = this.historyRecords.filter(
        (item) => item.id !== id
      );
      if (this.selectedHistoryId === id) {
        this.messages = [];
        this.draft = '';
        this.selectedHistoryId = '';
        this.sessionId = createSessionId();
        this.conversationCreatedAt = Date.now();
        if (this.composer) this.composer.value = '';
      }
      this.status = '对话已删除';
    } catch (error) {
      this.status = formatError(error);
    }
    this.update();
  }

  protected async saveQuickConfig(
    changes: Partial<AiAgentConfig>
  ): Promise<void> {
    if (this.pending || this.configSaving) return;
    this.configSaving = true;
    const previous = this.config;
    this.config = { ...this.config, ...changes };
    this.update();
    if (!(await this.saveConfig())) this.config = previous;
    this.configSaving = false;
    this.update();
  }

  protected async applyCode(code: string): Promise<void> {
    if (this.pending || this.codeApplying || this.toolRunning) return;
    this.codeApplying = true;
    this.status = '正在应用代码…';
    this.update();
    try {
      const result = await this.tools.writeSketch(code);
      this.messages.push({
        role: 'system',
        content: '代码已写入草图：' + JSON.stringify(result),
      });
      this.status = '代码已应用到草图';
    } catch (error) {
      this.status = formatError(error);
    } finally {
      this.codeApplying = false;
      this.schedulePersistHistory();
      this.update();
    }
  }

  protected async createCheckpoint(): Promise<void> {
    const root = this.workspaceService.tryGetRoots()[0];
    if (!root) {
      this.status = '当前没有打开的工作区。';
      this.update();
      return;
    }
    try {
      const path = await this.fileService.fsPath(root.resource);
      if (!path) {
        throw new Error('无法解析当前工作区路径。');
      }
      this.checkpoint = await this.service.createGitCheckpoint(
        path,
        `AI Agent checkpoint ${new Date().toISOString()}`
      );
      this.status = `Git 快照已创建：${this.checkpoint.slice(0, 8)}`;
    } catch (error) {
      this.status = error instanceof Error ? error.message : String(error);
    }
    this.update();
  }

  protected async rollbackCheckpoint(): Promise<void> {
    const root = this.workspaceService.tryGetRoots()[0];
    if (!root || !this.checkpoint) {
      return;
    }
    try {
      const path = await this.fileService.fsPath(root.resource);
      if (!path) {
        throw new Error('无法解析当前工作区路径。');
      }
      await this.service.rollbackGitCheckpoint(path, this.checkpoint);
      this.status = `已回滚到 ${this.checkpoint.slice(0, 8)}`;
    } catch (error) {
      this.status = error instanceof Error ? error.message : String(error);
    }
    this.update();
  }

  override dispose(): void {
    if (this.persistTimer !== undefined) window.clearTimeout(this.persistTimer);
    this.persistHistory();
    if (this.pending) void this.service.cancel();
    this.client.toolHandler = undefined;
    super.dispose();
  }
}

function extractArduinoCode(
  content: string,
  completeOnly = false
): string | undefined {
  const matches = [
    ...content.matchAll(/```(?:cpp|c\+\+|arduino|c)?\s*\n([\s\S]*?)```/gi),
  ]
    .map((match) => match[1].trim())
    .filter(Boolean);
  const complete = matches.find(
    (code) =>
      /\bvoid\s+setup\s*\(/.test(code) && /\bvoid\s+loop\s*\(/.test(code)
  );
  return completeOnly
    ? complete
    : complete ||
        matches.find((code) =>
          /#include\s*[<"]|\bdigitalWrite\s*\(/.test(code)
        );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isConversationRecord(value: unknown): value is AiConversationRecord {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Partial<AiConversationRecord>;
  return (
    typeof record.id === 'string' &&
    typeof record.title === 'string' &&
    typeof record.createdAt === 'number' &&
    typeof record.updatedAt === 'number' &&
    Array.isArray(record.messages) &&
    record.messages.every(
      (message) =>
        Boolean(message) &&
        (message.role === 'user' ||
          message.role === 'assistant' ||
          message.role === 'system') &&
        typeof message.content === 'string'
    )
  );
}
