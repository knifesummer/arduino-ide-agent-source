import { expect } from 'chai';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AiAgentHistoryStore } from '../../node/ai-agent-history';
import type { AiConversation } from '../../common/protocol/ai-agent-service';

describe('Agent 对话持久化', () => {
  let directory: string;
  let store: AiAgentHistoryStore;
  function newStore(): AiAgentHistoryStore {
    return new AiAgentHistoryStore(directory);
  }
  const conversation = (id: string): AiConversation => ({
    id,
    title: '按钮控制',
    createdAt: 1,
    updatedAt: 2,
    draft: '你好，继续修改',
    messages: [
      { role: 'user', content: '帮我编译' },
      { role: 'assistant', content: '已验证' },
    ],
  });
  beforeEach(async () => {
    directory = await fs.mkdtemp(join(tmpdir(), 'arduino-agent-history-test-'));
    store = newStore();
  });
  afterEach(async () => {
    // Only the mkdtemp directory created by this test is removed.
    await fs.rm(directory, { recursive: true, force: true });
  });
  it('重启后恢复完整消息、草稿和当前对话', async () => {
    const expected = conversation('chat_one');
    await store.save(expected);
    const restored = await newStore().read();
    expect(restored.activeId).eq(expected.id);
    expect(restored.conversations).deep.eq([expected]);
  });
  it('重启后保留可展开的思考记录，旧对话仍能读取', async () => {
    const record = conversation('chat_reasoning');
    const expected: AiConversation = {
      ...record,
      messages: [
        record.messages[0],
        {
          role: 'assistant',
          content: '结果',
          reasoning: '接口摘要',
          reasoningKind: 'summary',
        },
      ],
    };
    await store.save(expected);
    expect((await newStore().read()).conversations[0].messages).deep.eq(
      expected.messages
    );
    await store.save(conversation('old_chat'));
    expect((await newStore().read()).conversations.length).eq(2);
  });
  it('并发保存不会丢掉另一个会话', async () => {
    await Promise.all([
      store.save(conversation('chat_one')),
      store.save(conversation('chat_two')),
    ]);
    expect(
      (await store.read()).conversations.map((item) => item.id).sort()
    ).deep.eq(['chat_one', 'chat_two']);
  });
  it('关闭保留后不新增历史，已有对话仍可重命名和删除', async () => {
    await store.save(conversation('chat_one'));
    await store.setEnabled(false);
    await store.save(conversation('chat_new'));
    await store.save({ ...conversation('chat_one'), title: '重新命名' });
    const history = await store.read();
    expect(history.enabled).eq(false);
    expect(history.conversations.length).eq(1);
    expect(history.conversations[0].title).eq('重新命名');
    await store.delete('chat_one');
    expect((await newStore().read()).conversations).deep.eq([]);
  });
  it('损坏的历史文件不会被覆盖', async () => {
    const path = join(directory, 'ai-agent-history.json');
    await fs.writeFile(path, '{broken', 'utf8');
    let failed = false;
    try {
      await store.save(conversation('chat_one'));
    } catch {
      failed = true;
    }
    expect(failed).eq(true);
    expect(await fs.readFile(path, 'utf8')).eq('{broken');
  });
  it('重命名其他对话不会切换重启后恢复的当前对话', async () => {
    await store.save(conversation('chat_one'));
    await store.save(conversation('chat_two'));
    await store.save({ ...conversation('chat_one'), title: '改名' }, false);
    expect((await newStore().read()).activeId).eq('chat_two');
  });
});
