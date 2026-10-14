# Arduino IDE Agent

这是基于 Arduino IDE 2.3.1 的 Agent 预览分支。AI 对话显示在编辑器右侧的可收起面板中，当前支持 OpenAI Responses、OpenAI Chat Completions 和 Anthropic Messages 三种请求格式，也支持第三方 OpenAI 兼容提供商与中转站。

## 配置

在右侧 AI Agent 面板填写：

- 接口预设：OpenAI 官方、OpenCode Go、Anthropic 官方或自定义第三方/中转站
- Provider：OpenAI 兼容接口或 Anthropic Messages
- OpenAI API 类型：Chat Completions 或 Responses API（Anthropic 固定 Messages）
- API Key 认证方式：Bearer、`x-api-key`、`api-key` 或不自动发送
- Base URL：API 根地址，例如 `https://api.openai.com/v1`
- 模型名称
- 额外请求头：每行填写 `名称: 值`，适用于第三方网关的自定义认证或路由头
- 思考等级：自动、快速、平衡或深度；各协议采用对应的推理或 thinking 参数
- API Key
- Agent 权限：关键动作确认或全自动执行。全自动模式会在 AI 输出完整 `cpp` 代码块后实时写入当前草图主 `.ino` 文件。

API Key 通过系统凭据存储保存，不写入普通配置文件。额外请求头按用户填写的内容保存在本机，可能含认证信息，不应随源码发布。Base URL 只填写 API 根地址，插件会按 API 类型追加 `/chat/completions`、`/responses` 或 `/messages`。点击模型旁的“拉取模型”会请求同一 Base URL 下的 `/models`，支持 OpenAI 兼容响应的 `data` 列表、Anthropic/网关常见的 `models` 或 `results` 列表；选择结果后仍需点击“保存配置”。不支持可选推理或 thinking 参数的接口会自动移除该参数重试。

OpenCode Go 使用 `https://opencode.ai/zen/go/v1`。插件会为每个对话自动生成并复用稳定的 `x-opencode-session`，并发送 `arduino-ide-agent/2.3.1` User-Agent。DeepSeek、GLM、Kimi、MiMo、LongCat 和 Hy 等 Go 模型自动使用 Chat Completions；Grok、GPT 和 Muse 等模型可使用 Responses。第三方网关没有 `/models` 接口时仍可直接手填模型名称。

Windows 的“发行者未知 / Windows 已保护你的电脑”来自 SmartScreen 对未签名下载文件的信誉检查。首次使用测试版时，先在 ZIP 的属性中勾选“解除锁定”，再完整解压。已经解压的版本可运行包内的“修复启动提示.cmd”：它核对配套脚本和两个启动 EXE 的 SHA-256，备份原下载标记，然后仅解除这两个 EXE 的下载锁定；不会关闭 Windows 安全保护、修改执行策略或触碰工程、凭据与对话历史。

正式分发需要受信任的 Authenticode 代码签名。设置 electron-builder 的 `WIN_CSC_LINK`/`WIN_CSC_KEY_PASSWORD` 或 `CSC_LINK`/`CSC_KEY_PASSWORD` 后，打包脚本会启用签名并要求签名成功；主启动器和 Electron Core 都会签名，解锁工具的校验值会在签名后重新生成。无证书时仍生成明确标注的本地测试包。受信任的签名能显示发布者身份，但新发布的文件仍可能需要积累 SmartScreen 信誉；不能承诺首次下载一定免提示，也不能通过自签名或更改产品名解决。

参考：[微软 Unblock-File 说明](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.utility/unblock-file)、[SmartScreen 应用信誉说明](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)。

## 面板操作

新增[思考展示与提示词定制](ai-agent-thinking-and-prompts.md)：回复可展开接口返回的思考或推理摘要；设置中可完整编辑内置提示词、保存、撤销或恢复默认，并选择是否自动附加工程上下文。

Agent 的回答与工具使用规范见[回答规范与验证](ai-agent-quality.md)。简单问答直接抓重点，修改与执行结果以真实工具反馈为准；仅解释、示例和预览不会通过文本模式自动覆盖工程或上传。

- `Ctrl+Alt+A`：显示或隐藏右侧 AI 面板
- `Enter`：发送消息
- `Shift+Enter`：换行
- `停止`：取消当前请求

面板中的“快速开始”提供按钮 + LED、蜂鸣器提醒、DHT 温湿度、SG90 舵机、UART 串口传感器和光敏自动灯模板。点击模板只会将带有接线、依赖库、非阻塞要求和验证步骤的提示填入输入框，用户可以先修改参数再发送，不会直接改写草图或操作硬件。

当前已接入原生多轮工具循环，包含草图及文件读写、板卡与端口选择、编译上传、烧录引导程序、库搜索安装、串口监视及收发，并提供 Git 快照和回滚按钮。启用自动工程上下文时，发送前会刷新草图和板卡信息。文本模式只在用户明确要求修改程序时自动应用当前轮的完整 Arduino 代码块，解释与示例不覆盖工程。编译和上传复用 Arduino IDE 的 CoreService，要求当前工程和板卡有效。

回复支持 Markdown、代码块与独立思考折叠区。工具读写限定在当前草图范围，串口记录使用有限缓冲；模型请求与工具调用有轮数上限。右侧“编译”和“上传”按钮属于用户主动触发的显式操作。

## 构建

Arduino IDE 2.3.1 官方构建要求 Node.js `>=18.17 <21`、Yarn 和 Windows MSVC 工具链。安装依赖后执行：

```powershell
corepack yarn install --frozen-lockfile
corepack yarn build:dev
corepack yarn --cwd electron-app rebuild
corepack yarn --cwd electron-app build
corepack yarn --cwd electron-app package
```

构建输出位于 `electron-app/dist`。产品名为 `Arduino IDE Agent`，App ID 与官方 Arduino IDE 不同，可与原版并存。
