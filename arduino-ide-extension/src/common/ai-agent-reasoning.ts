import type {
  AiOpenAiApi,
  AiProvider,
  AiReasoningLevel,
} from './protocol/ai-agent-service';

export function reasoningOptions(
  provider: AiProvider,
  api: AiOpenAiApi,
  level: AiReasoningLevel,
  display: boolean,
  model: string
): Record<string, unknown> {
  const effort =
    level === 'fast'
      ? 'low'
      : level === 'balanced'
      ? 'medium'
      : level === 'deep'
      ? 'high'
      : undefined;
  if (provider === 'openai') {
    if (api === 'responses')
      return effort || display
        ? {
            reasoning: {
              ...(effort ? { effort } : {}),
              ...(display ? { summary: 'auto' } : {}),
            },
          }
        : {};
    return effort ? { reasoning_effort: effort } : {};
  }
  if (!display && !effort) return {};
  const adaptive =
    /claude-(?:(?:opus|sonnet)-4[-.][6-9]|(?:opus|sonnet|haiku|mythos|fable)-5|mythos-preview)/i.test(
      model
    );
  if (adaptive)
    return {
      thinking: {
        type: 'adaptive',
        display: display ? 'summarized' : 'omitted',
      },
      ...(effort ? { output_config: { effort } } : {}),
    };
  const budget = level === 'fast' ? 1024 : level === 'deep' ? 4096 : 2048;
  return { thinking: { type: 'enabled', budget_tokens: budget } };
}

export function removeReasoningOptions(body: Record<string, unknown>): void {
  for (const key of [
    'reasoning',
    'reasoning_effort',
    'thinking',
    'output_config',
  ])
    delete body[key];
}
