# Device settings

Each device (Local and every remote device with the device service) keeps its own settings. In the UI
they are the management area of the device's detail page (Devices → the device). The device service
declares the settings and their descriptions, so the live list is authoritative:

- `scripts/litch settings get <device>` lists every setting with its current value, default and
  description; `scripts/litch settings get <device> <key>` shows one.
- `scripts/litch settings set <device> key=value …` changes one or more settings in one save (exact
  value syntax for lists and environment variables: `scripts/litch settings --help`).

If someone else changed the settings at the same time, the command reports a conflict; read them again
and redo the change. Devices that only have Codex (no device service) have no settings.

## Keys

`<id>` is a harness id: `claude-code`, `codex`, `pi`, `dsh`, `opencode`, `gemini`, `qwen`, `acp`.

### Harnesses (one group per harness; changes restart that harness)

| Key | Type | Default | Meaning |
|---|---|---|---|
| `harness.<id>.enabled` | boolean | on for Claude Code and Pi; on when installed for DSH, OpenCode and Codex; off for Gemini CLI, Qwen Code and ACP | Offer this harness on the device. Off stops its runtime; the harness's own saved sessions are not touched |
| `harness.<id>.cliPath` | path | empty | Absolute path of the harness's command. Empty means look it up on the login `PATH` (and a few usual places). For `acp` it is required: the command of the ACP agent to run |
| `harness.<id>.env` | environment | empty | Environment variables only for this harness: proxy, API endpoint, API keys, `CODEX_HOME` for Codex. They override the service's own environment and the adapter's `env` file. Values can be marked secret |
| `harness.pi.approvals` | boolean | off | "Ask before acting": Pi asks before running commands, writing or editing files and other side effects in the main session. Not a security boundary (no sandbox; subagents are not asked about) |
| `harness.claude-code.promptCacheTtl` | enum `default` / `1h` | `default` | "Prompt cache duration" for Claude Code. `default` is what Claude Code does on its own (5 minutes with an API key, 1 hour when signed in with a Claude subscription). `1h` keeps the main conversation cached for an hour: cheaper for long conversations with pauses, but each cache write costs more (about 2× input instead of 1.25×). Subagents stay at 5 minutes. Passed to the runtime as `CHA_CLAUDE_PROMPT_CACHE_TTL` |
| `harness.claude-code.crossSessionInbox` | boolean | on | "Messages from other Claude sessions". While on, other Claude sessions on the same computer (the Claude desktop app, Claude Code in a terminal, other Claude sessions in Litch) can list Litch's Claude sessions and message them with `SendMessage`. The message shows in the conversation as "Message from …" and the session handles it in a turn of its own, with its own permissions: a full-access session runs the request without asking. Messages arrive only while the session's Claude Code process is running; after a turn ends it stays running for as long as `idleKeepAlive` says. Off: Litch's sessions are hidden from other sessions and receive nothing. Restarts Claude Code. Passed to the runtime as `CHA_CLAUDE_CROSS_SESSION_INBOX` |
| `harness.claude-code.idleKeepAlive` | enum `off` / `15m` / `1h` / `4h` | `1h` | "Keep idle sessions online". How long a Claude Code process stays after its turn ends when no background command keeps it, so other Claude sessions can still message the session and the next turn starts without a restart. Each kept session uses about 100–200 MB of memory; at most 8 processes are kept at once (shared with those keeping background commands), the longest idle closing first. Kept processes are not closed when every client disconnects. Applies only while `crossSessionInbox` is on. Restarts Claude Code. Passed to the runtime as `CHA_CLAUDE_KEEP_ALIVE_IDLE_SECONDS` |

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

### Session orchestration (group `sessions`, applies at once; `sessions.wrapUp` to new sessions)

| Key | Default | Meaning |
|---|---|---|
| `sessions.enabled` | on | Models may use `litch_sessions` to list and read sessions on the device, start sub-sessions and message their own sub-sessions; sub-sessions report back and can wake the parent. Off: new sessions do not get these tools; existing parent links still show |
| `sessions.wrapUp` | on | The model ends every turn with a `litch_sessions.wrap_up` call (its suggested tasks) and then its final answer. Off: sessions created afterwards do not get `wrap_up` and are not asked to wrap up, and no reminders are sent; the rest of `litch_sessions` works as before. Existing sessions keep the tools they started with |
| `sessions.wrapUpReminder` | on | If a turn you started ends without a wrap-up, Litch opens one short turn to remind the model. No effect while `sessions.wrapUp` is off |

### Worktrees (group `worktrees`, apply from the next worktree)

The device service creates a session's worktree with git on the device itself (only when git is
installed there). Existing worktrees are never moved.

| Key | Default | Meaning |
|---|---|---|
| `worktrees.root` | empty: `worktrees` in the device service's state directory | Absolute path; worktrees go under `<root>/<repository folder name>/` |
| `worktrees.branchPrefix` | `litch/` | Start of each new branch name; clearing it restores the default |
| `worktrees.fetchFirst` | off | Fetch the default branch from `origin` before branching from it. Off: use whichever of the local and `origin` copies is newer |
| `worktrees.autoCleanup` | on | When there are more live worktrees than `worktrees.keepCount`, remove those whose session is archived or gone first, then the least recently active (changes saved as a snapshot first; all restorable). Pinned, running, created within the last hour, and worktrees added as a project folder are kept |
| `worktrees.keepCount` | 15 (1 – 200) | Live worktrees to keep on the device |
| `worktrees.keptDays` | 30 (7 – 365) | A worktree with uncommitted changes whose session was archived is kept as it is for this many days, then its changes are saved as a snapshot and the folder removed |

## Things that are not device settings

- Per-device switches for the built-in browser, Computer Use and "operate this computer" live in Litch,
  not on the device: `scripts/litch tools set` (`browser-and-computer-use.md`).
- Projects: `scripts/litch projects list` and friends (`sessions-and-projects.md`).
- The adapter's `env` file (`~/.codex-harness-adapter/env`) is for standalone installs; prefer the
  per-harness `env` setting, which takes precedence anyway.
