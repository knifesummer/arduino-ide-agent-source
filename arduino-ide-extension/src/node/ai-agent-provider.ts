import {
  AiChatRequest,
  AiOpenAiApi,
  AiProvider,
  AiToolCall,
  AiToolDefinition,
  AiToolResult,
  AiReasoningKind,
} from '../common/protocol/ai-agent-service';

type WireItem = Record<string, any>;

/** One model turn, including the complete provider-specific assistant payload. */
export interface AiProviderTurn {
  text: string;
  calls: AiToolCall[];
  items: WireItem[];
}

export function toolDefinitions(
  provider: AiProvider,
  api: AiOpenAiApi,
  tools: AiToolDefinition[]
): WireItem[] {
  return tools.map(({ name, description, inputSchema }) =>
    provider === 'anthropic'
      ? { name, description, input_schema: inputSchema }
      : api === 'responses'
      ? { type: 'function', name, description, parameters: inputSchema, strict: false }
      : { type: 'function', function: { name, description, parameters: inputSchema } }
  );
}

export function initialInput(
  provider: AiProvider,
  api: AiOpenAiApi,
  request: AiChatRequest
): WireItem[] {
  return [
    ...(request.system && provider !== 'anthropic'
      ? [{ role: 'system', content: request.system }]
      : []),
    ...request.messages.map((message) => ({ ...message })),
  ];
}

export function appendToolResults(
  provider: AiProvider,
  api: AiOpenAiApi,
  input: WireItem[],
  turn: AiProviderTurn,
  results: AiToolResult[]
): void {
  if (provider === 'anthropic') {
    input.push(
      { role: 'assistant', content: turn.items },
      {
        role: 'user',
        content: turn.calls.map((call, index) => ({
          type: 'tool_result',
          tool_use_id: call.id,
          content: JSON.stringify(results[index]),
          ...(results[index].success ? {} : { is_error: true }),
        })),
      }
    );
  } else if (api === 'responses') {
    // Preserve reasoning items and signatures as well as function calls.
    input.push(
      ...turn.items,
      ...turn.calls.map((call, index) => ({
        type: 'function_call_output',
        call_id: call.id,
        output: JSON.stringify(results[index]),
      }))
    );
  } else {
    input.push(
      turn.items[0],
      ...turn.calls.map((call, index) => ({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(results[index]),
      }))
    );
  }
}

function parseCall(id: string, name: string, argumentsValue: unknown): AiToolCall {
  let input = argumentsValue;
  if (typeof input === 'string') {
    input = JSON.parse(input || '{}');
  }
  if (!id || !name || !input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('模型返回了无效工具调用，未执行任何操作。');
  }
  return { id, name, input: input as Record<string, unknown> };
}

/** SSE aggregation also supports gateways that ignore stream=true and return JSON. */
export class AiProviderCollector {
  private text = '';
  private readonly items = new Map<number, WireItem>();
  private readonly calls = new Map<number, WireItem>();
  private readonly argumentBuffers = new Map<number, string>();
  private reasoning = '';
  private reasoningField = 'reasoning_content';
  private readonly publicReasoning = new Map<string, string>();
  private finished = false;

  constructor(
    private readonly provider: AiProvider,
    private readonly api: AiOpenAiApi,
    private readonly onText: (text: string) => void,
    private readonly onReasoning: (text: string, kind: AiReasoningKind) => void = () => { /* 未注册展示监听时仍保留协议内容。 */ }
  ) {}

  accept(payload: WireItem): void {
    if (payload.error || payload.type === 'error' || payload.type === 'response.failed') {
      throw new Error(payload.error?.message || payload.response?.error?.message || '模型流式响应失败。');
    }
    if (this.provider === 'anthropic') {
      if (payload.type === 'content_block_start') {
        this.items.set(payload.index, { ...payload.content_block });
        if (payload.content_block?.type === 'thinking') this.addReasoning(`anthropic:${payload.index}`, payload.content_block.thinking, 'summary', true);
      } else if (payload.type === 'content_block_delta') {
        const item = this.items.get(payload.index);
        if (!item) {
          throw new Error('串流缺少内容块，无法安全执行工具。');
        }
        const delta = payload.delta || {};
        if (delta.type === 'text_delta') {
          item.text = (item.text || '') + (delta.text || '');
          this.addText(delta.text);
        } else if (delta.type === 'input_json_delta') {
          this.argumentBuffers.set(payload.index,
            (this.argumentBuffers.get(payload.index) || '') + (delta.partial_json || ''));
        } else if (delta.type === 'thinking_delta') {
          item.thinking = (item.thinking || '') + (delta.thinking || '');
          this.addReasoning(`anthropic:${payload.index}`, delta.thinking, 'summary');
        } else if (delta.type === 'signature_delta') {
          item.signature = (item.signature || '') + (delta.signature || '');
        }
      } else if (payload.type === 'message_stop') {
        this.finished = true;
      } else if (Array.isArray(payload.content)) {
        payload.content.forEach((item: WireItem, index: number) => {
          this.items.set(index, item);
          if (item.type === 'thinking') this.addReasoning(`anthropic:${index}`, item.thinking, 'summary', true);
        });
        this.addText(payload.content.filter((item: WireItem) => item.type === 'text').map((item: WireItem) => item.text || '').join(''));
        this.finished = true;
      }
      if (payload.delta?.stop_reason === 'max_tokens' || payload.stop_reason === 'max_tokens') {
        throw new Error('模型输出达到长度上限，工具参数可能不完整，未继续执行。');
      }
    } else if (this.api === 'responses') {
      if (payload.type === 'response.output_item.added' || payload.type === 'response.output_item.done') {
        this.items.set(payload.output_index, { ...payload.item });
        this.responseReasoning(payload.item, payload.output_index);
      } else if (payload.type === 'response.reasoning_summary_text.delta' || payload.type === 'response.reasoning_text.delta') {
        const summary = payload.type === 'response.reasoning_summary_text.delta';
        this.addReasoning(`responses:${payload.output_index}:${summary ? 'summary' : 'text'}:${summary ? payload.summary_index : payload.content_index}`, payload.delta, summary ? 'summary' : 'text');
      } else if (payload.type === 'response.reasoning_summary_text.done' || payload.type === 'response.reasoning_text.done') {
        const summary = payload.type === 'response.reasoning_summary_text.done';
        this.addReasoning(`responses:${payload.output_index}:${summary ? 'summary' : 'text'}:${summary ? payload.summary_index : payload.content_index}`, payload.text, summary ? 'summary' : 'text', true);
      } else if (payload.type === 'response.function_call_arguments.delta') {
        const item = this.items.get(payload.output_index);
        if (item) {
          item.arguments = (item.arguments || '') + (payload.delta || '');
        }
      } else if (payload.type === 'response.function_call_arguments.done') {
        const item = this.items.get(payload.output_index);
        if (item) {
          item.arguments = payload.arguments;
        }
      } else if (payload.type === 'response.output_text.delta') {
        this.addText(payload.delta);
      } else if (payload.type === 'response.completed') {
        if (payload.response?.output) {
          this.items.clear();
          payload.response.output.forEach((item: WireItem, index: number) => {
            this.items.set(index, item);
            this.responseReasoning(item, index);
          });
          this.addFinalText(this.responseText(payload.response));
        }
        this.finished = true;
      } else if (payload.type === 'response.incomplete') {
        throw new Error('模型响应不完整，未执行后续操作。');
      } else if (Array.isArray(payload.output)) {
        payload.output.forEach((item: WireItem, index: number) => {
          this.items.set(index, item);
          this.responseReasoning(item, index);
        });
        this.addFinalText(this.responseText(payload));
        this.finished = payload.status !== 'incomplete';
      }
    } else {
      const choice = payload.choices?.[0];
      if (!choice) {
        return;
      }
      const delta = choice.delta || choice.message || {};
      this.addText(typeof delta.content === 'string' ? delta.content : '');
      const reasoning = typeof delta.reasoning_content === 'string' ? delta.reasoning_content : delta.reasoning;
      if (typeof reasoning === 'string') {
        if (typeof delta.reasoning_content !== 'string') this.reasoningField = 'reasoning';
        this.reasoning += reasoning;
        this.addReasoning('chat', reasoning, 'text');
      }
      for (const call of delta.tool_calls || []) {
        const index = call.index ?? this.calls.size;
        const previous = this.calls.get(index) || { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (call.id) {
          previous.id = call.id;
        }
        previous.function.name += call.function?.name || '';
        previous.function.arguments += call.function?.arguments || '';
        this.calls.set(index, previous);
      }
      if (choice.finish_reason === 'length' || choice.finish_reason === 'content_filter') {
        throw new Error('模型输出被截断，未执行后续操作。');
      }
      if (choice.finish_reason || choice.message) {
        this.finished = true;
      }
    }
  }

  complete(): AiProviderTurn {
    if (!this.finished) {
      throw new Error('模型连接在响应完成前中断，未执行未完成的工具调用。');
    }
    let items = [...this.items.entries()].sort((a, b) => a[0] - b[0]).map((entry) => entry[1]);
    let calls: AiToolCall[];
    if (this.provider === 'anthropic') {
      this.items.forEach((item, index) => {
        const args = this.argumentBuffers.get(index);
        if (item.type === 'tool_use' && args !== undefined) {
          item.input = JSON.parse(args);
        }
      });
      calls = items.filter((item) => item.type === 'tool_use').map((item) => parseCall(item.id, item.name, item.input));
    } else if (this.api === 'responses') {
      calls = items.filter((item) => item.type === 'function_call').map((item) => parseCall(item.call_id, item.name, item.arguments));
    } else {
      const wireCalls = [...this.calls.entries()].sort((a, b) => a[0] - b[0]).map((entry) => entry[1]);
      calls = wireCalls.map((call) => parseCall(call.id, call.function.name, call.function.arguments));
      items = [{
        role: 'assistant',
        content: this.text || null,
        ...(wireCalls.length ? { tool_calls: wireCalls } : {}),
        ...(this.reasoning ? { [this.reasoningField]: this.reasoning } : {}),
      }];
    }
    return { text: this.text, items, calls };
  }

  private addText(value: unknown): void {
    if (typeof value === 'string' && value) {
      this.text += value;
      this.onText(value);
    }
  }

  private addReasoning(key: string, value: unknown, kind: AiReasoningKind, full = false): void {
    if (typeof value !== 'string' || !value) return;
    const previous = this.publicReasoning.get(key) || '';
    if (full && !value.startsWith(previous)) return;
    const delta = full ? value.slice(previous.length) : value;
    this.publicReasoning.set(key, full ? value : previous + value);
    if (delta) this.onReasoning((!previous && this.publicReasoning.size > 1 ? '\n\n' : '') + delta, kind);
  }

  private responseReasoning(item: WireItem | undefined, index: number): void {
    if (item?.type !== 'reasoning') return;
    (item.summary || []).forEach((part: WireItem, partIndex: number) => {
      if (part.type === 'summary_text') this.addReasoning(`responses:${index}:summary:${partIndex}`, part.text, 'summary', true);
    });
    (item.content || []).forEach((part: WireItem, partIndex: number) => {
      if (part.type === 'reasoning_text') this.addReasoning(`responses:${index}:text:${partIndex}`, part.text, 'text', true);
    });
  }

  private responseText(payload: WireItem): string {
    return typeof payload.output_text === 'string' ? payload.output_text : (payload.output || [])
      .filter((item: WireItem) => item.type === 'message')
      .flatMap((item: WireItem) => item.content || [])
      .filter((part: WireItem) => part.type === 'output_text' || part.type === 'text')
      .map((part: WireItem) => part.text || '').join('');
  }

  private addFinalText(text: string): void {
    if (text.startsWith(this.text)) this.addText(text.slice(this.text.length));
  }
}

export async function consumeAiResponse(
  response: Response,
  collector: AiProviderCollector
): Promise<AiProviderTurn> {
  if (response.headers.get('content-type')?.includes('application/json')) {
    collector.accept(await response.json());
    return collector.complete();
  }
  if (!response.body) {
    throw new Error('接口未返回响应内容。');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const consume = (frame: string): void => {
    const data = frame.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
    if (data && data !== '[DONE]') {
      collector.accept(JSON.parse(data));
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() || '';
      frames.forEach(consume);
      if (done) {
        break;
      }
      if (buffer.length > 4_000_000) {
        throw new Error('接口返回的单个事件过大。');
      }
    }
    if (buffer.trim()) {
      consume(buffer);
    }
    return collector.complete();
  } finally {
    reader.releaseLock();
  }
}
