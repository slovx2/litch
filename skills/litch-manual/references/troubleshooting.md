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

**设备提示“设备库是更新的版本建的，拒绝降级打开”。** 使用创建该设备库时的版本或更新的设备服务；不要删除设备库，其中保存了项目、会话归属、分组、置顶以及项目访问权限和确认记录。受支持的旧版设备库升级时保留这些数据；没有可用迁移的结构会保留原库并拒绝打开。

**从 0.27.x 升到 0.28.0 或 0.28.1 后项目消失。** 这两版设备服务会错误删除 v2 设备库。尚未升级设备服务时，先在线备份状态目录中的数据库，再使用包含修复的版本；不要为排查而重启或降级服务。若已丢失，修复版本只能防止再次删除，不能自动找回原项目；应先备份现场，再从升级前的备份恢复。会话内容仍由各引擎保存，仅按工作目录重建不能还原原项目名、多目录关系、分组和排序。

没有升级前备份时，维护者可使用仓库的 `scripts/recover-device-projects.mjs` 按工作目录重建。用 Node 24 运行，默认只读输出候选项目、会话归属和计划摘要：

```sh
node scripts/recover-device-projects.mjs --home ~/.codex-harness-adapter
node scripts/recover-device-projects.mjs --home ~/.codex-harness-adapter --only /work/app --only /work/notes
```

`--only` 可重复，只匹配完整目录，不包含子目录。脚本读取设备索引及 Claude、Pi、Codex 的现存库；DSH 会话头需要系统安装了 `zstd`。自定义路径可传 `--codex-db`、`--dsh-home`。已取证的元数据可用 `--inventory <JSON>` 离线预览，该模式禁止写入。

审阅并确认范围后，先断开会自动重连的客户端、停止设备服务，再用同样参数加 `--apply --expect <计划中的 digest>` 执行；源数据或筛选条件改变后需重新预览。脚本不负责停止或重启服务，写入前在线备份状态目录顶层和设备、引擎目录下的库及配置，存到 `<状态目录>-backups/project-recovery-<时间戳>-<随机后缀>/`，校验成功才写。只轮换本工具生成的完整备份并保留四份，不删除其他备份。恢复后再启动包含迁移修复的设备服务。

重建仅补未归属且能找到唯一工作目录的已索引会话，保留已有项目和归属，遇到多个项目都包含该目录则跳过。目录名用作新项目名，原分组、置顶、排序和权限确认不作推断；原有这些数据也不会被改动。

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

**Pi completes after retrying.** A failed model request does not necessarily fail the whole turn.
If retries recover, the turn completes; if they fail, the final error is shown. Other turn errors,
such as another instance modifying the session, are not cleared by a successful retry.

**Still working after sleep or a network drop.** After prolonged silence (normally 5 minutes, or
about 30 seconds after the executing device wakes), Litch can show a stalled-turn notice. Waiting
for approval, an answer or a tool is not treated as silent model output. Remote turns are observed
on the remote device; local wake does not interrupt them. This notice suggests missing progress,
not proof of a network failure. Windows uses the general silence threshold.

The notice gives the last progress time. **Keep waiting** hides it. **Interrupt and continue** asks
for confirmation, waits for interruption and sends a message to check completed steps and continue;
it does not replay your original prompt. If interruption cannot be confirmed, the turn changed or
there is another pending request/queued message, it does not start a continuation. Litch does not
automatically interrupt or change harness network timeouts. Native retry messages disappear on new
progress or completion. The continuation appears as a system card on desktop and phone.

**A model is unavailable or every turn fails at once.** Usually the harness's own sign-in or model
configuration. Check Devices → harness → Settings → Accounts/Config, or its own CLI; the user completes login steps. the harness's runtime log
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
  versions before this layout are no longer written.
- The desktop app's own logs (`main.jsonl`, `core.jsonl`: requests to devices, connection changes, UI
  commands): `~/Library/Logs/Litch` on macOS, the app's logs folder elsewhere, same limits. On the
  local device, Devices → the device → Logs has buttons that open this folder and the device's log
  folder; for a remote device the Logs section shows the folder and a `tail` command to copy.
- The desktop app's own data: the app's user-data folder (devices, sidebar snapshots, preferences).
- This manual: `~/.agents/skills/litch-manual`, linked into other harnesses' skill folders. Litch
  rewrites it every time it starts; the switch "Install the manual into local harnesses" is in Litch's
  settings.
