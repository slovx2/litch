# Configuration

本地入口用 `npm start` 或 Homebrew 的 `codex-harness-adapter start` / `brew services` 启动；无需修改登录 shell 或全局 PATH。
默认自动检测 Claude/Pi，`--harness` 可选择单引擎，`--claude-port` / `--pi-port` 可设置两个 SSH 端口，单引擎用 `--port`。
完整命令见[开始使用](/guide/getting-started)，桌面连接见[配置指南](/guide/gui)。

## 环境文件

适配器启动时读取 `~/.codex-harness-adapter/env`（`--home` 改变状态目录时为 `<home>/env`），每行 `KEY=VALUE`，空行和 `#` 开头的行忽略，允许 `export` 前缀和成对引号，值按字面使用、不做变量展开。
后台服务不继承终端环境，下列变量及代理、`PI_CLI` 等都应写在这里；修改后重启服务（`brew services restart codex-harness-adapter`）。

```sh
# ~/.codex-harness-adapter/env
CHA_CLAUDE_DEFAULT_MODEL=opus
HTTPS_PROXY=http://127.0.0.1:7890
```

优先级：适配器固定变量（`CODEX_HOME`、`CHA_CLAUDE_HOME`、`CHA_PI_HOME`、`CHA_DSH_HOME`、`CHA_CLAUDE_IDLE_EXIT_MS`）> 启动进程已有的同名变量 > 环境文件。
文件里写入密钥时用 `chmod 600` 限制权限，不要提交到任何仓库。

命令行的输出语言（中文或英文）默认跟随系统：先看 `CHA_LANG`，再看 `LANGUAGE`、`LC_ALL`、`LC_MESSAGES`、`LANG`，都没有时在 macOS 和 Windows 上取系统界面语言，仍然定不下来就用英文。`CHA_LANG=zh-CN` 或 `CHA_LANG=en` 可以写在环境文件里，后台服务同样生效；启动进程自己带了 `CHA_LANG` 时以它为准。

下列高级环境变量主要控制 Claude 适配器（`CHA_CLAUDE_*`）。Pi 使用原生 `PI_CODING_AGENT_DIR` 和 `PI_CLI`。
`PI_CLI` 指向要使用的 Pi（默认取 `PATH` 中的 `pi`）；适配器从它所在的 npm 包加载 Pi 运行时，只要求版本不低于下限。

Pi 默认不询问。打开设置 `harness.pi.approvals`（或者在环境文件里写 `CHA_PI_APPROVALS=1`）后，主会话里的命令走 `item/commandExecution/requestApproval`，写文件、改文件和其余有副作用的工具调用走 `item/fileChange/requestApproval`，差异在条目的 `changes` 上；等待时会话状态带 `waitingOnApproval`。读文件、搜索、计划模式自己的工具、客户端执行的工具不问。子代理里的操作不问，Pi 也没有沙箱，所以这不是安全边界。被否决的调用，模型收到 `denied by user`。

## DeepSeek Harness（实验性）

用 Codex 桌面驱动 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）。目前是实验性入口：覆盖线程列表、发消息、逐字流式输出、提权审批、向你提问、中断和重新打开后的历史，其余能力见下方"尚未支持"。

- **安装 dsh。** 适配器不自带 dsh，使用你自己安装的版本：`npm install -g @deepseek-ai/dsh`，要求不低于 **0.2.0-rc.2**（dsh 还没有稳定版，下限落在预发布号上，更高版本直接可用）。默认从 `PATH` 找 `dsh`，也可用 `CHA_DSH_CLI` 指定路径。
- **密钥。** 只读取 `DEEPSEEK_API_KEY`：前台启动时从当前终端继承，后台服务写进上面的环境文件。适配器给 dsh 用的是自己的状态目录，不读取 `~/.dsh` 里的登录信息。
- **启动。** 检测到本机装有 dsh 时，`start` 和后台服务会一并启动 dsh 入口，SSH 监听 `127.0.0.1:7333`（`--dsh-port` 可改），别名 `codex-harness-adapter-dsh`；没装时不提示、不占端口，Claude 和 Pi 不受影响（实验阶段的特例）。装了但版本过低或启动失败时只告警。单独启动用 `--harness dsh`，自检用 `doctor --harness dsh`。
- **会话日志上传默认关闭。** dsh 默认会随模型请求上传会话日志；经适配器启动的 dsh 一律关闭这项上传，确需保留 dsh 的默认行为时设置 `CHA_DSH_SESSION_LOG=1`。遥测同样默认关闭（`DSH_TELEMETRY_DISABLED` 未设置时置为 `1`）。
- **审批。** dsh 只在模型申请突破沙箱时询问，裁决是"允许这一次"或"拒绝"；Codex 的三档权限对应 dsh 的 `read-only`、`workspace-write`、`danger-full-access`。
- **提问。** 模型用 dsh 的提问工具问你时，桌面端弹出题卡作答，选项之外都能自己写。协议里的题没有多选的标记，dsh 的多选题到桌面端和单选题一个样子。没有连着的桌面端时模型得到“没有人应答”，接着往下做。
- **线程标题。** 标题由 dsh 生成：新线程先显示首条消息里你写的字，随后换成模型起的标题；之后在桌面端手动改名会写进 dsh 并固定下来。
- **技能。** 输入区里能列出并带上 dsh 的技能，清单由 dsh 自己给出：项目里的 `.dsh/skills/`、`.agents/skills/`（项目根是往上第一个带 `.git` 的目录，没有就是工作目录），和用户的 `~/.agents/skills/`；每项是 `<名字>/SKILL.md` 或 `<名字>.md`，开头的元数据里要有 `name` 和 `description`。适配器给 dsh 用的是自己的状态目录，`~/.dsh/skills/` 里的技能读不到，要共用请放到 `~/.agents/skills/`。技能没有开关，不想让它出现在清单里就在元数据里写 `user-invocable: false`。

版本兼容：适配器经 dsh 的 Web Remote 接口工作，这个接口没有版本协商。验证过的版本是 0.2.0-rc.2；更高版本如果改了接口，相关操作会报错并写明当前版本与验证过的版本，此时换回验证过的版本或升级适配器。

尚未支持：计划模式、分叉与回滚、压缩、子代理展示、MCP 管理、技能的开关与额外目录、结构化输出、很长会话里更早的历史。只在 macOS 上验证过。

## OpenCode（实验性）

用 Codex 桌面或 Litch 驱动 [OpenCode](https://opencode.ai)。适配器走 OpenCode 自带的 `opencode serve`（原生的 HTTP 接口和事件流），不经 ACP。

- **安装。** 适配器不自带 OpenCode，用你自己装的、配好提供方和密钥的那一份，要求不低于 **1.18.0**（验证过 1.18.33）。默认先从 `PATH` 找 `opencode`，再找官方安装脚本的位置 `~/.opencode/bin/opencode`，也可用 `CHA_OPENCODE_CLI` 指定。
- **启动。** 检测到 OpenCode 时一并启动，SSH 监听 `127.0.0.1:7334`（`--opencode-port` 可改），别名 `codex-harness-adapter-opencode`；没装时不提示、不占端口。第一次用到时，适配器才在回环地址上起一个带随机口令的 `opencode serve`，退出时一并收掉。
- **会话。** 会话就是 OpenCode 自己的会话，和你平时用的 OpenCode 共用一份数据，在哪边建的另一边都能打开。OpenCode 的终端界面起的是它自己的服务，看不到这边正在跑的回合，重开会话后才看得到。
- **能做的。** 发消息与逐字输出、思考过程、插话、中断；命令与改文件的审批（允许一次、本会话都允许、拒绝，拒绝可附一句说明交给模型），其他权限（读项目外文件、取网页、子代理等）也走命令审批；模型用提问工具问你时弹题卡；待办当计划、回合差异、用量；技能与自定义斜杠命令；计划模式（OpenCode 的 plan 代理）；按消息分叉、压缩、删除、改名、`!` 跑命令；带图片。
- **回退会恢复文件。** OpenCode 的回退会把那之后改过的文件也照快照恢复，和 Codex 只截掉历史不同。
- **权限三档。** OpenCode 没有沙箱：只读档不给模型改文件、跑命令、子代理三类工具；项目内档照 OpenCode 自己的权限设置；完全访问档由适配器把来问的一律放行。“本会话都允许”交给 OpenCode 的 always，它在服务退出前对同一项目都有效。
- **归档。** OpenCode 只能归档不能取消，所以归档只记在适配器这边，OpenCode 自己的界面里照样看得到。
- **尚未支持。** 很长会话的历史分页、设备侧排队、MCP 管理与征询、技能开关、子代理会话单独展示。
- **排查。** `doctor --harness opencode`；设 `CHA_OPENCODE_TRACE=<文件>` 可以逐行记下与客户端往来的协议消息。

## ACP agent（实验性）

说 [ACP](https://agentclientprotocol.com)（Agent Client Protocol）的编码 agent 都能经同一个通用入口接进来。内置两个预设，另留一个自填命令的入口：

| 标识 | 默认命令 | SSH 端口 | 命令行变量 |
|---|---|---|---|
| `gemini`（Gemini CLI） | `gemini --acp` | 7335（`--gemini-port`） | `CHA_GEMINI_CLI`、`CHA_GEMINI_ARGS` |
| `qwen`（Qwen Code） | `qwen --acp` | 7336（`--qwen-port`） | `CHA_QWEN_CLI`、`CHA_QWEN_ARGS` |
| `acp`（自填） | 无，必须填 | 7337（`--acp-port`） | `CHA_ACP_CLI`、`CHA_ACP_ARGS` |

- **默认关闭。** 三个入口都要在设备设置（或设置文件的 `harness.<标识>.enabled`）里打开才会启动；`acp` 打开了却没填命令时报“没装”。agent 本体不随适配器分发，用你自己装的、自己登录好的那一份。
- **命令与参数。** `CHA_<ID>_CLI` 换命令（路径或 `PATH` 里的名字），`CHA_<ID>_ARGS` 整个替换预设参数：按空白切开，双引号里的空白不切。例：`CHA_ACP_CLI=opencode`、`CHA_ACP_ARGS=acp`。这两个变量可以写进环境文件，也可以写进设置里该入口的环境变量。
- **能做的。** 新建、列出、重新打开会话（agent 支持 `session/load` 时能看到在别处建的会话的历史），发消息与逐字输出、思考过程、命令与改文件的审批（允许一次、本会话都允许、拒绝），工具调用（命令输出、带差异的改文件），计划，用量，斜杠命令当技能用，切模型、强度与模式（计划模式对应 agent 的 plan 模式），中断；agent 支持时可以从末尾分叉、可以带图片。agent 读写文件、跑命令都经适配器，所以改动会出现在对话里。
- **尚未支持。** 插话、压缩、回退、删除会话、向你提问、MCP 管理；权限只有一档，什么时候问由 agent 自己定。
- **登录。** 适配器不代为登录：agent 说要登录时，按提示去终端里先用它自己的命令登录好。
- **排查。** `doctor --harness gemini` 会真的起一次 agent 做握手（不建会话、不发消息）。诊断里的原因：找不到命令、`ACP 协议版本不符`（只认第 1 版）、没有完成握手（附 agent 标准错误的最后几行）。设 `CHA_ACP_TRACE=<文件>` 可以逐行记下与客户端往来的协议消息。

验证过：Gemini CLI 0.38.0（只做到握手）、`opencode acp` 1.18.33（假模型下的完整对话与审批）。Qwen Code 没有实测。

## Runtime backend

```bash
# Default uses the in-process Claude Agent SDK.
export CHA_CLAUDE_RUNTIME_TYPE="agent-sdk-sidecar"
#   codex      - pass app-server through to the real Codex CLI (shim layer)
#   agent-http - HTTP/SSE bridge for Claude Code Channels / agent-http
#   agentapi   - HTTP/SSE bridge for coder/agentapi
#   claude-p   - one-shot PTY/transcript wrapper via claude-p
#   mock       - local protocol testing
```

See [Backends](/guide/backends) for what each route supports. 本地入口在环境文件中设置 `CHA_CLAUDE_RUNTIME_TYPE` 后重启生效（`codex` 直通依赖 shim，除外）；`codex-harness-adapter-mode` 只用于远程 shim 部署。

## Provider and agent-loop selection

Provider selection is descriptor metadata plus routing to existing runtime
backends. It does not add a new provider runtime, auth flow, subscription model,
gateway, or entitlement.

```bash
# Known provider descriptor ids.
export CHA_CLAUDE_PROVIDER="claude-code" # or "codex"

# Known agent-loop ids.
export CHA_CLAUDE_AGENT_LOOP="native-claude-code-sdk" # or "codex-jsonl-proxy"
```

Current mappings:

| Provider / loop | Existing runtime behavior |
| --- | --- |
| `claude-code` / `native-claude-code-sdk` | `agent-sdk-sidecar` |
| `codex` / `codex-jsonl-proxy` | `codex-proxy` |

Backward compatibility rules:

- `CHA_CLAUDE_RUNTIME_TYPE`, `CHA_CLAUDE_RUNTIME`, and
  `CHA_CLAUDE_BACKEND` still override provider selection when set.
- `CHA_CLAUDE_MOCK=1` still forces the `mock` runtime.
- Saved config can set `provider_loop_provider` and
  `provider_loop_agent_loop` through `config/value/write`.
- Raw saved selection keys are filtered out of public `config/read`; the safe
  projection appears under `config.provider_loop_config.selection`, with
  redacted validation issues when a selection is unknown or mismatched.

Selection must stay within supported credential ownership models. It does not
collect or share credentials, pool personal subscriptions, reuse browser cookies
or session tokens, configure private endpoints, or bypass provider terms.

## Models & effort

```bash
# Defaults for new threads, surfaced through config/read.
# Any form Claude Code accepts: an alias (sonnet, opus[1m]) or a full model name (claude-sonnet-4-6).
# If it is not in Claude Code's own model catalog, model/list gets an extra row for it (marked default).
export CHA_CLAUDE_DEFAULT_MODEL="sonnet"
export CHA_CLAUDE_DEFAULT_EFFORT="medium"

# Codex App model picker list (comma-separated ids or JSON array of ids/objects).
export CHA_CLAUDE_MODELS="sonnet,opus,fable,haiku,sonnet-1m,opus-plan"

# Map Codex UI ids -> Claude SDK aliases/full names, and effort values.
export CHA_CLAUDE_MODEL_ALIASES='{"my-long-context":"sonnet[1m]"}'
export CHA_CLAUDE_EFFORT_ALIASES='{"xhigh":"max"}'
```

## MCP, tools & directories

```bash
# Passed to ClaudeAgentOptions (JSON object or path to a JSON file).
export CHA_CLAUDE_MCP_SERVERS='{"github":{"type":"stdio","command":"github-mcp"}}'

# Pre-approved tools (others still route through Codex approval) + extra dirs.
export CHA_CLAUDE_ALLOWED_TOOLS="Read,Glob,Grep"
export CHA_CLAUDE_ADD_DIRS="/repo/shared,/repo/docs"
```

## Worktree isolation

```bash
# Per-thread git worktree isolation (off by default — it creates branches).
export CHA_CLAUDE_AUTO_WORKTREE=1
export CHA_CLAUDE_WORKTREE_ROOT="$HOME/.codex-harness-adapter/worktrees"
```

When enabled, each new Codex thread runs in a dedicated `git worktree`.

## Daemon（仅远程 shim 部署）

以下变量只对[远程主机 shim 部署](/guide/deployment)生效；本地 SSH 入口固定不空闲退出，并通过 `--node` 选择 Node。

```bash
# Idle shutdown grace period in ms (default 15000; 0 = never exit).
export CHA_CLAUDE_IDLE_EXIT_MS="15000"

# Pin a node binary for the shim (e.g. when default node is < 24).
export CHA_CLAUDE_NODE="/absolute/path/to/node"
```

## Reference table

| Setting | Purpose |
| --- | --- |
| `CHA_CLAUDE_ADAPTER` | 仅 shim：`packages/claude/dist/claude/src/adapter.mjs` 路径。 |
| `CHA_CLAUDE_NODE` | 仅 shim：shim 启动的 Node。本地入口用 `--node`。 |
| `CHA_CLAUDE_COMPAT_VERSION` | Codex app-server version advertised (default `0.157.1`); separate from minimum CLI versions. |
| `CHA_CLAUDE_VERSION_SUFFIX` | Tag after the version to distinguish the adapter from real codex (default `codex-harness-adapter`; set `""` to behave exactly like upstream codex). |
| `CODEX_REAL` | 仅 shim：处理非 app-server 命令和 `codex` 直通的真实 Codex CLI。 |
| `CHA_CLAUDE_CLI` | 宿主 Claude Code 可执行文件，默认从 PATH 查找 claude。运行时诊断接受 CLI >= 2.1.282 的稳定版，配置仍由原生 CLAUDE_CONFIG_DIR 提供。 |
| `CHA_DSH_CLI` | 宿主 DeepSeek Harness 可执行文件，默认从 PATH 查找 dsh；要求 >= 0.2.0-rc.2。 |
| `CHA_PI_APPROVALS` | 值是 `1` 时 Pi 在动手之前先问，其它值都算关。通常不用手写，由设置 `harness.pi.approvals` 给出；设置里写过的优先于这里。改了要重启 Pi 的运行时。 |
| `CHA_DSH_SESSION_LOG` | 设为 `1` 时保留 dsh 默认的会话日志上传；默认关闭。 |
| `DEEPSEEK_API_KEY` | dsh 入口使用的密钥，不要提交到任何仓库。 |
| `CHA_CLAUDE_RUNTIME_TYPE` | Active backend route. |
| `CHA_CLAUDE_PROVIDER` | Provider descriptor id (`claude-code` or `codex`) mapped only to existing runtime behavior. |
| `CHA_CLAUDE_AGENT_LOOP` | Agent-loop id (`native-claude-code-sdk` or `codex-jsonl-proxy`) mapped only to existing runtime behavior. |
| `provider_loop_provider` | Saved config key for provider descriptor selection via `config/value/write`. |
| `provider_loop_agent_loop` | Saved config key for agent-loop selection via `config/value/write`. |
| `CHA_CLAUDE_DEFAULT_MODEL` / `_EFFORT` | Defaults for new threads. The model may be any alias or full model name Claude Code accepts; one that is not in its catalog gets its own row in `model/list`. |
| `CHA_CLAUDE_MODELS` | Codex App model picker list. |
| `CHA_CLAUDE_MODEL_ALIASES` / `_EFFORT_ALIASES` | Id remapping. |
| `CHA_CLAUDE_MCP_SERVERS` | MCP server config (JSON or file path). |
| `CHA_CLAUDE_ALLOWED_TOOLS` | Pre-approved tools. |
| `CHA_CLAUDE_ADD_DIRS` | Extra directories exposed to Claude. |
| `CHA_CLAUDE_AUTO_WORKTREE` / `_WORKTREE_ROOT` | Per-thread worktree isolation. |
| `CHA_CLAUDE_IDLE_EXIT_MS` | 仅 shim：守护进程空闲退出；本地入口固定为 `0`。还有 Claude 进程在看管后台命令时不算空闲。 |
| `CHA_CLAUDE_KEEP_ALIVE_SESSIONS` | 同时保留后台命令的 Claude 会话数上限，默认 `8`。回合结束时还有后台命令在跑，该会话的 Claude 进程就留下（每个约占 120–220 MB 内存）；超出上限的会话不保留，后台命令随回合结束而停止并有提示。设为 `0` 关闭保留。 |
| `CHA_CLAUDE_KEEP_ALIVE_DETACHED_MINUTES` | 全部客户端断开后，留着的 Claude 进程再保留多少分钟，默认 `30`；期间有客户端连回来就继续保留。`0` 表示一直保留。有回合在进行的进程不回收，包括停在等待用户确认上的回合。 |
| `CHA_CLAUDE_MOCK` | Run the protocol without Claude credentials. |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` | Claude auth / custom endpoint configuration. Keep real values out of git. |
