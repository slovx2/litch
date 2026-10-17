# OpenCode 适配器（实验性）

把 OpenCode 的原生会话映射到 Codex app-server 协议。走的是 OpenCode 自带的 `opencode serve`（v1 的 HTTP 接口加 `/global/event` 事件流），不经 ACP。

## 接入方式

OpenCode 本体不随适配器分发：适配器使用用户自己安装的 `opencode`。`CHA_OPENCODE_CLI` 可以指定路径；不设时先从 PATH 找，再找官方安装脚本的默认位置 `~/.opencode/bin/opencode`。第一次用到时，适配器起一个 `opencode serve --hostname 127.0.0.1 --port 0` 子进程，口令随机（`OPENCODE_SERVER_PASSWORD`）。它从标准输出读到地址，核对 `/global/health` 报的版本，再订阅 `/global/event`。各项是这样做的：

- **会话存在哪：** 会话就是 OpenCode 的会话，存在 OpenCode 自己的数据目录里（和用户平时用的 OpenCode 是同一份）。适配器每次打开都从 `GET /session/:id/message` 回放，不另存历史。
- **适配器库里放什么：** 只放界面元数据，包括归档标记、分组置顶、项目归属、会话设置、临时名和预览，还有客户端发来的输入的原样。回显和重读历史时，用户消息就照这份原样（图片、技能、文件引用都是发来的样子）。分叉出来的会话按消息先后把这份原样带过去。
- **请求带目录：** 每个请求都带 `x-opencode-directory`，值是会话的目录，OpenCode 照它选目录实例。serve 的工作目录在 `<CHA_OPENCODE_HOME>/runtime`，不落在用户项目里。
- **事件流断线：** 断了就退避重连，连上后把打开着的会话逐个重读补齐。重读期间这个会话的事件先缓着；还在流式输出的几段文字不再逐字推，结束时一次补上。所以不会重发，也不会漏。
- **回合：** 回合号就是那条用户消息的消息号。适配器照 OpenCode 的规则自己生成，然后经 `prompt_async` 交过去。会话闲下来（`session.idle`）时回合结束；被打断的、出错的分别报 `interrupted`、`failed`。
- **插话（`turn/steer`）：** 会话忙着时再发一句。OpenCode 在当前这一步结束后把它并进同一个循环。
- **打断：** 先 `abort`，再由适配器收拾挂着的审批和提问：撤回请求、发 `serverRequest/resolved`，OpenCode 那边也拒掉。
- **条目映射：**
  - 文字 → `agentMessage`；结束时带工具调用的报成过程说明。计划模式里是 `plan`。
  - 思考 → `reasoning`。
  - bash → `commandExecution`，输出跑着的时候分段推。
  - edit、write、apply_patch → `fileChange`。
  - 提问工具 → `dynamicToolCall`。
  - websearch、codesearch、webfetch → `webSearch`。
  - MCP 和其余工具 → `mcpToolCall`。
  - 压缩 → `contextCompaction`。
- **随回合推的通知：**
  - 待办（todowrite）→ `turn/plan/updated`。
  - 回合差异 → `turn/diff/updated`，取自 OpenCode 照快照算的 `summary.diffs`，改写成 git diff 的样子，不依赖 git。
  - 每一步的用量累加成 `thread/tokenUsage/updated`。OpenCode 的输入数不含缓存，这里加回去。
- **审批：** OpenCode 的权限请求里，edit 走文件改动审批，bash 和其余各类（读项目外的文件、联网取网页、子代理、反复相同的调用等）走命令审批，命令一栏写明是哪类权限。子代理会话里的请求转到它的主会话来问。各决定对应 OpenCode 的应答如下：

  | 决定 | 交给 OpenCode 的应答 |
  | --- | --- |
  | 允许这一次 | `once` |
  | 本会话都允许 | `always`（OpenCode 记在内存里，serve 退出前对同一项目有效） |
  | 拒绝 | 带一句说明的 `reject`，模型接着干 |
  | 拒绝并附说明（扩展 `declineWithNote`） | 说明交给模型 |
  | 取消 | 拒绝并打断回合 |

  注意：OpenCode 拒一个就把这个会话里别的挂着的请求一起拒掉。
- **提问：** 模型调 OpenCode 的提问工具（`question`）时，适配器转成 `item/tool/requestUserInput`。一次可以问几道题；有选项的题和没选项的题分开问。问不成（没有连着的客户端、拿着请求的连接都断了、回合被打断）就拒掉，模型拿到 OpenCode 的“用户没理会这道题”。适配器起 serve 时设了 `OPENCODE_ENABLE_QUESTION_TOOL=1`，这个工具默认只对 OpenCode 自己的界面开着。
- **权限三档：** OpenCode 没有沙箱，三档的差别在给不给工具、问不问。每条消息都带上档位，正在跑的回合用的是发出时的那一档。
  - 只读：不给模型 edit、bash、task 三类工具（经消息的 `tools`，它会整个替换会话的权限规则）。
  - 项目内：照 OpenCode 自己的权限设置。
  - 完全访问：适配器把 OpenCode 来问的一律放行。
- **模型和强度：**
  - `model/list` 列的是 OpenCode 已连上的提供方的模型，标识是 `提供方/模型`。
  - 强度是模型的 variant，另加一个 `default`（不指定 variant）。
  - 默认模型是 OpenCode 配置里的 `model`，没有就用它报的默认。
- **计划模式：** 用 OpenCode 的 `plan` 代理。
- **技能（`skills/list`）：** 问的是 OpenCode：`/skill` 加 `/command`，后者是自定义命令、MCP 提示词。点名技能的消息经 `/command` 执行，其余文字作参数。
- **分叉、回退、压缩、删除：**
  - 分叉：`/fork` 按消息切，`lastTurnId`、`beforeTurnId` 都换算成切点。
  - 回退（`thread/revert`；旧的 `thread/rollback` 按个数换算）：`/revert` 会把那之后改过的文件也照快照恢复，和 Codex 只截历史不同，声明里写明了（`restoresFiles`）。
  - 压缩：`/summarize`。
  - 删除：`DELETE /session/:id`。
  - 用户自己跑命令（`thread/shellCommand`）：`/shell`。
- **会话清单：**
  - 来自 `/experimental/session`（跨项目）。
  - 没说过话的空白会话不列：OpenCode 默认标题，适配器又没记过它的预览。
  - 名字是 OpenCode 生成的标题（默认标题不算）。生成之前收到的改名只当临时名。
- **归档：** OpenCode 只能归档不能取消归档，所以归档只是适配器这边的标记，OpenCode 自己的界面里照样看得到。
- **临时线程**（`ephemeral: true`，桌面端生成标题、摘要时用）：只存在于适配器内存里。线程上带 `outputSchema` 的回合以空结果结束，普通回合如实拒绝。
- **不适用、没有接的方法：**
  - `mcpServerStatus/list`、`app/installed`、`plugin/installed`、`marketplace/add` 答 -32004“不适用”。
  - 设备侧队列（`thread/queue/*` 的写操作）等没有接的方法答 -32601。
- **收场：** 先请 serve 收拾各目录实例（`/global/dispose`），再发结束信号，到点强杀。入口被强杀时，serve 旁边有一个极小的 sh 看着：入口一没，它就结束 serve。

## 版本

对用户安装的 OpenCode 只设下限（`src/versions.mts` 的 `opencodeMinimum`，当前 `1.18.0`）。它与 `protocol/versions.json` 的登记一致，有测试核对。实际验证过的版本记在 `opencodeVerified`（当前 `1.18.33`），不参与放行。启动未验证的版本时，运行日志里提示一次。接口不在时（404），报错带上当前版本和这份清单。

`--runtime-info` 找不到 OpenCode 或核对不过时，标准错误里的原文以下面三句之一开头，设备层的诊断照开头认：

- `宿主 OpenCode CLI 不可执行或未找到`
- `宿主 OpenCode CLI 版本不符`
- `无法读取宿主 OpenCode CLI 版本`

## 运行

| 变量 | 作用 |
| --- | --- |
| `CHA_OPENCODE_CLI` | 用户安装的 opencode 可执行文件；不设置时从 PATH 查找，再找 `~/.opencode/bin/opencode` |
| `CHA_OPENCODE_HOME` | 适配器状态目录，默认 `~/.codex-harness-adapter/opencode` |
| `CHA_OPENCODE_TRACE=<文件>` | 调试用，逐行记录与客户端往来的协议消息 |

模型的密钥、提供方配置都在用户自己的 OpenCode 配置里，适配器不读也不改。

## 验证

```sh
export CHA_OPENCODE_CLI=<本机已安装的 opencode>   # 装在 PATH 或 ~/.opencode/bin 时可省略
npm test                                          # 在本目录：构建后跑包级测试
```

测试起真的 `opencode serve`，模型是 `test/mock-model.mts` 里回环上的假 OpenAI 兼容端点。每个用例都把 HOME 和 `XDG_*` 指到临时目录，在那里写一份只有假提供方的 OpenCode 配置，并且：

- 关掉联网拉模型清单、自动更新、LSP 下载、分享和默认插件；
- npm 指到一个连不上的地址；
- 清掉环境里各家模型的密钥。

所以不发真实模型请求，也不碰用户的 `~/.config/opencode`、`~/.local/share/opencode`。本机没装 OpenCode 时，需要它的用例跳过。

经适配器主进程、设备进程和聚合面的整条链在根目录跑 `npm run client:check:opencode`（`scripts/check-opencode-e2e.mjs`，连同 `acp` 入口接 `opencode acp` 的那一条），隔离做法相同，没装 OpenCode 时跳过。

## 尚未覆盖

以下几项还没接：

- 历史分页；
- 设备侧消息队列；
- MCP 服务的征询（`mcpServer/elicitation/request`）；
- MCP 管理；
- 技能的开关与额外目录；
- 子代理会话的单独展示（子代理的权限请求已转到主会话）；
- `thread/timeline/list`。

用户在 OpenCode 自己的界面里对同一会话的操作，适配器通过事件流看得到；但 OpenCode 自己的界面起的是它自己的 serve，看不到适配器这边的实时事件，要重开会话才看得到。只在 macOS 上验证过。
