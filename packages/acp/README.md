# ACP 引擎（实验性）

把说 ACP（Agent Client Protocol，第 1 版）的编码 agent 接到 Codex app-server 协议上。一个包管四个 harness 标识，入口都是 `dist/acp/src/adapter.mjs`，由命令行用 `CHA_ACP_AGENT` 告诉它这一次扮演哪一个：

| 标识 | 默认命令 | 说明 |
|---|---|---|
| `gemini` | `gemini --acp` | Gemini CLI |
| `qwen` | `qwen --acp` | Qwen Code |
| `agy` | `agy acp` | Antigravity 订阅后端，由外壳路由到本入口 |
| `acp` | 无，必须配置 | 用户指定的任意 ACP agent（比如 `opencode acp`） |

预设在 `packages/protocol/src/acp-agents.json`。agent 本体不随适配器分发，一律用用户自己装的。

## 环境变量

`<ID>` 是标识的大写（`GEMINI`、`QWEN`、`AGY`、`ACP`）：

- `CHA_ACP_AGENT`：扮演哪一个，`gemini`、`qwen`、`agy`、`acp` 之一，没设按 `acp`。
- `CHA_<ID>_CLI`：命令（路径或 PATH 里的名字），没设用预设。`acp` 没有预设，不设就报“CLI 不可执行或未找到”。
- `CHA_<ID>_ARGS`：参数，整行按空白切开，双引号里的空白不切，`\"` 是字面的引号；设了就整个替换预设（设成空串就是不带参数）。
- `CHA_<ID>_HOME`：适配器给这个标识的状态目录（库、`agent.log`），默认 `~/.codex-harness-adapter/<id>`。不是 agent 自己的数据目录。agy 单独使用 `CHA_ACP_HOME`，缺省为 `~/.codex-harness-adapter/agy/acp`，不与 SDK 共库。

## 命令行

- `--version`：一行版本，带扮演的标识。
- `--runtime-info`：起 agent 只握一次手（`initialize`，不建会话、不发提示词），打出 `runtime/info` 的应答，`engine` 就是 `CHA_ACP_AGENT`。失败时退出码 1，原因写在标准错误里，命令行的诊断按这几句认：
  - `CLI 不可执行或未找到`：没配命令、找不到、不可执行；
  - `ACP 协议版本不符`：agent 回报的协议版本不是 1；
  - `没有完成 ACP 握手`：起来了但握手失败（退出、超时 60 秒、回了错误），后面带 agent 标准错误的最后几行。
- `--pty-self-check`：终端自检。
- `app-server --listen stdio://|unix://PATH|ws://HOST:PORT`：服务。

## 接入方式

- agent 第一次要用时才起（stdio 上一行一条的 JSON-RPC），退出了收尾，下一次要用时再起一个。读 `session/list`、建会话、`runtime/info` 会起它；读适配器自己记着的会话、答“这里没有”不起。
- 握手时声明我们能读写文件（`fs/read_text_file`、`fs/write_text_file`）和开终端（`terminal/*`）：agent 读写文件、跑命令都经我们，写文件出成带差异的改文件条目，命令输出一段段转给客户端。
- 我们的声明（`runtime/info` 的 `features`）照 agent 握手时报的能力定：有 `session/fork` 才能分叉，`promptCapabilities.image` 为真才收图片。agent 起不来时照保守的报（各项按没有算）。
- 映射：

| Codex | ACP |
|---|---|
| `thread/start` | `session/new` |
| `thread/resume`、`thread/read` | 经这里建过的照适配器库里记的历史；别的用 `session/load` 回放，agent 不支持 load 的历史是空的 |
| `thread/list` | `session/list`（翻完所有页）并上适配器记的 |
| `thread/fork` | `session/fork`，只能从末尾分 |
| `turn/start` | `session/prompt`；技能写成打头的 `/名字`，提到的文件是资源链接 |
| `turn/interrupt` | `session/cancel`，挂着的审批回 agent“取消”；10 秒内没收尾由适配器收尾 |
| 模型、强度、计划模式 | `session/set_config_option`（按 category：`model`、`thought_level`、`mode`），没有配置项时用 `session/set_model`、`session/set_mode`；计划模式是标识为 `plan`（或名字带 plan）的那个模式 |
| `model/list` | 最近见到的会话报的配置项或模型清单 |
| `session/request_permission` | 改文件的工具（edit、delete、move）走文件改动审批，别的走命令审批；选项按种类对（`allow_once` ↔ accept，`allow_always` ↔ acceptForSession，`reject_*` ↔ decline，cancel ↔ 取消并打断） |

- `session/update`：话和思考转成 `agentMessage`、`reasoning` 的增量；工具调用按种类转成 `commandExecution`、`fileChange`、`mcpToolCall`；`plan` 转成 `turn/plan/updated`；`usage_update` 和 `session/prompt` 应答里的用量转成 `thread/tokenUsage/updated`；`available_commands_update` 当技能报（路径是 `acp://<标识>/commands/<名字>` 这样的假标识，交给 agent 的只有名字）；`current_mode_update`、`config_option_update` 转成 `thread/settings/updated`；`session_info_update` 的标题转成改名通知（用户改过名的不盖）。
- 会话在 agent 进程换过之后要重新接上：有 `session/resume` 的接回去，只有 `session/load` 的回放一遍（历史以适配器记的为准），都没有的接不上，回合失败并说明原因。
- 动态工具（`thread/start.dynamicTools`，含 Litch 的客户端工具 `litch_*`）：`runtime/info` 的扩展里报 `clientTools`。带了动态工具的会话，`session/new`、`session/load`、`session/resume`、`session/fork` 的 `mcpServers` 里挂一个 stdio 的 MCP 服务 `litch`（规范要求每个 agent 都收 stdio 的）：命令是当前的 node 跑 `dist/acp/src/mcp-bridge.mjs`，它经本地套接字（放在临时目录下新建的、只有自己能进的目录里；Windows 上是命名管道）接回入口进程，口令在环境变量 `LITCH_ACP_MCP_TOKEN` 里。MCP 由入口答：工具名是命名空间去掉 `litch_` 再接工具名（`browser_navigate`），各命名空间的 `instructions` 放在 `initialize` 应答的 `instructions` 里。模型调用时按 `protocol/extensions/client-tools.json` 挑执行方，发标准的 `item/tool/call`，答复转成 MCP 的结果交回 agent。动态工具记在适配器库里，适配器重启、agent 进程换过之后接回会话时重新挂，分叉出来的会话带着原会话的。
- 动态工具的条目画成 `dynamicToolCall`，条目号就是 `item/tool/call` 的 `callId`。Gemini CLI 0.66 的调用 ID 带有真实工具名前缀，入口精确匹配当前会话注册的 MCP 工具；旧 agent 则匹配完整的服务限定标题（如 `litch_<工具>` 或 `<工具> (litch MCP Server)`）。命令文字、参数或 ID 后缀提到工具名不算。确认身份后只允许这一次，不额外转发 agent 的审批，要不要问用户仍由执行方决定；认不出的照普通审批转给用户，调用进来后再尝试认领条目。
- ACP 冒烟使用的精确版本写在 `protocol/versions.json` 的 `acpSmoke`：Gemini CLI 0.66.0、OpenCode 1.18.33。两者均验证工具调用、无重复审批和 MCP instructions 进入模型上下文，普通命令仍需要审批；见 `test/smoke.test.mts`。
- 权限模式来自 agent 会话目录（`acp:mode:<id>`）；没有目录时只有 agent 自主管理的一档。适配器不增加 OS 沙箱。
- 插话、主动压缩、回退仍无通用 v1 方法；删除按 sessionCapabilities.delete 开放，表单提问通过 MCP 征询卡呈现。未宣告 URL 征询、音频输入、v2。`mcpServerStatus/list` 等答 -32004。

## 运行与测试

```sh
export PATH=/opt/homebrew/opt/node@24/bin:$PATH
npm ci --prefix packages/acp
npm run build --prefix packages/acp
npm test --prefix packages/acp
```

测试的 agent 是 `test/fake-agent.mts`。真实冒烟使用回环假模型、隔离的 HOME/XDG 和假密钥，不读取个人配置。运行以下命令会按 `protocol/versions.json` 的 `acpSmoke` 安装精确版本到本工作树的 `.artifacts/acp-smoke-*`，构建并运行全部三条真实冒烟（不跳过）。Full 流水线的 OpenCode 作业也运行它：

```sh
npm run smoke:acp
```

只调试某一家时，构建后也可用 `LITCH_SMOKE_GEMINI` 或 `LITCH_SMOKE_OPENCODE` 指向隔离安装的 CLI，直接运行 `node --test packages/acp/dist/acp/test/smoke.test.mjs`；未提供的另一家会跳过。

## 嵌入和扩展

Antigravity 权限验收（已验证 CLI 1.5.2）单独运行，不使用真实账号或模型服务：

```sh
TEST_AGY_CLI=/absolute/path/to/agy node --test packages/acp/dist/acp/test/manual/agy-permissions.mjs
TEST_AGY_CLI=/absolute/path/to/agy node --test packages/acp/dist/acp/test/manual/agy-litch-permissions.mjs
```

它用隔离 HOME 和回环假 Gemini 验证默认审批、免审批启动参数、`toolPermission` 配置、
空闲时切换原生模式及同进程另一会话的行为。未提供 CLI 时直接失败。当前免审批参数和
配置均影响同进程的全部会话，不会添加 `yolo` 模式；不能把它们当成逐会话权限选择。
第二项通过真正的 Litch ACP 入口，在同一回合内切换完全访问、Default、完全访问，断言
仅 Default 的命令产生审批卡。Litch 选择 `allow_once`，不使用上述全局选项。

后台结果验收也使用真实 agy 和回环假模型：

```sh
TEST_AGY_CLI=/absolute/path/to/agy node --test packages/acp/dist/acp/test/manual/agy-background.mjs
```

它真实创建异步子智能体，控制子回答在父 `end_turn` 后到达；验证有界回读、增量追加和
`backgroundTask` 来历，输出短历史与 256 KiB 旧正文的回读耗时、字节数。
通用 ACP 的回合外正文立即展示，以 250ms 静默合并片段；仍有工具在跑则等工具结束。
这是 v1 缺少独立结束帧时的展示分段，不冒充 v2 的前台状态。尚未实现完整 ACP v2。
agy 专属回读与用户 prompt 共用会话锁；取消之后仍排空已经在途的回放，绝不将其并入新回合。
8 MiB 是回放内容的保留上限，超限时排空当前响应并停止后续检查，不会反复读大历史。

`AcpServer(home, env)` 的 `handle(peer, message)`、`closePeer(peer)`、`close()` 是双后端外壳使用的公开接口。
构建在 `dist/acp/src/server.mjs`；独立适配器安装包内为 `libexec/packages/acp/dist/acp/src/server.mjs`。
每会话能力见 `protocol/extensions/thread-capabilities.json`；通用鉴权和配置控制见 `protocol/extensions/acp-controls.json`。
只有声明扩展的连接才可读写对应字段。未登录的 agy 指引用户运行 `agy acp --login`；不读取或代管 OAuth。
