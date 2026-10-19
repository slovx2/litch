---
name: litch-manual
description: "Litch product manual and configuration assistant. Use when the user asks how Litch works or wants Litch set up or changed: devices and remote devices, harnesses (enable, CLI path, environment, how to install them), projects, sessions and sub-sessions, scheduled tasks, the built-in browser, Computer Use, letting remote devices operate this computer, phone pairing, appearance and language, diagnostics. Changes go through the bundled litch config command. Litch 产品手册与配置助手：用户问 Litch 怎么用，或要配置 Litch（设备与远程设备、harness 的开关与安装方法、项目、会话与子会话、定时任务、内置浏览器、Computer Use、远程设备操作本机、扫码绑定手机、外观与语言、诊断）时使用；改配置一律通过自带的 litch config 命令。"
---

# Litch manual

Litch is a desktop client (macOS, Windows) that gathers coding-agent harnesses (Claude Code, Codex, Pi,
DSH, OpenCode, Gemini CLI, Qwen Code and other ACP agents) from this computer and from remote machines
reached over SSH into one window. This skill is its manual: what everything is, where it lives in the UI,
and how to change it for the user with the `litch config` command.

Answer in the user's language (this manual is in English; translate UI names when the user writes
Chinese, the UI itself is bilingual).

## The configuration command

All configuration goes through one command in this skill's folder (the folder that holds this
`SKILL.md`; usually `~/.agents/skills/litch-manual`):

```sh
<skill folder>/scripts/litch <group> <action> [positional args] [--key value | --flag] [--json]
```

On Windows run `<skill folder>\scripts\litch.cmd` with the same arguments. In this manual the
command is written `scripts/litch …`; always call it by its absolute path.

- The Litch desktop app must be running on this computer. The command hands the request to it and
  prints its answer. If the app is not running the command says so and exits non-zero: ask the user to
  open Litch, then retry. Do not try to start or restart Litch yourself.
- `scripts/litch help` lists every group and action. `scripts/litch <group> --help` gives the exact
  arguments of one group. **Argument details are defined by `--help`, not by this manual**: when unsure
  about a flag or a value, ask `--help` first instead of guessing.
- A device argument accepts the device's name, its id, or `local` (this computer).
- Output is short text meant for you. Add `--json` for structured output when you need to parse it.
- A non-zero exit code means the change did not happen; read the message and tell the user.
- Never edit Litch's or the adapter's files directly (`devices.json`, `settings.json`, the
  `~/.codex-harness-adapter/env` file, preferences, local storage). The command updates the running app
  and the UI at once; hand-edited files are overwritten or ignored.

## Working rules

1. **Look before you change.** Run `scripts/litch status` first, and the matching read action
   (`list`, `get`, `log`, `sites`, `apps`, `status`) before any write. Use the names and ids it
   prints; do not invent device or task ids.
2. **One change at a time, then verify.** After a write, read the state back and tell the user what
   changed in plain words.
3. **Irreversible actions need the user's explicit yes in this conversation first**, even when the
   user's request implies them: `scripts/litch devices remove`, `scripts/litch phones revoke`,
   `scripts/litch tasks delete`, `scripts/litch machine log-clear`, `scripts/litch browser clear-data`.
   Say exactly what will be lost, wait for a clear yes, then run it. Litch then also shows a
   confirmation card (rule 4) naming what will be deleted; nothing is deleted until the user clicks
   Allow there.
4. **Guarded and irreversible actions wait for a click in the desktop app.** Actions that give agents
   more power (`scripts/litch tools set` turning Computer Use or "operate this computer" on,
   `scripts/litch machine set` loosening approval or access, `scripts/litch browser allow`) make Litch
   show a confirmation card, and so do the irreversible actions in rule 3; the change only happens when
   the user clicks Allow there. Tell the user to look at the Litch window. If they decline, accept it
   and do not retry in a loop.
5. **Prefer the narrowest change.** Turn on a capability for the one device that needs it, allow one
   site rather than many, keep "operate this computer" on its default approval unless the user asks.
6. **Settings that restart a harness interrupt it.** Changing a harness's enabled flag, CLI path or
   environment restarts that harness on that device; running turns in it stop. Warn the user if they have
   work running there (`scripts/litch status` shows it).
7. **Secrets.** Only write an API key into a harness's environment when the user gives it to you for
   that purpose. Do not echo keys back in full.
8. If a command answers that this Litch version does not have an operation, trust that answer, run
   `scripts/litch help`, and use what exists.

## System tasks are not Litch commands

`litch config` only covers Litch's own features. Things that belong to the operating system or to
other tools are done the usual way, in a shell, following the official instructions, with the user's
OK (or by telling the user what to run): installing or upgrading a harness (`references/harnesses.md`
has the official commands and the versions Litch verified), installing the Litch adapter on a remote
machine, SSH keys and `known_hosts` (`references/devices.md`), system permissions
(`references/browser-and-computer-use.md`). Afterwards, make Litch notice the change with its own
command: `scripts/litch harness restart`, `scripts/litch devices reconnect`, or the matching `status`.

## Things you cannot or should not do

| # | What | What to do instead |
|---|---|---|
| E1 | Grant system permissions: macOS Accessibility and Screen Recording, Windows UAC prompts | Tell the user which switch to turn on and where (`references/browser-and-computer-use.md`); the user flips it |
| E2 | Scan the phone pairing QR code, compare the confirmation code, click Allow | `scripts/litch phones pair <device>` opens the QR dialog; the user does the rest on the phone and the computer |
| E3 | Sign in to a harness (Claude Code's sign-in, `codex login`, getting API keys) | Tell the user to sign in in that harness's own CLI. If they give you a key, you may store it in the harness's environment (see `references/harnesses.md`) |
| E4 | Password logins, first-time host-key confirmation, creating or copying SSH keys when adding a remote device | Litch only adds targets that already log in without a password. Explain how to set that up (`references/devices.md`) and let the user do it |
| E5 | Updating Litch itself (checking, downloading, restarting to update, the automatic-check switch) | Not part of this manual or the command. Tell the user it is in Settings → About → Updates |
| E6 | Loosen security without the user seeing it | Guarded actions always show a confirmation card in Litch (rule 4) |
| E7 | Irreversible changes without asking | Ask first, then the user confirms in Litch (rules 3 and 4) |
| E8 | Keyboard shortcuts | Not configurable in Litch; you can only tell the user what they are |
| E9 | Settings of the Litch app on a phone | The desktop cannot reach them; tell the user where they are in the phone app |

When you hit one of these, say plainly which step the user has to do, where, and what happens after.

## Command index

Every operation, with the reference that explains it. Exact arguments: `scripts/litch <group> --help`.

| Command | Does | Reference |
|---|---|---|
| `scripts/litch help` | List all groups and actions | this file |
| `scripts/litch status` | Overview: devices and connection state, harnesses and versions, tool switches, paired phones, app version, language and look | `references/concepts-and-ui.md` |
| `scripts/litch open` | Open a page in the app: `settings[/section]`, `device <device>`, `tasks`, `new` | `references/concepts-and-ui.md` |
| `scripts/litch devices list` / `check` / `add` / `rename` / `wire` / `target` / `reconnect` / `remove` | Devices and remote devices | `references/devices.md` |
| `scripts/litch settings get` / `set` | A device's settings (harness switches, CLI paths, environment, SSH entries, terminals, scheduled tasks, session orchestration) | `references/device-settings.md` |
| `scripts/litch harness list` / `enable` / `disable` / `restart` | Harnesses on a device (installing them is a shell task, see the reference) | `references/harnesses.md` |
| `scripts/litch projects list` / `add` / `remove` | Projects (folders) on a device | `references/sessions-and-projects.md` |
| `scripts/litch tasks list` / `create` / `update` / `pause` / `resume` / `run` / `delete` | Scheduled tasks | `references/scheduled-tasks.md` |
| `scripts/litch tools set` | Per-device switches: built-in browser, Computer Use, operate this computer | `references/browser-and-computer-use.md`, `references/operate-this-computer.md` |
| `scripts/litch machine set` / `log` / `log-clear` | "Operate this computer": approval, access scope, activity log | `references/operate-this-computer.md` |
| `scripts/litch browser links` / `sites` / `allow` / `forget` / `clear-data` | Built-in browser preferences and data | `references/browser-and-computer-use.md` |
| `scripts/litch computer status` / `apps` / `forget` | Computer Use permission status and allowed apps | `references/browser-and-computer-use.md` |
| `scripts/litch phones list` / `pair` / `revoke` | Phones paired by QR code | `references/phones.md` |
| `scripts/litch look set` / `language` | Skin, light/dark, density, zoom; UI language | `references/appearance-and-preferences.md` |
| `scripts/litch notify task-success` | System notification when a scheduled task succeeds | `references/appearance-and-preferences.md` |
| `scripts/litch diagnose run` / `logs` / `ssh-config` | Diagnostics, logs, SSH entries for the official Codex app | `references/troubleshooting.md` |

## References

Read only the file you need.

- `references/concepts-and-ui.md`: devices, harnesses, projects, sessions, the sidebar, skins; a tour of
  every page and where things are.
- `references/devices.md`: this computer and remote devices; adding one over SSH, wire colors,
  reconnecting, adapter versions on remote machines.
- `references/device-settings.md`: every device setting key, its meaning and default.
- `references/harnesses.md`: the supported harnesses, how to install and update them the official way
  (verified versions), enabling, CLI path, environment variables, sign-in.
- `references/sessions-and-projects.md`: projects, sessions, the composer, approvals, plan mode,
  sub-sessions and session trees.
- `references/scheduled-tasks.md`: scheduled tasks and their settings.
- `references/browser-and-computer-use.md`: the built-in browser and Computer Use.
- `references/operate-this-computer.md`: letting agents on remote devices run commands and touch files
  on this computer.
- `references/phones.md`: pairing the Android app by QR code, revoking phones.
- `references/appearance-and-preferences.md`: look, language, notifications, links.
- `references/troubleshooting.md`: common problems and how to diagnose them.
