import { expect } from 'chai';
import { AiProviderCollector } from '../../node/ai-agent-provider';
import {
  buildAiAgentSystemPrompt,
  defaultAiAgentPrompt,
  normalizePromptSettings,
} from '../../common/ai-agent-prompt';
import {
  reasoningOptions,
  removeReasoningOptions,
} from '../../common/ai-agent-reasoning';

const ignoreAnswer = (): void => undefined;

describe('思考通道与提示词定制', () => {
  it('Chat Completions 思考与回答分离，原始思考仍可回传工具轮次', () => {
    const thought: string[] = [],
      answer: string[] = [];
    const collector = new AiProviderCollector(
      'openai',
      'chat-completions',
      (text) => answer.push(text),
      (text) => thought.push(text)
    );
    collector.accept({
      choices: [{ delta: { reasoning_content: '检查引脚。' } }],
    });
    collector.accept({
      choices: [
        {
          delta: { reasoning_content: '检查时序。', content: '已修复。' },
          finish_reason: 'stop',
        },
      ],
    });
    const turn = collector.complete();
    expect(thought.join('')).eq('检查引脚。检查时序。');
    expect(answer.join('')).eq('已修复。');
    expect(turn.items[0].reasoning_content).eq(thought.join(''));
  });
  it('兼容 reasoning 字段但不展示加密 reasoning_details', () => {
    let reasoning = '';
    const collector = new AiProviderCollector(
      'openai',
      'chat-completions',
      ignoreAnswer,
      (text) => (reasoning += text)
    );
    collector.accept({
      choices: [
        {
          message: {
            reasoning: '公开文本',
            reasoning_details: [{ data: 'ENCRYPTED' }],
            content: '回答',
          },
          finish_reason: 'stop',
        },
      ],
    });
    expect(collector.complete().items[0].reasoning).eq('公开文本');
    expect(reasoning).eq('公开文本');
  });
  it('Responses 摘要完成事件和最终快照不会重复，密文不展示', () => {
    let reasoning = '',
      answer = '';
    const collector = new AiProviderCollector(
      'openai',
      'responses',
      (text) => (answer += text),
      (text, kind) => {
        expect(kind).eq('summary');
        reasoning += text;
      }
    );
    collector.accept({
      type: 'response.reasoning_summary_text.delta',
      output_index: 0,
      summary_index: 0,
      delta: '检查',
    });
    collector.accept({
      type: 'response.reasoning_summary_text.delta',
      output_index: 0,
      summary_index: 0,
      delta: '代码',
    });
    collector.accept({
      type: 'response.reasoning_summary_text.done',
      output_index: 0,
      summary_index: 0,
      text: '检查代码',
    });
    collector.accept({
      type: 'response.completed',
      response: {
        output: [
          {
            type: 'reasoning',
            summary: [{ type: 'summary_text', text: '检查代码' }],
            encrypted_content: 'OPAQUE',
          },
          {
            type: 'message',
            content: [{ type: 'output_text', text: '正常回答' }],
          },
        ],
      },
    });
    expect(collector.complete().text).eq('正常回答');
    expect(reasoning).eq('检查代码');
    expect(answer).eq('正常回答');
  });
  it('Responses JSON 中的 reasoning_text 不会混进回答', () => {
    let reasoning = '';
    const collector = new AiProviderCollector(
      'openai',
      'responses',
      ignoreAnswer,
      (text) => (reasoning += text)
    );
    collector.accept({
      status: 'completed',
      output: [
        {
          type: 'reasoning',
          content: [{ type: 'reasoning_text', text: '第三方思考' }],
        },
        { type: 'message', content: [{ type: 'output_text', text: '结果' }] },
      ],
    });
    expect(collector.complete().text).eq('结果');
    expect(reasoning).eq('第三方思考');
  });
  it('Anthropic 思考流、签名和工具参数保持独立，支持不连续块索引', () => {
    let reasoning = '';
    const collector = new AiProviderCollector(
      'anthropic',
      'chat-completions',
      ignoreAnswer,
      (text) => (reasoning += text)
    );
    collector.accept({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '', signature: '' },
    });
    collector.accept({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: '需要读取草图。' },
    });
    collector.accept({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'signature_delta', signature: 'SIGNATURE' },
    });
    collector.accept({
      type: 'content_block_start',
      index: 2,
      content_block: {
        type: 'tool_use',
        id: 'call1',
        name: 'read_sketch',
        input: {},
      },
    });
    collector.accept({
      type: 'content_block_delta',
      index: 2,
      delta: { type: 'input_json_delta', partial_json: '{}' },
    });
    collector.accept({ type: 'message_stop' });
    const turn = collector.complete();
    expect(reasoning).eq('需要读取草图。');
    expect(turn.items[0].signature).eq('SIGNATURE');
    expect(turn.calls[0].input).deep.eq({});
  });
  it('Anthropic 非流式响应跳过 redacted_thinking 和签名', () => {
    let reasoning = '';
    const collector = new AiProviderCollector(
      'anthropic',
      'chat-completions',
      ignoreAnswer,
      (text) => (reasoning += text)
    );
    collector.accept({
      content: [
        { type: 'thinking', thinking: '摘要', signature: 'SIGNATURE' },
        { type: 'redacted_thinking', data: 'REDACTED' },
        { type: 'text', text: '正文' },
      ],
    });
    expect(collector.complete().text).eq('正文');
    expect(reasoning).eq('摘要');
  });
  it('完整替换默认提示词，可关闭动态上下文或保存空提示词', () => {
    const custom = '只按用户的格式回答。\n保留我的空行。\n';
    const prompt = buildAiAgentSystemPrompt({
      approvalMode: 'auto',
      systemPrompt: custom,
      includeIdeContext: false,
    });
    expect(prompt).eq(custom);
    expect(prompt).not.include('任务范围');
    expect(
      buildAiAgentSystemPrompt({
        approvalMode: 'auto',
        systemPrompt: '',
        includeIdeContext: false,
      })
    ).eq('');
    expect(
      buildAiAgentSystemPrompt({
        approvalMode: 'auto',
        systemPrompt: null,
        includeIdeContext: false,
      })
    ).eq(defaultAiAgentPrompt());
  });
  it('保留上下文时使用自定义规则，旧配置迁移和快捷保存不覆盖它', () => {
    const previous = {
      systemPrompt: '我的规则',
      includeIdeContext: false,
      displayReasoning: false,
    };
    expect(normalizePromptSettings({}, previous)).deep.eq(previous);
    expect(
      normalizePromptSettings({ systemPrompt: null }, previous).systemPrompt
    ).eq(null);
    const restored = normalizePromptSettings(
      JSON.parse(JSON.stringify(previous))
    );
    expect(restored).deep.eq(previous);
    const prompt = buildAiAgentSystemPrompt({
      approvalMode: 'auto',
      systemPrompt: '我的规则',
      context: { boardName: 'Arduino Uno' },
    });
    expect(prompt).include('我的规则');
    expect(prompt).include('Arduino Uno');
    expect(prompt).not.include('以用户最新明确要求');
  });
  it('超大或无效提示词不静默截断', () => {
    expect(() =>
      normalizePromptSettings({ systemPrompt: 'x'.repeat(120001) })
    ).throw();
    expect(() => normalizePromptSettings({ systemPrompt: 23 })).throw();
  });
  it('不同接口使用各自思考参数，可关闭摘要请求并降级', () => {
    expect(
      reasoningOptions('openai', 'responses', 'auto', true, 'gpt')
    ).deep.eq({ reasoning: { summary: 'auto' } });
    expect(
      reasoningOptions('openai', 'responses', 'auto', false, 'gpt')
    ).deep.eq({});
    expect(
      reasoningOptions(
        'anthropic',
        'chat-completions',
        'deep',
        true,
        'claude-sonnet-4-6'
      )
    ).deep.eq({
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'high' },
    });
    const legacy = reasoningOptions(
      'anthropic',
      'chat-completions',
      'fast',
      true,
      'claude-sonnet-4-5'
    ) as { thinking: { budget_tokens: number } };
    expect(legacy.thinking.budget_tokens).eq(1024);
    const body = {
      tools: [{}],
      model: 'gateway',
      ...reasoningOptions('openai', 'responses', 'deep', true, 'gpt'),
    };
    removeReasoningOptions(body);
    expect(body).deep.eq({ tools: [{}], model: 'gateway' });
  });
});
