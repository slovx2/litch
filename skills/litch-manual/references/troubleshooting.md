# Troubleshooting

Start every investigation with `scripts/litch status`, then narrow down.

## Tools

- `scripts/litch diagnose run <device>` runs the device's checks (each harness's command, terminals,
  SSH entries) and reports what failed and why. Same as Devices → the device → Diagnostics → Run checks.
- `scripts/litch diagnose logs <device>` reads the tail of a log (`--source`, `--harness <id>`; see
  `scripts/litch diagnose --help`): the device process (`device`), the background service (`service`),
  control-channel requests (`control`), the device's per-request summary (`requests`: method, harness,
  ok, duration, error), or for one harness its runtime log (`runtime`), diagnostics log
  (`diagnostics`), per-request summary (`rpc`) and, for Claude Code, its detailed debug log (`debug`).
  Same as Devices → the device → Logs. Quote the relevant lines to the user, not whole logs, and never
  secrets that may appear in them. The summaries never contain conversation text, file contents or
  command output.
- `scripts/litch diagnose ssh-config <device>` prints the `~/.ssh/config` snippet that lets the
  **official Codex desktop app** reach this device's harnesses through the built-in SSH entries (only
  for entries that are on and running; turn them on with the `ssh.<id>.enabled` settings,
  `device-settings.md`). Litch itself does not need it.

## Common problems

**`scripts/litch` says the Litch desktop app is not running.** Ask the user to open Litch; retry. The
command never starts Litch.

**The command says this Litch version has no such operation.** The manual and the app differ in
version; run `scripts/litch help` and use what exists.

**A Claude Code session says another process has taken over and it is read-only.** The Claude desktop
app or a terminal `claude` still has it open; see `sessions-and-projects.md` → "Claude Code sessions
started elsewhere" for how to make it let go. Litch picks up the change by itself within seconds.

**A harness is "Unavailable" or "Not installed".** See `harnesses.md` → "Not installed or Unavailable".
After fixing, `scripts/litch harness restart <device> <id>`.

**A model is unavailable or every turn fails at once.** Usually the harness's own sign-in or model
configuration. The user checks it in the harness's own CLI (exception E3); the harness's runtime log
(`diagnose logs`) shows the error.

**A remote device does not connect.** `scripts/litch devices check <target>` and the table in
`devices.md`. Authentication and host-key problems are fixed by the user in a terminal; then
`scripts/litch devices reconnect <device>`.

**"The adapter is too old" or "an older service is running" on a remote device.** The user upgrades the
adapter there (rerun the install script, or `brew upgrade codex-harness-adapter`). An older service keeps
running until its turns finish; Litch never stops it by itself.

**Built-in browser or Computer Use calls fail.** Check the device's switches
(`scripts/litch tools set`, `browser-and-computer-use.md`) and, for Computer Use,
`scripts/litch computer status` for missing macOS permissions. Calls from sessions not started in Litch,
or while no Litch desktop is connected, fail by design.

**Sub-sessions or scheduled tasks are missing.** The device may have them switched off
(`sessions.enabled`, `tasks.enabled`) or the remote adapter is older than 0.11.0.

**Windows.** On Windows devices native Codex and "operate this computer" (on the Windows desktop) are
not available yet; Claude Code's "Read only" and "In project" modes cannot run commands there (use Full
access or WSL2); network-share folders are not supported in the files panel.

## Where things live (read-only facts for explaining, do not edit by hand)

- The adapter's state on each device: `~/.codex-harness-adapter` (device settings in
  `device/settings.json`). All its logs are under `~/.codex-harness-adapter/logs/` (one subfolder per
  harness). Each log is rotated at 10 MB, keeps at most 5 files and drops files not written for 7 days
  (`LITCH_LOG_MAX_BYTES`, `LITCH_LOG_KEEP`, `LITCH_LOG_MAX_AGE_DAYS` in the service's environment change
  this). Logs left in the old places (`device/*.log`, `<harness>/*.log`, `claude-code/debug.jsonl`) by
  versions before this layout are no longer written and can be deleted.
- The desktop app's own logs (`main.jsonl`, `core.jsonl`: requests to devices, connection changes, UI
  commands): `~/Library/Logs/Litch` on macOS, the app's logs folder elsewhere, same limits. On the
  local device, Devices → the device → Logs has buttons that open this folder and the device's log
  folder; for a remote device the Logs section shows the folder and a `tail` command to copy.
- The desktop app's own data: the app's user-data folder (devices, sidebar snapshots, preferences).
- This manual: `~/.agents/skills/litch-manual`, linked into other harnesses' skill folders. Litch
  rewrites it every time it starts; the switch "Install the manual into local harnesses" is in Litch's
  settings.
