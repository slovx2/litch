# Devices

## 计划重启后的对话恢复

Litch 发起升级、重启设备服务或强制重启一个 harness 时，会为符合条件的用户回合、Litch 子会话及运行中的经理回合准备一次自动继续。
前台回合已经完成、但仍有后台任务或看护的会话也纳入恢复。重启前保存设备已观察到的后台任务摘要，以及 Codex `litch_background.watch` 的命令、进程号与登记目的；续发消息要求模型先核对进程和结果，再决定是否重新挂起任务或登记看护。后台进程可能仍存活，不会直接重放旧工具，也不复用未经核对的进程号。设备先中断仍在运行的旧回合并保存恢复记录；新服务启动后在原会话发消息，对话中显示“重启后自动继续”。本机、远程设备使用相同规则，桌面和手机都能看到，关闭客户端不影响已经准备好的恢复。

范围包括 Claude 报告的后台 Bash／Monitor、Pi／OpenCode／ACP 的 `litch_shell`、dsh 及其他引擎通过 `backgroundTasks` 报告的工作、原生 Codex 后台命令和有效 watch。只恢复经 Litch 发起并记录过的工作；不扫描系统进程来猜测任务，也不接管引擎未报告的后台工作。重启准备最多并行检查 4 条会话，恢复串行进行；连接和只读检查失败最多退避重试 3 次，恢复或发送请求本身不重试。

设备恢复期间，客户端会自动重试订阅会话，不会将会话标成只读；待发消息在恢复后继续发送。
重试仍失败时显示载入错误，可手动重试。

工具结果未知也会继续，但自动消息要求模型先核实文件、进程与外部副作用，不得盲目重做；它不代表新的批准。
用户停止、等待审批或回答、定时任务、目标／队列续做不自动恢复。暂停、结束中、已结束或正在重置的经理不自动恢复；收尾事件仍由经理自己的流程处理。
子会话恢复完成后，结果继续进入原父会话的回报队列。计划中断本身不产生完成回报，也不会另行重复唤醒父会话。
不支持接回旧会话的 harness 保留中断状态；不能恢复的回合可由用户发送消息继续。

每条已授权工作最多自动续一次，恢复记录 24 小时过期。发送结果不明时不重试，避免重复执行。
普通停止服务、退出应用时关闭后台服务、意外崩溃、强杀或断电不会新建恢复记录。
设备服务开始关闭后不再接收新的客户端或引擎工作；尚未完成的工具恢复会明确结束为关闭错误，不会在关闭数据库后继续更新工具清单。
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

## 首次安装远程设备服务

桌面添加设备的检查结果、设备列表及连接失败页，在远端未安装时提供“安装设备服务”。手机的手动添加页、设备列表和设备详情也支持，不需要桌面转发。
检查只读取系统和下载工具；点击按钮后，确认卡列出目标主机、与当前应用相同的安装版本，以及远端执行的命令。确认后通过原有 SSH 连接下载该版本的 `install.sh`，使用 `--version` 安装；安装脚本核对发布包 SHA-256。随后启动设备服务并验证连接，成功后才将新设备保存到列表。

界面依次显示下载、安装、启动、连接。失败显示发生的阶段和远端原话，并给出可复制的手动命令；重试需重新检查和确认。安装不会停止已有服务。关闭安装界面会取消后续步骤；已经安装的文件不会回滚。

一键安装支持 Linux 和 macOS，远端必须具备 `curl` 或 `wget`。没有下载工具时只显示原因及手动命令，先自行装好工具。Windows 原生 SSH 不提供一键安装；请先在 WSL 中安装并启用 SSH，再以 WSL 作为远程设备，或在 WSL 终端执行所示命令。SSH 认证和主机指纹确认仍使用正常流程；手机使用已经保存的手机密钥及主机指纹。

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
  minutes until the app quits. **Cancel pending upgrade** stops future attempts; remote upgrades never force a stop. If the adapter's install method can't be recognized, Litch only shows the
  commands to copy; a service run in the foreground or by a service manager (`brew services`, systemd)
  is installed but not restarted. This is desktop-only and not available through `scripts/litch`; the
  phone app only shows that the service is older.
- 本机设备服务等待换上应用自带版本时，设备详情的“设备服务”中同时提供“立即重试”和“立即换上”。“立即重试”只在空闲时更新；“立即换上”与远程设备使用同一确认框，列出被中断的工作，确认后停止旧进程并用自带版本重新启动。
- **Restart device service** is in the device row's ⋯ menu in the sidebar, the desktop device details’ **Device service** section, and the phone's device-list menu, for local and remote devices.
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

## 桌面设备设置窗口

设备列表、设备详情以及 harness 详情都在设置模态窗口中，左侧设置导航始终保留。主窗口继续显示原对话。
侧栏设备菜单、升级提示和 `litch open device` 直接打开窗口内对应设备/章节；服务升级、配置助手和设备操作入口照常可用。
关闭窗口、切换设置分组或离开有未保存配置的详情时，仍会询问保存、放弃或取消。

### 应用更新后的设备服务升级

应用重启完成后，等待设备连接完成（最多十五秒），再并行查询忙闲（最多五秒），按新应用版本弹一次升级提示。已是当前版本、离线或由外部服务管理器管理的设备不列入。第一次安装本功能也适用；同一应用版本不重复弹。

- 本机空闲时自动换上自带版本；忙时可选“不升级”“空闲时自动升级”“强制升级”。弹框中每台设备默认选中“空闲时自动升级”，点击“应用选择”后才执行；取消仍不升级。强制升级复用重启恢复：符合条件的普通回合自动继续，后台任务、待答和定时任务不会自动重跑。
- 远程设备在线、应用能管理该独立服务，且能识别安装方式或新版已安装时，提供“强制升级”。尚未安装时先下载安装并核验版本，成功后才强制切换；安装失败不会停止旧服务。由外部服务管理器管理时不提供。普通升级仍等空闲，强制升级需确认会中断回合及终止已检测到的后台任务数量。手机目前仅显示版本提示，没有升级框。
- 等待由当前应用运行期间的核心维护：本机每三十秒重试，远程每五分钟及重新连接时重试；设备详情显示等待状态，可取消。取消不会撤销已安装的文件。退出应用会结束等待。
- 忙闲来自设备的空闲检查；旧设备不支持只读状态查询时显示未知，执行切换前仍进行空闲检查。
- 每台设备独立升级。远程失败单独显示原因和“设备详情”入口，可在详情中重试，不影响应用或其他设备。

后台开发服务器等长期任务也会使设备保持忙碌。设备详情和提示框显示后台任务数及命令摘要；本机和远程都可明确选择强制重启，远程等待区保留立即重试与取消等待。现有的远程一键升级也采用这条更完整的空闲检查。旧服务仍执行它原有的空闲判断；更新服务后才具备新增的后台保护。
