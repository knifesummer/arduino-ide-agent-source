import React from '@theia/core/shared/react';
import { defaultAiAgentPrompt } from '../../common/ai-agent-prompt';

export interface PromptSettingsValue {
  readonly systemPrompt: string | null;
  readonly includeIdeContext: boolean;
}

export function AiAgentPromptSettings(
  props: PromptSettingsValue & {
    readonly disabled?: boolean;
    readonly onSave: (value: PromptSettingsValue) => Promise<boolean>;
  }
): React.ReactElement {
  const editor = React.useRef<HTMLTextAreaElement | null>(null);
  const [dirty, setDirty] = React.useState(false);
  const dirtyRef = React.useRef(false);
  const [useDefault, setUseDefault] = React.useState(
    props.systemPrompt === null
  );
  const [includeContext, setIncludeContext] = React.useState(
    props.includeIdeContext
  );
  const [saving, setSaving] = React.useState(false);
  const [notice, setNotice] = React.useState('');
  const markDirty = (): void => {
    dirtyRef.current = true;
    setDirty(true);
    setNotice('');
  };
  const resetDraft = (): void => {
    if (editor.current)
      editor.current.value = props.systemPrompt ?? defaultAiAgentPrompt();
    setUseDefault(props.systemPrompt === null);
    setIncludeContext(props.includeIdeContext);
    dirtyRef.current = false;
    setDirty(false);
    setNotice('');
  };
  React.useEffect(() => {
    if (dirtyRef.current) return;
    if (editor.current)
      editor.current.value = props.systemPrompt ?? defaultAiAgentPrompt();
    setUseDefault(props.systemPrompt === null);
    setIncludeContext(props.includeIdeContext);
  }, [props.systemPrompt, props.includeIdeContext]);
  return (
    <details className="agent-prompt-settings">
      <summary>
        内置提示词{' '}
        <span>{props.systemPrompt === null ? '默认规则' : '自定义规则'}</span>
      </summary>
      <p className="agent-muted">
        可完整替换默认提示词。保存后下一次请求生效，实际操作能力以 IDE
        工具和权限设置为准。
      </p>
      <textarea
        ref={editor}
        aria-label="Agent 内置提示词"
        className="agent-prompt-textarea"
        defaultValue={props.systemPrompt ?? defaultAiAgentPrompt()}
        maxLength={120_000}
        spellCheck={false}
        disabled={saving}
        onKeyDown={(event) => {
          if (event.key !== 'Tab') event.stopPropagation();
        }}
        onInput={() => {
          setUseDefault(false);
          markDirty();
        }}
      />
      <label className="agent-setting-checkbox">
        <input
          type="checkbox"
          checked={includeContext}
          disabled={saving}
          onChange={(event) => {
            setIncludeContext(event.target.checked);
            markDirty();
          }}
        />
        自动附加当前工程、板卡和近期操作上下文
      </label>
      <div className="agent-prompt-actions">
        <button
          type="button"
          className="theia-button"
          disabled={saving || props.disabled || !dirty}
          onClick={async () => {
            setSaving(true);
            try {
              const saved = await props.onSave({
                systemPrompt: useDefault ? null : editor.current?.value ?? '',
                includeIdeContext: includeContext,
              });
              if (saved) {
                dirtyRef.current = false;
                setDirty(false);
                setNotice('提示词已保存，下次请求使用新规则。');
              } else setNotice('保存失败，编辑内容已保留。');
            } catch {
              setNotice('保存失败，编辑内容已保留。');
            } finally {
              setSaving(false);
            }
          }}
        >
          保存提示词
        </button>
        <button
          type="button"
          className="theia-button secondary"
          disabled={saving}
          onClick={() => {
            if (editor.current) editor.current.value = defaultAiAgentPrompt();
            setUseDefault(true);
            markDirty();
            setNotice('已填入默认规则，点击保存后生效。');
          }}
        >
          恢复默认
        </button>
        <button
          type="button"
          className="theia-button secondary"
          disabled={!dirty || saving}
          onClick={resetDraft}
        >
          撤销编辑
        </button>
      </div>
      <div className="agent-muted" role="status">
        {notice || (dirty ? '有未保存的修改' : '规则已保存')}
      </div>
    </details>
  );
}
