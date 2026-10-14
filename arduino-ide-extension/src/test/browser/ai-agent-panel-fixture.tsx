import React from '@theia/core/shared/react';
import { createRoot } from '@theia/core/shared/react-dom/client';
import { flushSync } from '@theia/core/shared/react-dom';
import {
  AiAgentPanel,
  AiAgentPanelProps,
  resolveConversationTitle,
} from '../../browser/ai-agent/ai-agent-panel';
import type { AiConversation } from '../../common/protocol/ai-agent-service';
import { AiAgentPromptSettings } from '../../browser/ai-agent/ai-agent-prompt-settings';

const demoMessages = [
  {
    role: 'user' as const,
    content: '把按钮控制 LED 和蜂鸣器的程序改成非阻塞，并检查编译。',
  },
  { role: 'assistant' as const, content: '' },
  {
    role: 'assistant' as const,
    reasoning:
      '先检查按钮的消抖逻辑，再比较 millis() 与原来的延时行为。\n保留引脚和已验证的硬件设置。',
    reasoningKind: 'summary' as const,
    content:
      '已把延时改成 **millis() 非阻塞计时**。按钮连接 D2，LED 连接 D8，蜂鸣器连接 D9。\n\n下面的代码可以直接应用到当前草图。\n\n```cpp\nvoid setup() {\n  pinMode(8, OUTPUT);\n}\n\nvoid loop() {\n  digitalWrite(8, HIGH);\n}\n```\n\n1. 连接开发板。\n2. 检查端口后上传。\n\n编译验证已经完成。',
  },
  { role: 'system' as const, content: '模型调用工具：compile' },
  {
    role: 'system' as const,
    content: '{"success":true,"message":"编译成功。","board":"Arduino UNO"}',
  },
];
const first: AiConversation = {
  id: 'chat_fixture',
  title: '按钮与 LED 的非阻塞控制',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  messages: demoMessages,
};
const second: AiConversation = {
  id: 'chat_serial',
  title: '温度传感器串口调试',
  createdAt: Date.now() - 500000,
  updatedAt: Date.now() - 500000,
  messages: [{ role: 'user', content: '检查串口温度数据' }],
};

function Fixture(): React.ReactElement {
  const [state, setState] = React.useState({
    messages: [...demoMessages] as AiAgentPanelProps['messages'],
    conversations: [first, second],
    activeId: first.id,
    draft: '',
    status: '已完成',
    pending: false,
    enabled: true,
    settings: false,
    config: {
      provider: 'openai' as const,
      openaiApi: 'chat-completions' as const,
      authMode: 'bearer' as const,
      baseUrl: 'https://opencode.ai/zen/go/v1',
      customHeaders: '',
      model: 'deepseek-v4.1-flash',
      approvalMode: 'auto' as 'auto' | 'confirm',
      reasoningLevel: 'deep' as 'auto' | 'fast' | 'balanced' | 'deep',
      hasApiKey: true,
      systemPrompt: null as string | null,
      includeIdeContext: true,
      displayReasoning: true,
    },
  });
  const composer = React.useRef<HTMLTextAreaElement | null>(null);
  const calls = React.useRef<string[]>([]);
  (window as unknown as { agentFixture: unknown }).agentFixture = {
    state,
    titles: {
      automatic: resolveConversationTitle('新对话', '编译按钮草图'),
      renamed: resolveConversationTitle('我的工程', '编译按钮草图'),
    },
    calls: calls.current,
    setPending: (pending: boolean) =>
      flushSync(() => setState((previous) => ({ ...previous, pending }))),
    setStatus: (status: string) =>
      flushSync(() => setState((previous) => ({ ...previous, status }))),
  };
  const action = (name: string): void => {
    calls.current.push(name);
    setState((previous) => ({ ...previous, status: name }));
  };
  return (
    <AiAgentPanel
      messages={state.messages}
      conversations={state.conversations}
      activeId={state.activeId}
      draft={state.draft}
      status={state.status}
      pending={state.pending}
      busy={state.pending}
      ready
      historyEnabled={state.enabled}
      contextLabel="button_beep_led · Arduino UNO · COM3"
      config={state.config}
      models={[{ id: 'deepseek-v4.1-flash' }, { id: 'kimi-k2.6' }]}
      settings={
        <fieldset className="arduino-ai-agent-settings">
          <label>
            接口地址
            <input defaultValue="https://opencode.ai/zen/go/v1" />
          </label>
          <label>
            API Key
            <input type="password" placeholder="已保存在系统凭据中" />
          </label>
          <label>
            模型
            <select defaultValue="deepseek-v4.1-flash">
              <option>deepseek-v4.1-flash</option>
            </select>
          </label>
          <div className="arduino-ai-agent-settings-actions">
            <button className="theia-button">保存配置</button>
            <button className="theia-button secondary">测试连接</button>
          </div>
          <AiAgentPromptSettings
            systemPrompt={state.config.systemPrompt}
            includeIdeContext={state.config.includeIdeContext}
            onSave={async (value) => {
              calls.current.push('prompt-save');
              setState((previous) => ({
                ...previous,
                config: { ...previous.config, ...value },
              }));
              return true;
            }}
          />
        </fieldset>
      }
      showSettings={state.settings}
      onSettings={(settings) =>
        setState((previous) => ({ ...previous, settings }))
      }
      onNew={() => {
        action('new');
        if (composer.current) composer.current.value = '';
        setState((previous) => ({
          ...previous,
          messages: [],
          activeId: '',
          draft: '',
        }));
      }}
      onSelect={(activeId) => {
        action('select');
        const record = state.conversations.find((item) => item.id === activeId);
        if (record)
          setState((previous) => ({
            ...previous,
            activeId,
            messages: record.messages,
            draft: record.draft || '',
          }));
      }}
      onRename={(id, title) => {
        action('rename');
        setState((previous) => ({
          ...previous,
          conversations: previous.conversations.map((item) =>
            item.id === id ? { ...item, title } : item
          ),
        }));
      }}
      onDelete={(id) => {
        action('delete');
        setState((previous) => ({
          ...previous,
          conversations: previous.conversations.filter(
            (item) => item.id !== id
          ),
        }));
      }}
      onHistoryEnabled={(enabled) =>
        setState((previous) => ({ ...previous, enabled }))
      }
      onDraft={(draft) => setState((previous) => ({ ...previous, draft }))}
      onSend={() => {
        const content = composer.current?.value || state.draft;
        action('send');
        if (composer.current) composer.current.value = '';
        setState((previous) => ({
          ...previous,
          draft: '',
          messages: [...previous.messages, { role: 'user', content }],
        }));
      }}
      onStop={() => {
        action('stop');
        setState((previous) => ({ ...previous, pending: false }));
      }}
      onModel={(model) =>
        setState((previous) => ({
          ...previous,
          config: { ...previous.config, model },
        }))
      }
      onReasoning={(reasoningLevel) =>
        setState((previous) => ({
          ...previous,
          config: { ...previous.config, reasoningLevel },
        }))
      }
      onPermission={(approvalMode) =>
        setState((previous) => ({
          ...previous,
          config: { ...previous.config, approvalMode },
        }))
      }
      onTemplate={() => {
        const draft = '写一个 Arduino 按钮控制 LED 的非阻塞程序。';
        if (composer.current) composer.current.value = draft;
        setState((previous) => ({ ...previous, draft }));
        composer.current?.focus();
      }}
      onTool={action}
      onApply={() => action('apply')}
      onCheckpoint={() => action('checkpoint')}
      onRollback={() => action('rollback')}
      composerRef={(node) => {
        composer.current = node;
      }}
    />
  );
}

const mount = document.getElementById('fixture');
if (mount) createRoot(mount).render(<Fixture />);
