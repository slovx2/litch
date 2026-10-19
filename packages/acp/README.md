# ACP 引擎（实验性）

把说 ACP（Agent Client Protocol，第 1 版）的编码 agent 接到 Codex app-server 协议上。一个包管三个 harness 标识，入口都是 `dist/acp/src/adapter.mjs`，由命令行用 `CHA_ACP_AGENT` 告诉它这一次扮演哪一个：

| 标识 | 默认命令 | 说明 |
|---|---|---|
| `gemini` | `gemini --acp` | Gemini CLI |
| `qwen` | `qwen --acp` | Qwen Code |
| `acp` | 无，必须配置 | 用户指定的任意 ACP agent（比如 `opencode acp`） |

预设在 `packages/protocol/src/acp-agents.json`。agent 本体不随适配器分发，一律用用户自己装的。

## 环境变量

`<ID>` 是标识的大写（`GEMINI`、`QWEN`、`ACP`）：

- `CHA_ACP_AGENT`：扮演哪一个，`gemini`、`qwen`、`acp` 之一，没设按 `acp`。
- `CHA_<ID>_CLI`：命令（路径或 PATH 里的名字），没设用预设。`acp` 没有预设，不设就报“CLI 不可执行或未找到”。
- `CHA_<ID>_ARGS`：参数，整行按空白切开，双引号里的空白不切，`\"` 是字面的引号；设了就整个替换预设（设成空串就是不带参数）。
- `CHA_<ID>_HOME`：适配器给这个标识的状态目录（库、`agent.log`），默认 `~/.codex-harness-adapter/<id>`。不是 agent 自己的数据目录。

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
- 动态工具的条目画成 `dynamicToolCall`，条目号就是 `item/tool/call` 的 `callId`。agent 为这次调用报的 `tool_call` 按标题认（`litch_<工具>`、`mcp_litch_<工具>`、`mcp__litch__<工具>`、`<工具> (litch MCP Server)`），认不出的在调用进来时按参数认领（Gemini CLI 在参数里有字符串 `command` 时拿命令当标题，按它认），都认不到就另起一个条目。agent 为这些工具来问权限的（Gemini CLI 默认会问）认得出就直接“允许这一次”，不转给用户（和别的入口一样，要不要问用户由执行方定）；认不出的照普通审批转给用户。
- 实测（2026-10-20）：Gemini CLI 0.38.0、OpenCode 1.18.33 的 `acp` 都把 MCP 的 `instructions` 放进了给模型的系统提示，见 `test/smoke.test.mts`。
- 权限只有一档（`:danger-full-access`）：适配器不加沙箱，agent 自己决定什么时候问。
- 不支持（声明里关掉，调了答 -32601）：插话、压缩、回退、删除会话、向用户提问、MCP 征询；`mcpServerStatus/list` 等答 -32004。

## 运行与测试

```sh
export PATH=/opt/homebrew/opt/node@24/bin:$PATH
npm ci --prefix packages/acp
npm run build --prefix packages/acp
npm test --prefix packages/acp
```

测试的 agent 是 `test/fake-agent.mts`（照 ACP 第 1 版答的假 agent，收到 `mcpServers` 会把 MCP 服务起起来，回合里按几家 agent 报调用的样子调它的工具）。对着真的 agent 冒烟默认跳过，手动开：

```sh
# opencode acp，模型是回环上的假 OpenAI 兼容模型，HOME 和 XDG 都是临时的
LITCH_SMOKE_OPENCODE=$(which opencode) node --test packages/acp/dist/acp/test/smoke.test.mjs
# gemini：一条只握手；一条经 MCP 桥调客户端工具，模型是回环上的假 Gemini API（假的密钥，不发真实请求）
LITCH_SMOKE_GEMINI=$(which gemini) node --test packages/acp/dist/acp/test/smoke.test.mjs
```
