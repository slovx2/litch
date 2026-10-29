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

**A Claude Code turn shows "Retrying 2/10 · Connection lost" (or "Retrying (attempt 2)").** The model
request failed (dropped connection, overload, server error) and Claude Code is retrying it by itself, up
to 10 times by default; the turn keeps going and the line disappears once the request goes through. Text
the failed attempt had already shown is withdrawn. To change the number of retries, set
`CLAUDE_CODE_MAX_RETRIES` in the harness's environment (`0` turns retrying off). If every retry fails, the
turn fails with the last error.

**Pi 自动重试后完成回答。** 单次模型请求失败不代表整个回合失败；重试成功后回合显示完成。
如果重试最终仍失败，显示最后一次模型错误；会话被其他实例修改等回合错误不会被成功重试清除。

**合盖或断网后一直显示工作中。** 执行回合的设备唤醒后约 30 秒没有新进展，或一般情况下
持续 5 分钟没有进展，Litch 会在回合末尾提醒。检查每 5 秒进行一次；等待审批、用户回答或
正在执行工具时不会按模型停流提醒。远程回合由远程设备观察，本机唤醒不会触发远程中断。
macOS、Linux 支持唤醒观察，Windows 使用 5 分钟通用提醒。这里只能发现可能停滞，不能证明网络故障。
提醒前会复查完整回合，补回客户端离线时漏掉的进展；已有提醒、等待和工具状态每分钟复查，
回合结束后撤销。唤醒标记延迟送达时，从收到标记起至少再观察 30 秒。

可以选择“继续等待”收起本次提醒，或点击“中断并继续”。后者先请求中断，确认旧回合已经中断后
才发送核对已有步骤并继续工作的消息；不会重放原始指令。10 秒内未确认中断、回合已经变化或
已有待答请求、排队消息时，不会另发继续请求。Litch 不会自动中断或调整 harness 的网络超时。
Codex 原生重试时显示它给出的提示，新进展或回合结束后消失；没有次数信息时不猜次数。

**A model is unavailable or every turn fails at once.** Usually the harness's own sign-in or model
configuration. The user checks it in the harness's own CLI (exception E3); the harness's runtime log
(`diagnose logs`) shows the error.

**A remote device does not connect.** `scripts/litch devices check <target>` and the table in
`devices.md`. Authentication and host-key problems are fixed by the user in a terminal; then
`scripts/litch devices reconnect <device>`.

**"The adapter is too old" or "an older service is running" on a remote device.** The user can click
**Upgrade** in the device's "Device service" section (see `devices.md`), or upgrade the adapter there by
hand (rerun the install script, or `brew upgrade codex-harness-adapter`). An older service keeps running
until it is idle; Litch stops it only after the user confirmed. If the upgrade fails at the download
step, the device probably can't reach GitHub: install from a copied archive with `install.sh --from`.

**Built-in browser or Computer Use calls fail.** Check the device's switches
(`scripts/litch tools set`, `browser-and-computer-use.md`) and, for Computer Use,
`scripts/litch computer status` for missing macOS permissions. Calls from sessions not started in Litch,
or while no Litch desktop is connected, fail by design.

**Sub-sessions or scheduled tasks are missing.** The device may have them switched off
(`sessions.enabled`, `tasks.enabled`) or the remote adapter is older than 0.11.0.

**Windows.** On Windows devices "operate this computer" (on the Windows desktop) is not available yet;
Claude Code's "Read only" and "In project" modes cannot run commands there (use Full access or WSL2);
network-share folders are not supported in the files panel.

## Where things live (read-only facts for explaining, do not edit by hand)

- The adapter's state on each device: `~/.codex-harness-adapter` (device settings in
  `device/settings.json`). All its logs are under `~/.codex-harness-adapter/logs/` (one subfolder per
  harness). Each log is rotated at 10 MB, keeps at most 5 files and drops files not written for 7 days
  (`LITCH_LOG_MAX_BYTES`, `LITCH_LOG_KEEP`, `LITCH_LOG_MAX_AGE_DAYS` in the service's environment change
  this). Claude Code's `debug.jsonl` rotates at 50 MB and keeps 3 older files instead
  (`CHA_CLAUDE_DEBUG_LOG_MAX_BYTES`, `CHA_CLAUDE_DEBUG_LOG_KEEP`); the 7-day rule applies to it too. Logs left in the old places (`device/*.log`, `<harness>/*.log`, `claude-code/debug.jsonl`) by
  versions before this layout are no longer written and can be deleted.
- The desktop app's own logs (`main.jsonl`, `core.jsonl`: requests to devices, connection changes, UI
  commands): `~/Library/Logs/Litch` on macOS, the app's logs folder elsewhere, same limits. On the
  local device, Devices → the device → Logs has buttons that open this folder and the device's log
  folder; for a remote device the Logs section shows the folder and a `tail` command to copy.
- The desktop app's own data: the app's user-data folder (devices, sidebar snapshots, preferences).
- This manual: `~/.agents/skills/litch-manual`, linked into other harnesses' skill folders. Litch
  rewrites it every time it starts; the switch "Install the manual into local harnesses" is in Litch's
  settings.
