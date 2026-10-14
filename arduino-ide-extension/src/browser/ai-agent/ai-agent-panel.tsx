import React from '@theia/core/shared/react';
// @ts-expect-error Theia's Node16 module build needs this type-only ESM bridge.
import type { Options } from 'react-markdown';
import type {
  AiConversation,
  AiModelInfo,
  AiAgentConfig,
  AiReasoningKind,
} from '../../common/protocol/ai-agent-service';
import { AI_AGENT_TEMPLATES } from './ai-agent-templates';

const Markdown = React.lazy<React.ComponentType<Options>>(
  // @ts-expect-error Same ESM bridge used by the IDE's release-notes view.
  () => import('react-markdown')
);

export interface AgentPanelMessage {
  readonly role: 'user' | 'assistant' | 'system';
  readonly content: string;
  readonly reasoning?: string;
  readonly reasoningKind?: AiReasoningKind;
}

export function resolveConversationTitle(
  previous: string | undefined,
  firstMessage: string | undefined
): string {
  return previous && previous !== '新对话'
    ? previous
    : firstMessage?.trim().slice(0, 40) || '新对话';
}

export interface AiAgentPanelProps {
  readonly messages: readonly AgentPanelMessage[];
  readonly conversations: readonly AiConversation[];
  readonly activeId: string;
  readonly status: string;
  readonly pending: boolean;
  readonly busy: boolean;
  readonly ready: boolean;
  readonly historyEnabled: boolean;
  readonly draft: string;
  readonly contextLabel: string;
  readonly config: AiAgentConfig;
  readonly models: readonly AiModelInfo[];
  readonly showSettings: boolean;
  readonly settings: React.ReactNode;
  readonly checkpoint?: string;
  readonly onSettings: (visible: boolean) => void;
  readonly onNew: () => void;
  readonly onSelect: (id: string) => void;
  readonly onRename: (id: string, title: string) => void;
  readonly onDelete: (id: string) => void;
  readonly onHistoryEnabled: (enabled: boolean) => void;
  readonly onDraft: (value: string) => void;
  readonly onSend: () => void;
  readonly onStop: () => void;
  readonly onModel: (model: string) => void;
  readonly onReasoning: (level: AiAgentConfig['reasoningLevel']) => void;
  readonly onPermission: (mode: AiAgentConfig['approvalMode']) => void;
  readonly onTemplate: (id: string) => void;
  readonly onTool: (name: string) => void;
  readonly onApply: (code?: string) => void;
  readonly onCheckpoint: () => void;
  readonly onRollback: () => void;
  readonly composerRef: (node: HTMLTextAreaElement | null) => void;
}

type IconName =
  | 'panel'
  | 'plus'
  | 'search'
  | 'chat'
  | 'changes'
  | 'settings'
  | 'arrow'
  | 'stop'
  | 'shield'
  | 'chevron'
  | 'copy'
  | 'check'
  | 'close'
  | 'edit'
  | 'trash'
  | 'chip'
  | 'sparkle';

const iconPaths: Record<IconName, string> = {
  panel:
    'M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z M9 3v18',
  plus: 'M12 5v14 M5 12h14',
  search: 'M16 16l5 5 M10.5 18a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15',
  chat: 'M21 11a9 9 0 0 1-9 9H4l-2 2V11a9 9 0 1 1 19 0z',
  changes: 'M5 3h12l3 3v15H5z M8 10h8 M12 6v8 M8 18h8',
  settings: 'M4 6h16 M4 12h16 M4 18h16 M8 3v6 M16 9v6 M10 15v6',
  arrow: 'M12 20V4 M5 11l7-7 7 7',
  stop: 'M7 7h10v10H7z',
  shield: 'M12 2l8 3v7c0 5-8 10-8 10S4 17 4 12V5l8-3z M12 7v5 M12 16h.01',
  chevron: 'M7 10l5 5 5-5',
  copy: 'M9 8h11v13H9z M15 4V2H3v15h2',
  check: 'M5 12l4 4L20 5',
  close: 'M6 6l12 12 M18 6 6 18',
  edit: 'M4 20l4-1L20 7l-3-3L5 16z M14 7l3 3',
  trash: 'M4 6h16 M9 6V3h6v3 M6 6l1 15h10l1-15 M10 10v7 M14 10v7',
  chip: 'M6 6h12v12H6z M9 9h6v6H9z M9 2v4 M15 2v4 M9 18v4 M15 18v4 M2 9h4 M2 15h4 M18 9h4 M18 15h4',
  sparkle: 'M12 2l3 7 7 3-7 3-3 7-3-7-7-3 7-3z',
};

function Icon({ name }: { readonly name: IconName }): React.ReactElement {
  return (
    <svg
      aria-hidden="true"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={iconPaths[name]} />
    </svg>
  );
}

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const element = document.createElement('textarea');
  element.value = text;
  element.style.position = 'fixed';
  element.style.opacity = '0';
  document.body.appendChild(element);
  element.select();
  const copied = document.execCommand('copy');
  element.remove();
  if (!copied) {
    throw new Error('复制失败');
  }
}

function CopyButton({
  text,
  label = '复制',
}: {
  readonly text: string;
  readonly label?: string;
}): React.ReactElement {
  const [state, setState] = React.useState<'idle' | 'done' | 'error'>('idle');
  React.useEffect(() => {
    if (state === 'idle') return;
    const timer = window.setTimeout(() => setState('idle'), 1600);
    return () => window.clearTimeout(timer);
  }, [state]);
  return (
    <button
      type="button"
      className="agent-icon-button"
      aria-label={state === 'done' ? '已复制' : label}
      title={state === 'error' ? '复制失败，请手动选择文字' : label}
      onClick={() => {
        void copyText(text).then(
          () => setState('done'),
          () => setState('error')
        );
      }}
    >
      <Icon name={state === 'done' ? 'check' : 'copy'} />
      {label === '复制代码' && (
        <span>
          {state === 'done'
            ? '已复制'
            : state === 'error'
            ? '复制失败'
            : '复制'}
        </span>
      )}
    </button>
  );
}

function AssistantMessage({
  text,
  busy,
  onApply,
}: {
  readonly text: string;
  readonly busy: boolean;
  readonly onApply: (code?: string) => void;
}): React.ReactElement {
  return (
    <React.Suspense fallback={<div className="agent-markdown">{text}</div>}>
      <Markdown
        className="agent-markdown"
        skipHtml
        components={{
          a: ({ href, children }) => (
            <a
              href={/^https?:\/\//i.test(href || '') ? href : undefined}
              target="_blank"
              rel="noopener noreferrer"
            >
              {children}
            </a>
          ),
          pre: ({ children }) => (
            <div className="agent-code-block">{children}</div>
          ),
          code: ({ inline, className, children }) => {
            const code = String(children).replace(/\n$/, '');
            if (inline)
              return <code className="agent-inline-code">{children}</code>;
            return (
              <React.Fragment>
                <div className="agent-code-toolbar">
                  <span>{className?.replace('language-', '') || '代码'}</span>
                  <div>
                    <CopyButton text={code} label="复制代码" />
                    {/\bvoid\s+setup\s*\(/.test(code) &&
                      /\bvoid\s+loop\s*\(/.test(code) && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => onApply(code)}
                        >
                          应用到草图
                        </button>
                      )}
                  </div>
                </div>
                <pre>
                  <code className={className}>{children}</code>
                </pre>
              </React.Fragment>
            );
          },
        }}
      >
        {text}
      </Markdown>
    </React.Suspense>
  );
}

export function operationLabel(content: string): string {
  const names: Record<string, string> = {
    get_context: '读取工程上下文',
    read_sketch: '读取当前草图',
    write_sketch: '更新草图',
    list_boards: '查找开发板',
    list_ports: '检测端口',
    select_board: '选择开发板',
    select_port: '选择端口',
    compile: '编译草图',
    upload: '上传草图',
    burn_bootloader: '烧录引导程序',
    search_libraries: '查找库',
    install_library: '安装库',
    read_serial: '读取串口',
    send_serial: '发送串口消息',
    open_serial_monitor: '打开串口监视器',
    clear_serial: '清空串口',
    list_sketch_files: '浏览草图文件',
    read_sketch_file: '读取工程文件',
    write_sketch_file: '更新工程文件',
  };
  const name = content.match(
    /(?:工具：|工具:|模型调用工具：)\s*([a-z_]+)/
  )?.[1];
  if (name) return names[name] || '执行 Arduino 操作';
  if (/失败|错误|取消/.test(content))
    return content.split('\n')[0].slice(0, 70);
  try {
    const value = JSON.parse(content);
    if (value && typeof value.message === 'string') return value.message;
    if (value?.success) return '操作完成';
  } catch {
    /* A text operation entry needs no JSON parsing. */
  }
  return content.startsWith('{') || content.startsWith('[')
    ? '操作结果'
    : content.split('\n')[0].slice(0, 70);
}

export function AiAgentPanel(props: AiAgentPanelProps): React.ReactElement {
  const [showHistory, setShowHistory] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [menu, setMenu] = React.useState<
    'tools' | 'model' | 'permission' | undefined
  >();
  const [showChanges, setShowChanges] = React.useState(false);
  const [editing, setEditing] = React.useState<string>();
  const [title, setTitle] = React.useState('');
  const [deleting, setDeleting] = React.useState<string>();
  const input = React.useRef<HTMLTextAreaElement | null>(null);
  const composing = React.useRef(false);
  const viewport = React.useRef<HTMLDivElement | null>(null);
  const stickToBottom = React.useRef(true);
  const active = props.conversations.find(
    (record) => record.id === props.activeId
  );
  const conversationTitle =
    active?.title ||
    props.messages
      .find((message) => message.role === 'user')
      ?.content.slice(0, 35) ||
    '新对话';
  const history = [...props.conversations]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .filter((record) =>
      record.title.toLocaleLowerCase().includes(query.toLocaleLowerCase())
    );
  const toolMessages = props.messages.filter(
    (message) => message.role === 'system'
  );
  const lastMessage = props.messages[props.messages.length - 1];
  React.useLayoutEffect(() => {
    const node = viewport.current;
    if (node && stickToBottom.current) node.scrollTop = node.scrollHeight;
  }, [
    props.messages.length,
    lastMessage?.content,
    lastMessage?.reasoning,
    props.activeId,
  ]);
  React.useLayoutEffect(() => {
    stickToBottom.current = true;
    if (viewport.current)
      viewport.current.scrollTop = viewport.current.scrollHeight;
  }, [props.activeId]);
  const closeMenu = (): void => setMenu(undefined);
  const models = new Map(props.models.map((model) => [model.id, model]));
  models.set(props.config.model, { id: props.config.model });
  const busy = props.busy || !props.ready;
  const iconButton = (
    icon: IconName,
    label: string,
    action: () => void,
    disabled = false,
    pressed?: boolean
  ): React.ReactNode => (
    <button
      type="button"
      className="agent-icon-button"
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={action}
    >
      <Icon name={icon} />
    </button>
  );
  const messageRows: React.ReactNode[] = [];
  for (let index = 0; index < props.messages.length; index++) {
    const message = props.messages[index];
    if (
      message.role === 'assistant' &&
      !message.content &&
      (!message.reasoning || props.config.displayReasoning === false) &&
      (!props.pending || index !== props.messages.length - 1)
    ) {
      continue;
    }
    if (message.role === 'system') {
      const group: string[] = [message.content];
      const start = index;
      while (props.messages[index + 1]?.role === 'system')
        group.push(props.messages[++index].content);
      messageRows.push(
        <details key={'operation-' + start} className="agent-operation">
          <summary>
            <Icon
              name={
                group.some((item) => /失败|错误/.test(item))
                  ? 'shield'
                  : 'check'
              }
            />
            <span>{operationLabel(group[0])}</span>
            <span className="agent-muted">
              {group.length > 1 ? group.length + ' 条记录' : '查看详情'}
            </span>
            <Icon name="chevron" />
          </summary>
          <div className="agent-operation-body">
            {group.map((entry, entryIndex) => (
              <pre key={entryIndex}>{entry}</pre>
            ))}
          </div>
        </details>
      );
      continue;
    }
    const streaming =
      props.pending &&
      index === props.messages.length - 1 &&
      message.role === 'assistant';
    messageRows.push(
      <article
        key={message.role + '-' + index}
        className={'agent-message ' + message.role}
      >
        {message.role === 'assistant' && (
          <div className="agent-author">
            <Icon name="sparkle" />
            <span>Arduino Agent</span>
            {streaming && <span className="agent-generating">正在处理</span>}
          </div>
        )}
        {message.role === 'assistant' &&
          message.reasoning &&
          props.config.displayReasoning !== false && (
            <details className="agent-reasoning">
              <summary>
                <Icon name="chevron" />
                <span>
                  {message.reasoningKind === 'summary'
                    ? '推理摘要'
                    : '思考过程'}
                </span>
                {streaming && (
                  <span className="agent-generating">正在思考</span>
                )}
              </summary>
              <div className="agent-reasoning-body">
                <div className="agent-muted">模型接口返回的内容</div>
                <div className="agent-reasoning-text">{message.reasoning}</div>
                <CopyButton text={message.reasoning} label="复制思考文本" />
              </div>
            </details>
          )}
        <div className="agent-message-content">
          {message.role === 'user' ? (
            message.content
          ) : message.content ? (
            <AssistantMessage
              text={message.content}
              busy={busy}
              onApply={props.onApply}
            />
          ) : props.pending && streaming && !message.reasoning ? (
            <span className="agent-thinking">
              正在读取工程并思考<span>···</span>
            </span>
          ) : null}
        </div>
        {message.content && !streaming && (
          <div className="agent-message-actions">
            <CopyButton text={message.content} label="复制消息" />
            {message.role === 'user' &&
              iconButton(
                'edit',
                '编辑并再次提问',
                () => {
                  props.onDraft(message.content);
                  if (input.current) {
                    input.current.value = message.content;
                    input.current.focus();
                  }
                },
                busy
              )}
          </div>
        )}
      </article>
    );
  }
  return (
    <div
      className={
        'arduino-ai-agent-root agent-workspace' +
        (showHistory ? ' history-visible' : '')
      }
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          closeMenu();
          props.onSettings(false);
          setDeleting(undefined);
        }
      }}
    >
      <aside
        className="agent-history"
        aria-label="对话侧栏"
        hidden={!showHistory}
      >
        <div className="agent-history-brand">
          <Icon name="sparkle" />
          <strong>Arduino Agent</strong>
          {iconButton('panel', '收起对话侧栏', () => setShowHistory(false))}
        </div>
        <button
          type="button"
          className="agent-new-chat"
          onClick={props.onNew}
          disabled={busy}
        >
          <Icon name="edit" />
          <span>新对话</span>
        </button>
        <div className="agent-history-search">
          <Icon name="search" />
          <input
            aria-label="搜索历史对话"
            placeholder="搜索对话"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="agent-history-list">
          <div className="agent-history-section">
            <Icon name="chip" />
            <span>工程</span>
          </div>
          <div className="agent-history-project" title={props.contextLabel}>
            {props.contextLabel.split(' · ')[0] || '当前草图'}
          </div>
          <div className="agent-history-section">最近的对话</div>
          {!history.length && (
            <div className="agent-history-empty">
              {query ? '没有匹配的对话' : '你的对话会显示在这里'}
            </div>
          )}
          {history.map((record) => (
            <div
              key={record.id}
              className={
                'agent-history-item' +
                (record.id === props.activeId ? ' active' : '')
              }
            >
              {editing === record.id ? (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (title.trim()) {
                      props.onRename(record.id, title.trim());
                      setEditing(undefined);
                    }
                  }}
                >
                  <input
                    aria-label="对话名称"
                    autoFocus
                    value={title}
                    maxLength={80}
                    onChange={(event) => setTitle(event.target.value)}
                  />
                  <button
                    type="submit"
                    className="agent-icon-button"
                    aria-label="保存对话名称"
                  >
                    <Icon name="check" />
                  </button>
                  {iconButton('close', '取消重命名', () =>
                    setEditing(undefined)
                  )}
                </form>
              ) : (
                <React.Fragment>
                  <button
                    type="button"
                    className="agent-history-open"
                    title={record.title}
                    disabled={busy}
                    onClick={() => {
                      props.onSelect(record.id);
                      if ((viewport.current?.clientWidth || 0) < 600)
                        setShowHistory(false);
                    }}
                  >
                    <span>{record.title}</span>
                    <small>
                      {new Date(record.updatedAt).toLocaleDateString('zh-CN', {
                        month: '2-digit',
                        day: '2-digit',
                      })}
                    </small>
                  </button>
                  <div className="agent-history-item-actions">
                    {iconButton(
                      'edit',
                      '重命名对话',
                      () => {
                        setEditing(record.id);
                        setTitle(record.title);
                      },
                      busy
                    )}
                    {iconButton(
                      'trash',
                      '删除对话',
                      () => setDeleting(record.id),
                      busy
                    )}
                  </div>
                </React.Fragment>
              )}
              {deleting === record.id && (
                <div className="agent-delete-confirm">
                  <span>删除这条对话？</span>
                  <button
                    type="button"
                    onClick={() => {
                      props.onDelete(record.id);
                      setDeleting(undefined);
                    }}
                  >
                    删除
                  </button>
                  <button type="button" onClick={() => setDeleting(undefined)}>
                    取消
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
        <label className="agent-history-retention">
          <input
            type="checkbox"
            checked={props.historyEnabled}
            disabled={!props.ready}
            onChange={(event) => props.onHistoryEnabled(event.target.checked)}
          />
          保留对话历史
          <span>{props.historyEnabled ? '本地保存' : '临时对话'}</span>
        </label>
      </aside>
      <div className="agent-chat">
        <header className="agent-topbar">
          {iconButton(
            'panel',
            '显示对话侧栏',
            () => setShowHistory(!showHistory),
            false,
            showHistory
          )}
          <div className="agent-conversation-title" title={conversationTitle}>
            <Icon name="chat" />
            <span>{conversationTitle}</span>
          </div>
          <button
            type="button"
            className={'agent-tab' + (showChanges ? ' active' : '')}
            onClick={() => setShowChanges(!showChanges)}
            aria-expanded={showChanges}
          >
            <Icon name="changes" />
            <span>变更</span>
            {toolMessages.length > 0 && <small>{toolMessages.length}</small>}
          </button>
          <div className="agent-topbar-spacer" />
          {iconButton('plus', '新对话', props.onNew, busy)}
          {iconButton(
            'settings',
            '连接设置',
            () => props.onSettings(!props.showSettings),
            false,
            props.showSettings
          )}
        </header>
        <div className="agent-contextbar">
          <span className="agent-context-chip" title={props.contextLabel}>
            <Icon name="chip" />
            {props.contextLabel || '当前草图'}
          </span>
          <span
            className={'agent-status' + (props.pending ? ' is-busy' : '')}
            role="status"
            title={props.status}
          >
            {props.status}
          </span>
        </div>
        {showChanges && (
          <section className="agent-changes" aria-label="操作与变更">
            <div>
              <strong>操作与变更</strong>
              {iconButton('close', '关闭变更面板', () => setShowChanges(false))}
            </div>
            <p>
              {props.checkpoint
                ? '已有 Git 快照 ' + props.checkpoint.slice(0, 8)
                : '创建 Git 快照，可以恢复工程文件。'}
            </p>
            <div className="agent-change-actions">
              <button
                type="button"
                disabled={busy}
                onClick={props.onCheckpoint}
              >
                创建快照
              </button>
              <button
                type="button"
                disabled={busy || !props.checkpoint}
                onClick={props.onRollback}
              >
                恢复快照
              </button>
            </div>
            {toolMessages.length ? (
              toolMessages.slice(-6).map((message, index) => (
                <details key={index}>
                  <summary>{operationLabel(message.content)}</summary>
                  <pre>{message.content}</pre>
                </details>
              ))
            ) : (
              <span className="agent-muted">本对话还没有操作记录</span>
            )}
          </section>
        )}
        <div
          className="agent-transcript"
          ref={viewport}
          role="log"
          aria-label="对话消息"
          aria-busy={props.pending}
          onScroll={() => {
            const node = viewport.current;
            if (node)
              stickToBottom.current =
                node.scrollHeight - node.scrollTop - node.clientHeight < 72;
          }}
        >
          {!props.messages.length ? (
            <div className="agent-welcome">
              <div className="agent-welcome-logo">
                <Icon name="sparkle" />
              </div>
              <h2>一起完成你的 Arduino 项目</h2>
              <p>编写代码、检查报错、连接开发板，或直接上传草图。</p>
              <div className="agent-suggestions">
                {AI_AGENT_TEMPLATES.slice(0, 4).map((template) => (
                  <button
                    type="button"
                    key={template.id}
                    disabled={busy}
                    onClick={() => props.onTemplate(template.id)}
                  >
                    <Icon name="chat" />
                    <span>
                      {template.title}
                      <small>{template.summary}</small>
                    </span>
                    <Icon name="chevron" />
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="agent-message-list">{messageRows}</div>
          )}
        </div>
        <footer className="agent-composer-area">
          <div className="agent-composer">
            <textarea
              aria-label="给 AI 助手的消息"
              placeholder="提问、修改草图，或者让 Agent 帮你完成操作…"
              defaultValue={props.draft}
              ref={(node) => {
                input.current = node;
                props.composerRef(node);
              }}
              rows={3}
              onChange={(event) => props.onDraft(event.currentTarget.value)}
              onCompositionStart={() => {
                composing.current = true;
              }}
              onCompositionEnd={(event) => {
                composing.current = false;
                props.onDraft(event.currentTarget.value);
              }}
              onBlur={(event) => {
                composing.current = false;
                props.onDraft(event.currentTarget.value);
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Tab') event.stopPropagation();
                if (
                  event.key === 'Enter' &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing &&
                  !composing.current &&
                  event.keyCode !== 229
                ) {
                  event.preventDefault();
                  if (!busy && input.current?.value.trim()) {
                    props.onDraft(input.current.value);
                    props.onSend();
                  }
                }
              }}
            />
            <div className="agent-composer-toolbar">
              <div className="agent-composer-left">
                <button
                  type="button"
                  className="agent-icon-button"
                  aria-label="添加上下文或执行操作"
                  title="上下文与 Arduino 操作"
                  aria-expanded={menu === 'tools'}
                  onClick={() =>
                    setMenu(menu === 'tools' ? undefined : 'tools')
                  }
                >
                  <Icon name="plus" />
                </button>
                <button
                  type="button"
                  className={'agent-permission ' + props.config.approvalMode}
                  disabled={busy}
                  onClick={() =>
                    setMenu(menu === 'permission' ? undefined : 'permission')
                  }
                  aria-expanded={menu === 'permission'}
                >
                  <Icon name="shield" />
                  <span>
                    {props.config.approvalMode === 'auto'
                      ? '完全访问'
                      : '操作确认'}
                  </span>
                </button>
              </div>
              <div className="agent-composer-right">
                <button
                  type="button"
                  className="agent-model-choice"
                  disabled={busy}
                  onClick={() =>
                    setMenu(menu === 'model' ? undefined : 'model')
                  }
                  aria-expanded={menu === 'model'}
                  title="选择模型与思考等级"
                >
                  <span>
                    {props.config.model || '选择模型'}
                    <small>
                      {
                        {
                          auto: '自动',
                          fast: '快速',
                          balanced: '平衡',
                          deep: '深度',
                        }[props.config.reasoningLevel]
                      }
                    </small>
                  </span>
                  <Icon name="chevron" />
                </button>
                <button
                  type="button"
                  className="agent-send"
                  disabled={props.pending ? false : busy || !props.draft.trim()}
                  aria-label={props.pending ? '停止当前请求' : '发送消息'}
                  title={props.pending ? '停止当前请求' : '发送消息'}
                  onClick={props.pending ? props.onStop : props.onSend}
                >
                  <Icon name={props.pending ? 'stop' : 'arrow'} />
                </button>
              </div>
            </div>
          </div>
          <div className="agent-composer-hint">
            <span>Enter 发送 · Shift+Enter 换行</span>
            <span>
              {props.historyEnabled ? '对话保存在本机' : '不保留当前对话'}
            </span>
          </div>
          {menu && (
            <React.Fragment>
              <button
                type="button"
                className="agent-menu-dismiss"
                aria-label="关闭操作菜单"
                onClick={closeMenu}
              />
              <div
                className={'agent-popup ' + menu}
                role="dialog"
                aria-label={
                  menu === 'model'
                    ? '模型与思考等级'
                    : menu === 'permission'
                    ? 'Agent 权限'
                    : 'Arduino 操作'
                }
              >
                <div className="agent-popup-heading">
                  <strong>
                    {menu === 'model'
                      ? '模型与思考等级'
                      : menu === 'permission'
                      ? 'Agent 权限'
                      : 'Arduino 操作'}
                  </strong>
                  {iconButton('close', '关闭菜单', closeMenu)}
                </div>
                {menu === 'tools' && (
                  <div className="agent-tool-menu">
                    {[
                      ['get_context', '读取板卡与端口'],
                      ['read_sketch', '读取当前代码'],
                      ['list_sketch_files', '浏览工程文件'],
                      ['compile', '编译草图'],
                      ['upload', '上传到开发板'],
                      ['open_serial_monitor', '打开串口监视器'],
                      ['read_serial', '读取串口输出'],
                      ['burn_bootloader', '烧录引导程序'],
                    ].map(([name, label]) => (
                      <button
                        type="button"
                        disabled={busy}
                        key={name}
                        onClick={() => {
                          closeMenu();
                          props.onTool(name);
                        }}
                      >
                        {label}
                      </button>
                    ))}
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        closeMenu();
                        props.onCheckpoint();
                      }}
                    >
                      创建 Git 快照
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        closeMenu();
                        props.onApply();
                      }}
                    >
                      应用最近的 AI 代码
                    </button>
                  </div>
                )}
                {menu === 'permission' && (
                  <div className="agent-permission-options">
                    <button
                      type="button"
                      className={
                        props.config.approvalMode === 'confirm'
                          ? 'selected'
                          : ''
                      }
                      onClick={() => {
                        props.onPermission('confirm');
                        closeMenu();
                      }}
                    >
                      <strong>操作确认</strong>
                      <span>上传或烧录前由你确认</span>
                    </button>
                    <button
                      type="button"
                      className={
                        props.config.approvalMode === 'auto' ? 'selected' : ''
                      }
                      onClick={() => {
                        props.onPermission('auto');
                        closeMenu();
                      }}
                    >
                      <strong>完全访问</strong>
                      <span>根据指令编辑草图和执行 Arduino 操作</span>
                    </button>
                  </div>
                )}
                {menu === 'model' && (
                  <div className="agent-model-menu">
                    <label>
                      模型
                      <select
                        aria-label="选择模型"
                        value={props.config.model}
                        onChange={(event) => props.onModel(event.target.value)}
                      >
                        {[...models.values()].map((model) => (
                          <option key={model.id} value={model.id}>
                            {model.label || model.id}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      type="button"
                      className="agent-text-button"
                      onClick={() => {
                        closeMenu();
                        props.onSettings(true);
                      }}
                    >
                      连接设置 / 拉取更多模型
                    </button>
                    <label>
                      思考等级
                      <select
                        aria-label="选择思考等级"
                        value={props.config.reasoningLevel}
                        onChange={(event) =>
                          props.onReasoning(
                            event.target
                              .value as AiAgentConfig['reasoningLevel']
                          )
                        }
                      >
                        <option value="auto">自动</option>
                        <option value="fast">快速（low）</option>
                        <option value="balanced">平衡（medium）</option>
                        <option value="deep">深度（high）</option>
                      </select>
                    </label>
                  </div>
                )}
              </div>
            </React.Fragment>
          )}
        </footer>
        {props.showSettings && (
          <section className="agent-settings-drawer" aria-label="连接设置">
            <div className="agent-settings-heading">
              <div>
                <strong>连接与模型</strong>
                <p>配置你的模型提供商</p>
              </div>
              {iconButton('close', '关闭连接设置', () =>
                props.onSettings(false)
              )}
            </div>
            <div className="agent-settings-scroll">{props.settings}</div>
          </section>
        )}
      </div>
    </div>
  );
}
