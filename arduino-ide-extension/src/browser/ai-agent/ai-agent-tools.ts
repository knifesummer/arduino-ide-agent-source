import {
  inject,
  injectable,
  postConstruct,
} from '@theia/core/shared/inversify';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import URI from '@theia/core/lib/common/uri';
import { EditorManager } from '@theia/editor/lib/browser/editor-manager';
import { isWindows } from '@theia/core/lib/common/os';
import { MonitorViewContribution } from '../serial/monitor/monitor-view-contribution';
import {
  BoardsService,
  CoreService,
  LibraryService,
  LibraryPackage,
  PortIdentifier,
  MonitorManagerProxyClient,
} from '../../common/protocol';
import { BoardsServiceProvider } from '../boards/boards-service-provider';
import {
  CurrentSketch,
  SketchesServiceClientImpl,
} from '../sketches-service-client-impl';

export interface AiArduinoToolSchema {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export const AI_ARDUINO_TOOLS: AiArduinoToolSchema[] = [
  {
    name: 'get_context',
    description: '读取当前草图、板卡和串口上下文。',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'read_sketch',
    description: '读取当前 Arduino 草图的主 .ino 文件内容。',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'write_sketch',
    description: '将完整 Arduino C++ 代码写入当前草图的主 .ino 文件。',
    inputSchema: {
      type: 'object',
      required: ['content'],
      properties: { content: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'list_boards',
    description: '搜索或列出 Arduino 开发板。',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'list_ports',
    description: '列出当前检测到的串口和网络端口。',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'select_board',
    description: '按 FQBN 或精确名称选择开发板。',
    inputSchema: {
      type: 'object',
      properties: { fqbn: { type: 'string' }, name: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'select_port',
    description: '选择已检测到的端口。',
    inputSchema: {
      type: 'object',
      required: ['address', 'protocol'],
      properties: { address: { type: 'string' }, protocol: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'compile',
    description: '编译当前草图并返回成功或错误信息。',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'upload',
    description: '先编译，再将当前草图上传到已选择的开发板。',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'search_libraries',
    description: '按名称搜索 Arduino 库。',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: { query: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'install_library',
    description: '安装搜索结果中的指定 Arduino 库。',
    inputSchema: {
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string' }, version: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'list_sketch_files',
    description: '列出当前 Arduino 草图目录中的文件。',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'read_sketch_file',
    description: '读取当前草图目录中的指定文件，例如 include/config.h。',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: { path: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'write_sketch_file',
    description: '写入当前草图目录中的指定源文件。',
    inputSchema: {
      type: 'object',
      required: ['path', 'content'],
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'burn_bootloader',
    description: '向当前选定开发板烧录引导程序。此操作会重写引导区。',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'open_serial_monitor',
    description: '打开 Arduino 串口监视器并连接当前板卡端口。',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'send_serial',
    description: '向当前串口发送一条文本消息。',
    inputSchema: {
      type: 'object',
      required: ['message'],
      properties: {
        message: { type: 'string' },
        lineEnding: { type: 'string', enum: ['', '\\n', '\\r', '\\r\\n'] },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'read_serial',
    description: '读取 Agent 自打开串口监视器以来收到的串口消息。',
    inputSchema: {
      type: 'object',
      properties: { clear: { type: 'boolean' } },
      additionalProperties: false,
    },
  },
  {
    name: 'clear_serial',
    description: '清空 Agent 暂存的串口消息。',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
];

export interface AiArduinoContext {
  readonly sketchUri?: string;
  readonly sketchName?: string;
  readonly boardName?: string;
  readonly fqbn?: string;
  readonly port?: PortIdentifier;
  readonly detectedPorts?: readonly {
    readonly address: string;
    readonly protocol: string;
    readonly boards: readonly {
      readonly name: string;
      readonly fqbn: string | undefined;
    }[];
  }[];
}

export interface AiSketchContent {
  readonly sketchUri: string;
  readonly sketchName: string;
  readonly mainFileUri: string;
  readonly content: string;
  readonly truncated: boolean;
}

@injectable()
export class AiAgentTools {
  @inject(SketchesServiceClientImpl)
  private readonly sketches: SketchesServiceClientImpl;
  @inject(BoardsServiceProvider)
  private readonly boardsProvider: BoardsServiceProvider;
  @inject(BoardsService)
  private readonly boardsService: BoardsService;
  @inject(CoreService)
  private readonly coreService: CoreService;
  @inject(LibraryService)
  private readonly libraryService: LibraryService;
  @inject(FileService)
  private readonly fileService: FileService;
  @inject(EditorManager)
  private readonly editorManager: EditorManager;
  @inject(MonitorViewContribution)
  private readonly monitorView: MonitorViewContribution;
  @inject(MonitorManagerProxyClient)
  private readonly monitorManagerProxy: MonitorManagerProxyClient;
  private readonly serialBuffer: string[] = [];

  @postConstruct()
  protected init(): void {
    this.monitorManagerProxy.onMessagesReceived(({ messages }) => {
      for (const message of messages) {
        if (message) {
          this.serialBuffer.push(message);
        }
      }
      while (this.serialBuffer.length > 200) {
        this.serialBuffer.shift();
      }
    });
  }
  async getContext(): Promise<AiArduinoContext> {
    await this.boardsProvider.ready;
    const sketch = await this.sketches.currentSketch();
    const config = this.boardsProvider.boardsConfig;
    const detected = await this.boardsService.getDetectedPorts();
    return {
      ...(CurrentSketch.isValid(sketch)
        ? { sketchUri: sketch.uri, sketchName: sketch.name }
        : {}),
      ...(config.selectedBoard
        ? {
            boardName: config.selectedBoard.name,
            fqbn: config.selectedBoard.fqbn,
          }
        : {}),
      ...(config.selectedPort ? { port: config.selectedPort } : {}),
      detectedPorts: Object.values(detected).map(({ port, boards }) => ({
        address: port.address,
        protocol: port.protocol,
        boards: (boards || []).map((board) => ({
          name: board.name,
          fqbn: board.fqbn,
        })),
      })),
    };
  }

  async execute(
    name: string,
    input: Record<string, unknown> = {}
  ): Promise<unknown> {
    switch (name) {
      case 'get_context':
        return this.getContext();
      case 'read_sketch':
        return this.readSketch();
      case 'write_sketch':
        return this.writeSketch(asString(input.content) || '');
      case 'list_boards':
        return this.listBoards(asString(input.query));
      case 'list_ports':
        return this.listPorts();
      case 'select_board':
        return this.selectBoard(asString(input.fqbn), asString(input.name));
      case 'select_port':
        return this.selectPort(
          asString(input.address),
          asString(input.protocol)
        );
      case 'compile':
        return this.compile();
      case 'upload':
        return this.upload();
      case 'search_libraries':
        return this.searchLibraries(asString(input.query));
      case 'install_library':
        return this.installLibrary(
          asString(input.name),
          asString(input.version)
        );
      case 'list_sketch_files':
        return this.listSketchFiles();
      case 'read_sketch_file':
        return this.readSketchFile(asString(input.path) || '');
      case 'write_sketch_file':
        return this.writeSketchFile(
          asString(input.path) || '',
          typeof input.content === 'string' ? input.content : ''
        );
      case 'burn_bootloader':
        return this.burnBootloader();
      case 'open_serial_monitor':
        return this.openSerialMonitor();
      case 'send_serial':
        return this.sendSerial(
          typeof input.message === 'string' ? input.message : '',
          typeof input.lineEnding === 'string' ? input.lineEnding : '\n'
        );
      case 'read_serial':
        return this.readSerial(input.clear === true);
      case 'clear_serial':
        return this.clearSerial();
      default:
        throw new Error(`未知 Arduino 工具：${name}`);
    }
  }

  async readSketch(): Promise<AiSketchContent> {
    const sketch = await this.requireSketch();
    const mainFileUri = new URI(sketch.mainFileUri);
    const editorWidget = await this.editorManager.getByUri(mainFileUri);
    let diskValue: string | undefined;
    try {
      diskValue = (
        await this.fileService.read(mainFileUri, {
          acceptTextOnly: true,
        })
      ).value;
    } catch {
      // An editor can still provide an unsaved document when the provider is
      // temporarily unavailable.
    }
    const editorValue = editorWidget?.editor.document.getText();
    const value = editorWidget?.saveable.dirty
      ? editorValue || diskValue || ''
      : diskValue || editorValue || '';
    const maxCharacters = 120_000;
    return {
      sketchUri: sketch.uri,
      sketchName: sketch.name,
      mainFileUri: sketch.mainFileUri,
      content: value.slice(0, maxCharacters),
      truncated: value.length > maxCharacters,
    };
  }

  async writeSketch(content: string): Promise<Record<string, unknown>> {
    if (!content.trim()) {
      throw new Error('write_sketch 需要非空 Arduino C++ 代码。');
    }
    if (content.length > 2_000_000) {
      throw new Error('草图代码超过 2 MB，拒绝写入。');
    }
    if (content.includes('\u0000')) {
      throw new Error('草图代码包含非法空字符，拒绝写入。');
    }
    const sketch = await this.requireSketch();
    const mainFileUri = new URI(sketch.mainFileUri);
    if (!/\.(ino|pde)$/i.test(mainFileUri.path.base)) {
      throw new Error('当前草图主文件不是 .ino 或 .pde 文件。');
    }
    const editorWidget = await this.editorManager.getByUri(mainFileUri);
    if (editorWidget && !editorWidget.editor.isReadonly) {
      const document = editorWidget.editor.document;
      const source = document.getText();
      const replaced = await editorWidget.editor.replaceText({
        source,
        replaceOperations: [
          {
            range: {
              start: { line: 0, character: 0 },
              end: document.positionAt(source.length),
            },
            text: content,
          },
        ],
      });
      if (!replaced) {
        throw new Error('编辑器拒绝了草图修改。');
      }
      await document.save();
    } else {
      await this.fileService.write(mainFileUri, content, {
        encoding: 'utf8',
        overwriteEncoding: true,
      });
    }
    return {
      success: true,
      sketchName: sketch.name,
      mainFileUri: sketch.mainFileUri,
      characters: content.length,
      lines: content.split(/\r?\n/).length,
      message: '代码已实时写入当前草图。',
    };
  }

  private async listBoards(query?: string): Promise<unknown> {
    const boards = await this.boardsService.searchBoards({ query });
    return boards.map((board) => ({
      name: board.name,
      fqbn: board.fqbn,
      packageName: board.packageName,
    }));
  }

  private async listPorts(): Promise<unknown> {
    const detected = await this.boardsService.getDetectedPorts();
    return Object.values(detected).map(({ port, boards }) => ({
      address: port.address,
      protocol: port.protocol,
      addressLabel: port.addressLabel,
      boards: boards || [],
    }));
  }

  private async selectBoard(fqbn?: string, name?: string): Promise<unknown> {
    if (!fqbn && !name) {
      throw new Error('select_board 需要 fqbn 或 name。');
    }
    const boards = await this.boardsService.searchBoards({
      query: fqbn || name,
    });
    const selected = boards.find(
      (board) =>
        (fqbn && board.fqbn === fqbn) ||
        (!fqbn &&
          name &&
          board.name.toLocaleLowerCase() === name.toLocaleLowerCase())
    );
    if (!selected) {
      throw new Error('没有找到精确匹配的开发板，请先使用 list_boards。');
    }
    this.boardsProvider.updateConfig(selected);
    return this.getContext();
  }

  private async selectPort(
    address?: string,
    protocol?: string
  ): Promise<unknown> {
    if (!address || !protocol) {
      throw new Error('select_port 需要 address 和 protocol。');
    }
    const ports = await this.boardsService.getDetectedPorts();
    const exists = Object.values(ports).some(
      ({ port }) => port.address === address && port.protocol === protocol
    );
    if (!exists) {
      throw new Error('该端口当前未被 Arduino IDE 检测到。');
    }
    this.boardsProvider.updateConfig({ address, protocol });
    return this.getContext();
  }

  private async compile(): Promise<unknown> {
    const sketch = await this.requireSketch();
    const fqbn = this.requireBoard();
    await this.coreService.compile({
      sketch,
      fqbn,
      verbose: true,
      optimizeForDebug: false,
      sourceOverride: {},
    });
    return {
      success: true,
      message: '编译成功。',
      context: await this.getContext(),
    };
  }

  private async upload(): Promise<unknown> {
    const sketch = await this.requireSketch();
    const fqbn = this.requireBoard();
    const port = this.boardsProvider.boardsConfig.selectedPort;
    if (!port) {
      throw new Error('上传前请先选择开发板端口。');
    }
    await this.coreService.compile({
      sketch,
      fqbn,
      verbose: true,
      optimizeForDebug: false,
      sourceOverride: {},
    });
    const response = await this.coreService.upload({
      sketch,
      fqbn,
      port,
      verbose: true,
      verify: true,
      userFields: await this.boardsProvider.selectedBoardUserFields(),
    });
    this.boardsProvider.updateConfig(response.portAfterUpload);
    return {
      success: true,
      message: '上传成功。',
      context: await this.getContext(),
    };
  }

  private async searchLibraries(query?: string): Promise<unknown> {
    if (!query) {
      throw new Error('search_libraries 需要 query。');
    }
    const libraries = await this.libraryService.search({ query });
    return libraries.slice(0, 20).map((library) => summarizeLibrary(library));
  }

  private async installLibrary(
    name?: string,
    version?: string
  ): Promise<unknown> {
    if (!name) {
      throw new Error('install_library 需要 name。');
    }
    const libraries = await this.libraryService.search({ query: name });
    const selected = libraries.find(
      (library) => library.name.toLocaleLowerCase() === name.toLocaleLowerCase()
    );
    if (!selected) {
      throw new Error('没有找到精确匹配的库，请先使用 search_libraries。');
    }
    await this.libraryService.install({ item: selected, version });
    return { success: true, library: summarizeLibrary(selected) };
  }

  private async listSketchFiles(): Promise<unknown> {
    const sketch = await this.requireSketch();
    const root = new URI(sketch.uri);
    const stat = await this.fileService.resolve(root);
    return (stat.children || []).map((child) => ({
      path: child.name,
      isFile: child.isFile,
      isDirectory: child.isDirectory,
      size: child.size,
    }));
  }

  private async readSketchFile(relativePath: string): Promise<unknown> {
    const uri = await this.resolveSketchFile(relativePath);
    const editorWidget = await this.editorManager.getByUri(uri);
    const value = editorWidget?.editor.document.getText();
    const content =
      value ??
      (await this.fileService.read(uri, { acceptTextOnly: true })).value;
    return {
      path: relativePath,
      uri: uri.toString(),
      content: content.slice(0, 120_000),
      truncated: content.length > 120_000,
    };
  }

  private async writeSketchFile(
    relativePath: string,
    content: string
  ): Promise<unknown> {
    if (!content.trim()) {
      throw new Error('write_sketch_file 需要非空文件内容。');
    }
    if (content.length > 2_000_000) {
      throw new Error('草图文件超过 2 MB，拒绝写入。');
    }
    const uri = await this.resolveSketchFile(relativePath);
    if (
      uri.isEqual(
        new URI((await this.requireSketch()).mainFileUri).normalizePath(),
        !isWindows
      )
    ) {
      return this.writeSketch(content);
    }
    const editorWidget = await this.editorManager.getByUri(uri);
    if (editorWidget?.editor.isReadonly) {
      throw new Error('当前文件为只读，未覆盖文件。');
    }
    if (editorWidget) {
      const document = editorWidget.editor.document;
      const source = document.getText();
      const replaced = await editorWidget.editor.replaceText({
        source,
        replaceOperations: [
          {
            range: {
              start: { line: 0, character: 0 },
              end: document.positionAt(source.length),
            },
            text: content,
          },
        ],
      });
      if (!replaced) {
        throw new Error('编辑器拒绝了文件修改。');
      }
      await document.save();
    } else {
      await this.fileService.write(uri, content, {
        encoding: 'utf8',
        overwriteEncoding: true,
      });
    }
    return { success: true, path: relativePath, characters: content.length };
  }

  private async resolveSketchFile(relativePath: string): Promise<URI> {
    const sketch = await this.requireSketch();
    const normalized = relativePath.trim().replace(/\\/g, '/');
    const segments = normalized.split('/');
    if (
      !normalized ||
      normalized.startsWith('/') ||
      segments.some(
        (segment) => !segment || segment === '.' || segment === '..'
      ) ||
      !/^[A-Za-z0-9._/-]+$/.test(normalized)
    ) {
      throw new Error('文件路径必须是当前草图目录内的相对路径。');
    }
    const root = new URI(sketch.uri);
    const uri = root.resolve(normalized).normalizePath();
    const rootPath = root.path.toString().endsWith('/')
      ? root.path.toString().slice(0, -1)
      : root.path.toString();
    if (!uri.path.toString().startsWith(`${rootPath}/`)) {
      throw new Error('文件路径不能离开当前草图目录。');
    }
    return uri;
  }

  private async burnBootloader(): Promise<unknown> {
    const sketch = await this.requireSketch();
    const fqbn = this.requireBoard();
    const port = this.boardsProvider.boardsConfig.selectedPort;
    if (!port) {
      throw new Error('烧录引导程序前请先选择开发板端口。');
    }
    await this.coreService.burnBootloader({
      fqbn,
      port,
      verify: false,
      verbose: true,
    });
    return {
      success: true,
      message: '引导程序烧录成功。',
      sketch: sketch.name,
    };
  }

  private async openSerialMonitor(): Promise<unknown> {
    await this.monitorView.openView({ activate: true, reveal: true });
    return { success: true, message: '串口监视器已打开。' };
  }

  private async sendSerial(
    message: string,
    lineEnding: string
  ): Promise<unknown> {
    if (!message) {
      throw new Error('send_serial 需要 message。');
    }
    const connected = await this.monitorManagerProxy
      .isWSConnected()
      .catch(() => false);
    if (!connected) {
      throw new Error('串口监视器尚未连接，请先打开串口监视器并选择板卡端口。');
    }
    const ending =
      lineEnding === '\\r\\n' || lineEnding === '\r\n'
        ? '\r\n'
        : lineEnding === '\\r' || lineEnding === '\r'
        ? '\r'
        : lineEnding === '\\n' || lineEnding === '\n'
        ? '\n'
        : '';
    this.monitorManagerProxy.send(message + ending);
    return { success: true, message: '串口消息已发送。' };
  }

  private async readSerial(clear: boolean): Promise<unknown> {
    const messages = [...this.serialBuffer];
    if (clear) {
      this.serialBuffer.length = 0;
    }
    return {
      connected: await this.monitorManagerProxy
        .isWSConnected()
        .catch(() => false),
      messages,
      text: messages.join(''),
    };
  }

  private clearSerial(): unknown {
    this.serialBuffer.length = 0;
    return { success: true, message: '串口消息缓存已清空。' };
  }

  private async requireSketch() {
    const sketch = await this.sketches.currentSketch();
    if (!CurrentSketch.isValid(sketch)) {
      throw new Error('当前没有打开的 Arduino 草图。');
    }
    return sketch;
  }

  private requireBoard(): string {
    const fqbn = this.boardsProvider.boardsConfig.selectedBoard?.fqbn;
    if (!fqbn) {
      throw new Error('请先选择带 FQBN 的开发板。');
    }
    return fqbn;
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function summarizeLibrary(library: LibraryPackage): Record<string, unknown> {
  return {
    name: library.name,
    author: library.author,
    availableVersions: library.availableVersions,
    installedVersion: library.installedVersion,
    summary: library.summary,
    description: library.description,
  };
}
