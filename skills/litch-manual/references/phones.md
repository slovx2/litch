# Phones (Android and iOS, pairing by QR code)

iOS 手机设置的“关于”提供“隐私政策”和“支持与反馈”，在系统浏览器打开公开页面。
iOS 的更新由 App Store 或 TestFlight 管理。支持问题通过 GitHub issues 提交；该渠道公开，
不要附带私钥、验证码、配对二维码或私人会话，隐私请求先询问私密联系方式。

The Litch phone app connects over SSH to the same machines. Instead of copying keys by hand, a
device the desktop already reaches can be added to the phone by scanning a QR code: the phone creates
its own key, enrolls it on that machine, and the user confirms a matching code on the computer. The
computer's keys never leave it, and each phone can be revoked on its own. Remote adapter 0.12.0 or
later.

## Commands

- `scripts/litch phones list <device>` lists phones paired with that device (name, date).
- `scripts/litch phones pair <device>` opens the pairing dialog in the Litch window. Optional flags
  change the address the phone will use (host, port, user; see `scripts/litch phones --help`); they only
  affect what goes into the QR code, not how the desktop connects.
- `scripts/litch phones revoke <device> <phone>` removes that phone's key from the device.
  **Irreversible: ask first**, then the user confirms in Litch; the phone can no longer connect until paired again.

## What the user does (exception E2)

You can only open the dialog. Then the user:

1. In the phone app: Add device → Scan to add, and scan the code (or paste "Copy pairing text").
2. On the computer, Litch shows "Phone '…' wants to pair" with a 6-digit code; if it matches the phone,
   the user clicks Allow.

The code is valid for 10 minutes and once only (a new one appears when it expires); the confirmation has
to happen within 2 minutes. Do not show the QR code while sharing the screen.

## Requirements and problems

- The phone must reach the address in the code directly (no jump hosts). If the phone cannot connect,
  re-open the dialog with an address the phone can reach (for example the machine's LAN or VPN address).
- Pairing **this computer** (Local) needs its SSH server on: macOS System Settings → General → Sharing
  → Remote Login; Windows "OpenSSH Server" optional feature; Linux sshd. That is a system setting the user
  turns on.
- Litch refuses to create a code (and says why) when `authorized_keys` is a symlink or read-only, sshd
  does not accept keys, two-factor login is required, or the one-time key cannot be authenticated.
- Windows administrator accounts cannot be paired by QR code yet (their keys live in
  `administrators_authorized_keys`); add the phone's public key there by hand.
- On a machine without the desktop app, `codex-harness-adapter pair` shows the same QR code in a
  terminal.
- Settings of the Litch app on the phone itself are out of reach (exception E9).
  They live in the phone app under Settings: Appearance (language, theme: follow the system, light,
  dark; skin: Retro, Literary, Standard, the same three as on the desktop, default Retro), Conversation
  (sending during a turn), connection, task cards, the sign-in approval key's fingerprint, updates.
  Every pick-one setting is a single row with its current value (for example "Theme  Light ›"); tap it
  to choose in a sheet. 手机设置里每个单选项都是一行“名称　当前值 ›”，点开在底部单里选。
  Task cards are one row per device with how many harnesses have them on ("This Mac  3/4 on ›"); tap
  it to tick harnesses one by one in a sheet that stays open, with Turn all on / Turn all off at the end.
  An offline device or an outdated device service shows the reason on each item and cannot be changed.
  任务卡每台设备一行“名称　N/M 已开 ›”，点开逐个勾，单不收起，末尾是全部开启或全部关闭。

## 内嵌 Tailscale 网络

添加设备和设备详情的“通过 Tailscale 连接”提供自动（默认）、总是、从不。
自动模式在内置节点已登录时，把 Tailscale IP、`.ts.net` 地址和网络图中匹配的节点名称交给内置网络；
其余地址使用系统网络。未登录时仍可利用外部 Tailscale 的系统路由；系统连接失败才提示登录内置网络，
并提供直接进入登录页的按钮。总是模式要求内置节点可用；从不模式只用系统网络。
旧数据中的开启迁移为总是，关闭或未设置迁移为自动。每次连接状态显示实际使用的网络路径。
内置通道不占用系统 VPN。SSH 仍使用原来的私钥与固定主机指纹；不改变服务器 SSH 的认证配置。

添加设备的可选入口可先进入 Tailscale 设置，登录后返回继续填写；自动模式无需再次打开开关。
扫码确认页使用同一套选路规则。内置网络选中后不会因失败回退公网，也不会将 MagicDNS 交给系统 DNS。

设置 → Tailscale 显示节点状态、节点名与 tailnet。点击登录后自动打开系统浏览器，
30 秒未取得地址会提示检查网络后重试；回到 Litch 自动核对状态，不需要再次登录。
已保存的节点在应用重启后自动恢复。管理员批准、节点恢复中和网络拨号失败分别提示。
控制服务器默认折叠，留空使用 Tailscale，也可以填写 Headscale 的 HTTPS 地址；不接受带凭据或查询参数的地址。
切换控制服务器前须清除状态，避免跨服务器复用节点身份。

一个应用安装共享一个节点，每台设备分别选择网络。退出登录断开所有内嵌连接；清除状态还会删除
本机节点身份与加密密钥，再登录将注册新节点，原节点需在控制台另行移除。普通 SSH 不受影响。
Android 的状态由 Keystore 密钥加密并排除系统备份；节点状态不经过 JS，也不自动上传遥测日志。
已有系统 VPN 仍可能影响底层网络可达性；不占 VPN 槽位不代表绕过系统 VPN。

后台连接期限到达时内嵌节点也停止；浏览器登录期间为节点保留最长十分钟，SSH 仍按原期限断开。
前台的下一次连接或状态查询恢复同一身份。iOS 可更早被系统挂起，
不能保证长期后台保活。更改此设备的网络模式会按同一个设备 ID 重连，不另建设备记录。

## Android 后台期限

Phone Settings → Connection → Disconnect in background defaults to **5 minutes**. Choose 1, 5, 10,
30 or 60 minutes, or Never. Once due, Litch closes the phone's SSH connections and pauses retries;
tasks on the computer keep running. Returning to Litch cancels the deadline, keeps healthy
connections and restores disconnected ones. Never disables Litch's own background timeout.

The deadline includes time spent in deep sleep. Android may delay the non-waking alarm while the
phone sleeps or restricts background work; disconnection is not guaranteed at the exact minute.
Returning to the foreground cancels a pending deadline without disconnecting a healthy connection.

Use Open system settings in the same section to find this app's battery or background controls.
If the page cannot open, Litch shows a manual path. Allow background activity or choose Unrestricted
battery use to keep connections in the background. The Standard battery optimization status reports
only Android's exemption list, not every manufacturer's background permission.
This section is hidden on iOS. These are phone settings; desktop `litch config` cannot change them.

## iOS 后台连接与更新

iOS 的设备网络开关可由 VoiceOver 单独选中，标签与开关状态一起读取，不重复朗读标题。
On iOS, VoiceOver can focus device network switches individually and read their label and state
without repeating the row title.

iOS 的 SSH 私钥保存在系统 Keychain。自建模拟器包应使用构建脚本默认的本地 ad-hoc 签名；
无签名包只用于编译检查，不能验证密钥保存或配对。
SSH private keys on iOS are stored in Keychain. Use the build script's default local ad-hoc
signature for simulator testing; unsigned builds cannot validate key storage or pairing.

iOS 内嵌 Tailscale 不占用系统 VPN，SSH 仍使用 Litch 的私钥与主机指纹校验。
节点登录状态保存在不可迁移、不同步的 Keychain 中；换手机需重新登录。
后台执行期限到期后节点暂停，回到前台恢复；退出或清除状态会断开内嵌网络连接。
On iOS, embedded Tailscale leaves the system VPN available and keeps Litch's SSH key and host
fingerprint checks. Node credentials stay in device-only Keychain storage and require a new login
on another phone. The node pauses when background execution expires and resumes in the foreground.
Signing out or clearing state disconnects embedded network connections.

iOS 在五分钟期限或系统允许的后台执行时间先到期时关闭 SSH 连接，并暂停重连。
返回 Litch 后恢复连接；断开期间电脑上的任务继续运行。Litch 不申请后台常驻。

iOS 不能安装下载的 APK。设置页提示通过安装应用的 App Store 或 TestFlight 更新，开发包需重新构建安装。
iOS 不运行 Android 更新清单检查、下载或安装流程，也不显示自动检查与安装权限开关。

iOS 终端底部的键盘按钮用于显示或收起系统键盘；“粘贴”从系统剪贴板插入文字。
终端尚在启动时点击键盘按钮，会在终端可输入后显示键盘，无需重复点击。
终端可横屏显示；离开终端后恢复竖屏。
首次读取其他应用复制的内容时，iOS 可能要求允许粘贴。多行内容遵守终端程序的括号粘贴模式。

In the iOS terminal, use the keyboard button to show or hide the system keyboard, and **Paste** to
insert text from the system clipboard. iOS may ask for permission to paste from another app.
If you tap the keyboard button while the terminal is starting, the keyboard opens when input is ready.
The terminal supports landscape orientation; other screens return to portrait.
Pasted text respects the terminal program's bracketed paste mode.

## In a session on the phone

手机上的运行记号会缓慢呼吸：会话列表（含首页最近会话、经理与工作线、子会话）、会话中的活动行、
经理页签、子代理图标和设备的运行状态使用相同节奏。记号的颜色和形状跟随皮肤，不增加行高；活动文字保持稳定。
回合结束即恢复静态；系统开启“减弱动态效果”时保留完整不透明度的状态记号，App 进入后台后停止动画。

复制收在菜单里，不占消息下方的位置：长按用户消息选“复制消息”，长按回答选“复制回答”（针对按住的那条，
复制该条完整 Markdown），点回合状态行的 ⋯ 也可复制回合最后一条回答；复制后显示“已复制”。
用户消息的发送时刻和交付状态记号（排队 ◷、停止待发 ‖、状态待确认 ⓘ）在气泡左边，点记号显示整句说明。用户消息的评论、附件和会话提及规则见 `sessions-and-projects.md`。

Pending questions are answered above the composer; settled questions leave a combined question/answer
record in the conversation. Mid-turn messages say “Added to this turn” and divide folded activity into
segments. The rules are shared with the desktop and described in `sessions-and-projects.md`.
Manager events can be read as expandable system rows. The manager page has Console, Chat, Lines
and Overview tabs. Chat remembers whether you were at the bottom or reading a message: returning
follows the latest bottom in the first case and restores that message in the second, including when
messages arrived while you were away. Other board tabs retain their own scroll positions.
手机经理的“对话”页签在离开时记住贴底状态或正在阅读的消息；返回时分别定位到最新底部或原消息。
控制台、工作线和概览各自保留滚动位置。建议任务的操作见 `managers-and-suggestions.md`。

- **Conversation settings**: the **+** button next to the input box opens Add images plus the model,
  effort, speed, permission and Plan mode, each showing its current value; tap one to change it. When
  Plan mode is on, the + button carries an accent dot. The same applies on the New session page.
  手机输入框旁的“+”里是添加图片和对话参数（模型、强度、速度、权限、计划模式），每项写着当前值；计划模式开着时“+”上有强调色圆点。
- **Scheduled task**: a session run by a scheduled task (or targeted by one) shows a ⏱ clock in the
  title bar; tap it to open the task. 定时任务跑出的会话在标题栏显示时钟，点开是任务详情。
- **Background tasks**: while background tasks run, a small pill above the input box shows a breathing
  mark and their count (screen readers say "N background tasks running"); tap it to open the
  Background tasks page. 输入框上方的小胶囊只写记号和个数，点开看后台任务。
- **Suggested task cards**: a waiting card shows **Start** and **Do it here**; **Edit and start**,
  **Dismiss** and turning task cards off are under ⋯ at the card's top right. The "New worktree" switch
  sits beside the buttons (it moves below them on narrow screens); its explanation is on the Edit and
  start page. 卡上只有“开始”“在这里做”，其余在右上角“⋯”里。
  When the target harness cannot run as strictly as the parent session, Start is dimmed and its
  screen-reader name gives the reason; it becomes available once the parent session's access is raised.
  Do it here and Edit and start (to pick another harness) still work.
  目标 harness 收不到父会话那么严时，“开始”置灰，读屏名称写明原因；放宽父会话权限后可点。
- **New session**: harnesses are a row of pills (swipe sideways when they do not fit). A dimmed pill
  cannot be used on this device; tap it to see why. Long-press a pill to see its version.
  新建对话的 harness 是一排胶囊，置灰的点了写原因，长按看版本。
- **Usage and limits**: tap the small context ring beside the input box (it fills with the share of
  context in use), or ⋯ → Usage and limits. 输入框旁的小圆环按上下文用量填充，点开看具体数字。It shows the
  context in use and, for subscription logins (Claude Code with an Anthropic subscription, Codex with a
  ChatGPT login), each limit window's usage and when it resets; API keys have no limits to show.
- **Compact context**: ⋯ → Compact context, or the button in the usage sheet. Not offered for harnesses
  that cannot compact; while a turn runs it says to wait.
- **Activity and subagents**: as on the desktop, each subagent a harness starts is one line (type,
  description, time, and a status: queued, running, done, failed or stopped); tap it to open the
  subagent's page with its task, the failure reason and its own transcript (read only). Tapping an
  activity group opens its steps below it, with **Collapse** at the end; the tapped line stays in place.
  While the activity line is the last thing in a running turn it is the turn's status; there is no
  separate "… is working" line under it. Between steps, it ends with "Working · N s", with the elapsed
  time updating every second; while a step runs, it shows "Running: …". Screen readers announce the
  same status. Once text follows the activity, the usual turn status line applies.
  After the turn, the folded summary reads "Processed · N steps"
  and the time is written once, on the turn's last line ("Done · 41 s · 15:34").
  回合在跑、活动行在最下面时不再另起状态行；步骤之间在活动行末尾显示“正在工作 · N 秒”，用时每秒更新，
  有步骤在跑时显示“正在运行：…”，读屏同样可读到状态。正文接着出来后沿用原有状态行规则。
  回合结束后摘要写“已处理 · N 步”，用时只写在回合尾。
- **Quote part of a reply**: long-press a reply → Select text; the word under the finger is already
  selected with both handles (drag them, or long-press elsewhere). Reply in the system menu opens a box
  to write a note on the passage (it can stay empty); Add puts it above the input box as a quote (the same
  comment chip as "Comment on this reply" on the desktop, sent as `<litch-comments>`).
  安卓上滚动后仍可调整选区；拖到对话区边缘时，列表让正在调整的端点和把手保持可见，
  不会为了另一端的选区跳动。后台任务条和输入区不属于选字区域。
  Tap the chip to change the note. Done leaves selecting. Comment, rename and message-edit dialogs,
  workspace forms and searchable pickers keep their content above the keyboard; long dialogs scroll
  within the available space, and buttons can be tapped while the keyboard is open.
- **Android updates**: the phone checks the GitHub release feed and shows a bar on the device and session lists;
  the user taps Update, then confirms the system installer. If it says the new version is signed
  differently, the installed build was not a release build (for example one installed for testing):
  uninstall it and install the release APK once (this clears the phone app's data; devices must be added
  again), after which updates work. If the download breaks off, the bar offers Retry; any failure bar can
  be closed with ✕ and stays closed for that package until a newer one is released.

## Approving the agent's sign-ins on the phone

Chrome requests have their own cards: instance access shows the Chrome instance name, website access
shows the origin, and sign-in shows the website and reason. For Chrome sign-in, finish signing in on
the computer and then choose **Sign-in complete**; this is separate from the built-in browser's
saved-account sign-in flow below.

When an agent asks to sign in to a site in the built-in browser (see `browser-and-computer-use.md`) and
the session's device is paired with the phone, the card also shows in that session on the phone, above
the input box. The phone only offers "Sign in as {account}" and Decline (the web page is on the computer,
so signing in by hand happens there); whichever side answers first wins.

- Usernames are masked on the phone (`so•••@gmail.com`); the password never goes through it. Litch on
  the computer fills in and submits after it has checked the phone's signature.
- Approving needs the phone's fingerprint, face or screen lock. Without any screen lock the phone cannot
  approve.
- The phone signs with its own **approval key** (separate from its SSH key, one per phone, whichever way
  it connects, ordinary sshd or Tailscale SSH). Pairing by QR code with a current desktop sends it along
  (covered by the confirmation code). Phones paired earlier do not need to pair again: the computer
  remembers the key at the first approval and shows a notice; if that was not the user, remove the phone
  in the desktop's settings.
- Phone Settings → Sign-in approvals shows the approval key's fingerprint; the desktop's paired-phones
  setting shows the same one. If the computer says the phone's key does not match, pair the phone again
  by scanning.
- Cards from scheduled-task turns expire after 30 minutes and can carry "Let this scheduled task use this
  account for this site from now on".
- The phone must have Litch open and be connected to that device to see the card (no background
  notifications yet).

## Tailscale SSH

When the address in the code is served by Tailscale SSH (the machine runs `tailscale set --ssh` and the
phone comes in over the tailnet), tailscaled lets connections in by the Tailscale ACL and ignores
`authorized_keys`, so the one-time key cannot work. Litch notices this (the SSH banner of that address,
or the device reporting Tailscale SSH for a `*.ts.net` / `100.64.0.0/10` address) and creates the code
the Tailscale way instead: the dialog says so, the phone must have Tailscale on and signed in, and after
logging in with its own key it enrolls itself; the confirmation code and Allow work as usual.

- Whether a phone can log in is decided by the Tailscale ACL. Any tailnet device the ACL allows can log in
  as that user without a key, so **revoking a phone in Litch does not block it**: change the ACL or remove
  the device in the Tailscale admin console. The phone list and the revoke prompt say this.
- If the ACL uses check mode, Litch (and the phone) shows the verification link; open it, finish the
  check, then retry.
- If the one-time key check fails because the address the desktop uses is Tailscale SSH, the dialog says
  so and offers "Use Tailscale instead".
- `codex-harness-adapter pair` asks whether the phone uses the Tailscale address when the machine runs
  Tailscale SSH; the Tailscale way without `--host` puts the machine's tailnet IP in the code.
- When the desktop's own SSH config reaches the device by its Tailscale name (MagicDNS name, short name or
  tailnet IP) and the device runs Tailscale SSH, the dialog fills in the device's tailnet IP: the phone's
  DNS may not resolve MagicDNS names (for example while another VPN app is on). The menu next to the host
  switches between the IP, the full MagicDNS name and the short name.

手机的项目根目录、定时任务工作目录、子会话/建议任务工作目录、设备路径设置和 harness 路径设置均可浏览连接设备的目录或文件，并支持手动输入路径跳转。选择器不使用手机文件系统代替服务器路径；取消不会修改表单。手机尚无创建经理入口，MCP 设置保持只读。

## 配对主机密钥确认 / Pairing host-key confirmation

桌面端通过本次已认证 SSH 连接取得服务端地址，设备优先探测该地址实际监听的 SSH 密钥，支持另一个 sshd 使用独立 HostKey、容器及端口转发。
入口密钥与设备自报、本机 known_hosts 不一致，或没有记录、无法直接核实时，会先显示地址、双方及入口的 SHA256 指纹与手机可能连到其他机器的风险。
用户点击“确认并生成二维码”才继续，取消不出码。确认仅用于这一张码，不修改 known_hosts 或保存全局信任；到期换码、地址或密钥变化后重新确认。
二维码和一次性钥匙登录检查使用同一把入口密钥。手机仍须能直接访问码中的地址；桌面端的 ProxyJump 不会复制到手机。

The desktop obtains the server address through the current authenticated SSH connection. The device probes that listener’s public keys, including custom sshd HostKey files, containers, and forwarded ports.
If the entry key differs, is unknown, or cannot be checked directly, Litch shows the address, fingerprints, and risk before creating a code. The user must explicitly confirm this code; cancelling creates no code.
Confirmation is not saved, does not change known_hosts, and must be repeated for a new code or changed address or keys. The QR code and login check pin the same entry key. The phone must still reach that address directly; desktop ProxyJump settings are not transferred.
