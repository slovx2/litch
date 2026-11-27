# Device settings

Each device (Local and every remote device with the device service) keeps its own settings. In the UI
device-wide settings are on Settings → the device. All devices are listed directly in the settings
navigation (desktop) or at the top of Settings (phone). Select a harness row to open its own page;
its Runtime tab contains enable/disable, restart and runtime settings (desktop also has installation).
The device service
declares the settings and their descriptions, so the live list is authoritative:

- `scripts/litch settings get <device>` lists every setting with its current value, type and title; querying one also gives its
  description; `scripts/litch settings get <device> <key>` shows one.
- `scripts/litch settings set <device> key=value …` changes one or more settings in one save (exact
  value syntax for lists and environment variables: `scripts/litch settings --help`).

If someone else changed the settings at the same time, the command reports a conflict; read them again
and redo the change. Devices that only have Codex (no device service) have no settings.

## Keys

`<id>` is a harness id: `claude-code`, `codex`, `pi`, `dsh`, `opencode`, `gemini`, `qwen`, `acp`.

### Harnesses (one group per harness; changes restart unless stated otherwise)

| Key | Type | Default | Meaning |
|---|---|---|---|
| `harness.<id>.enabled` | boolean | on for Claude Code and Pi; on when installed for DSH, OpenCode and Codex; off for Gemini CLI, Qwen Code and ACP | Offer this harness on the device. Off stops its runtime; the harness's own saved sessions are not touched |
| `harness.<id>.cliPath` | path | empty | Absolute path of the harness's command. Empty means look it up on the login `PATH` (and a few usual places). For `acp` it is required: the command of the ACP agent to run |
| `harness.<id>.env` | environment | empty | Environment variables only for this harness: proxy, API endpoint, API keys, `CODEX_HOME` for Codex. They override the service's own environment and the adapter's `env` file. Values can be marked secret |
| `harness.<id>.taskCards` | boolean | on | Suggested tasks, new-session offers, wrap-up and reminders for this harness; applies immediately to existing sessions too. Explicitly authorized sub-session starts remain available |
| `harness.<id>.backgroundShell` | boolean | on | Only `pi`, `opencode` and `acp`. "Background commands": gives the model `litch_shell` tools (start, read, stop, list) so dev servers, watchers and long builds or scripts keep running after the turn ends; they show under Background tasks and the model continues on its own when one finishes by itself. Commands run on this device like the model's own; running ones stop when this harness's runtime restarts. Claude Code, Codex and DSH have their own background commands; Gemini CLI and Qwen Code do not get this. Restarts the harness. |
| `harness.pi.approvals` | boolean | off | "Ask before acting": Pi asks before running commands, writing or editing files and other side effects in the main session. Not a security boundary (no sandbox; subagents are not asked about) |
| `harness.claude-code.toolLoading` | enum `auto` / `on` / `off` | `auto` | On-demand tool defaults; Automatic keeps unverified environments upfront. Explicit per-tool declarations win. Restart Claude Code to apply. |
| `harness.claude-code.toolLoadingOverrides` | string | empty | Comma-separated `namespace=always` or `namespace.tool=defer`. Goal and permission keys: `goal-tools`, `permission-tools`. Applies when on-demand loading is enabled; restart to apply. See harnesses for environment equivalents and priority. |
| `harness.claude-code.promptCacheTtl` | enum `default` / `1h` | `1h` | "Prompt cache duration" for Claude Code. `default` is what Claude Code does on its own (5 minutes for API, cloud and extra usage; 1 hour within subscription usage). The default `1h` keeps the main conversation cached for an hour: cheaper for long conversations with pauses, but each cache write costs more (about 2× input instead of 1.25×). Subagents stay at 5 minutes. |
| `harness.claude-code.crossSessionInbox` | boolean | on | "Messages from other Claude sessions". While on, other Claude sessions on the same computer (the Claude desktop app, Claude Code in a terminal, other Claude sessions in Litch) can list Litch's Claude sessions and message them with `SendMessage`. The message shows in the conversation as "Message from …" and the session handles it in a turn of its own, with its own permissions: a full-access session runs the request without asking. From the Claude desktop app or a terminal, messages arrive only while the session's Claude Code process is running (after a turn ends it stays running for as long as `idleKeepAlive` says); another Litch Claude session on the same device starts the receiving session's process first if it is not running. Off: Litch's sessions are hidden from other sessions and receive nothing. Restarts Claude Code. |
| `harness.claude-code.idleKeepAlive` | enum `off` / `15m` / `1h` / `4h` | `1h` | "Keep idle sessions online". How long a Claude Code process stays after its turn ends when no background command keeps it, so other Claude sessions can still message the session and the next turn starts without a restart. Each kept session uses about 100–200 MB of memory; at most 8 processes are kept at once (shared with those keeping background commands), the longest idle closing first. Kept processes are not closed when every client disconnects. Applies only while `crossSessionInbox` is on. Restarts Claude Code. |

原生 Codex 使用独立的设备内设置 `litch.backgroundWake`（Codex 详情的配置页，不是上表的运行时环境变量）。需要 Codex 0.163.0 及以上，默认开，新建会话获得 `litch_background` 登记工具；关闭会取消已登记任务的自动继续，不停止命令、不重启 Codex。任务仍由原生执行器管理权限、输出和生命周期；设备或 Codex 重启不自动继续，自动续跑不设次数上限。低版本会显示当前不支持及升级提示，但开关仍可更改。升级后新建会话才获得登记工具。

这也适用于新建的 Codex 子会话、接受提案后新建的会话、经理和经理工作线。修改经理规则保留已经安装的后台登记工具。旧版本曾将部分子会话的工具登记覆盖，升级不会自动修复这些旧记录；若仍提示本会话未安装登记工具，请新建会话。

Native Codex has a separate `litch.backgroundWake` setting in its Config tab. It defaults to on and requires Codex **0.163.0 or later**. Older versions show an upgrade hint without disabling the switch; start a new session after upgrading. Turning it off cancels registered continuations without stopping commands or restarting Codex. Device/runtime restarts do not resume this work; automatic continuations have no count limit.

The ACP entries take their arguments from an environment variable in their own `env` setting:
`CHA_GEMINI_ARGS`, `CHA_QWEN_ARGS`, `CHA_ACP_ARGS` (split on whitespace, double quotes supported).

`scripts/litch harness enable` / `disable` are shortcuts for `harness.<id>.enabled`.

### SSH entries for the official Codex desktop app (group `ssh`, apply at once)

| Key | Default | Meaning |
|---|---|---|
| `ssh.<id>.enabled` | off when Litch started the service (Local, and remote services Litch starts); on for a service started by hand with `codex-harness-adapter start` | A built-in SSH server on `127.0.0.1` that lets the official Codex desktop app reach this harness. Litch itself never uses them |
| `ssh.<id>.port` | 7331 Claude Code, 7332 Pi, 7333 DSH, 7334 OpenCode, 7335 Gemini CLI, 7336 Qwen Code, 7337 ACP | Port on 127.0.0.1; every entry needs its own. Changing it drops existing connections; the Codex app's ssh config must follow |

There is no entry for Codex itself. `scripts/litch diagnose ssh-config <device>` prints the ssh config
snippet for entries that are on and running (see `troubleshooting.md`).

### Reconnectable terminals (group `processes`, apply to new terminals)

| Key | Default | Range | Meaning |
|---|---|---|---|
| `processes.bufferBytes` | 2097152 (2 MiB) | 65536 – 1 GiB | Output kept per terminal and replayed on reconnect |
| `processes.limit` | 32 | 1 – 4096 | Terminals running at once on the device |
| `processes.idleMs` | 0 (keep forever) | 0 – 2147483647 | End a terminal nobody has been attached to for this long |
| `processes.exitedMs` | 600000 (10 min) | 0 – 2147483647 | How long an exited terminal's status and output are kept |

### Scheduled tasks (group `tasks`, apply at once)

| Key | Default | Meaning |
|---|---|---|
| `tasks.enabled` | on | "Run on schedule". Off: schedules do not fire; running and manually started runs continue. When turned back on, missed times are not made up (one-time tasks still run once) |
| `tasks.maxConcurrent` | 2 (1 – 16) | Task runs going at once on the device; the rest wait in order |
| `tasks.approvalTimeoutMinutes` | 30 (1 – 1440) | Approvals and questions in a task's turn wait this long for someone to answer them from the desktop or phone, then the device declines them (questions skipped) and notes it in the run history |

### Session orchestration (group `sessions`, applies at once; `sessions.wrapUp` to new sessions)

| Key | Default | Meaning |
|---|---|---|
| `sessions.enabled` | on | Models may use `litch_sessions` to list and read sessions on the device, start sub-sessions and message their own sub-sessions; sub-sessions report back and can wake the parent. Off: ordinary new sessions do not get these tools; existing parent links still show. Does not affect managers or their worklines: delegation, reports and automatic wakes continue |
| `sessions.wrapUp` | on | The model ends every turn with a `litch_sessions.wrap_up` call (its suggested tasks) and then its final answer. Off: sessions created afterwards do not get `wrap_up` and are not asked to wrap up, and no reminders are sent; the rest of `litch_sessions` works as before. Existing sessions keep the tools they started with |
| `sessions.wrapUpReminder` | on | If a turn you started ends without a wrap-up, Litch opens one short turn to remind the model. Antigravity subscription sessions skip this reminder; the setting also has no effect while `sessions.wrapUp` is off |

### Worktrees (group `worktrees`, apply from the next worktree)

The device service creates a session's worktree with git on the device itself (only when git is
installed there). Existing worktrees are never moved.

| Key | Default | Meaning |
|---|---|---|
| `worktrees.root` | empty: `worktrees` in the device service's state directory | Absolute path; worktrees go under `<root>/<repository folder name>/` |
| `worktrees.branchPrefix` | `litch/` | Start of each new branch name; clearing it restores the default |
| `worktrees.fetchFirst` | off | Fetch the default branch from `origin` before branching from it. Off: use whichever of the local and `origin` copies is newer |
| `worktrees.autoCleanup` | on | When there are more live worktrees than `worktrees.keepCount`, remove those whose session is archived, least recently active first (changes saved as a snapshot first; all restorable). Worktrees of sessions that are not archived are never removed, so the count can go over. Pinned, running, created within the last hour, still shared by an unarchived session, and worktrees added as a project folder are kept |
| `worktrees.keepCount` | 15 (1 – 200) | Live worktrees to keep on the device |
| `worktrees.keptDays` | 30 (7 – 365) | A worktree with uncommitted changes whose session was archived is kept as it is for this many days, then its changes are saved as a snapshot and the folder removed |

## Power (local macOS service)

Settings → the device → **Power** saves switches immediately. The desktop registers its
local service; a phone connected to that service can use the local-task and plugged-in switches too. Ordinary remote services do not
get them automatically. Windows/Linux do not support them.

| Key | Default | Meaning |
|---|---|---|
| `power.preventSleepWhileWorking` | on | Local tasks only: prevent idle system sleep while a turn (including approvals/questions) or background task runs, on battery too; releases 30 seconds after work ends |
| `power.preventSleepWhileRemoteWorking` | off | Desktop local-device settings only: also prevent local sleep for turns and background tasks on connected remote devices, independently of the local-task switch |
| `power.keepAwakeWhilePluggedIn` | off | While plugged in, keep the system awake even without tasks and with the desktop app closed, as long as the device service runs |

The desktop's local-device toolbar and the phone device header offer the plugged-in shortcut.
The state line reports whether the service is actually requesting wakefulness, running on battery,
or failed. Unplugging releases the plugged-in request within about 15 seconds; running tasks still
follow their own switches. Remote tasks do not affect local sleep by default. The remote option uses
the desktop's existing connection state, without extra remote polling; disconnected, unavailable or
unconfirmed work retains its original evidence for at most 90 seconds. Closing the desktop ends
remote reporting; local tasks and the plugged-in setting remain controlled by the local service.
All switches increase power use and allow the display to sleep and lock. They do
not prevent lid closure/manual sleep/shutdown/low-battery protection, wake a sleeping machine, or make
locked-screen interaction work. Work bypassing the device service is outside their scope.

```sh
scripts/litch settings get local power.keepAwakeWhilePluggedIn
scripts/litch settings set local power.keepAwakeWhilePluggedIn=on
```

A service-only local install can register on that computer with
`codex-harness-adapter device-start --local-service`; later restarts keep the choice.

## Suggestion retention

Settings → the device → **Session orchestration → Suggestion retention** controls ordinary pending
suggestions. `sessions.suggestionRetentionDays` is an enum: `1`, `3`, `7` (default),
`14`, `30` or `never`. Changes apply immediately without restarting and recalculate expiry
from each card's original creation time. Shortening retention can expire old cards immediately;
handled and expired cards never come back when retention increases. The global list is described
in `managers-and-suggestions.md`.

```sh
scripts/litch settings get local sessions.suggestionRetentionDays
scripts/litch settings set local sessions.suggestionRetentionDays=14
scripts/litch settings get local sessions.suggestionRetentionDays
```

Use `never` instead of `14` to keep pending cards indefinitely. Values are plain enum strings:
do not add JSON quotation marks inside the value.

## Things that are not device settings

- 执行“操作这台电脑”的审批方式、访问范围仍保存在桌面端；开关 `tools.machine` 与
  `tools.browser`、`tools.computer` 均保存在设备。浏览器/CU 另有 `harness.<id>.browser|computer` 覆盖。
  使用 `scripts/litch tools set`，见 `browser-and-computer-use.md`。
- Projects: `scripts/litch projects list` and friends (`sessions-and-projects.md`).
- The adapter's `env` file (`~/.codex-harness-adapter/env`) is for standalone installs; prefer the
  per-harness `env` setting, which takes precedence anyway.

### Claude 的驱动后端

`harness.claude-code.backend` 可选 `sdk`（默认）或 `tui`。无需重启：当前回合仍用原后端，下一回合按新设置恢复同一个原生会话；已有会话也适用。切换时如原进程还有回合、审批或后台任务，先结束它们，避免丢失活动任务。

TUI 要求 Claude Code **2.1.316 或更新版本**。默认验证版已满足此要求。版本不足时，在设备的 Claude Code 安装与更新中选择“默认验证版”或“更新到最新”。SDK 的版本要求不变。TUI 启动失败不会自动退回 SDK；需要先在会话所属设备完成 CLI 登录和工作目录信任。

TUI 第一版不支持计划模式与计划确认、子代理、后台任务、PowerShell 工具、运行中插话、分叉、手动压缩、追加上下文、持续目标和会话间消息。中断会关闭当前 CLI，下一回合从原生历史恢复。用量来自已落盘消息，不是完整的后台总账。原样 magpie tap 可用时提供 token 增量，否则按消息块显示；不承诺订阅额度节省。

路径设置旁可选择目录或文件。CLI 路径使用文件选择器，工作树存放位置使用目录选择器；harness 声明的路径字段也提供对应选择。远程文件列表会标注链接和可执行文件，不读取文件内容或运行选中的文件。路径浏览需要设备服务提供此能力；旧设备会提示手动填写或升级，填写路径与保存设置仍可使用。设备服务的状态目录在界面中为只读信息，不提供更改入口。

SSH 私钥和“操作这台电脑”的自定义位置属于桌面本机，始终使用本机选择器，不会浏览待连接或发起请求的远程设备。手机的 SSH 私钥仍通过手机文件选择器导入。

## 无人值守与 GitHub 仓库

桌面：所有者在“设置 → GitHub”，登记后显示各设备同步状态，有未同步设备时点刷新图标重新同步。其余在“设置 → 设备 → 无人值守”：设备详情的“无人值守”一行显示采集概况，进入后依次为开机自启、GitHub 身份、仓库和经理分配。身份行的“+”打开添加向导，设备码方式大字显示一次性码，可复制，可在系统浏览器打开 github.com/login/device；关闭向导会取消仍在等待的授权。仓库行显示状态点、四项就绪点和待分拣数，暂停、恢复用行尾图标，展开后修改触发、门槛、反馈、采集身份、目录和回写，改动后才出现预览和保存。经理设置的“运行环境”里也能为该经理选择身份、仓库和凭据注入。

本机与使用该设备账号登录的桌面 SSH 连接都可以配置身份、仓库、经理分配和开机自启。设备未返回权限时，只显示可查阅的信息；失去权限后关闭已打开的配置表单。

展开仓库，点「就绪检查」旁的重新检查，可以查看工作目录、设备自启、Agent 的 GitHub 身份和回写权限。普通检查不会写入 GitHub；「写权限未验证」表示设备尚不能通过读取确认写入能力。

手机：设备详情的“无人值守”只读显示仓库状态、开机自启、身份和经理分配，仓库可以暂停、恢复；配置改在桌面或 `litch config`。设备未提供的操作不显示。

下文说明配置模型和命令。

所有者是全局设置，可以通过 GitHub 个人主页、数字 ID 或桌面所在电脑的 `gh` 登录解析，按数字 ID 同步到各设备。离线设备回到在线后须重新检查同步状态。

无人值守按三层配置：

1. **GitHub 身份**：设备可用 GitHub CLI 设备码授权机器人账号，也可导入目标设备的 gh 登录或接收细粒度令牌。如果授权的是所有者账号，须明确确认。一个身份可为不同资源所有者绑定多份细粒度令牌；明文不会显示。

   目标设备首次用设备码授权时会下载并校验 GitHub CLI，可通过代理下载。设备码授权固定申请 `repo`、`read:org` 和 `gist`；桌面向导默认勾选 `notifications`。已有机器人缺少此权限时，在「GitHub 身份」找到它，点「加权限」，用同一个机器人账号重新授权。也可导入设备上已具备该权限的 gh 登录。细粒度令牌可继续用于仓库兜底，不提供机器人通知。
2. **仓库**：从已授权身份可读的仓库中添加，每台设备同一仓库只采集一次。填写目标设备上的工作目录、允许的 base 分支；采集身份可由设备选择或手动指定。设置触发项、标签路由与回写权限。近 24 小时预览不会写 GitHub、移动水位或启动模型；诊断可能指出未查全的范围。
3. **经理分配**：一位经理使用一个 GitHub 身份并接收指定仓库的事件。同一仓库里，一个身份只能分给一位经理。@、指派和 review 请求按身份寻址；标签按仓库路由。默认给经理与工作线注入这一身份的凭据：注入后 gh 和访问 github.com 的 Git 在任何目录都用这一身份，凭据失效或身份配置异常时命令报错，不改用系统 gh。关闭后改用系统 gh 凭据，寻址身份保持不变。Qwen 在 Windows 上和 Antigravity 订阅登录方式下，Agent 自己跑的命令认不出所在会话，注入对它们不生效，照旧用系统 gh。Qwen 的已注入会话里，审批卡片上的命令前面会多出一行 `export LITCH_THREAD_ID=…`。Gemini 的已注入会话各占一个 Gemini 进程。设备上有经理开着注入时，新建的 Gemini 会话第一回合也单独起进程，比共用进程慢几秒；没有经理开注入时不受影响。OpenCode 为认出会话装了一个本地插件；OpenCode 有插件时，会先等它在配置目录里装插件依赖。设备连不上 npm 源，而这个依赖又从没装成过时，打开项目会多等约一分钟。

设备首先查看每个经理所绑定的机器人在已分配仓库中的通知，接收 @ 提及、指派和评审请求。已读通知也会采集；Litch 不会标为已读或改订阅。通知按 GitHub 返回的轮询间隔采集，至少 60 秒，独立于仓库来源间隔；限流时按返回时间重试。仓库事件仍按来源间隔另行核对，负责已绑定主题的跟进、CI、关闭与合并，也补查漏掉的请求。可在仓库的「就绪检查」查看通知权限与接口状态。

缺少通知权限或通知接口不可用时，就绪检查只提示该入口降级，来源保持启用；仓库流每轮兜底，仍可入箱、提醒和接单。

即时反馈默认开启，语言默认跟随 Litch 界面。经理身份没有评论写权限时，就绪检查会说明即时反馈不可用。评论和草稿 PR 开关允许经理通过 Litch 工具代写；Agent 也可按设备自身的 gh、git、SSH 配置工作。Agent 的 gh 身份如果是你的账号，它发的评论会被视作你的评论。

先开启采集，再单独打开自动提醒经理。暂停采集不删除历史；就绪检查分别显示采集、提醒、派工作线和回写。检查限额、覆盖缺口和积压，再决定是否恢复。执行隔离结果供参考。设备服务自启是独立开关；Linux 是否能在登出后工作取决于 systemd linger，macOS、Windows 的用户服务要登录后才运行。受控接管或卸载可能重启或停止当前服务，以重连后读到的状态为准。

### 配置命令

以下用法也可在终端运行 `litch config`，把命令开头的 `scripts/litch` 换成 `litch config`。

- `scripts/litch external-owner resolve <主页或数字ID>`，或使用 `--local-gh`；`scripts/litch external-owner get` 查看同步状态，加 `--device <设备>` 查看实际值；`scripts/litch external-owner set <主页或数字ID>` 解析后由桌面确认。
- `scripts/litch device-identity list` 获取身份、凭据引用与代次；`scripts/litch device-identity repositories` 查看可访问仓库，按需使用 `--identity`、`--cursor`。
- `scripts/litch device-identity add --scopes notifications` 用 GitHub CLI 设备码授权并允许采集通知。已有机器人用同一个账号重做；要保留其他可选权限，在 `--scopes` 里一起列出。用 `scripts/litch device-identity login status <登录ID>` 查询，`scripts/litch device-identity login cancel <登录ID>` 取消，或用 `scripts/litch device-identity login confirm <登录ID>` 确认使用自己的账号。
- `scripts/litch device-identity import` 可导入设备上已登录的 gh 账号；`scripts/litch device-identity revoke <身份ID> <凭据引用>` 撤销指定凭据。
- 在目标设备运行 `scripts/litch device-identity paste --stdin` 或 `scripts/litch device-identity rotate <身份ID> <凭据引用> --stdin`。别名 `scripts/litch device-source credential configure --stdin` 与 `scripts/litch device-source credential rotate <身份ID> <凭据引用> --stdin` 也接受相同的输入。安装后的命令可写为 `litch config`，替换 `scripts/litch`。令牌须从管道或重定向读入。不要把令牌放进参数、对话、环境输出或 shell 历史。
- `scripts/litch device-source list --json` 查看来源及版本；`scripts/litch device-source preview --draft '<来源JSON>'` 预览；`scripts/litch device-source upsert --draft '<来源JSON>' --revision <版本>` 经预览和桌面确认后保存。新来源版本为 0；JSON 仅包含公开配置和凭据引用。每个来源传一个仓库，通过仓库字段设置 `pollIdentity`、`labelRoutes`、`immediateFeedback` 和 `immediateFeedbackLanguage`。
- `scripts/litch device-source manager get <经理ID>` 查看分配和版本；用 `scripts/litch device-source manager set <经理ID> --identity <身份ID> --repos <仓库ID列表> --inject on --revision <版本>` 保存，清除用 `--identity none`。
- `scripts/litch device-source check <来源ID>` 检查就绪；`scripts/litch device-source pause <来源ID>` 暂停；`scripts/litch device-source resume <来源ID>` 恢复。
- `scripts/litch device-autostart status` 查看；`scripts/litch device-autostart enable` 启用，接管、linger 分别用 `--takeover`、`--allow-linger`；`scripts/litch device-autostart disable` 卸载自启。若需要停服务，明确给 `--confirm-stop`；可用 `--resume-after-restart` 选择恢复计划。

设备命令默认本机。设置远程目标时加 `--device <设备>`；桌面与命令操作的是同一台设备的配置。
