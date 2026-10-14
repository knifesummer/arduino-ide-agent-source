import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { inject, injectable } from '@theia/core/shared/inversify';
import { FileUri } from '@theia/core/lib/node/file-uri';
import {
  AiAgentConfig,
  AiAgentConfigInput,
  AiAgentEvent,
  AiAgentService,
  AiAgentServiceClient,
  AiGitStatus,
  AiChatRequest,
  AiModelInfo,
  AiOpenAiApi,
  AiProvider,
  AiReasoningLevel,
  AiAuthMode,
  AiConversation,
  AiConversationHistory,
  AiToolResult,
} from '../common/protocol/ai-agent-service';
import { AiAgentHistoryStore } from './ai-agent-history';
import { redactAiDiagnostic } from './ai-agent-privacy';
import {
  textOnlySystemPrompt,
  normalizePromptSettings,
} from '../common/ai-agent-prompt';
import {
  reasoningOptions,
  removeReasoningOptions,
} from '../common/ai-agent-reasoning';
import {
  AiProviderCollector,
  appendToolResults,
  consumeAiResponse,
  initialInput,
  toolDefinitions,
} from './ai-agent-provider';
import { Keychain } from './auth/keychain';
import { ConfigDirUriProvider } from './theia/env-variables/env-variables-server';

const DEFAULT_CONFIG: StoredConfig = {
  provider: 'openai',
  openaiApi: 'chat-completions',
  authMode: 'bearer',
  baseUrl: 'https://opencode.ai/zen/go/v1',
  customHeaders: '',
  model: 'deepseek-v4.1-flash',
  approvalMode: 'confirm',
  reasoningLevel: 'auto',
  systemPrompt: null,
  includeIdeContext: true,
  displayReasoning: true,
};
const execFileAsync = promisify(execFile);

interface StoredConfig {
  provider: AiProvider;
  openaiApi: AiOpenAiApi;
  authMode: AiAuthMode;
  baseUrl: string;
  customHeaders: string;
  model: string;
  approvalMode: AiAgentConfig['approvalMode'];
  reasoningLevel: AiReasoningLevel;
  systemPrompt: string | null;
  includeIdeContext: boolean;
  displayReasoning: boolean;
}

@injectable()
export class AiAgentServiceImpl implements AiAgentService {
  private readonly clients = new Set<AiAgentServiceClient>();
  @inject(ConfigDirUriProvider)
  private readonly configDirUriProvider: ConfigDirUriProvider;
  @inject(AiAgentHistoryStore)
  private readonly history: AiAgentHistoryStore;
  private readonly keychain = new Keychain({
    credentialsSection: 'arduino-ide-ai-agent',
    account: 'default',
  });
  private config: StoredConfig = { ...DEFAULT_CONFIG };
  private loaded = false;
  private loading: Promise<void> | undefined;
  private configQueue: Promise<unknown> = Promise.resolve();
  private activeAbortController: AbortController | undefined;
  private readonly connectionSessionId = `arduino-${randomUUID()}`;

  private get configPath(): string {
    return join(
      FileUri.fsPath(this.configDirUriProvider.configDirUri()),
      'ai-agent.json'
    );
  }

  async getConfig(): Promise<AiAgentConfig> {
    await this.loadConfig();
    return this.publicConfig();
  }

  saveConfig(input: AiAgentConfigInput): Promise<AiAgentConfig> {
    const task = this.configQueue
      .catch(() => undefined)
      .then(() => this.writeConfig(input));
    this.configQueue = task;
    return task;
  }

  private async writeConfig(input: AiAgentConfigInput): Promise<AiAgentConfig> {
    const baseUrl = normalizeBaseUrl(input.baseUrl);
    if (!/^https?:\/\//i.test(baseUrl) || !hasHttpHostname(baseUrl)) {
      throw new Error('Base URL 必须以 http:// 或 https:// 开头。');
    }
    const url = new URL(baseUrl);
    if (url.username || url.password) {
      throw new Error(
        'Base URL 不能包含账号或密码，请使用 API Key 或额外请求头。'
      );
    }
    if (
      !['openai', 'anthropic'].includes(input.provider) ||
      !['confirm', 'auto'].includes(input.approvalMode)
    ) {
      throw new Error('服务商或权限模式无效，配置未保存。');
    }
    if (!input.model.trim()) {
      throw new Error('模型名称不能为空。');
    }
    await this.loadConfig();
    const customHeaders = normalizeCustomHeaders(input.customHeaders);
    const promptSettings = normalizePromptSettings(input, this.config);
    const model = input.model.trim();
    const nextConfig: StoredConfig = {
      provider: input.provider,
      openaiApi: normalizeOpenAiApiForConfig(input.openaiApi, baseUrl, model),
      authMode: normalizeAuthMode(input.authMode, input.provider),
      baseUrl,
      customHeaders,
      model,
      approvalMode: input.approvalMode,
      reasoningLevel: normalizeReasoningLevel(input.reasoningLevel),
      ...promptSettings,
    };
    await fs.mkdir(dirname(this.configPath), { recursive: true });
    const temporaryPath = this.configPath + `.${randomUUID()}.tmp`;
    const newKey = input.apiKey?.trim();
    const previousKey = newKey ? await this.getApiKey() : undefined;
    let changedKey = false;
    try {
      await fs.writeFile(temporaryPath, JSON.stringify(nextConfig, null, 2), {
        encoding: 'utf8',
        mode: 0o600,
      });
      if (newKey) {
        if (!(await this.keychain.storeCredentials(newKey))) {
          throw new Error('系统凭据存储不可用，API Key 和配置均未保存。');
        }
        changedKey = true;
      }
      await fs.rename(temporaryPath, this.configPath);
      this.config = nextConfig;
    } catch (error) {
      if (changedKey) {
        const restored = previousKey
          ? await this.keychain.storeCredentials(previousKey)
          : await this.keychain.deleteCredentials();
        if (!restored)
          throw new Error(
            '配置文件未保存，凭据回滚失败，请重新保存原 API Key。'
          );
      }
      throw new Error(this.safeDiagnostic(error, newKey));
    } finally {
      await fs.unlink(temporaryPath).catch(() => undefined);
    }
    return this.publicConfig();
  }

  async testConnection(): Promise<string> {
    await this.loadConfig();
    const apiKey = await this.getApiKey();
    if (!apiKey && this.config.authMode !== 'none') {
      throw new Error('请先填写 API Key。');
    }
    const response = await this.request(
      {
        messages: [{ role: 'user', content: 'Reply with OK only.' }],
        system: 'You are a connection test. Reply with OK only.',
      },
      apiKey || '',
      false
    ).catch((error) => {
      throw new Error(this.safeDiagnostic(error, apiKey));
    });
    return response ? this.safeDiagnostic(response, apiKey) : '连接成功';
  }

  async listModels(): Promise<AiModelInfo[]> {
    await this.loadConfig();
    const apiKey = await this.getApiKey();
    if (!apiKey && this.config.authMode !== 'none') {
      throw new Error('请先填写 API Key。');
    }
    const headers = this.buildHeaders(apiKey || '', 'model-list');
    const response = await fetch(modelsEndpointFor(this.config.baseUrl), {
      method: 'GET',
      headers,
    }).catch((error) => {
      throw new Error(this.safeDiagnostic(error, apiKey));
    });
    if (!response.ok) {
      throw new AiRequestError(
        this.safeDiagnostic(await formatHttpError(response), apiKey),
        response.status
      );
    }
    const payload = (await response.json()) as unknown;
    const models = parseModelList(payload);
    if (!models.length) {
      throw new Error('模型接口没有返回可用模型。');
    }
    return models;
  }

  async sendMessage(request: AiChatRequest): Promise<void> {
    await this.loadConfig();
    const clients = Array.from(this.clients);
    const connection = clients[clients.length - 1];
    if (!connection) {
      throw new Error('AI Agent 前端连接尚未建立。');
    }
    const client: AiAgentServiceClient = {
      onAgentEvent: (event) =>
        connection.onAgentEvent({ ...event, requestId: request.requestId }),
      executeArduinoTool: (call) =>
        connection.executeArduinoTool({
          ...call,
          requestId: request.requestId,
        }),
    };
    if (this.activeAbortController) {
      throw new Error('当前请求还在执行，请等待完成或停止。');
    }
    const apiKey = await this.getApiKey();
    if (!apiKey && this.config.authMode !== 'none') {
      this.emit(client, { type: 'error', message: '请先填写 API Key。' });
      return;
    }
    const controller = new AbortController();
    this.activeAbortController = controller;
    this.emit(client, {
      type: 'status',
      message: `正在连接 ${
        this.config.provider === 'openai'
          ? 'OpenAI 兼容接口'
          : 'Anthropic Messages'
      }…`,
    });
    try {
      await this.runAgent(request, apiKey || '', client, controller.signal);
      this.emit(client, { type: 'done' });
    } catch (error) {
      if (controller.signal.aborted) {
        this.emit(client, { type: 'status', message: '已停止当前请求。' });
        this.emit(client, { type: 'done', cancelled: true });
        return;
      }
      const message = this.safeDiagnostic(
        error,
        apiKey,
        request.messages.map((item) => item.content)
      );
      const status = error instanceof AiRequestError ? error.status : undefined;
      const retryable =
        status === undefined ||
        status === 408 ||
        status === 429 ||
        status >= 500;
      this.emit(client, { type: 'error', message, retryable, status });
    } finally {
      if (this.activeAbortController === controller) {
        this.activeAbortController = undefined;
      }
    }
  }

  async cancel(): Promise<void> {
    this.activeAbortController?.abort();
  }

  getConversationHistory(): Promise<AiConversationHistory> {
    return this.history.read();
  }

  saveConversation(
    conversation: AiConversation,
    activate = true
  ): Promise<void> {
    return this.history.save(conversation, activate);
  }

  setHistoryEnabled(enabled: boolean): Promise<void> {
    return this.history.setEnabled(enabled);
  }

  deleteConversation(id: string): Promise<void> {
    return this.history.delete(id);
  }

  clearConversationHistory(): Promise<void> {
    return this.history.clear();
  }

  async getGitStatus(workspacePath: string): Promise<AiGitStatus> {
    const path = workspacePath.trim();
    if (!path) {
      return { isRepository: false };
    }
    try {
      await this.git(path, ['rev-parse', '--is-inside-work-tree']);
      const [branch, head, porcelain] = await Promise.all([
        this.git(path, ['branch', '--show-current']),
        this.git(path, ['rev-parse', '--short', 'HEAD']),
        this.git(path, ['status', '--porcelain']),
      ]);
      return {
        isRepository: true,
        branch: branch || '(detached)',
        head,
        dirty: Boolean(porcelain),
      };
    } catch {
      return { isRepository: false };
    }
  }

  async createGitCheckpoint(
    workspacePath: string,
    message: string
  ): Promise<string> {
    const path = workspacePath.trim();
    if (!path) {
      throw new Error('当前没有可用的工作区路径。');
    }
    const status = await this.getGitStatus(path);
    if (!status.isRepository) {
      await this.git(path, ['init']);
    }
    await this.git(path, ['add', '-A']);
    const staged = await this.git(path, ['diff', '--cached', '--name-only']);
    if (staged) {
      await this.git(path, [
        '-c',
        'user.name=Arduino IDE Agent',
        '-c',
        'user.email=arduino-agent@localhost',
        'commit',
        '-m',
        message.trim() || 'AI Agent checkpoint',
      ]);
    }
    return this.git(path, ['rev-parse', 'HEAD']);
  }

  async rollbackGitCheckpoint(
    workspacePath: string,
    reference: string
  ): Promise<void> {
    const path = workspacePath.trim();
    const ref = reference.trim();
    if (!path || !ref || !/^[0-9a-zA-Z._/-]+$/.test(ref)) {
      throw new Error('Git 回滚参数无效。');
    }
    await this.git(path, ['reset', '--hard', ref]);
  }

  dispose(): void {
    this.activeAbortController?.abort();
    this.activeAbortController = undefined;
    this.clients.clear();
  }

  setClient(client: AiAgentServiceClient): void {
    this.clients.add(client);
  }

  disposeClient(client: AiAgentServiceClient): void {
    this.clients.delete(client);
    this.activeAbortController?.abort();
  }

  private async runAgent(
    request: AiChatRequest,
    apiKey: string,
    client: AiAgentServiceClient,
    signal: AbortSignal
  ): Promise<void> {
    const config = { ...this.config };
    const tools = request.tools || [];
    let system = tools.length
      ? request.system
      : textOnlySystemPrompt(request.system);
    const input = initialInput(config.provider, config.openaiApi, {
      ...request,
      system,
    });
    const allowed = new Set(tools.map((tool) => tool.name));
    let toolsEnabled = tools.length > 0;
    const endpoint = endpointFor(
      config.provider,
      config.baseUrl,
      config.openaiApi
    );
    const headers = {
      'content-type': 'application/json',
      ...this.buildHeaders(apiKey, 'chat', request.sessionId),
      ...(config.provider === 'anthropic'
        ? { 'anthropic-version': '2023-06-01' }
        : {}),
    };
    let callsExecuted = 0;
    let optionalReasoning = true;
    for (let round = 0; round < 16; round++) {
      signal.throwIfAborted();
      const body: Record<string, unknown> = {
        model: config.model,
        stream: true,
        ...(config.provider === 'anthropic'
          ? { max_tokens: 8192, messages: input, ...(system ? { system } : {}) }
          : config.openaiApi === 'responses'
          ? { input, store: false, max_output_tokens: 8192 }
          : { messages: input }),
        ...(optionalReasoning
          ? reasoningOptions(
              config.provider,
              config.openaiApi,
              config.reasoningLevel,
              config.displayReasoning,
              config.model
            )
          : {}),
        ...(toolsEnabled
          ? { tools: toolDefinitions(config.provider, config.openaiApi, tools) }
          : {}),
      };
      let response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
      });
      if (
        !response.ok &&
        [400, 422].includes(response.status) &&
        optionalReasoning &&
        Object.keys(body).some((key) =>
          [
            'reasoning',
            'reasoning_effort',
            'thinking',
            'output_config',
          ].includes(key)
        ) &&
        /reasoning|thinking|output_config|unknown parameter|unexpected field/i.test(
          await response.clone().text()
        )
      ) {
        optionalReasoning = false;
        removeReasoningOptions(body);
        response = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal,
        });
      }
      if (!response.ok) {
        const errorText = await response.clone().text();
        if (
          toolsEnabled &&
          [400, 404, 405, 422].includes(response.status) &&
          /tool|function.?call|unsupported|unknown parameter|unrecognized/i.test(
            errorText
          )
        ) {
          toolsEnabled = false;
          system = textOnlySystemPrompt(request.system);
          if (config.provider !== 'anthropic') {
            const systemItem = input.find((item) => item.role === 'system');
            if (systemItem) systemItem.content = system;
            else input.unshift({ role: 'system', content: system });
          }
          this.emit(client, {
            type: 'status',
            message: '当前提供商不支持工具调用，已切换为对话模式。',
          });
          continue;
        }
        throw new AiRequestError(
          await formatHttpError(response),
          response.status
        );
      }
      this.emit(client, { type: 'round_start' });
      const turn = await consumeAiResponse(
        response,
        new AiProviderCollector(
          config.provider,
          config.openaiApi,
          (text) => this.emit(client, { type: 'text_delta', text }),
          (text, kind) => {
            if (config.displayReasoning)
              this.emit(client, { type: 'reasoning_delta', text, kind });
          }
        )
      );
      signal.throwIfAborted();
      if (!turn.calls.length) {
        if (!turn.text.trim())
          throw new Error(
            '接口未返回回答正文或工具调用，请检查模型及输出额度。已有思考记录已保留。'
          );
        return;
      }
      const results: AiToolResult[] = [];
      for (const call of turn.calls) {
        signal.throwIfAborted();
        if (++callsExecuted > 40) {
          throw new Error('本轮已达到 40 次工具调用上限，请确认结果后继续。');
        }
        if (!allowed.has(call.name)) {
          results.push({
            success: false,
            output: '未知或未授权的 Arduino 工具。',
          });
          continue;
        }
        this.emit(client, {
          type: 'status',
          message: '正在执行 Arduino 操作…',
        });
        results.push(
          await connectionResult(client.executeArduinoTool(call), signal)
        );
      }
      appendToolResults(
        config.provider,
        config.openaiApi,
        input,
        turn,
        results
      );
    }
    throw new Error('本轮已达到 16 次模型请求上限，请根据已完成操作继续对话。');
  }

  private async request(
    request: AiChatRequest,
    apiKey: string,
    stream: boolean,
    client?: AiAgentServiceClient,
    signal?: AbortSignal
  ): Promise<string> {
    const endpoint = endpointFor(
      this.config.provider,
      this.config.baseUrl,
      this.config.openaiApi
    );
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    Object.assign(
      headers,
      this.buildHeaders(apiKey, 'chat', request.sessionId)
    );
    const messages = request.messages.map((message) => ({
      role: message.role,
      content: message.content,
    }));
    let body: Record<string, unknown>;
    if (this.config.provider === 'anthropic') {
      headers['anthropic-version'] = '2023-06-01';
      body = {
        model: this.config.model,
        max_tokens: 2048,
        stream,
        messages,
        ...(request.system ? { system: request.system } : {}),
      };
    } else if (this.config.openaiApi === 'responses') {
      body = {
        model: this.config.model,
        stream,
        max_output_tokens: 2048,
        input: [
          ...(request.system
            ? [{ role: 'system', content: request.system }]
            : []),
          ...messages,
        ],
        ...reasoningBody(
          this.config.provider,
          this.config.reasoningLevel,
          this.config.openaiApi
        ),
      };
    } else {
      body = {
        model: this.config.model,
        stream,
        messages: [
          ...(request.system
            ? [{ role: 'system', content: request.system }]
            : []),
          ...messages,
        ],
        ...reasoningBody(
          this.config.provider,
          this.config.reasoningLevel,
          this.config.openaiApi
        ),
      };
    }
    let response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });
    // Some OpenAI-compatible gateways reject the optional field instead of
    // ignoring it. Retry once without it so a reasoning preference never
    // prevents an otherwise valid request.
    if (
      !response.ok &&
      this.config.provider === 'openai' &&
      this.config.reasoningLevel !== 'auto' &&
      (response.status === 400 || response.status === 422) &&
      (await response.clone().text()).match(
        /reasoning(?:[_ ]effort)?|unknown parameter|unrecognized.*parameter|unexpected field/i
      )
    ) {
      const fallbackBody = { ...body };
      delete fallbackBody.reasoning_effort;
      delete fallbackBody.reasoning;
      response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(fallbackBody),
        signal,
      });
    }
    if (!response.ok) {
      throw new AiRequestError(
        await formatHttpError(response),
        response.status
      );
    }
    if (!stream) {
      const payload = (await response.json()) as Record<string, any>;
      return extractText(this.config.provider, payload, this.config.openaiApi);
    }
    if (!client) {
      return '';
    }
    return this.consumeStream(response, client);
  }

  private async consumeStream(
    response: Response,
    client: AiAgentServiceClient
  ): Promise<string> {
    let fullText = '';
    const body = response.body as any;
    if (body && typeof body[Symbol.asyncIterator] === 'function') {
      let buffer = '';
      const decoder = new TextDecoder();
      for await (const chunk of body as AsyncIterable<Uint8Array | string>) {
        buffer +=
          typeof chunk === 'string'
            ? chunk
            : decoder.decode(Buffer.from(chunk), { stream: true });
        const parts = buffer.split(/\r?\n\r?\n/);
        buffer = parts.pop() || '';
        for (const part of parts) {
          fullText += this.consumeSseEvent(part, client);
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) {
        fullText += this.consumeSseEvent(buffer, client);
      }
    } else {
      const text = await response.text();
      for (const part of text.split(/\r?\n\r?\n/)) {
        fullText += this.consumeSseEvent(part, client);
      }
    }
    return fullText;
  }

  private consumeSseEvent(event: string, client: AiAgentServiceClient): string {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('\n');
    if (!data || data === '[DONE]') {
      return '';
    }
    let payload: Record<string, any>;
    try {
      payload = JSON.parse(data);
    } catch {
      return '';
    }
    if (payload.type === 'error' || payload.error?.message) {
      throw new Error(payload.error?.message || 'Provider 流式响应失败。');
    }
    let text = '';
    if (this.config.provider === 'anthropic') {
      if (
        payload.type === 'content_block_delta' &&
        payload.delta?.type === 'text_delta'
      ) {
        text = payload.delta.text || '';
      }
    } else if (this.config.openaiApi === 'responses') {
      if (payload.type === 'response.output_text.delta') {
        text = payload.delta || '';
      } else if (
        payload.type === 'response.error' ||
        payload.type === 'response.failed'
      ) {
        throw new Error(
          payload.error?.message ||
            payload.response?.error?.message ||
            'Provider 流式响应失败。'
        );
      }
    } else {
      text = payload.choices?.[0]?.delta?.content || '';
    }
    if (text) {
      this.emit(client, { type: 'text_delta', text });
    }
    return text;
  }

  private emit(client: AiAgentServiceClient, event: AiAgentEvent): void {
    try {
      client.onAgentEvent(event);
    } catch {
      // The renderer may close while a request is still being consumed.
    }
  }

  private buildHeaders(
    apiKey: string,
    purpose: 'chat' | 'model-list',
    sessionId?: string
  ): Record<string, string> {
    const headers: Record<string, string> = {
      'user-agent': 'arduino-ide-agent/2.3.1',
    };
    const authMode = normalizeAuthMode(
      this.config.authMode,
      this.config.provider
    );
    if (authMode === 'bearer' && apiKey) {
      headers.authorization = `Bearer ${apiKey}`;
    } else if (authMode === 'x-api-key' && apiKey) {
      headers['x-api-key'] = apiKey;
    } else if (authMode === 'api-key' && apiKey) {
      headers['api-key'] = apiKey;
    }
    const customHeaders = parseCustomHeaders(this.config.customHeaders);
    Object.assign(headers, customHeaders);
    if (
      isOpenCodeGoUrl(this.config.baseUrl) &&
      !hasHeader(customHeaders, 'x-opencode-session')
    ) {
      headers['x-opencode-session'] = sessionId || this.connectionSessionId;
    }
    if (purpose === 'model-list' && this.config.provider === 'anthropic') {
      headers['anthropic-version'] = '2023-06-01';
    }
    return headers;
  }

  private async getApiKey(): Promise<string | undefined> {
    try {
      return (await this.keychain.getStoredCredentials()) || undefined;
    } catch {
      return undefined;
    }
  }

  private async git(workspacePath: string, args: string[]): Promise<string> {
    const result = await execFileAsync('git', ['-C', workspacePath, ...args], {
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
      encoding: 'utf8',
    });
    return String(result.stdout || '').trim();
  }

  private async loadConfig(): Promise<void> {
    if (this.loaded) return;
    if (!this.loading) this.loading = this.readConfig();
    try {
      await this.loading;
    } finally {
      this.loading = undefined;
    }
  }

  private async readConfig(): Promise<void> {
    try {
      const raw = await fs.readFile(this.configPath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<StoredConfig>;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error('配置格式无效');
      this.config = {
        ...DEFAULT_CONFIG,
        provider: parsed.provider === 'anthropic' ? 'anthropic' : 'openai',
        baseUrl:
          typeof parsed.baseUrl === 'string'
            ? parsed.baseUrl
            : DEFAULT_CONFIG.baseUrl,
        model:
          typeof parsed.model === 'string'
            ? parsed.model
            : DEFAULT_CONFIG.model,
        approvalMode: parsed.approvalMode === 'auto' ? 'auto' : 'confirm',
        openaiApi: normalizeOpenAiApiForConfig(
          parsed.openaiApi,
          String(parsed.baseUrl || DEFAULT_CONFIG.baseUrl),
          String(parsed.model || DEFAULT_CONFIG.model)
        ),
        authMode: normalizeAuthMode(parsed.authMode, parsed.provider),
        customHeaders: normalizeCustomHeaders(parsed.customHeaders),
        reasoningLevel: normalizeReasoningLevel(parsed.reasoningLevel),
        ...normalizePromptSettings(parsed),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(
          '无法读取 Agent 配置，已保留原文件，未覆盖；请检查文件格式或权限。'
        );
      }
    }
    this.loaded = true;
  }

  private safeDiagnostic(
    error: unknown,
    apiKey?: string,
    content: string[] = []
  ): string {
    const message = error instanceof Error ? error.message : String(error);
    const values = Object.values(parseCustomHeaders(this.config.customHeaders));
    return redactAiDiagnostic(message, [
      apiKey || '',
      ...values.filter((value) => value.length >= 8),
      ...content.filter((value) => value.length >= 16),
    ]);
  }

  private async publicConfig(): Promise<AiAgentConfig> {
    return {
      ...this.config,
      hasApiKey: Boolean(await this.getApiKey()),
    };
  }
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function connectionResult(
  operation: Promise<AiToolResult>,
  signal: AbortSignal
): Promise<AiToolResult> {
  return new Promise((resolve, reject) => {
    const cancelled = (): void => reject(new Error('请求已停止。'));
    signal.addEventListener('abort', cancelled, { once: true });
    operation
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', cancelled));
    if (signal.aborted) {
      cancelled();
    }
  });
}

function normalizeReasoningLevel(value: unknown): AiReasoningLevel {
  return value === 'fast' || value === 'balanced' || value === 'deep'
    ? value
    : 'auto';
}

function normalizeAuthMode(
  value: unknown,
  provider: unknown = 'openai'
): AiAuthMode {
  if (
    value === 'bearer' ||
    value === 'x-api-key' ||
    value === 'api-key' ||
    value === 'none'
  ) {
    return value;
  }
  return provider === 'anthropic' ? 'x-api-key' : 'bearer';
}

function normalizeCustomHeaders(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    return '';
  }
  // Validate on save/load but keep the user's readable one-header-per-line
  // format in the config file.
  parseCustomHeaders(value);
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
}

function parseCustomHeaders(value: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [index, rawLine] of value.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const separator = line.indexOf(':');
    if (separator <= 0) {
      throw new Error(`额外请求头第 ${index + 1} 行格式无效，应为“名称: 值”。`);
    }
    const name = line.slice(0, separator).trim();
    const headerValue = line.slice(separator + 1).trim();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) {
      throw new Error(`额外请求头名称无效：${name}`);
    }
    if (/^(host|content-length|connection|transfer-encoding)$/i.test(name)) {
      throw new Error(`额外请求头不允许覆盖 ${name}。`);
    }
    if (/\r|\n/.test(headerValue)) {
      throw new Error('额外请求头值不能包含换行。');
    }
    headers[name.toLowerCase()] = headerValue;
  }
  return headers;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === name);
}

function isOpenCodeGoUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      parsed.hostname.toLowerCase() === 'opencode.ai' &&
      /\/zen\/go(?:\/|$)/i.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

function reasoningBody(
  provider: AiProvider,
  level: AiReasoningLevel,
  openaiApi: AiOpenAiApi
): Record<string, unknown> {
  if (provider !== 'openai') {
    return {};
  }
  const effort =
    level === 'fast'
      ? 'low'
      : level === 'balanced'
      ? 'medium'
      : level === 'deep'
      ? 'high'
      : undefined;
  if (!effort) {
    return {};
  }
  return openaiApi === 'responses'
    ? { reasoning: { effort } }
    : { reasoning_effort: effort };
}

function normalizeOpenAiApi(value: unknown): AiOpenAiApi {
  return value === 'responses' ? 'responses' : 'chat-completions';
}

function normalizeOpenAiApiForConfig(
  value: unknown,
  baseUrl: string,
  model: string
): AiOpenAiApi {
  const api = normalizeOpenAiApi(value);
  // OpenCode Go publishes DeepSeek, GLM, Kimi, MiMo, LongCat and Hy models
  // through its OpenAI-compatible Chat Completions endpoint. Correct an old
  // saved Responses selection so upgrading the Agent fixes the common 400.
  if (
    api === 'responses' &&
    isOpenCodeGoUrl(baseUrl) &&
    /deepseek|glm|kimi|mimo|longcat|hy\d|space-bunny/i.test(model)
  ) {
    return 'chat-completions';
  }
  return api;
}

function endpointFor(
  provider: AiProvider,
  baseUrl: string,
  openaiApi: AiOpenAiApi
): string {
  const normalized = normalizeBaseUrl(baseUrl).replace(
    /\/(?:chat\/completions|responses|messages)$/i,
    ''
  );
  const suffix =
    provider === 'anthropic'
      ? '/messages'
      : openaiApi === 'responses'
      ? '/responses'
      : '/chat/completions';
  return normalized.endsWith(suffix) ? normalized : `${normalized}${suffix}`;
}

function modelsEndpointFor(baseUrl: string): string {
  const normalized = normalizeBaseUrl(baseUrl)
    .replace(/\/(?:chat\/completions|responses|messages)$/i, '')
    .replace(/\/models$/i, '');
  return `${normalized}/models`;
}

async function formatHttpError(response: Response): Promise<string> {
  let message = `请求失败（HTTP ${response.status}）。`;
  try {
    const payload = (await response.json()) as Record<string, any>;
    const remoteMessage =
      payload.error?.message || payload.error?.type || payload.message;
    if (remoteMessage) {
      message += ` ${remoteMessage}`;
    }
  } catch {
    // Some gateways return an HTML or plain-text error page.
  }
  return message;
}

class AiRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'AiRequestError';
  }
}

function hasHttpHostname(value: string): boolean {
  try {
    const parsed = new URL(value);
    return Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

function extractText(
  provider: AiProvider,
  payload: Record<string, any>,
  openaiApi: AiOpenAiApi = 'chat-completions'
): string {
  if (provider === 'anthropic') {
    return (payload.content || [])
      .filter((block: any) => block.type === 'text')
      .map((block: any) => block.text || '')
      .join('');
  }
  if (openaiApi === 'responses') {
    if (typeof payload.output_text === 'string') {
      return payload.output_text;
    }
    return (payload.output || [])
      .flatMap((item: any) => item.content || [])
      .filter(
        (content: any) =>
          content.type === 'output_text' || content.type === 'text'
      )
      .map((content: any) => content.text || '')
      .join('');
  }
  return payload.choices?.[0]?.message?.content || '';
}

function parseModelList(payload: unknown): AiModelInfo[] {
  const raw = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object'
    ? (payload as Record<string, unknown>).data ??
      (payload as Record<string, unknown>).models ??
      (payload as Record<string, unknown>).results
    : undefined;
  if (!Array.isArray(raw)) {
    return [];
  }
  const result = new Map<string, AiModelInfo>();
  for (const item of raw) {
    if (typeof item === 'string') {
      const id = item.trim();
      if (id) {
        result.set(id, { id });
      }
      continue;
    }
    if (!item || typeof item !== 'object') {
      continue;
    }
    const value = item as Record<string, unknown>;
    const id = String(value.id ?? value.name ?? '').trim();
    if (!id) {
      continue;
    }
    const label = String(
      value.display_name ?? value.displayName ?? value.label ?? ''
    ).trim();
    const ownedBy = String(value.owned_by ?? value.ownedBy ?? '').trim();
    result.set(id, {
      id,
      ...(label ? { label } : {}),
      ...(ownedBy ? { ownedBy } : {}),
    });
  }
  return Array.from(result.values()).sort((left, right) =>
    left.id.localeCompare(right.id)
  );
}
