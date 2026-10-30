# Operate this computer (remote devices)

With this on, sessions on a **remote device** can run commands, read and write files, and copy files
between that machine and this computer (the one running the Litch desktop app), after the user
approves. Requests travel back over the existing SSH connection and are approved and run by the desktop
app; no port is opened and macOS Remote Login is not used.

- Remote devices only, per device; **off by default**. Not available when the desktop app runs on
  Windows. The remote adapter needs 0.10.0 or later.
- Codex, Claude Code and Pi sessions started from Litch get it as tools; other harnesses (and anything
  else running on the remote machine) use the `litch-machine` command there (same as
  `codex-harness-adapter machine`: `machines`, `exec`, `ps`, `read`, `write`, `ls`, `cp`, `--json`).

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
