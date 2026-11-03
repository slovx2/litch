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

In the UI: Devices → the remote device → "Use this computer" → "Operate this computer (commands and
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
  limit.
- 69 from inside Codex's default sandbox or Claude Code's "In project" / "Read only" modes: use the
  built-in tools of that session instead, or Full access.
- OpenCode's and Claude Code's command tools time out after 120 seconds by default, which can kill a
  command still waiting for approval; ask the model to raise the timeout.
