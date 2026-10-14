# Arduino IDE Agent

基于 [Arduino IDE 2.3.1](https://github.com/arduino/arduino-ide) 的桌面 AI 助手分支。对话面板停靠在 IDE 右侧，支持中文、独立滚动、历史对话和原生 Arduino 工具调用。这是预览项目，仍使用较早的 Arduino/Theia/Electron 基础版本，已知限制见 [安全说明](SECURITY.md)。

## 功能

- OpenAI Chat Completions、Responses 与 Anthropic Messages，支持第三方兼容接口与中转站。
- 自定义 Base URL、系统凭据中的 API Key、认证方式和额外请求头；预设及上游模型列表。
- 思考等级、可展开的接口思考或推理摘要、完整替换内置提示词和可选工程上下文。
- 草图读写、开发板及端口选择、编译、上传、烧录引导程序、库搜索安装、串口收发。
- Git 快照及回滚、可选对话历史、会话切换和中文组合输入。

没有开发板或依赖不完整时，实际编译及上传仍需补齐相应环境。新安装默认要求确认关键动作；可以在设置中主动选择自动执行。工具权限由程序控制，自定义提示词不改变权限检查。

使用说明：[接口与工具](docs/ai-agent.md)、[思考与提示词](docs/ai-agent-thinking-and-prompts.md)、[回答规范](docs/ai-agent-quality.md)。

## 从源码构建

基础版本要求 Node.js `>=18.17 <21`、Yarn Classic、Python 3 和原生模块构建工具。Windows 需要 MSVC；生成 Windows 原生启动器还需要 Go。源码包保留锁文件、源码、许可证、静态资源和测试，不带编译产物或依赖目录。

```powershell
corepack yarn install --frozen-lockfile
corepack yarn --cwd arduino-ide-extension build
corepack yarn --cwd electron-app rebuild
corepack yarn --cwd electron-app build
node electron-app/launcher/build.cjs
corepack yarn --cwd electron-app node scripts/package.js --win zip
```

最后两步用于 Windows ZIP。其他平台使用相应 electron-builder 目标，无需 Windows 启动器。打包脚本不自动发布，也不使用 Arduino 官方的发布存储配置。没有 Git 元数据的源码包从 `SOURCE-MANIFEST.json` 读取构建标识。

原生依赖需按测试或 Electron 运行目标分别重建，详情见 [开发指南](docs/development.md)。`yarn --cwd electron-app package` 的前置脚本会清理整个 `dist`；已有便携配置时，应使用上述直接调用脚本的命令并指定新的输出目录。

## 检查与源码导出

```powershell
python scripts/test-export-source.py
python scripts/export-source.py --check
python scripts/export-source.py
```

导出只选择 Git 跟踪的源码文件。默认生成 `release-source/arduino-ide-agent-source-<commit>.zip`，包含逐文件 SHA-256 清单；发现疑似凭据或本机路径时拒绝生成。不会复制 `.git`、个人配置、对话、日志、缓存、安装包或 `node_modules`。在提交新文件后再导出，避免漏掉尚未跟踪的实现。

测试、隐私边界及手动上传步骤见 [开源交付说明](docs/source-release.md)。真实提供商验证需要用户自己的配置和凭据，默认 CI 不读取凭据或调用收费模型。

## 来源与许可证

本项目是 Arduino IDE 的修改分支，沿用上游 **AGPL-3.0-or-later** 许可证，原始版权声明保留在源文件中。完整许可证见 [LICENSE.txt](LICENSE.txt)，上游项目及贡献说明见 [Arduino IDE](https://github.com/arduino/arduino-ide) 与 [原开发文档](docs/CONTRIBUTING.md)。
