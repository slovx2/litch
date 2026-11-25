# Operate this computer (remote devices)

With this on, sessions on a **remote device** can run commands, read and write files, and copy files
between that machine and this computer (the one running the Litch desktop app), after the user
approves. Requests travel back over the existing SSH connection and are approved and run by the desktop
app; no port is opened and macOS Remote Login is not used.

- Remote devices only, per device; **off by default**. Supports macOS and Windows desktops.
  The remote adapter needs 0.10.0 or later.
- Codex, Claude Code and Pi sessions started from Litch get it as tools; other harnesses (and anything
  else running on the remote machine) use the `litch-machine` command there (same as
  `codex-harness-adapter machine`: `machines`, `exec`, `ps`, `read`, `write`, `ls`, `cp`, `--json`).

开关 `tools.machine` 保存在会话所在设备，默认关闭，不分 harness。升级首次连接时从旧桌面设置迁入一次，设备已有值优先。
开启后，普通会话、经理、工作线、手机创建及其子会话、定时新会话均获得 `litch_machine`，即使桌面离线也一样。
执行时需要具备“操作这台电脑”能力的桌面连接；没有则立即返回 `noExecutor`，桌面连接后下一次调用即可执行。
已有会话不会补装工具，开启后请新建经理或新开线。设备关闭开关后，动态工具调用直接返回 `disabled`；命令行入口仍可由执行桌面展示原有开启确认卡。
审批方式、访问范围、操作记录仍属于具体执行桌面。

## Settings

In the UI: Settings → the remote device → "Use this computer" → "Operate this computer (commands and
files)".

When access is off, a tool call displays an enable card in the calling conversation and the desktop's
global pending requests, with a system notification. Only the user can choose **Enable and continue**:
this enables access with sensitive places blocked and every command/write requiring approval, then
continues the same call through its normal operation approval. **Open settings** opens that device's
settings without enabling access. Declining or leaving the card unanswered for 10 minutes keeps access
off; the model must not retry repeatedly or bypass this restriction. This enable card is desktop-only;
the phone's signed approval channel currently supports browser sign-in, not this setting.

- Turn it on or off with `scripts/litch tools set <device> …` (see `scripts/litch tools --help`).
  Turning it on is **guarded** (the user confirms in Litch). Turning it off ends every process that
  device started here, withdraws pending cards and fails calls in progress.
- `scripts/litch machine set <device> …` changes approval and access (flags: `scripts/litch machine
  --help`). Loosening either is **guarded**.

**Approval** (UI "Approval"):

| Value | UI | Behavior |
|---|---|---|
| `session` (default) | Once per session | Each session asks once for "run and write" and once for "read and list" |
| `each` | Every action | Every command and write asks; reads ask once per session |
| `never` | Never ask | No cards. Litch marks this in red in the title bar and settings. Only on explicit request |

Cards offer Allow once / Allow for this session / Decline (with an optional note to the model). There
is no "always allow". A card unanswered for 10 minutes counts as declined.

无人值守经理或子会话需要审批时，Mac 上的有限读写、列目录和非交互命令可在会话里显示「不阻塞 · 等你批准」。
会话可以继续，24 小时内可在执行操作的 Mac 上选择「仅允许本次」「限时允许」或「拒绝」。批准后同一份请求进入
会话的后台任务，可在那里停止；完成、拒绝和到期结果送回原会话。手机和其他桌面能看到卡片，批准须在执行操作的 Mac 上完成。
访问范围不变；涉及禁止位置的命令、交互命令或复制不进入异步审批。

**Allow for…** on the card grants this session N hours (0.25–168) of every action, including in
"Every action" mode; commands that mention a blocked location still ask. The grant is kept on the
session's device and shown above the composer, where × revokes it (see "Timed approvals" in
`sessions-and-projects.md`).

**Access** (UI "Access"):

| Value | UI | Behavior |
|---|---|---|
| `sensitive` (default) | Block sensitive places | Blocks a built-in list: `~/.ssh`, `~/.gnupg`, keychains, mail, messages, contacts, calendars, browser profiles, Litch's own data, `~/.codex-harness-adapter`, Codex and Claude credentials, gh, aws, docker, kube, `.netrc`, `.npmrc` and similar |
| `open` | Allow everything | Nothing blocked |
| `custom` | Custom | Starts from the built-in list; add or remove paths |

File tools refuse blocked places outright. Commands cannot be fully checked: a command that mentions a
blocked place shows a red card even if the session was already allowed.

Copying a folder also checks its destination children: blocked subfolders and files are skipped and
reported, even when the destination root itself is allowed.

### Windows

- Commands run in Windows PowerShell without a profile, with UTF-8 input/output. Use PowerShell
  syntax; `machines` reports the shell. Text writes use UTF-8 without a BOM and preserve the supplied
  line endings. Copy preserves bytes, including files using legacy encodings; text reads expect UTF-8.
- Paths accept `C:\Users\name\file.txt`, `C:/Users/name/file.txt`, `~/file.txt` and UNC paths such as
  `\\server\share\file.txt`. Access checks ignore case and resolve junctions and symbolic links.
  Drive-relative paths (`C:file.txt`), device paths and alternate data streams are rejected.
- Windows 列目录和递归复制在遍历前统一解析禁止规则与实际目录的真实路径；8.3 短名、大小写或 junction 别名不能改变禁止范围。禁止目录本身可显示，内部条目不展开；路径解析失败时停止，不回退到字面比较。
- The Windows sensitive list covers SSH/GPG keys, Windows credentials and protection keys,
  browser profiles, Outlook data, Litch and harness configuration, and common CLI credentials.
  AppData locations follow this computer's configuration. Custom paths are absolute paths or use `~`.
- End and Stop all terminate the entire process tree. POSIX signals are unavailable; use `ps … kill`.
- From a remote shell, quote the whole Windows argument, for example:
  `litch-machine cp 'desktop:C:\Users\name\report.txt' 'session:/tmp/report.txt'`.
- If PowerShell or a file operation reports access denied or a security-policy error, review the
  original error and Windows Security's Protection history or your organization's policy. Litch does
  not bypass those controls; only approve the program or folder if you recognize and trust it.

## Long commands / 长命令

- `litch_machine.exec` 的 `timeout_ms`（命令行 `litch-machine exec --timeout-ms`）默认 10 分钟
  （600000 毫秒），最多 60 分钟（3600000 毫秒）。到期时执行设备结束进程。
- 单次调用最多等待 100 秒；设 `yield_ms`（命令行 `--yield-ms`）可提前拿到进程号，再用
  `litch_machine.process`（命令行 `litch-machine ps`）按序号读取。输出只保留最近一段，
  单次返回最多 32 KiB。回合结束不影响已返回进程号的命令；来源设备持续断线 10 分钟会结束其命令，
  在此之前重连可继续读取。桌面与实际执行命令的设备断开时，该连接上的进程会结束。
- `exec` gives the command 10 minutes by default (600000 ms), with a maximum of 60 minutes
  (3600000 ms). A single call waits at most 100 seconds. Set `yield_ms` (`--yield-ms` in the CLI)
  to get a process ID sooner, then read new output with `process` (`litch-machine ps`). Only recent
  output is retained, and each response returns up to 32 KiB. Yielded commands can outlive the
  model's turn. A continuous 10-minute disconnect from the source device stops its commands; if it
  reconnects sooner, you can continue reading. If the desktop loses its connection to the
  execution device itself, processes on that connection end.
- 如果已有会话仍显示旧的工具时限，开始新会话以获取更新后的工具说明。
  If an existing session still shows the old tool limit, start a new session to get the updated tool definition.

## Watching and stopping

- The title bar shows a marker while a remote device runs commands here or waits for approval; its
  popover lists pending cards and running commands (End one, or Stop all).
- `scripts/litch machine log <device>` shows the recent operations from that device (kept on this
  computer, up to 500 per device).
- `scripts/litch machine log-clear <device>` clears that log. **Irreversible: ask first**; the user then confirms in Litch.

## Common problems

- Exit codes of `litch-machine` on the remote side: 64 bad arguments, 69 cannot reach the device service
  or blocked by a sandbox, 75 no Litch desktop connected, 76 several Litch desktops connected, 77
  declined or unanswered, 78 switch is off, 79 blocked by access scope, 80 still running at the time
  limit, 81 submitted for approval and not yet executed.
- 69 from inside Codex's default sandbox or Claude Code's "In project" / "Read only" modes: use the
  built-in tools of that session instead, or Full access.
- OpenCode's and Claude Code's command tools time out after 120 seconds by default, which can kill a
  command still waiting for approval; ask the model to raise the timeout.
