import { expect } from 'chai';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileUri } from '@theia/core/lib/node/file-uri';
import { redactAiDiagnostic } from '../../node/ai-agent-privacy';
import { AiAgentServiceImpl } from '../../node/ai-agent-service-impl';
import type {
  AiAgentConfigInput,
  AiAgentEvent,
} from '../../common/protocol/ai-agent-service';

describe('Agent 诊断与配置隐私', () => {
  const key = 'fixture-secret-' + 'z'.repeat(28);
  let directory: string;
  let service: AiAgentServiceImpl;
  let savedKey: string | undefined;
  let canStore: boolean;
  const originalFetch = globalThis.fetch;
  const input: AiAgentConfigInput = {
    provider: 'openai',
    openaiApi: 'chat-completions',
    authMode: 'bearer',
    baseUrl: 'https://example.invalid/v1',
    customHeaders: '',
    model: 'test-model',
    approvalMode: 'confirm',
    reasoningLevel: 'auto',
  };
  beforeEach(async () => {
    directory = await fs.mkdtemp(join(tmpdir(), 'arduino-agent-privacy-test-'));
    service = new AiAgentServiceImpl();
    savedKey = undefined;
    canStore = true;
    Object.defineProperty(service, 'configDirUriProvider', {
      value: { configDirUri: () => FileUri.create(directory) },
    });
    Object.defineProperty(service, 'keychain', {
      value: {
        getStoredCredentials: async () => savedKey,
        storeCredentials: async (value: string) => {
          if (!canStore) return false;
          savedKey = value;
          return true;
        },
        deleteCredentials: async () => {
          savedKey = undefined;
          return true;
        },
      },
    });
  });
  afterEach(async () => {
    globalThis.fetch = originalFetch;
    service?.dispose();
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  });
  it('脱敏已知密钥、编码形式、认证头和敏感 URL 参数，保留错误原因', () => {
    const text = `HTTP 400 missing x-opencode-session. ${key} ${encodeURIComponent(
      'private+/key'
    )} Authorization: Bearer unknown-token-42; https://example.invalid/?api_key=other-secret`;
    const result = redactAiDiagnostic(text, [key, 'private+/key']);
    expect(result).include('missing x-opencode-session');
    for (const secret of [
      key,
      'private%2B%2Fkey',
      'unknown-token-42',
      'other-secret',
    ])
      expect(result).not.include(secret);
  });
  it('不把非法或旧配置中的未知密钥字段返回前端', async () => {
    await fs.writeFile(
      join(directory, 'ai-agent.json'),
      JSON.stringify({ ...input, apiKey: key, password: key })
    );
    const config = await service.getConfig();
    expect(config).not.have.property('apiKey');
    expect(config).not.have.property('password');
    expect(config.approvalMode).eq('confirm');
  });
  it('凭据保存失败不会变更已保存文件或内存配置', async () => {
    await service.saveConfig(input);
    const before = await fs.readFile(join(directory, 'ai-agent.json'), 'utf8');
    canStore = false;
    try {
      await service.saveConfig({ ...input, model: 'new-model', apiKey: key });
      throw new Error('应该拒绝');
    } catch (error) {
      expect(String(error)).include('均未保存');
    }
    expect((await service.getConfig()).model).eq(input.model);
    expect(await fs.readFile(join(directory, 'ai-agent.json'), 'utf8')).eq(
      before
    );
    expect(await fs.readdir(directory)).deep.eq(['ai-agent.json']);
  });
  it('配置替换失败会恢复旧凭据，不覆盖内存配置', async () => {
    await service.saveConfig({ ...input, apiKey: 'old-key' });
    await fs.unlink(join(directory, 'ai-agent.json'));
    await fs.mkdir(join(directory, 'ai-agent.json'));
    try {
      await service.saveConfig({ ...input, apiKey: key, model: 'new-model' });
      throw new Error('应该拒绝');
    } catch (error) {
      expect(String(error)).not.include(key);
    }
    expect(savedKey).eq('old-key');
    expect((await service.getConfig()).model).eq(input.model);
  });
  it('损坏配置保留原文件并明确报错，不静默覆盖', async () => {
    await fs.writeFile(join(directory, 'ai-agent.json'), '{broken');
    try {
      await service.saveConfig(input);
      throw new Error('应该拒绝');
    } catch (error) {
      expect(String(error)).include('已保留原文件');
    }
    expect(await fs.readFile(join(directory, 'ai-agent.json'), 'utf8')).eq(
      '{broken'
    );
  });
  it('并发保存串行执行，不丢失先保存的自定义提示词', async () => {
    await Promise.all([
      service.saveConfig({ ...input, systemPrompt: '自定义规则' }),
      service.saveConfig({ ...input, model: 'another-model' }),
    ]);
    const config = await service.getConfig();
    expect(config.systemPrompt).eq('自定义规则');
    expect(config.model).eq('another-model');
  });
  it('模型列表 HTTP 报错不会回显密钥或自定义认证头', async () => {
    const headerKey = 'private-header-' + 'h'.repeat(20);
    await service.saveConfig({
      ...input,
      apiKey: key,
      customHeaders: `x-gateway-secret: ${headerKey}`,
    });
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          error: { message: `Invalid authentication: ${key} ${headerKey}` },
        }),
        { status: 401, headers: { 'content-type': 'application/json' } }
      );
    try {
      await service.listModels();
      throw new Error('应该拒绝');
    } catch (error) {
      expect(String(error))
        .include('HTTP 401')
        .not.include(key)
        .not.include(headerKey);
    }
  });
  it('流式错误脱敏后才进入对话事件与历史', async () => {
    await service.saveConfig({ ...input, apiKey: key });
    const events: AiAgentEvent[] = [];
    service.setClient({
      onAgentEvent: (event) => events.push(event),
      executeArduinoTool: async () => ({ success: false, output: '不可用' }),
    });
    globalThis.fetch = async () =>
      new Response(
        `data: ${JSON.stringify({
          error: { message: `Authentication failed: ${key}` },
        })}\n\n`,
        { headers: { 'content-type': 'text/event-stream' } }
      );
    await service.sendMessage({
      messages: [{ role: 'user', content: '测试' }],
    });
    const error = events.find((event) => event.type === 'error');
    expect(error?.type).eq('error');
    expect(JSON.stringify(error)).not.include(key);
    expect(JSON.stringify(error)).include('[已脱敏]');
  });
  it('拒绝把账号密码写入 Base URL', async () => {
    try {
      await service.saveConfig({
        ...input,
        baseUrl:
          'https://' + ['account', 'secret'].join(':') + '@example.invalid/v1',
      });
      throw new Error('应该拒绝');
    } catch (error) {
      expect(String(error)).include('不能包含账号或密码');
    }
    expect((await service.getConfig()).approvalMode).eq('confirm');
  });
});
