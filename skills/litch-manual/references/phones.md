# Phones (Android and iOS, pairing by QR code)

消息输入框占满添加按钮与右侧操作键之间的空间；空闲、运行中插话与讨论追问都随内容增高，达到上限后在框内滚动，清空后恢复。

The message field fills the space between the add button and the actions on the right. Idle messages, mid-turn input, and discussion questions grow with their content, scroll within the field at the height limit, and shrink when cleared.

iOS 手机设置的“关于”提供“隐私政策”和“支持与反馈”，在系统浏览器打开公开页面。
iOS 的更新由 App Store 或 TestFlight 管理。隐私查询、删除请求及内容举报发至 admin@datawake.cc。
设置中的“反馈或举报内容”打开邮件，“第三方许可”打开许可说明；普通问题也可通过公开 GitHub issues 提交，
不要附带私钥、验证码、配对二维码或私人会话。

## 数据同意 / Data sharing consent

Android 不显示 AI 数据同意框，发送不经过此闸门；隐私政策仍可从设置访问。

Android does not show the AI data consent dialog or gate sending on it. The privacy policy remains available in Settings.

iOS 首次向 AI 服务发起操作前，会说明消息、附件、代理读取的项目文件和会话上下文的数据去向。
用户可以取消；取消不会发送本次内容。同意按设备与供应商配置保存，换供应商或配置变化后重新确认。
讨论抽屉打开时，同意框显示在抽屉上方；取消后保留追问草稿，允许后完成发送并清空输入框。
同意框弹出时主动收起键盘；键盘正在收起或再次打开时，系统返回只收键盘，不取消本次许可。键盘收起后再次返回或点击取消，才取消发送并保留草稿。
若远端未上报完整供应商信息，界面提示先核实配置，同意仍按设备、harness 和已知配置保存；检测到供应商或配置变化时重新询问。文件附件先上传到选定设备，
后续发送给模型仍须获得该服务的同意。经理操作同时说明其配置的派发服务。
设置可“撤回 AI 数据同意”；这只影响手机今后的操作，不删除已经传出的内容，也不停止远端运行的任务。
手机不控制已经自主运行的远程代理；在电脑上更改服务或要求代理使用其他服务前，应重新核实数据去向。

Before the first AI action on iOS, Litch explains where messages, attachments, project files and
conversation context may be processed. You can cancel. Consent is saved per device and reported
provider configuration; detected provider or configuration changes require confirmation. Unknown provider
details are shown explicitly; consent is still saved per device, harness and known configuration. When a discussion drawer is open,
consent appears above it. Cancelling keeps the draft; agreeing sends the question and clears
the input after submission succeeds. The consent dialog dismisses the keyboard when it opens.
Back only dismisses a visible or closing keyboard; once it is hidden, Back or Cancel cancels
the send and keeps the draft. File attachments are uploaded to the
selected device first; sending them to a model still requires consent for that service. Manager
actions also disclose their configured dispatch service. Withdraw consent in Settings to be asked
again. This does not delete data already sent or stop autonomous work on your remote computer.

Tailscale 登录前说明控制服务器处理的节点/网络元数据，提供隐私政策链接和继续/取消。
取消后仍可使用普通 SSH。自定义控制服务器的数据处理由其运营方负责。
Before Tailscale sign-in, review the node and network metadata disclosure and privacy link, then
continue or cancel. Direct SSH remains available. Custom control servers have their own operators.

正式 iOS/Android 包不提供开发深链、模拟/夹具启动方式或测试更新源。升级时清除旧开发设置，
设备、SSH 密钥和普通偏好保留。开发者的 Release E2E 包使用显式构建开关，不能作为发布包分发。
Production iOS and Android builds do not expose development links, mock/fixture boot modes or test
update feeds. Upgrades remove old development settings while retaining devices, SSH keys and normal preferences.

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

粘贴配对文本时，提交按钮固定在键盘上方，文本区域可以滚动。

You can only open the dialog. Then the user:

1. In the phone app: Add device → Scan to add, and scan the code (or paste "Copy pairing text"). The pasted-text submit button stays above the keyboard, while the text area scrolls.
2. On the computer, Litch shows "Phone '…' wants to pair" with a 6-digit code; if it matches the phone,
   the user clicks Allow.

The code is valid for 10 minutes and once only (a new one appears when it expires); the confirmation has
to happen within 2 minutes. Do not show the QR code while sharing the screen.

## Requirements and problems

- 会话输入区会持续显示不可用 harness 的具体原因和下一步（安装、启用、升级或重启）；恢复后自动收起。
  设备断线时显示连接提示，目录刷新不会延迟或重放 harness 的旧状态。
  An unavailable harness shows its reason and next step above the composer until it recovers.
  A device disconnection shows a connection notice; refreshing sessions does not replay stale harness status.
- 手机系统日志只记连接阶段、harness 可用性与目录对账的开始和结束。iOS 按
  `subsystem == "dev.litch.connection"` 查看，Android 按 `LitchConnection` 标签查看。
  `d1`、`d2` 是应用本次启动内的设备编号，不包含主机地址、钥匙或会话正文。
  Connection diagnostics use iOS subsystem `dev.litch.connection` and Android tag `LitchConnection`.
  Device labels such as `d1` are local to the current app launch; host addresses, keys and messages are omitted.

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

扫码后，地址可能属于 Tailscale 时会先弹出“可能是 Tailscale”。判定结合电脑二维码中的提示、`100.64.0.0/10`、`fd7a:115c:a1e0::/48`、`*.ts.net` 和手机内置网络的节点表；共享地址段只能说明可能使用，不能证明。

- 已登录：显示当前 tailnet，点击“确认正确”继续，或“更换 Tailscale 账号”退出旧账号并登录。
- 未登录：选择“登录 Tailscale”，或在已有系统 VPN／外部 Tailscale 时选择“直接连接”。直接连接对该设备使用“从不”选路，避免错误地进入内置网络。
- 登录或换号成功后自动继续绑定；取消、失败、等待管理员批准时不继续。登录期间二维码过期，需要重新生成。
- 电脑收到手机的 SSH 登记请求后才出现确认按钮；在这之前仍显示等待连接，并提醒检查手机的 Tailscale 账号。二维码新增提示是可选项，新旧码仍可读取。

设备名称行优先显示名字，过长时截断；引擎徽标放在已有地址行。主机密钥指纹留在设备详情的核对信息里，不与名称争用空间。

After scanning, a **May use Tailscale** dialog appears when the QR hint, address range, MagicDNS suffix, or embedded node map suggests Tailscale. Signed-in users confirm the displayed tailnet or switch accounts. Signed-out users sign in or choose **Connect directly** for a system VPN or external Tailscale; direct connection sets this device’s route to **Never**. Successful sign-in resumes pairing automatically. Cancellation, failure, pending node approval, or an expired code does not continue pairing. The computer can show its confirmation only after the phone’s SSH enrollment request arrives. Older QR codes and phones remain supported.

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
子代理图标和设备的运行状态使用相同节奏。记号的颜色和形状跟随皮肤，不增加行高；活动文字保持稳定。
回合结束即恢复静态；系统开启“减弱动态效果”时保留完整不透明度的状态记号，App 进入后台后停止动画。
经理页的页签不用皮肤记号：“对话”在经理回合进行中显示小转圈，等人时显示等待色圆点，有新回复时显示未读色圆点；
“控制台”“工作线”的数字带框，有工作线等人时工作线页签显示等人的条数并改用等待色。

复制收在菜单里，不占消息下方的位置：长按用户消息选“复制消息”，长按回答选“复制回答”（针对按住的那条，
复制该条完整 Markdown），点回合状态行的 ⋯ 也可复制回合最后一条回答；复制后显示“已复制”。
用户消息的发送时刻和交付状态记号（排队是时钟、停止待发是暂停、状态待确认是圆圈里的 i）在气泡左边，点记号显示整句说明。用户消息的评论、附件和会话提及规则见 `sessions-and-projects.md`。

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

Chrome instance and tab access need no separate approval when Chrome control is enabled. Website approval shows the origin; phones show a read-only notice to handle it in the controlling desktop conversation. Sign-in shows the website and reason.
Chrome 总开关开启后不再逐个审批实例或标签。网站审批在手机上显示只读提示，请在控制端桌面的对应会话中处理。

For Chrome sign-in, finish signing in on
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

## iPad 与 Android 平板

平板支持横竖屏和系统多窗口，按当前窗口的可用宽度自动布局：

- 小于 840 点：单栏，保留当前页面；返回列表选择其他会话。
- 840 点起：左侧为设备、会话或经理目录，右侧为对话或工作台。侧栏宽 240–300 点，正文至少 600 点。
- 1280 点起：从对话打开终端、文件、差异、后台任务等工具时，右侧增加 380 点的工具栏；关闭工具回到对话。未打开工具时不留空栏。

旋转、分屏收窄或调整窗口尺寸不会重建会话；草稿和阅读位置保留。经理工作台继续用页签切换对话、控制台、工作线和概览。
外接键盘在消息输入框中按 Enter 发送，Shift+Enter 换行；输入法组合文字和软键盘回车仍按原方式输入。
手机继续使用单栏导航和原来的方向规则（终端可横屏），不显示平板侧栏。

## 配对主机密钥确认 / Pairing host-key confirmation

出码前，桌面端用一次性钥匙直连可探测的手机入口，验证它确实执行配对强制命令；此检查在主机密钥确认之前，成功后仍须核对有差异的指纹。
不读取设备的 `~/.ssh/authorized_keys`、使用独立钥匙库或不支持 `command=` 的 SSH 服务不能以一次性钥匙绑定手机，例如 Tyrs Hand Worker 的内置 SSH 入口。
认证策略拒绝一次性钥匙也会阻止绑定；这不是网络错误。请换成系统 OpenSSH 的端口，必要时给 sshd 配置独立端口。
失败后地址表单仍可编辑，修改主机、端口或用户会重新检查，不需要先生成二维码。网络不通／响应超时、钥匙文件无法写入及适配器执行失败分别提示。
Tailscale SSH 保留专用配对方式。仅凭通用的 `SSH-2.0-Go` 横幅无法认定服务就是 Tyrs Hand Worker；不按服务名猜测支持情况。
此检查不要求设备新增协议能力，旧设备仍沿用原有配对方法。桌面端无法直接探测手机入口时保留原有主机密钥确认及自检流程，不能将未检查的入口标为已通过。

Before asking you to confirm a host-key difference, the desktop tests a reachable phone endpoint with only the one-time key and checks that its forced enrollment command runs. A successful test does not replace host-key confirmation.
SSH services with a separate key store or no forced-command support, including the Tyrs Hand Worker SSH server, cannot use this pairing method. Authentication policies can also reject the one-time key.
Use the system OpenSSH port, adding a separate sshd port if necessary. The address form stays editable after a failure, and changing the host, port or user runs the checks again before showing a code.
Network failures, key-file write failures and enrollment-command failures have separate messages. Tailscale SSH keeps its dedicated flow. Older device services require no new protocol method; endpoints the desktop cannot probe retain the existing confirmation and check flow.

桌面端通过本次已认证 SSH 连接取得服务端地址，设备优先探测该地址实际监听的 SSH 密钥，支持另一个 sshd 使用独立 HostKey、容器及端口转发。
入口密钥与设备自报、本机 known_hosts 不一致，或没有记录、无法直接核实时，会先显示地址、双方及入口的 SHA256 指纹与手机可能连到其他机器的风险。
用户点击“确认并生成二维码”才继续，取消不出码。确认仅用于这一张码，不修改 known_hosts 或保存全局信任；到期换码、地址或密钥变化后重新确认。
二维码和一次性钥匙登录检查使用同一把入口密钥。手机仍须能直接访问码中的地址；桌面端的 ProxyJump 不会复制到手机。

The desktop obtains the server address through the current authenticated SSH connection. The device probes that listener’s public keys, including custom sshd HostKey files, containers, and forwarded ports.
If the entry key differs, is unknown, or cannot be checked directly, Litch shows the address, fingerprints, and risk before creating a code. The user must explicitly confirm this code; cancelling creates no code.
Confirmation is not saved, does not change known_hosts, and must be repeated for a new code or changed address or keys. The QR code and login check pin the same entry key. The phone must still reach that address directly; desktop ProxyJump settings are not transferred.
## 工具图片 / Tool images

手机在工具摘要右侧显示 AI 读取的图片；窄屏保留最后一张，“+N”打开同组图库。点击后全屏查看，
可前后切换、捏合缩放，关闭返回原位置。原图只在查看时从会话设备读取；单图解码上限为 400 万像素。
设备隐私开关“在对话里显示 AI 读取的图片”同时适用于手机；关闭会隐藏小图并关闭查看器。

The phone shows images read by AI beside tool summaries. Narrow screens keep the last thumbnail;
“+N” opens the group gallery. Tap for full-screen viewing, previous/next navigation and pinch zoom.
Originals load from the session device only when opened, with a four-million-pixel limit per image.
The device’s **Show images read by AI in conversations** privacy setting also applies to the phone;
turning it off hides the thumbnails and closes the viewer.
