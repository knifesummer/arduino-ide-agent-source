import { enableJSDOM } from '@theia/core/lib/browser/test/jsdom';
const disableJSDOM = enableJSDOM();
import { FrontendApplicationConfigProvider } from '@theia/core/lib/browser/frontend-application-config-provider';
FrontendApplicationConfigProvider.set({});
import { expect } from 'chai';
import { AiAgentTools } from '../../browser/ai-agent/ai-agent-tools';
disableJSDOM();

describe('Agent 工具操作回归', () => {
  it('重复打开串口监视器保持同一视图，不使用关闭开关', async () => {
    const tools = new AiAgentTools();
    const widget = { disposed: false };
    let opened: typeof widget | undefined;
    Object.defineProperty(tools, 'monitorView', {
      value: {
        openView: async () => {
          opened ??= widget;
          return opened;
        },
      },
    });
    await tools.execute('open_serial_monitor');
    await tools.execute('open_serial_monitor');
    expect(opened).eq(widget);
    expect(widget.disposed).eq(false);
  });

  function fileTools(readonly = false): {
    tools: AiAgentTools;
    writes: string[];
  } {
    const tools = new AiAgentTools();
    const writes: string[] = [];
    const sketch = {
      uri: 'file:///workspace/demo',
      mainFileUri: 'file:///workspace/demo/demo.ino',
      name: 'demo',
      files: [],
    };
    Object.defineProperty(tools, 'sketches', {
      value: { currentSketch: async () => sketch },
    });
    Object.defineProperty(tools, 'editorManager', {
      value: {
        getByUri: async () =>
          readonly ? { editor: { isReadonly: true } } : undefined,
      },
    });
    Object.defineProperty(tools, 'fileService', {
      value: {
        write: async (uri: { toString(): string }) => {
          writes.push(uri.toString());
        },
      },
    });
    return { tools, writes };
  }

  it('子目录与主草图同名时只修改指定子文件', async () => {
    const { tools, writes } = fileTools();
    await tools.execute('write_sketch_file', {
      path: 'src/demo.ino',
      content: '// auxiliary file',
    });
    expect(writes).deep.eq(['file:///workspace/demo/src/demo.ino']);
  });

  it('只读编辑器不能通过磁盘写入路径被绕过', async () => {
    const { tools, writes } = fileTools(true);
    try {
      await tools.execute('write_sketch_file', {
        path: 'config.h',
        content: '// config',
      });
      throw new Error('应该拒绝');
    } catch (error) {
      expect(String(error)).include('只读');
    }
    expect(writes).deep.eq([]);
  });
});
