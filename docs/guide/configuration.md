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

适配器自己连的 MCP 服务（会话配置、配置覆盖、用户级 `.claude.json` 里的）按会话跨回合复用连接：
第二个回合不再重起 stdio 服务、不再和 HTTP 服务重新握手，只先 ping 一次确认还通。服务配置
（含引用的环境变量、请求头）或工作目录变了就重建；会话归档、删除、卸载、回退时关掉，
没人用的连接空闲超时、超出条数上限或客户端全都断开时也关掉。回合被打断时还有请求在途的连接、
请求被取消或超时过的连接、重新登录过 OAuth 的服务的连接都不留，下个回合重新连。

行为上的变化：有状态的 stdio 服务（浏览器自动化这一类）以前每个回合重起、状态清空，现在同一个会话里
跨回合保留状态（开着的页面、登录状态等），和原生 Codex 一样；要回到每回合重起，把下面的分钟数设成 `0`。

```bash
# 没人用的 MCP 连接留多久（分钟，可以带小数），默认 10，最长约 35791（24.8 天，再大按这个算）；0 表示不复用，每个回合重新连。
export CHA_CLAUDE_MCP_IDLE_MINUTES=10
# 整个适配器最多留几条没人用的 MCP 连接（一个会话的一个服务算一条；stdio 服务一条就是一个子进程），
# 超出时先关最久没用的，默认 8；0 也表示不复用。
export CHA_CLAUDE_MCP_IDLE_CONNECTIONS=8
```


## Claude Code 自己的设置、计划文件与请求头

```bash
# 起 CLI 时读哪几层 Claude Code 设置（逗号分隔：user、project、local），默认三层都读。
# 只给 user 时工作区里的 .claude/settings*.json（hooks、env 等）、CLAUDE.md、.mcp.json、.claude/skills 都不读；
# 入口自己列技能（skills/list）、钩子（hooks/list）、模型，认凭据作用域时也只看选中的几层。
export CHA_CLAUDE_SETTING_SOURCES="user"

# 计划模式的计划文件放哪：workspace（默认，<工作区>/.claude/plans/codex-harness-adapter/<线程号>/）
# 或 config（Claude Code 自己的默认位置 <CLAUDE_CONFIG_DIR 或 ~/.claude>/plans/，工作区里不留东西）。
# config 时用户、项目设置里配的 plansDirectory 被入口盖掉；这个目录各会话共用，计划模式只豁免本会话
# CLI 自己的那一个计划文件（<slug>.md，从会话记录里认），别的文件照常按沙箱。
export CHA_CLAUDE_PLANS_LOCATION="config"

# 设成 1 时 CLI 发的每个模型请求带 thread-id: <线程号>（合进 ANTHROPIC_CUSTOM_HEADERS，原有的头保留）。
# 默认关，关着时一个多余的头都不发；给按线程计费的代理用，代理转发上游前要自己剥掉。
# Claude Code 设置的 env 里配了 ANTHROPIC_CUSTOM_HEADERS 时以它为底合并，也盖不掉 thread-id；
# 托管策略（managed-settings.json）里配的盖不过。追问子代理的回合跑在父会话上，带父线程号。
export CHA_CLAUDE_THREAD_ID_HEADER=1

# 提示缓存时长。默认 default：入口什么都不设，和直接跑 CLI 时一样（API key 时 5 分钟，订阅登录时 CLI 自己用 1 小时）。
# 设成 1h 时给 CLI 设它自己的 ENABLE_PROMPT_CACHING_1H=1、CLAUDE_CODE_PROMPT_CACHE_TTL=1h、
# CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL=5m（自己设过的照旧），cache_control.ttl 和 anthropic-beta 由 CLI 决定。
# 1 小时缓存在长对话里更省（少重新写入缓存），但写入缓存的单价更高。
export CHA_CLAUDE_PROMPT_CACHE_TTL=1h

# 默认 on：Claude 会话照旧自动起名（每个会话的头几个回合里 CLI 用小模型发一次起标题的请求，
# 入口把起出来的标题当会话名）。设成 off 时不再有这个请求：CLI 不自己起（入口给它设
# CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1），入口也不请它起、回合结束不读标题。
export CHA_CLAUDE_SESSION_TITLE=off
```

五项给了认不出的值时入口启动就报错。

关掉自动起名后线程名在协议上的表现：

- 新会话的 `name` 一直是 `null`，入口不会自己发 `thread/name/updated`；`thread/list`、`thread/read` 里没有名字，客户端照常拿 `preview`（第一句话）显示，和原生 Codex 没起名时一样。
- 客户端的 `thread/name/set` 照常生效，照常发 `thread/name/updated`。
- 开关在入口启动时读，改了要重启入口。已经起好名的会话不动；开着时 CLI 已经写进会话记录、入口还没读到的标题，关掉以后也不再读。

## Codex 风格的 `-c` 与权限档位

Claude 入口的 `app-server` 和 `codex app-server` 一样接受 `-c key=<TOML 值>`（也可写 `--config key=…`、`--config=key=…`），可以给多次：

```sh
node packages/claude/dist/claude/src/adapter.mjs app-server --listen stdio:// \
  -c approval_policy='"never"' \
  -c default_permissions='"saas"' \
  -c permissions.saas.extends='":workspace"' \
  -c 'permissions.saas.filesystem={ "/workspaces" = "deny", "/workspaces/u1" = "write", "/home/u1/.codex" = "read" }' \
  -c 'permissions.saas.network={ enabled = true }'
```

- 键按 `.` 拆成路径，值按 TOML 解析，解析不了就当字符串（与 codex 相同）。同一个键给多次，后面的为准。
- 只认这几个键：`approval_policy`、`sandbox_mode`、`default_permissions`、`developer_instructions`、`permissions.*`、`mcp_servers.*`、`shell_environment_policy.*`、`skills.*`。别的键（`model_provider`、`features.*` 之类 codex 专有的）不报错，记进调试日志（`config.cliOverride.ignored`）后忽略。
- 优先级：`-c` > 状态目录的 `config.json`（客户端经 `config/value/write` 写的）> 内置默认。`-c` 这一层只在内存里，不写回 `config.json`；表按键合并（`-c mcp_servers.a=…` 不会冲掉 `config.json` 里的 `mcp_servers.b`），其余整个替换。`mcp_servers` 之下还有 `~/.claude.json` 的 `mcpServers` 与 `CHA_CLAUDE_MCP_SERVERS`，它们排在 `config.json` 和 `-c` 前面。
- 写错了（档位继承成环、继承 `:danger-full-access`、`default_permissions` 指向没定义的档位、条目格式不对、TOML 写坏了被当成字符串）进程直接起不来，错误打在标准错误上。`config.json` 里的 `permissions` 形状不对也一样。
- 键里任何一段是 `__proto__`、`constructor`、`prototype` 的整条忽略。
- `config/value/write` 写进 `config.json` 的值按叠上 `-c` 之后的有效配置校验，所以 `default_permissions` 可以写只在 `-c` 里定义的档位名。

### 自定义权限档位

`permissions.<名字>` 的写法和判定照 codex（以 `rust-v0.163.0` 为准，与 `rust-v0.155.1` 一致）：

- `extends`：继承别的档位；内置档位里只能继承 `:read-only`（`:root` 可读）和 `:workspace`（`:root` 可读，工作区根、`/tmp`、`$TMPDIR` 可写）。子档位的条目覆盖父档位的同名条目。名字不能以 `:` 开头。
- `filesystem`：键是绝对路径、`~/...`，或特殊路径 `:root`、`:workspace_roots`、`:tmpdir`、`:slash_tmp`；值是 `read`、`write`、`deny`（`none` 同 `deny`），或者“子路径 → 访问”的表（`":workspace_roots" = { "." = "write", docs = "read" }`，子路径不能含 `.`、`..`）。read、write 只接受精确路径或结尾的 `/**`。不认识的特殊路径忽略。
- 判定：命中的条目里最深的为准，同样深时 `deny` > `write` > `read`。所以可以整个目录 `deny`，再把里面的子目录放回 `read` 或 `write`。
- `workspace_roots`（`{ "/路径" = true }`）和请求里的 `runtimeWorkspaceRoots` 一起组成 `:workspace_roots`；请求没给 `runtimeWorkspaceRoots` 时是会话的工作目录。
- `network.enabled`：命令能不能联网。`network` 下其余的键（代理、域名名单等）不生效。
- `thread/start`、`turn/start`、`thread/resume`、`thread/fork`、`thread/settings/update` 的 `permissions` 可以填这里定义的名字，没定义的名字照旧回 `-32602`；`default_permissions` 管不带权限也不带旧式 `sandbox` 的新会话。会话记下选中那一刻的档位，之后改配置不影响已有会话，除非请求里再选一次。`permissionProfile/list` 会列出这些档位。

同一份规则同时管两处：模型的 `Bash` 命令（macOS 用 `sandbox-exec`，Linux 用 `bwrap`：禁读的目录盖一层空 tmpfs，再把其中放回的子目录挂回；照 codex 另起 PID 命名空间，挂一份只有沙箱自己进程的 /proc。Docker 默认遮住了 /proc 下的一些路径，用户命名空间里挂不了新的 /proc，这时沙箱里的 /proc 是空的（`ps`、`/dev/stdin`、`/dev/fd`、bash 的进程替换用不了），不回落成宿主的 /proc，免得看到别的会话的命令行；容器加 `--security-opt systempaths=unconfined` 就能挂）和文件类工具（`Read`、`Glob`、`Grep`、`LS`、`NotebookRead` 查禁读，`Write`、`Edit`、`MultiEdit`、`NotebookEdit` 查可写）。`Glob`、`Grep` 的搜索范围里只要有禁读的目录就整个拒绝，请模型换一个不含它的目录；`Glob` 的 pattern 带 `..` 段也拒绝。读文件照 codex 不走审批：哪种审批策略（含 `never`）、计划模式下，读工作目录外的文件都按可读范围直接判定，可读就读，禁读的直接拒；不选自定义档位时整个磁盘可读。

- 路径先取真实路径再判定，大小写也按磁盘上的真实写法纠正（macOS 默认的卷不分大小写）；还不存在的那一段取不到真实写法，在 macOS 上 `deny` 条目按不分大小写比。
- 不存在的禁读路径照样受管：`sandbox-exec` 的规则不要求路径存在；`bwrap` 照 codex，在可写范围里对第一个不存在的那一级挂一个 `/dev/null` 占位，命令里建不出它，命令结束后删掉占位（只删空文件、空目录）。
- 可写目录下的 `.git`、`.agents`、`.codex`、`.aws`、`.claude` 默认只读（codex 的 `metadata_write_denial`；`.claude` 是这边加的，里面的设置、钩子、Skill 会被打开同一工作区的 Claude Code 执行），不存在的也不许建；`.git` 是指向别处的文件时，指向的 gitdir 一并只读。档位里给这个路径写了条目就照档位，比如 `"/ws/u1/.codex" = "write"`。Linux 上不存在的元数据目录只在工作区根下面放占位（只读的空目录），`/tmp` 之类别的可写目录下的靠文件类工具拦。计划文件放在工作区里时（`CHA_CLAUDE_PLANS_LOCATION` 不是 `config`）在 `.claude/plans/` 下，计划模式里本会话的那一个照常能写；入口自己链的 Skill 在 Claude Code 配置目录下，不受影响。

不受档位管的（这些照旧只看审批策略和各自的设置）：MCP 服务的工具、动态工具（客户端注册的）、`Monitor` 之类自己带命令的工具、Claude Code 的钩子、`command/exec`（客户端直接起的命令，照旧按请求里的 `sandboxPolicy`）。

和 codex 不一样的地方：

- `deny` 的 glob 条目（如 `"/srv/**/*.env" = "deny"`）还不支持，写了选档位时报错；不继承 `:root` 可读、靠 `:minimal` 只读一部分目录的档位也还不支持。
- Linux 上禁读目录里放回 `read` 的子目录也会挂回（codex 0.163.0 的 bwrap 只挂回可写的，只读的子目录在命令里看不到，它的文件工具却能读）。
- 并发的两条 `Bash` 命令共用同一个占位时，先结束的那条会删掉占位，另一条在剩下的时间里能建出那个路径（codex 有占位登记表，这里没有）。
- 内置档位（`:workspace` 等）不做元数据目录保护、不看 `runtimeWorkspaceRoots`，与之前一样。

### Bash 命令的环境变量

`shell_environment_policy` 照 codex（`rust-v0.163.0`）管模型 `Bash` 命令（含子代理的）拿到的环境变量，可以放在 `-c`、`config.json`，也可以放在 `thread/start` 的 `config` 里（键可以写成 `shell_environment_policy.set.PATH` 这样带点的）。照 codex，线程的 `config` 接在 `-c` 后面当覆盖：整张 `shell_environment_policy` 表给的就换掉 `-c` 那张，带点的键只换那一项；这一层再按表逐键叠到 `config.json` 上。

- `inherit`：`all`（默认，全继承）、`core`（只留 `PATH`、`SHELL`、`TMPDIR`、`TEMP`、`TMP`、`HOME`、`LANG`、`LC_ALL`、`LC_CTYPE`、`LOGNAME`、`USER`）、`none`。
- `ignore_default_excludes`：默认 `true`；写 `false` 时去掉名字含 `KEY`、`SECRET`、`TOKEN` 的变量。
- `exclude`、`include_only`：变量名的通配符（`*`、`?`），不分大小写；也可以写成 `filters = { "模式" = "include" | "exclude" }`，但不能和这两个混用。
- `set`：“变量名 → 值”，在 `exclude` 之后、`include_only` 之前生效。
- 顺序同 codex：按 `inherit` 取底，然后默认排除、`exclude`、`set`、`include_only`。`LITCH_THREAD_ID` 总是留着。写错了（未知的键、`inherit` 取值不对之类）回 `-32602`，写在 `-c` 或 `config.json` 里则进程起不来。

命令由 Claude Code 起，入口拿不到它的环境，所以配了规则时，入口把命令包进一个 bash，先按规则删、改变量，再跑原命令。因此：`set` 的值出现在这个 bash 的命令行里，同 uid 的沙箱外进程能从 `/proc` 读到，和读环境变量一样；在 Claude Code 2.1.282 上实测，会话记录里存的仍是模型写的原命令，不带这些值。另外，包了之后命令里的 `cd` 不再带到下一条命令。规则等于默认时命令原样不动。`command/exec`、MCP 服务、钩子不受它管。

规则只改命令的环境，Claude Code 自己的环境（模型凭据、被 `exclude` 挡在命令外面的令牌）不动。为了不让模型绕过去读它：配了规则或选了自定义档位的会话里，Linux 上的文件类工具不碰 `/proc`（`Read /proc/self/environ` 能读到 Claude Code 的整份环境，经工作区里的链接也一样），搜索范围含 `/proc` 的也拒绝；Skill 的内联 shell 不经过这层改写，这类会话里关掉。命令在沙箱里只看得到自己 PID 命名空间的 `/proc`，看不到 Claude Code 进程。

### Skill 开关

Claude Code 的 Skill 开关照 codex 存在配置的 `skills.config` 里：一串 `{ path = "<SKILL.md 的绝对路径>", enabled = false }` 或 `{ name = "<名字>", enabled = true }`，按顺序套，后面的为准；`-c skills.config=…` 接在 `config.json` 那一串后面。`skills/config/write` 和 `config/batchWrite` 写的是同一处（`skills/config/write` 关就改掉同一个选择器的那条或追加，开就删掉那条；只靠 Claude Code 自己 `settings.json` 的 `skillOverrides` 关着的，留一条开的盖过它）。

Claude Code 自己的开关只认名字，所以按路径关掉同名 Skill 里的一个时：`skills/extraRoots/set` 加进来的额外目录里的 Skill 不链给 Claude Code，同名的别的 Skill 照常可用；用户目录、项目目录里的同名 Skill 只要有一个关着，这个名字整个关掉（`skills/list` 里照样按路径报开关）。原来存在状态目录 `skills.json` 里的开关不再读，要重新设一次。

`thread/start`、`thread/resume` 等请求的 `config` 里也可以给 `skills`，照 codex 只对这个会话生效：它接在 `-c` 后面当覆盖（整张 `skills` 表给的就换掉 `-c` 那张，`skills.config` 这样带点的键只换那一项），这一层的 `skills.config` 接在 `config.json` 那一串后面。`skills.bundled.enabled = false` 关掉 Claude Code 自带的 Skill（它的 `disableBundledSkills`）。会话级的开关只能按名字交给 Claude Code：额外目录的链接是整个进程共用的，只按进程级的规则藏，所以会话里打开一个进程级关掉的额外目录 Skill 不生效，会话里按路径关掉的同名 Skill 整个名字关。`skills/list` 不带会话（codex 也不带），列的是进程级的开关。

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
| `CHA_CLAUDE_COMPAT_VERSION` | Codex app-server version advertised (default `0.163.0`); separate from minimum CLI versions. |
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
| `CHA_CLAUDE_MCP_IDLE_MINUTES` | 适配器自己连的 MCP 服务跨回合复用：没人用的连接留多久（分钟），默认 `10`，最长约 `35791`；`0` 表示不复用，每个回合重新连。有状态的 stdio 服务因此跨回合保留状态。 |
| `CHA_CLAUDE_MCP_OAUTH_CLIENT_NAME` | MCP 服务 OAuth 登录时动态注册报的客户端名（授权页上给用户看），默认 `codex-harness-adapter`。接入方要显示自己的名字时设它。 |
| `CHA_CLAUDE_MCP_IDLE_CONNECTIONS` | 整个适配器最多留几条没人用的 MCP 连接（一个会话的一个服务算一条），超出时先关最久没用的，默认 `8`；`0` 也表示不复用。 |
| `CHA_CLAUDE_ALLOWED_TOOLS` | Pre-approved tools. |
| `CHA_CLAUDE_ADD_DIRS` | Extra directories exposed to Claude. |
| `CHA_CLAUDE_AUTO_WORKTREE` / `_WORKTREE_ROOT` | Per-thread worktree isolation. |
| `CHA_CLAUDE_SETTING_SOURCES` | 起 CLI 时读哪几层 Claude Code 设置，逗号分隔的 `user`、`project`、`local`，默认三层都读；认不出的值启动报错。 |
| `CHA_CLAUDE_PLANS_LOCATION` | 计划文件放哪：`workspace`（默认，工作区里每个线程一个目录）或 `config`（`<CLAUDE_CONFIG_DIR 或 ~/.claude>/plans/`）。CLI 只认项目内的 `plansDirectory`，所以不能指定任意目录。 |
| `CHA_CLAUDE_THREAD_ID_HEADER` | 设成 `1` 时模型请求带 `thread-id: <线程号>`（合进 `ANTHROPIC_CUSTOM_HEADERS`），不带回合号；默认关。 |
| `CHA_CLAUDE_PROMPT_CACHE_TTL` | 提示缓存时长：`default`（默认，什么都不设，和直接跑 CLI 一样）或 `1h`（设 CLI 自己的 `ENABLE_PROMPT_CACHING_1H`、`CLAUDE_CODE_PROMPT_CACHE_TTL=1h`、`CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL=5m`）。 |
| `CHA_CLAUDE_SESSION_TITLE` | 默认 `on`，Claude 会话自动起名；`off` 时 CLI 和入口都不发起标题的模型请求，会话名只来自 `thread/name/set`。 |
| `CHA_CLAUDE_IDLE_EXIT_MS` | 仅 shim：守护进程空闲退出；本地入口固定为 `0`。还有 Claude 进程在看管后台命令时不算空闲（只是空闲保留着的不算）。 |
| `CHA_CLAUDE_KEEP_ALIVE_SESSIONS` | 同时保留后台命令的 Claude 会话数上限，默认 `8`。回合结束时还有后台命令在跑，该会话的 Claude 进程就留下（每个约占 120–220 MB 内存）；超出上限的会话不保留，后台命令随回合结束而停止并有提示。设为 `0` 关闭保留。 |
| `CHA_CLAUDE_KEEP_ALIVE_DETACHED_MINUTES` | 全部客户端断开后，留着的 Claude 进程再保留多少分钟，默认 `30`；期间有客户端连回来就继续保留。`0` 表示一直保留。有回合在进行的进程不回收，包括停在等待用户确认上的回合。只是空闲保留着的进程（见下一行）不等这个时间，全部断开时马上回收。 |
| `CHA_CLAUDE_KEEP_ALIVE_IDLE_SECONDS` | 回合结束后没有后台命令的 Claude 进程再留多少秒，默认 `0`（回合结束就退出）。大于 `0` 时进程留到超时再退出，期间同一会话的下个回合直接用它，省掉起进程的时间，代价是每个留着的会话一直占着一个 Claude 进程的内存（和看管后台命令时一样）；后台命令全部结束后也照这个时长留。和后台命令共用 `CHA_CLAUDE_KEEP_ALIVE_SESSIONS` 的上限，满了先回收闲得最久的空闲进程（看管后台命令的不让位），回收不出位置就不留；上限为 `0` 时也不留。会话归档、删除、卸载、回退，全部客户端断开，改技能目录或技能开关，适配器停止时马上回收。留着的进程照旧占着它的 MCP 连接，回收后按 MCP 连接的空闲规则处理。 |
| `CHA_CLAUDE_MOCK` | Run the protocol without Claude credentials. |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` | Claude auth / custom endpoint configuration. Keep real values out of git. |
