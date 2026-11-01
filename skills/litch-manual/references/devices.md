# Devices

## 计划重启后的对话恢复

Litch 发起升级、重启设备服务或强制重启一个 harness 时，会为符合条件的普通用户回合准备一次自动继续。
设备先中断旧回合并保存恢复记录；新服务启动后在原会话发消息，对话中显示“重启后自动继续”。桌面和手机都能看到，关闭客户端不影响已经准备好的恢复。

设备恢复期间，客户端会自动重试订阅会话，不会将会话标成只读；待发消息在恢复后继续发送。
重试仍失败时显示载入错误，可手动重试。

工具结果未知也会继续，但自动消息要求模型先核实文件、进程与外部副作用，不得盲目重做；它不代表新的批准。
用户停止、等待审批或回答、定时任务、子会话、经理、目标／队列续做和仍有后台任务的会话不自动恢复。
不支持接回旧会话的 harness 保留中断状态；不能恢复的回合可由用户发送消息继续。

每条用户工作最多自动续一次，恢复记录 24 小时过期。发送结果不明时不重试，避免重复执行。
普通停止服务、退出应用时关闭后台服务、意外崩溃、强杀或断电不会新建恢复记录。
命令行明确要在随后启动时恢复，可使用 `device-stop --resume-after-restart`；普通 `device-stop` 不续跑。

## Local and remote

- **Local** is this computer. It is always there; Litch starts its bundled device service on launch.
  The service keeps running after Litch quits, so sessions, terminals and scheduled tasks are not
  interrupted. On quit Litch asks whether to stop it as well (only for a service Litch started
  itself); the choice can be remembered, and File → "Ask About the Background Service on Quit" turns
  the question back on. Local cannot be removed or renamed.
- A **remote device** is another machine reached through its own SSH server. Litch logs in with the
  user's ssh config and keys, starts the device service there if needed and keeps one connection that
  carries every harness on that machine. No port is opened on either side.
- A machine that only has the Codex CLI (no Litch adapter) can be added too; it then has Codex as its
  only harness. Installing the adapter there later and reconnecting switches it to the device service.

## Reading

- `scripts/litch devices list` lists devices with name, id, connection state, target and wire color.
- `scripts/litch devices check` tests an SSH target without adding it: whether it is reachable,
  trusted, logs in, and what is installed there (device service and its version, or Codex only). Use
  it before `devices add` and to explain a failing connection.

## Adding a remote device

`scripts/litch devices add` adds a device: a display name and a target, where the target is an alias
from `~/.ssh/config` or `user@host:port` (exact flags: `scripts/litch devices --help`). Litch runs the
same check as `devices check` first and refuses targets that fail it.

Requirements the user must meet first (Litch will not do these, exception E4):

1. `ssh <target>` must log in **without a password prompt**: a key in `~/.ssh` or loaded in the ssh
   agent (a key with a passphrase has to be added to the agent first). Litch has no password field.
2. The host key must already be trusted: the user connects once in a terminal (`ssh <target>`) and
   accepts the fingerprint.
3. The Litch adapter 0.6.0 or later should be installed on that machine (or the Codex CLI 0.157.1 or
   later for a Codex-only device). Install on Linux or macOS:
   `curl -fsSL https://github.com/slovx2/litch/releases/latest/download/install.sh | sh`, or on macOS
   `brew install slovx2/tap/codex-harness-adapter`. Litch then starts the service itself; nothing has to
   be started by hand.

Check results and what to tell the user:

| Result | Meaning | Next step |
|---|---|---|
| Unreachable | No network path or SSH server | Check host, port, VPN, that sshd runs |
| Host not trusted | Host key not in `known_hosts` | User runs `ssh <target>` once and accepts |
| Login refused | Key not accepted | User sets up key login (`ssh-copy-id`), or loads the key into the agent |
| Nothing installed | Neither adapter nor codex found | Install the adapter (command above) |
| Too old | Adapter older than required | Rerun the install script or `brew upgrade codex-harness-adapter` |
| Won't start / Handshake failed | The service did not come up | `scripts/litch diagnose logs <device>` after adding, or run `codex-harness-adapter doctor` there |

Feature minimums on the remote adapter: built-in browser and Computer Use 0.8.0, "operate this
computer" 0.10.0, session trees and scheduled tasks 0.11.0, phone pairing 0.12.0.

## Changing a device

- `scripts/litch devices rename` changes the display name.
- `scripts/litch devices wire` sets the wire color: `green`, `orange`, `blue`, `violet`, `yellow`,
  `brown`, `red` or `slate`.
- `scripts/litch devices target` changes how Litch connects (another alias or `user@host:port`); it is
  checked like a new device and the device reconnects.
- `scripts/litch devices reconnect` drops and re-opens the connection (useful after the user fixed
  something on the remote side, or after upgrading the adapter there).
- `scripts/litch devices remove` removes a remote device from Litch. **Irreversible: ask first**; the
  user then confirms in Litch. It only stops Litch from connecting; nothing on that machine is deleted
  (sessions, the adapter and its service stay). Port forwards for the built-in browser and any "operate this computer" processes from
  that device end.

## Connection behavior

- Litch reconnects by itself after a drop (backing off up to 30 seconds); running turns continue on
  the device and are not lost. While offline the sidebar shows the last known sessions read-only.
- Authentication failures, untrusted host keys, missing or too-old adapters are not retried
  automatically: fix the cause, then `scripts/litch devices reconnect`.
- Litch never upgrades or stops a remote device service on its own. When the remote service is older
  than the app, the device's "Device service" section says so (the device's row in the device list and
  in the sidebar gets a small mark; clicking the sidebar mark opens that section) and offers **Upgrade**. Only after the user confirms does Litch, over ssh, install the app's own version
  there (the install script with `--version`, or `brew upgrade codex-harness-adapter`) and ask the
  service to stop when idle (`device-stop --if-idle`); the reconnect then starts the new version. While
  the service is busy the old one keeps running and Litch retries on every connection and every 5
  minutes until the app quits; **Switch Now** stops it right away after a second confirmation that lists
  what gets interrupted. If the adapter's install method can't be recognized, Litch only shows the
  commands to copy; a service run in the foreground or by a service manager (`brew services`, systemd)
  is installed but not restarted. This is desktop-only and not available through `scripts/litch`; the
  phone app only shows that the service is older.
- **Restart device service** is in the device row's ⋯ menu in the sidebar (next to **Settings**, which
  opens the device's detail page) and in the phone's device-list menu, for local and remote devices.
  It asks the service to stop, waits until the old process has exited, starts it again and reconnects;
  the row shows "Restarting" and a note says whether it worked and why not. If any session is running a
  turn or a background task, Litch first lists the sessions that will be interrupted. 符合条件的普通回合
  会自动继续；用户停止、待答与自动任务不恢复。具体范围和工具结果核对要求见上方“计划重启后的对话恢复”。
  If the service reports other work (terminals, device processes), Litch lists it and asks again. Not
  offered while the device is offline, connected to a single harness only, run in the foreground or by
  a service manager (restart it the way it was started), or upgrading. It never upgrades. This is
  not available through `scripts/litch`.

## Related

- Device settings (harness switches, terminals, tasks, SSH entries): `device-settings.md`.
- Harness install and enable: `harnesses.md`.
- Per-device switches for the browser, Computer Use and "operate this computer": `tools set` in
  `browser-and-computer-use.md` and `operate-this-computer.md`.
- Diagnostics and logs: `troubleshooting.md`.
