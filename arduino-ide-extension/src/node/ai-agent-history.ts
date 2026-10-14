import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  AiConversation,
  AiConversationHistory,
} from '../common/protocol/ai-agent-service';

export class AiAgentHistoryStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly directory: string) {}

  private get path(): string {
    return join(this.directory, 'ai-agent-history.json');
  }

  async read(): Promise<AiConversationHistory> {
    await this.queue.catch(() => undefined);
    return this.readFile();
  }

  save(conversation: AiConversation, activate = true): Promise<void> {
    validateConversation(conversation);
    return this.change((history) => {
      if (
        !history.enabled &&
        !history.conversations.some((item) => item.id === conversation.id)
      ) {
        return history;
      }
      const records = history.conversations.filter(
        (item) => item.id !== conversation.id
      );
      if (records.length >= 100) {
        throw new Error('已有 100 个历史对话，请删除不需要的对话后继续保存。');
      }
      return {
        ...history,
        activeId: activate ? conversation.id : history.activeId,
        conversations: [conversation, ...records],
      };
    });
  }

  setEnabled(enabled: boolean): Promise<void> {
    return this.change((history) => ({ ...history, enabled }));
  }

  delete(id: string): Promise<void> {
    return this.change((history) => ({
      ...history,
      activeId: history.activeId === id ? undefined : history.activeId,
      conversations: history.conversations.filter((item) => item.id !== id),
    }));
  }

  clear(): Promise<void> {
    return this.change((history) => ({
      ...history,
      activeId: undefined,
      conversations: [],
    }));
  }

  private change(
    update: (history: AiConversationHistory) => AiConversationHistory
  ): Promise<void> {
    const task = this.queue
      .catch(() => undefined)
      .then(async () => {
        const history = update(await this.readFile());
        const value = JSON.stringify(history);
        if (Buffer.byteLength(value, 'utf8') > 32 * 1024 * 1024) {
          throw new Error(
            '对话历史超过 32 MB，未覆盖已有历史；请删除不需要的对话。'
          );
        }
        await fs.mkdir(dirname(this.path), { recursive: true });
        await fs.writeFile(this.path + '.tmp', value, 'utf8');
        await fs.rename(this.path + '.tmp', this.path);
      });
    this.queue = task;
    return task;
  }

  private async readFile(): Promise<AiConversationHistory> {
    try {
      const raw = await fs.readFile(this.path, 'utf8');
      const parsed = JSON.parse(raw) as AiConversationHistory;
      if (
        !parsed ||
        !Array.isArray(parsed.conversations) ||
        typeof parsed.enabled !== 'boolean'
      ) {
        throw new Error('对话历史格式不正确。');
      }
      parsed.conversations.forEach(validateConversation);
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { enabled: true, conversations: [] };
      }
      throw new Error('无法读取已有对话历史，已保留原文件，未覆盖。');
    }
  }
}

function validateConversation(value: AiConversation): void {
  if (
    !value ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(value.id) ||
    typeof value.title !== 'string' ||
    value.title.length > 120 ||
    !Number.isFinite(value.createdAt) ||
    !Number.isFinite(value.updatedAt) ||
    !Array.isArray(value.messages) ||
    value.messages.length > 1000 ||
    (value.draft !== undefined &&
      (typeof value.draft !== 'string' || value.draft.length > 120_000)) ||
    value.messages.some(
      (message) =>
        !message ||
        !['user', 'assistant', 'system'].includes(message.role) ||
        typeof message.content !== 'string' ||
        message.content.length > 2_000_000 ||
        (message.reasoning !== undefined && (typeof message.reasoning !== 'string' || message.reasoning.length > 500_000)) ||
        (message.reasoningKind !== undefined && !['text', 'summary'].includes(message.reasoningKind))
    )
  ) {
    throw new Error('对话历史数据无效或过大，未保存。');
  }
}
