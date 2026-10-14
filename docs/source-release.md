# 开源源码交付

源码包只包含实现、必要静态资源、构建配置、锁文件、测试、使用文档及许可证。`SOURCE-MANIFEST.json` 记录相对路径、文件大小、SHA-256 和源提交标识，不含提交作者、邮箱、远程凭据或本机路径。

## 排除范围

- `.git` 及提交历史、上游发布和同步工作流。
- `agent-data`、`.arduinoIDE-Agent`、本机 Agent 配置、对话历史、自定义个人提示词。
- `.env`、证书和私钥、日志、临时验证结果、缓存及下载文件。
- `node_modules`、`lib`、`src-gen`、`dist`、程序 EXE/DLL 和安装包。

Windows 启动器保留 Go 源码与构建脚本，EXE 在本机生成。供压缩工具回归使用的小型合成 ZIP 测试夹具保留，并扫描内部条目。`.github/workflows/agent-check.yml` 是仅有的导出工作流，只运行源码隐私、类型检查和离线 Agent 回归，不发布应用。

## 运行检查

```powershell
corepack yarn --cwd arduino-ide-extension build
corepack yarn --cwd arduino-ide-extension test
corepack yarn --cwd electron-app test
node scripts/qa-agent-panel.cjs
python scripts/test-export-source.py
python scripts/export-source.py --check
corepack yarn audit --json
```

Mocha 与当前原生模块必须使用匹配的 Node/Electron ABI。上游浏览器测试需要对应的原生模块重建；在 Electron 的 Node 环境中测试时使用 `ELECTRON_RUN_AS_NODE=1`。测试临时目录应可写；遇到权限阻止时可为该测试进程指定项目内的临时目录，不需要关闭系统防护。Windows PowerShell 启动修复回归使用系统默认临时环境，验证下载标记、文件摘要及脚本入口。

界面验收脚本需要已构建的扩展、`puppeteer-core` 和已安装的 Edge/Chrome；不会访问模型或真实工程。提供商 QA 脚本仅用于显式运行的验证，需要自己的配置与凭据，不随开源包提供个人配置。

## 上传到新 GitHub 仓库

1. 解压源码包，将 `arduino-ide-agent-source` 中的文件作为新仓库内容。
2. 保留 `.gitignore`、`LICENSE.txt`、文档和 `SOURCE-MANIFEST.json`；上传前查看文件清单。
3. 在这个干净目录创建新 Git 仓库，或者通过 GitHub 上传该目录内的文件。不要复制原工作目录的 `.git` 或运行数据。
4. 后续版本在新仓库提交代码后运行 `python scripts/export-source.py`；用 `--zip <包路径>` 可复核已生成的源码包。

本交付是脱敏源码预览，依赖审计遗留告警及 Windows 沙箱兼容参数见 [SECURITY.md](../SECURITY.md)。独立开发板和所有第三方网关的完整实测仍需各自环境。
