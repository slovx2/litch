# Phones (Android app, pairing by QR code)

The Litch Android app connects over SSH to the same machines. Instead of copying keys by hand, a
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

1. In the Android app: Add device → Scan to add, and scans the code (or pastes "Copy pairing text").
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
  does not accept keys, two-factor login is required, or the host key does not match.
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

## Android background connections

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
Manager events can be read as expandable system rows, but the phone has no manager board/settings
or global Suggestions entry; it keeps its per-session suggestion list (`managers-and-suggestions.md`).

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
- **Updates**: the phone checks the GitHub release feed and shows a bar on the device and session lists;
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
