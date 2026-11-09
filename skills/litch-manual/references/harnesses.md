# Harnesses

## The supported harnesses

| Id | Name | Notes |
|---|---|---|
| `claude-code` | Claude Code | Needs the standalone `claude` CLI, signed in. Also lists Claude Code sessions started elsewhere on the machine |
| `codex` | Codex | The native Codex CLI (`codex app-server`). Uses the user's own Codex data (`~/.codex`, or `CODEX_HOME`); only one codex process should write a given session at a time |
| `pi` | Pi | Installed with npm (`@earendil-works/pi-coding-agent`) |
| `dsh` | DSH (DeepSeek Harness) | Experimental |
| `opencode` | OpenCode | Experimental; uses the user's `opencode` |
| `gemini` | Gemini CLI | Over ACP; off by default |
| `qwen` | Qwen Code | Over ACP; off by default |
| `acp` | Other ACP agent / 其他 ACP Agent | ACP-compatible agents without a dedicated integration, such as Gemini, Qwen, or a custom command; off by default, needs its command in `harness.acp.cliPath` |
| `agy` | Antigravity | Experimental; API key uses the SDK runtime, subscription uses official `agy acp`; off by default |

Litch never bundles a harness. Each device uses what is installed on it. Feature support differs: plan
mode exists only where the harness supports it.

Codex 历史刚写入时若暂报 `list_turns is not supported yet`，设备会短暂重试历史读取和恢复，
保留原生分页与游标。持续失败仍显示原错误；无需因此降级或重装 Codex。

## Seeing what is there

桌面与手机的 harness「设置 → 运行」页用一行显示“实际使用：版本 · 路径”。有多份安装时，
点展开图标查看全部路径和版本，当前使用的那份标为“使用中”。停止的 harness 显示“已选择”，
不表示进程正在运行。修改路径后，正在运行的入口信息仍保留到实际重启。

未指定命令行路径时，Litch 同时检查 PATH 中的全部同名命令、登记的固定位置（例如
`~/.local/bin/claude`、`~/.opencode/bin/opencode`）和当前 npm 的全局目录，自动选择版本最高的一份。
同版本优先保留 PATH 顺序；无法运行或读不出版本的排在最后，全部未知时仍取最先找到的命令。
设置中的路径优先于对应环境变量；指定了路径或命令名就严格使用，不自动替换。
运行中的进程在重启后使用重新选出的版本，原地更新会使版本探测缓存失效。
找不到 CLI 时，只有用户实际配置过命令行路径或对应环境变量，诊断才会提示修正该配置；
自动选择并传给引擎的路径不视为用户配置。

- `scripts/litch harness list <device>` shows every harness on the device: enabled or not, ready or
  unavailable with the reason, and the version when known.

## Installing and updating (a system task, not a Litch command)

Installing or upgrading a harness is done with the harness's own official installer, in a shell, as the
user. Litch has no command for it. Do it yourself with the user's OK, or give the user the command:

| Harness | Official install (pin a version where shown) | Litch verified | Minimum | Docs |
|---|---|---|---|---|
| Claude Code | `curl -fsSL https://claude.ai/install.sh \| bash -s 2.1.316` (Windows PowerShell: `& ([scriptblock]::Create((irm https://claude.ai/install.ps1))) 2.1.316`) | 2.1.316 | 2.1.282 | https://code.claude.com/docs/en/setup |
| Codex | `npm install -g @openai/codex@0.163.0` | 0.163.0 | 0.157.1 | https://github.com/openai/codex |
| Pi | `npm install -g @earendil-works/pi-coding-agent@0.99.1` | 0.99.1 | 0.99.1 | https://github.com/earendil-works/pi |
| DSH | `npm install -g @deepseek-ai/dsh@0.2.0-rc.2` | 0.2.0-rc.2 | 0.2.0-rc.2 | https://www.npmjs.com/package/@deepseek-ai/dsh |
| OpenCode | `curl -fsSL https://opencode.ai/install \| bash -s -- --version 1.18.33` (Windows: `npm install -g opencode-ai@1.18.33`) | 1.18.33 | 1.18.0 | https://opencode.ai/docs |
| Gemini CLI | Official instructions; choose an explicit version before installing | 0.66.0（ACP 冒烟） | none | https://github.com/google-gemini/gemini-cli |
| Qwen Code | Official instructions; choose an explicit version before installing | none | none | https://github.com/QwenLM/qwen-code |

- Prefer the verified version. Newer versions usually work too; Litch only needs the minimum and never
  requires an exact version. To use a newer release, check the official version and pin that exact version in the command.
  Gemini CLI 0.66.0 已通过隔离的 ACP 握手和工具调用冒烟；Qwen Code 尚未验证。
- Gemini 的 Litch 工具调用由执行方决定是否审批，不额外显示一次 Gemini 工具审批。
  普通命令、文件操作和其他 MCP 服务的工具仍按原有审批处理。
- Never use sudo. If npm's global folder is not writable, tell the user (they can set an npm prefix in
  their home, or use a Node version manager); do not change system folders.
- 官方脚本与 npm 安装完成后，Litch 都重新检测实际入口，并在安装日志中显示路径和版本。
  若指定的旧路径仍生效，日志同时列出新安装的位置，提示修改或清空路径设置后重新检测；
  不自动改写用户指定的路径。指定路径无效时安装任务提示修正，不能绕开它启动另一份。
- For a remote device the command has to run on that machine: in a terminal there, or, with the user's
  OK, `ssh <alias> '<command>'` from here.
- Afterwards make Litch pick it up: `scripts/litch harness restart <device> <id>` (it re-detects the
  command; the Devices page has the same as the harness's Restart button). If the harness was disabled,
  `scripts/litch harness enable <device> <id>`.

**Signing in, API keys, providers and the harness's own settings** live on the Devices page: each
harness row has a **Settings** button (详情设置) that opens these tabs. Runtime settings belong to Litch; the other tabs read and write the
harness's own config files on that device (shared with its CLI there):

- **Claude Code 账号与网关并用**：另配 API key 不会隐藏已配置的官方账号模型。
  Claude Code 2.1.312 起不再从项目的 `.claude/settings.json` 或 `settings.local.json` 读取
  claude.ai 登录凭据；请在设备的启动环境、用户级设置或 Litch 的账号设置中配置。
  Litch 按 CLI 实际生效的凭据归属账号额度，不把被忽略的项目令牌当成独立账号。
  旧版 CLI 仍沿用项目凭据覆盖规则；项目 API key、apiKeyHelper 和第三方服务地址不受这项限制。
- **Claude Code 子代理与工具发现**：子代理回答不显示 CLI 附加的工具清单和用量包装。
  计划和只读模式允许加载延迟工具的定义，实际调用仍受原有权限边界限制。计划确认在对应正文处理后显示。

- **Runtime** (opens first on managed devices): CLI path, environment, task cards, browser and computer
  use switches, and harness-specific runtime options such as Claude Code prompt cache duration.
  These settings are available even when the harness has no native Config tab. Unsaved runtime
  changes prompt to save, discard or cancel when leaving. The device page keeps status, enable,
  installation and restart controls.

- **Claude Code 自动压缩窗口（桌面端）**：设备详情的“配置 → 上下文窗口”按供应商和实际模型分别设置，包含官方账号。
  范围为 100K–1M token，留空继承 Claude 设置；同一模型的 `[1m]` 变体共用一行。
  设置存在设备的 Litch `context-windows.json`，不会改其他供应商，也不改变模型容量或订阅额度。
  CLI 会预留输出和摘要空间后提前压缩，这不是请求的硬上限；需 Claude Code 2.1.299 或更新版本。
  保存后在没有后台任务的下一回合生效；已有后台任务继续运行，不会为更新窗口被停止。
  若 `settings.json` 的 env 配了全局窗口（例如 500K），每个模型行都会显示覆盖数值和来源。
  “改为默认自动压缩窗口”经确认把它移到顶层 `autoCompactWindow`：单独设置的模型优先，其余模型继续用该默认值；
  “清除全局覆盖”只删用户 env 的这一项。设备启动环境或管理员设置的覆盖仍会显示，不会静默清除。
  “关闭 1M 上下文”独立控制可用容量，自动压缩窗口仍受该容量限制。手机端专门验收另行安排。

- **Config**: default model and effort, permissions, and the rest of what the harness's official app
  offers (Codex: approval, sandbox, web search, features, skills/plugins/hooks, memories; Claude Code:
  `~/.claude/settings.json`, including models, context window, telemetry and OpenTelemetry export;
  OpenCode, Pi, DSH: their own settings). Codex also has a global context window and auto-compact
  limit that apply to every model. Some changes say they need a new session or a restart; the page
  offers the restart. Codex's Config tab also has **Name sessions automatically** (on by default; it is
  Litch's own switch, kept on the device, not in Codex's config file): after the first text message of a
  session started in Litch is accepted, Litch names it independently with a small model of the luna
  family, only if the account's model list has one, and never over a name the user set. Naming does
  not wait for the main turn to finish and continues if it is interrupted. Failed sends do not
  consume the naming opportunity. Turning it off affects sessions started
  afterwards. DSH's Config tab lists its built-in plugins; the ones DSH cannot run without are locked
  on (turning them off broke turns, restarts or this page), and one that is already off can be turned
  back on (it says so). Turning off any other removes what it provides.
- **Accounts**: sign in (browser, device code, or pasting a code back), set an API key, add custom
  providers, switch the active provider. Codex can stay signed in to ChatGPT while using an API-key
  provider. OAuth credentials stay in the harness's own store; keys the harness only reads from
  environment variables are kept in that harness's environment on the device (secret).
  Claude Code has no active provider: the one account (Claude subscription, Console, or a
  `claude setup-token` long-lived token) and any number of providers the user adds (Anthropic API keys,
  Anthropic-compatible gateways with a hand-written or fetched model list) all appear in the model
  picker as `[Provider] model` once more than one is usable. Each session runs on the provider of its
  model and can switch at the next turn (the composer says so under the input); new sessions start
  with the last model picked. Editing a gateway offers "Fetch models from provider" to tick models
  from its `/v1/models` into the list. Keys and extra headers of added
  providers are stored by Litch on the device (not in `~/.claude`), shown only by their last four
  characters. Moving a provider to another host or changing its key header requires entering the key
  again. A session whose provider was removed fails with an error instead of moving to another
  provider. Credentials or a gateway configured in Claude Code's own `settings.json` or environment
  show as a read-only "Claude Code" provider.
  In an existing Claude Code session with context usage above 50%, selecting another provider
  (including the account) asks whether to **Compact and switch**, **Switch directly**, or cancel.
  Compacting uses the current provider and may reduce the cost of sending history to the new one. Switching waits for successful
  compaction; failure, interruption or disconnection keeps the original selection. Stop an active
  turn before confirming either switch. Changing models within the same provider does not prompt.
  At 50% or less, or when usage is unknown, the selection changes directly.
  Manual compaction does not accept messages until it finishes. A failed or interrupted compaction
  is shown as unfinished, including when reopening the conversation.
- **Models** (Codex only): a custom model list that replaces Codex's built-in catalog in its model
  picker. Each entry either uses a built-in model as is, or is based on one with a new model name,
  display name or context window (everything else is copied from the base). Models not in the list
  disappear from the picker; "restore" goes back to the built-in catalog. Takes effect after a restart.
  When the list was first taken over from the user's own `model_catalog_json` file, a model there with
  the same name as a built-in one keeps the user's own fields (the user's win where they differ); only
  the fields the user did not set follow Codex's built-in catalog.
- **MCP**: the harness's user-level MCP servers.
- **Instructions**: the user-level `AGENTS.md` (Claude Code: `CLAUDE.md`). **Unified mode** writes one
  copy and turns the other harnesses' files into symlinks to it (old files are backed up beside them).

Unsaved changes on the Config, Models or Instructions tab are not dropped silently: switching tab,
going back, opening another page or device, or closing the window (desktop) first asks Save, Discard or
Cancel (on the phone: switching tab and going back).

These tabs edit the harness’s own files and account state, so litch config does not duplicate their
Config/Models/MCP/Instructions editors or OAuth flow. Litch’s own automatic-naming switch is the
exception described below. Guide the user to Accounts to sign in and complete browser/code steps. If the user hands you an API key, you may
still store it in that harness's environment on that device:
`scripts/litch settings set <device> harness.<id>.env=…` (value syntax: `scripts/litch settings --help`).

## Enabling, disabling, restarting

`scripts/litch harness auto-title <device>` reads Litch's automatic naming switch for new Codex
sessions. Append `on` or `off` to change it. In the UI: Devices → Codex → Settings → Config →
Name sessions automatically. This does not rename existing sessions or change Codex's native settings.

原生 Codex 0.163.0 及以上支持显式后台任务接续。设备详情 → 设置 → 配置中有“后台任务自动继续”（`litch.backgroundWake`），默认开启。新建 Litch 会话获得显式登记有限原生命令的工具，完成后可自动接续；已有会话不会因此补装工具。关闭立即撤销已登记任务的自动继续，不停止原生命令。开启不恢复已取消登记；设备服务或 Codex 重启后不自动续跑。这个设置保存在设备服务中，不修改 Codex 的全局配置。桌面和手机设置页标明版本要求；低版本显示当前版本与设备详情升级入口，开关仍可更改。后台任务页以小字说明当前版本不支持、版本无法确认，或本会话未安装登记工具；升级或启用后请新建会话。

Native Codex background continuation requires **0.163.0 or later**. Desktop and mobile settings show the requirement and an upgrade hint for older versions; the switch remains editable. The Background tasks page explains an unsupported or unverified runtime, or a session without the registration tool. Start a new session after upgrading or enabling the feature. Turning it off cancels continuations without stopping commands; turning it back on does not restore cancelled registrations. Device or Codex restarts do not resume this work. The setting stays in Litch and does not modify Codex configuration.

- `scripts/litch harness enable <device> <id>` / `scripts/litch harness disable <device> <id>` turn a
  harness on or off on that device (the `harness.<id>.enabled` setting). Disabling stops its runtime;
  its sessions stay on disk and come back when re-enabled. Disabled harnesses disappear from the
  new-session page.
- `scripts/litch harness restart <device> <id>` restarts one harness and re-detects its command (use it
  after the user installed or upgraded the CLI by hand, or changed its login).

Enabling, disabling, restarting, and changing a harness's CLI path or environment interrupt turns
running in that harness on that device. Check `scripts/litch status` first and warn the user.

## "Not installed" or "Unavailable"

OpenCode startup and restart establish fresh connections to the current serve process. Failed
requests are reported without automatically repeating operations. If a connection error persists,
check the harness Runtime tab and device logs before restarting.

OpenCode 启动或重启时重新连接当前 serve 进程，不沿用旧进程的连接。请求失败会直接报告，不自动重复操作。
若持续出现连接错误，先检查 harness 的 Runtime 页与设备日志，再重启。

ACP（含 agy 订阅后端）回合慢时，设备日志目录的 `<harness>/rpc.jsonl` 中可按
`threadId`、`turnId` 筛选 `acp.*` 事件，查看 attach/flush、prompt、首次思考/正文和
工具起止。`promptMs` 是从 prompt 发出开始的毫秒数，工具 `durationMs` 包含审批等待。
这些日志只含标识、时间和状态；首次块是 ACP 可见时间，不能当作模型服务端首 token 时间。

1. Is it installed for the user's login shell? Run its version command in a login shell on that device
   (`claude --version`, `codex --version`, …); `scripts/litch harness list <device>` shows Litch's view.
2. Installed somewhere unusual: set its command explicitly,
   `scripts/litch settings set <device> harness.<id>.cliPath=/absolute/path/to/cli`.
3. Too old: install the verified or a newer version as above, then restart it.
4. Starts but fails: read `scripts/litch diagnose logs <device>` for that harness
   (`troubleshooting.md`), most often a sign-in or model problem in the harness itself.
5. Gemini CLI, Qwen Code and ACP are off by default: enable them first.

## ACP 会话能力与 Antigravity 订阅

“其他 ACP Agent”（英文 Other ACP agent）用于接入没有单独适配的、支持 ACP 协议的 Agent，
比如 Gemini、Qwen 或自定义命令。它的内部标识仍为 `acp`，显示名调整不改变已有会话或协议字段。

Antigravity 的订阅入口运行用户安装的官方 `agy acp`。在详情设置的“账号”页点击“登录 Google 账号”，本机和远程设备均运行 `agy acp --login`，不检测或打开目标设备的浏览器；可在同页查看状态、退出登录。
账号页始终提供登录链接。在桌面或手机复制链接，或点击“打开浏览器”在当前客户端打开；完成授权后粘贴授权码或完整回调 URL 并提交。支持取消，成功后自动刷新状态。此入口只提供官方终端登录支持的 Google 账号授权，不再提供 ACP 的 Gemini Enterprise 浏览器登录分支。
首次使用且尚未创建会话时，新建页也会查询官方 ACP 提供的模型和思考强度；具体选项以该入口返回的目录为准。

Accounts always uses `agy acp --login` for both local and remote devices, without checking for a browser
on the target device. Copy the link or open it in a browser on the current desktop or phone, then paste
the authorization code or callback URL and submit. You can cancel; success refreshes the status automatically.
This entry supports Google account terminal authorization, not ACP's Gemini Enterprise browser sign-in.
Model and reasoning-effort options are also loaded before the first conversation;
available choices come from the official ACP agent.
订阅额度显示在桌面输入区的用量圆环弹层、手机的“用量与额度”页：按模型组列出 5 小时／每周
已用百分比和重置时间（剩余量为 100% 减去已用量）。数据来自官方 `agy -p /usage --output-format json`，
不会启动模型回合或消耗额度。查看时才查询，30 秒内复用缓存；已查到额度后在回合结束时按相同间隔刷新。
未登录、查询失败或该账号没有提供额度时不显示额度条；API key 模式不查询订阅额度。
自定义 `CHA_AGY_ARGS` 为非标准 `acp` 参数时暂不查询，以免读到另一账号目录的额度。
登录状态用 agy 的只读会话查询验证；未提供查询能力时显示“登录状态未知”，网络错误显示失败原因，不当作未登录。登录和凭据由 agy 自己管理；Litch
不读取、复制或代存 OAuth 令牌。账号、套餐与第三方客户端的适用范围以 Google 当前政策为准，
使用订阅前应确认相关账号风险；官方 ACP 接口存在不等于任意消费订阅包装都已获授权。

同一 Antigravity 下不同会话可能属于不同后端。已打开会话的能力、模型、权限模式以该会话后端
声明为准；改变新建默认后端不会把旧会话迁移过去。没有会话级声明时才使用 harness 默认能力。

ACP agent 声明的模式会出现在权限选项中，显示 agent 提供的名称。它们不代表 Litch 增加了
操作系统沙箱；模式与模型的调整在回合之间应用。只有 agent 声明图片输入时才能附图；官方
agy CLI 的具体能力以当前握手为准，不能套用独立 ACP 包的能力。文件引用在 agent 接受内嵌
资源且文件较小、可读为 UTF-8 时附正文，否则作为文件链接。

Antigravity 的 ACP 入口默认按 agy 配置审批。选择“完全访问”后，Litch 只为这个会话自动批准
每次工具请求，不弹审批卡或留下自动批准提示；不改 agy 配置，不开启进程级免审参数。
完全访问和原生模式均可在回合中切换，下一个审批请求立即按新选择处理；切回 Default 等原生
模式后恢复 agy 的审批规则。没有一次性允许选项的请求仍显示审批卡，避免扩大为永久授权。
不提供只读或工作区沙箱。命令审批的理由与命令相同时只显示一次。

ACP 在回合外推来的正文会显示为“后台续跑”，不再等下一条用户消息。Antigravity 1.5.x 的
ACP 入口可能在父回合结束后停止推送子智能体结果；Litch 只在观察到 `invoke_subagent`
且父回合正常结束后，显示“子智能体可能仍在运行”，并在空闲期间回读历史。回读间隔从
3 秒逐步退避至 30 秒，最长 10 分钟；新内容立即显示，后半句在原条目更新，不重复追加。
已有内容一分钟未变化后，每 60 秒检查一次，不据此推断完成。十分钟最多检查 22 次；
这是结果检查，不是子智能体的精确状态或进度。用户发消息、停止、关闭或归档会话、修改
会话设置、连接断开时取消；回放出现下一条用户消息或超过 8 MiB 时也停止。预算结束时
撤掉检查行，只有一直没收到内容才提示“未收到后台结果，可发消息询问”。

Antigravity ACP uses agy's permission settings by default. Full access makes Litch allow each tool
request once in that session, without an approval card or approval message. It changes neither agy
configuration nor process flags. Switching between Full access and native modes takes effect for
the next request, even during a turn. Requests without an allow-once option still ask; Litch never
silently chooses a persistent grant. No read-only or workspace sandbox is provided. Duplicate
command titles are omitted from approval reasons on desktop and mobile.

ACP output received between turns appears as a background continuation. Antigravity 1.5.x may
stop forwarding subagent output after the parent turn ends. After an observed `invoke_subagent`
and normal completion, Litch shows an uncertainty notice and checks history while idle. New text
appears immediately; later chunks update the same item. Checks back off from 3 to 30 seconds and
then to 60 seconds after received content stays unchanged for a minute. Unchanged content does
not prove completion. The budget is 10 minutes, at most 22 checks. Sending a message, stopping,
closing, archiving, changing session settings, or disconnecting cancels it. A subsequent user
message in history or a replay exceeding 8 MiB also stops checks. At expiry the monitor disappears;
Litch only suggests asking about the result if no content arrived.

表单提问显示征询卡，数值、布尔和选项保留原始类型；取消或连接断开时不会默认接受。正式
宣告的子代理可以向父会话的订阅者请求审批，未宣告的会话仍拒绝。子代理不能直接发送用户
消息，只有 agent 明确授予取消能力时才能单独中断。

会话删除仅在 agent 声明支持时显示；最后一个订阅关闭且没有回合运行时可释放 ACP 会话，
历史仍保留。中途插话、回退和主动压缩没有通用 ACP v1 方法，相关入口保持关闭。
`acpControls` 集成接口支持按声明列登录方式、显式 authenticate/logout、通用 select/boolean
配置、MCP 服务和附加目录；不会自动登录、自动执行终端鉴权命令或扩大权限。URL 征询和音频
附件目前未开放。

ACP 的 `allow_always` / `reject_always` 表示让 agent 记住选择，规范没有保证只作用于当前会话。
选到此类选项时，Litch 会再明确说明实际范围并请求确认；未确认不会发送持久决定。
## Antigravity（实验性）

详情设置的“鉴权方式”选择 Gemini API key 或 Google 订阅（官方 ACP）。切换后按提示重启，
只改变新建会话的默认后端；打开已有会话仍使用原后端。两边会话汇总显示，但不能互相恢复上下文。
订阅模式使用用户安装并登录的官方 `agy` CLI，默认参数 `acp`；设备设置的“命令行路径”指定
该 CLI（也可用 `CHA_AGY_CLI`），参数覆盖为 `CHA_AGY_ARGS`。Litch 不提取 OAuth，也不把 SDK API key 注入订阅后端。
会话能力随原后端显示；API key 模式的限制不代表订阅 ACP 的能力限制。

已安装 Antigravity App 或 IDE 不代表已安装订阅所需的 CLI。安装区域单独显示 agy CLI 的版本或
“未检测到 agy CLI”，并显示停用状态。CLI 按 PATH、官方安装目录发现，显式路径优先；macOS/Linux
的官方目录是 `~/.local/bin/agy`，Windows 是 `%LOCALAPPDATA%\agy\bin\agy.exe`。
安装区域提供“安装最新版”，由所选设备的服务执行官方脚本，远程设备同样支持。脚本按官方 manifest
校验下载包 SHA-512，安装过程和失败日志显示在界面；成功后检测实际版本、启用并重启引擎。
官方脚本已有 CLI 时直接退出，不支持指定版本或由此脚本升级；已安装时显示当前版本和“重新检测”。
失败时可复制官方命令，或查看[官方安装说明](https://antigravity.google/docs/getting-started)。
也可以在会话所在设备的终端运行：

```sh
# macOS / Linux
curl -fsSL https://antigravity.google/cli/install.sh | bash
```

```powershell
# Windows PowerShell
irm https://antigravity.google/cli/install.ps1 | iex
```

手动安装后开启设备设置中的 Antigravity“启用”，选择 Google 订阅（官方 ACP），在账号页登录，或按
[官方 ACP 说明](https://antigravity.google/docs/ide/extensions/acp/)运行 `agy acp --login`。
若终端未找到命令，使用上述安装目录的绝对路径。重新检测不自动替用户打开停用的 harness。

设备上的 `agy` 对应 Antigravity，默认关闭。当前 API key 后端使用独立 TypeScript 引擎和
SDK 0.1.23 的 localharness。第一次创建会话时从官方 PyPI 按需下载；Litch 不捆绑该程序，
也不要求 Python。程序、wheel 和 schema 均按版本与 SHA-256 固定；损坏或未知版本会明确报错。
已装 App、IDE 或 `agy` CLI 不代表已装 SDK runtime。
API key 模式无需安装 agy CLI；自定义 SDK runtime 仍用 `CHA_ANTIGRAVITY_CLI`，不要填到订阅 CLI 的路径项。

在 Devices → Antigravity → Settings → Accounts 配置 `GEMINI_API_KEY`，保存后重启引擎。
密钥只写不读回。默认模型和 Gemini API 地址在详情设置中修改，新建会话生效；自定义地址会
收到 API key。API key 后端没有订阅登录按钮，不读取桌面或 CLI 的 OAuth 缓存。

API key 后端支持文字流式、文件与同步命令工具、逐次审批、中断，以及自己创建的会话列表和恢复。
没有操作系统沙箱，每个工具执行前都要批准；拒绝或取消不执行。只有“逐次审批（无沙箱）”这一档，不能把它当作
只读或项目沙箱。第一期不支持计划、子代理、分叉、客户端工具或浏览器控制，模型切换需新建会话。
SDK 会话与 App/CLI 会话不可互相恢复。鉴权失效时更新 key；下载校验失败时检查指定路径或重新安装，
不要关闭校验或换未经核验的二进制。

The API key backend offers “Ask each time (no sandbox)”: every tool needs approval. It does not
provide read-only or workspace sandbox profiles, and it does not bypass approval.

Antigravity 默认使用订阅（官方 ACP）。只装 `agy`、未配置 API key 的用户无需下载 SDK runtime。
登录可在账号页通过链接和授权码完成，也可手动运行官方 `agy acp --login`。订阅通过官方 ACP 使用 CLI 登录；第三方客户端在消费套餐下的
适用范围仍需用户确认，存在账号限制风险。Litch 不读取或转存登录令牌。风险说明显示在“鉴权方式”
设置项，不另弹确认。API key 模式为低优先级实验选项，只有用户主动选择后才使用 localharness。

### 旧版 Claude Code 的自动压缩窗口

Claude Code 低于 2.1.299 时，对话仍正常运行，本次启动不传入 Litch 配置的模型压缩窗口，
其他设置保持生效。对话内提示实际路径、版本和未生效的设置，并指向设备详情的安装/更新入口。
同一会话、同一路径与版本只提示一次；切换 CLI 或升级后重新判断。更新并重启后，保存的窗口设置生效。
这项降级只针对自动压缩窗口，不改变其他功能各自的最低版本要求。
