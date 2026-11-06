# Built-in browser and Computer Use

内置浏览器、Computer Use 和“操作这台电脑”是 Litch 的常驻工具。只要会话所在设备、所在 harness 的开关开启，
新会话就获得对应工具：桌面和手机新建、经理、工作线、普通子会话、任务卡与定时任务均遵守同一规则。
创建时不要求桌面在线；调用时由连接这台设备、声明能执行该工具的 Litch 桌面端执行。远程会话经原连接回到桌面执行。

已有的 Claude Code 和 Pi 会话在重新打开、重连或设备重启后恢复时，按当前开关刷新这三项工具。
正在运行的回合不受打断，更新在回合结束后生效。角色工具与自定义工具保留；只读与临时侧聊不会因此增加能力。
Codex 已有会话保持创建时的工具清单。关闭开关后，执行路由立即拒绝对应工具调用。

没有可用桌面时，调用立即返回 `noExecutor`，提示打开 Litch 桌面端并连接这台设备；桌面上线后下一次调用即可执行。
后台子会话优先使用父会话的执行连接，无须先打开子会话。执行中断线会返回失败，不会换一台桌面重做；操作可能已部分完成，重试前先核查结果。
网站、登录审批与系统权限继续由执行桌面检查。近期已了结调用保留去重记录；会话卸载、归档或删除时释放，记录达到上限时淘汰最早的条目。

## Switches per device and harness

The browser and Computer Use are switched per device and, below that, per harness (task cards too;
see `sessions-and-projects.md`). A harness that was never switched on its own follows its device, and
so does a harness installed later. The tree under Settings → Per-harness switches lists only the
harnesses enabled on each device: one turned off in the device settings has no row there and is left
out when a device's box is clicked, and its switches are kept and apply again once it is enabled.

`scripts/litch tools set <device> …` changes them (exact flags: `scripts/litch tools --help`):

- without `--harness`, every harness on the device changes together;
- with `--harness <id>`, only that harness;
- Task cards, browser and Computer Use all write device settings and require the device to be online.
  Desktop and mobile share these values. "Operate this computer" also uses the device setting `tools.machine`.

| Switch | Default | Notes |
|---|---|---|
| Task cards | on | Stored on the device; per harness only |
| Built-in browser | on | |
| Computer Use | off | Turning it on is **guarded**: Litch shows a confirmation card and the user must click Allow. For a remote device it means agents on that machine can operate any app on this computer, without asking app by app |
| Operate this computer | off | Remote devices only, not per harness, see `operate-this-computer.md`. Guarded |

In the UI: Settings → Per-harness switches, a table with a row per device (expand it to see its
harnesses) and a column per switch. A device cell is checked when all its harnesses are on, empty
when all are off and half-checked otherwise; clicking it sets the whole column for that device. The
three columns of an offline device are read-only. The device page (Devices → the device) shows a
one-line summary with a link to that table.

开关保存在设备设置的 `tools.browser`、`tools.computer`、`tools.machine`，每个 harness 可用 `harness.<id>.browser`、
`harness.<id>.computer` 覆盖；未覆盖的跟随设备。“操作这台电脑”不分 harness。浏览器默认开，另两项默认关。升级后首次连接时，仅将设备尚未设置的旧桌面值迁入；确认成功后删除本地旧值，之后设备值始终优先。

已有会话不补装工具：开启后需要新建经理或新开工作线/会话。关闭开关会立即阻止后续调用。
Claude 的新分叉和 hand_off 按当前开关重新整理工具；其余引擎的分叉继承源会话工具，需 fresh 新建才能获得新开启的工具。
只读旁问与自动起标题等临时内部会话保留原有工具限制。


## Built-in browser

- 用户在当前网页普通点击链接或按钮打开新标签时，自动切到新标签；Cmd/Ctrl+点击、中键点击
  在后台打开，Shift 配合点击按前台打开处理。没有真实输入的脚本弹窗不切换当前标签。
  代理正在操作的标签开出的新标签仍归同一代理，并保持后台；交给用户登录期间开的弹窗
  归用户，普通点击时切过去。后台网页不会自动打开浏览器面板或切走用户正在看的页面。
- In the side panel, tab **Browser**: tabs, address bar (non-URLs search the web), back, forward,
  reload, "Open in system browser". One browser profile is shared by all sessions and devices: sign in
  once in the panel and agents can use that session.
- Agents work in their own tabs (marked "Agent"); they can only read the address and title of the
  user's tabs. Agent tabs close at the end of the turn unless the agent left one open for the user. To
  stop an agent in the browser, interrupt the turn. `file:` pages cannot be opened.
- **Site approval**: local addresses (localhost, 127.0.0.1, `*.localhost`) are always allowed. Any
  other site asks first, once per origin (scheme, host and port), with a card: Allow this turn / Allow
  for this session / Always allow / Trust all sites / Decline.
- **Trust all sites**: while it is on, agents open any site without asking, except sites on the
  blocklist, which are always refused (a blocklist entry covers the domain and its subdomains). It
  applies to every session and device, including sessions on remote devices. When it is off, sites are
  asked about one by one again and the blocklist does nothing. The card's "Trust all sites" turns it on
  and allows the current site; Settings → Built-in browser → Site approval turns it off and edits the
  blocklist.
- **Remote localhost**: when a session on a remote device opens `localhost:<port>`, Litch forwards that
  port over SSH to this computer automatically (loopback only) and rewrites the address. Apps that
  hard-code `localhost:3000` in OAuth callbacks or CORS lists may not match the forwarded port.

### 下载 / Downloads

- 用户自己打开的标签下载自动保存到操作这台浏览器的电脑的系统“下载”目录；浏览器面板显示状态、最终路径和“在文件夹中显示”。同名文件自动编号，绝不覆盖已有文件，不自动打开或执行下载内容。
- 代理标签的每个下载都要用户单独批准，卡片显示文件名、来源站点及大小（服务器没给大小则显示未知）。网站许可不等于下载许可。为避免混淆人工输入和代理输入，即使用户在保留的代理标签中点击，也仍需批准；用户可以自己新开标签下载。
- 点击后立即用原始请求接收，不暂停后重试一次性链接。待批准文件临时存在本机私有目录，网页和浏览器工具读不到，临时路径不向 Agent 暴露；它不构成防御拥有完全文件权限 Agent 的操作系统安全边界。批准后才保存到“下载”，拒绝、十分钟超时、关闭待审批标签或应用退出时清理；崩溃残留在下次启动清理。
- 单文件最多 1 GiB、同时最多 4 个下载、临时数据总量最多 2 GiB；超限或网络失败会明确显示失败，不自动重试。未知大小在传输过程中检查。
- Agent 点击后使用 `litch_browser.downloads` 查询或处理延迟出现的下载审批；大文件尚未完成时稍后再查，完成结果给出最终本机路径。远程会话的文件也保存到控制端电脑。工具不接受任意保存路径，不会给 Agent 审批权限。不要重新点击一次性下载链接。

Downloads in user-owned tabs save automatically to the controlling computer’s system Downloads folder. The browser panel shows progress, the saved path and **Show in folder**. Existing files are never overwritten; duplicate names receive a number. Files are never opened or executed automatically.

Every download in an agent-owned tab requires individual approval, including manual clicks in a retained agent tab. The card shows the filename, source origin and size, or **Unknown size**. Website access does not authorize downloads. The original request is received once into a private temporary folder to avoid replaying one-time links. Pending paths and content are not exposed to browser tools or webpages. This is not an OS security boundary against an agent with unrestricted filesystem access. Approval publishes the file to Downloads. Rejection, a ten-minute timeout, closing a pending tab, or application exit deletes temporary data; startup cleans crash leftovers.

Limits are 1 GiB per file, four active downloads and 2 GiB of temporary data. Unknown sizes are checked during transfer. Failures never trigger an automatic retry. After clicking, call `litch_browser.downloads` to review pending approvals and progress; call again for delayed or large downloads. Completed results contain the controlling desktop’s local path, even for remote sessions. Agents cannot choose arbitrary save paths or approve downloads themselves. Do not repeat one-time download links.

### Importing from another browser

A one-time import into the built-in browser from **Google Chrome, Microsoft Edge, Brave, Arc,
Chromium, Vivaldi or Firefox** on this computer (macOS and Windows; not Safari, not Linux). It is not a
sync: to bring in newer data, import again. There is no command for it and agents cannot start it
(exception E10); tell the user where to click:

- Settings → Built-in browser → **Import from another browser** → "Import…";
- the Browser tab's menu (**···** at the right of the address bar) → "Import cookies and passwords…";
- a banner at the top of the Browser tab, shown until the user imports once or clicks "Not now".

In the dialog the user picks the browser and profile, then what to import: **Cookies** (site
sign-ins) and **Saved passwords**, both on by default. A kind that cannot be read on this computer, or
that the profile does not have, is greyed out with the reason.
"Only import cookies for these sites" limits cookies to listed domains (subdomains included).

Before importing:

- Quit the source browser completely (also from the background). While it is open its files are in
  use and the result says so; quit it and click "Try again".
- On macOS, importing from a Chromium-based browser (Chrome, Edge, Brave, Arc, Chromium, Vivaldi) asks
  once for permission to use that browser's key in the Keychain; the user must choose Allow. If they
  denied it, "Try again" asks again. Firefox does not ask.
- Limitation of this version: on Windows, recent Chrome, Edge, Brave and other Chromium-based browsers
  protect part of their data (mostly cookies) so that only the browser itself can read it. Litch
  cannot import that part yet; the rest is imported as usual and the result says so. Trying again
  does not help.

The result lists each kind with how many were imported, already there, invalid and failed. Nothing
already in Litch is overwritten (same site, name and path for cookies; same site and user name for
passwords). Invalid means expired or malformed cookies, partitioned cookies (the import API
cannot preserve their partition keys), or password entries that are not for a website (Android apps). The import itself
never shows cookie values or passwords to agents or in the Litch window; only counts.

Litch keeps session cookies across application restarts and updates using the system's secure
storage. They remain session cookies; persistent cookies keep their original expiration dates.
Signing out removes the saved state for those cookies, and **Clear browsing data** also deletes
the saved session state. If secure storage is unavailable, session cookies are not saved to disk.
Websites can still expire or revoke a login and require authentication again. Previously lost
session cookies cannot be recovered; sign in again once after installing this fix.

### Saved passwords

Passwords (imported, or saved after signing in) are kept in Litch's own store, encrypted with the
system's secure storage. Nothing is filled in by itself: in a tab the user opened, clicking a sign-in
field shows the saved accounts for that site, and the password goes in only after the user picks one.
Pages that are not https are never filled (localhost and other loopback addresses are the exception).
Tabs an agent opened show no suggestions and are never filled.

After a sign-in with a password Litch does not have, the Browser tab asks the user: **Save**, **Not
now** or **Never for this site**. If Litch already has that user name for the site with a different
password, it offers to **Update** it instead. Only the user answers; nothing is saved automatically. Agents must use request_sign_in rather
than typing passwords.

Settings → Built-in browser → **Saved passwords** lists them by site and user name: search, delete
one, delete all. Below it, **Never save passwords for** lists the sites marked "Never for this site";
removing one makes Litch ask again there. Passwords cannot be shown or copied. "Clear browsing data"
keeps them.

### When an agent needs the user signed in

Agents never ask for passwords, one-time codes or other secrets in the chat and never type them. When
a page needs signing in, the agent asks Litch (`litch_browser` → `request_sign_in`, with the site and
a short reason). Until the request is over, the agent cannot touch that tab; if it had run scripts on
that page, the page is reloaded first.

- A card shows in the Browser panel and in the conversation (and on a paired phone, see phones.md):
  the real site, the agent's reason, and the saved accounts for exactly that site.
- **Sign in with {account}**: Litch fills that saved account and submits the form itself. The agent
  never sees the password or the user name; while Litch fills and until the page has moved on, the
  agent sees nothing of that tab (console, dialogs, popups, title). If the page still holds the
  password afterwards, Litch closes the tab and opens the same address in a new one. Litch's own
  fill does not ask to save the password. Sites that need a popup, a one-time code or a second step
  after the password are handed to the user.
- **Sign in myself**: the user signs in on the page (saved passwords work as in their own tabs) and
  clicks **Done, hand back**; password fields are cleared before the tab goes back.
- **Decline**: the agent is told not to try another way; it cannot ask again for that site in the
  same turn.
- Filling is greyed out, with the reason, when the page is not https (loopback excepted), sends the
  password with GET or to another site, or the sign-in form cannot be found or is hidden.
- There is no time limit, except in scheduled-task turns (30 minutes). There the card can also be
  ticked "Use this account for this task from now on"; next time that task signs in to that site
  with that account without asking (see scheduled-tasks.md).
- Optional: Settings → Built-in browser → Saved passwords → **Require Touch ID before filling**
  (macOS only, off by default).

代理撤回登录请求后，Litch 会继续清理登录页；“代理已收回”提示可点“知道了”关闭。只有页面确实无法安全重新打开时，才关闭标签并显示“标签已关掉”；“知道了”关闭对应提示，不会重新开始登录。

After an agent withdraws a sign-in request, Litch still cleans up the page. Dismiss the withdrawn
notice with **Got it**. A **Tab closed** notice appears only when the page cannot be safely
reopened; **Got it** dismisses that notice without starting another sign-in.

If the user asks you (as the agent) to sign in somewhere, use `request_sign_in` rather than asking
for their password.

Preferences (Settings → Built-in browser):

- `scripts/litch browser links` sets whether links in conversations open in the built-in browser
  (default) or the system browser. Cmd/Ctrl-click and middle-click always use the system browser.
- `scripts/litch browser sites` lists the always-allowed sites.
- `scripts/litch browser allow` adds a site to the always-allowed list. **Guarded**: the user confirms in
  Litch. Only do it when the user asked for that site.
- `scripts/litch browser forget` removes one always-allowed site, or all of them (see `--help`).
- `scripts/litch browser trust on|off` turns "Trust all sites" on or off. Turning it on is **guarded**:
  the user confirms in Litch. Only do it when the user asked for it.
- `scripts/litch browser blocked` shows whether all sites are trusted, and the blocklist.
- `scripts/litch browser block` adds a site to the blocklist (a domain like `example.com` or a URL;
  subdomains are included).
- `scripts/litch browser unblock` removes one site from the blocklist, or clears it (see `--help`).
  **Guarded**: the user confirms in Litch.
- `scripts/litch browser clear-data` clears cookies, sign-ins, site storage and cache of the built-in
  browser. **Irreversible: ask first**, then the user confirms in Litch (the user will be signed out
  of every site there). Always-allowed sites and saved passwords are kept.

## Computer Use (macOS and Windows)

The model operates apps on this computer: screenshots, clicks, typing. While it works an on-screen
notice is shown; **Esc** (or Stop) takes control back and ends Computer Use for that app in this turn.

Windows 上，停止、Esc 和回合结束会取消进行中及排队中的动作。逐字输入、拖拽和连续按键在输入步骤之间停止，并释放本次动作已按下的键和鼠标按钮。已经送进应用的输入（包括整段粘贴）不会撤回；取消后应重新观察应用，再继续未完成部分。旧版助手仍只支持停止等待结果，需要更新助手才能中止正在执行的输入。

- **macOS permissions**: the separate helper app "Litch Computer Use" needs **Accessibility** and
  **Screen Recording**. Agents cannot grant these (exception E1). Tell the user: Litch → Settings →
  Computer Use → "Open System Settings", or System Settings → Privacy & Security → Accessibility, and
  → Screen Recording, turn on "Litch Computer Use"; after granting Screen Recording click "Restart
  helper" in Litch's Computer Use settings. If macOS offers "Quit & Reopen", "Later" is fine.
- **Windows**: no system permission is needed; the helper starts when needed. Litch warns when it runs
  as administrator or UAC is off (the helper could then control elevated windows).
- `scripts/litch computer status` reports the permission or helper state.
- **普通应用不逐个授权**：开启设备和 harness 的 Computer Use 后即可操作正在运行的普通应用，本机与远程会话遵循相同规则。
  正式发布版 Litch 自身例外，见下文。On Windows, windows that run as administrator still cannot be controlled. The agent
  does not open apps that are not running; it asks the user to.
- Not supported: Linux, a locked screen.

### 访问正式版 Litch 本身

读取窗口（截图和辅助功能树）及所有输入动作都需要授权，因为代理可能读取其他对话、替用户批准请求或修改设置。
授权卡提供“允许本次”“本对话内允许”“24 小时内对所有对话允许”和“拒绝”。本次覆盖单次工具调用；批量中含自身动作时，
在第一步前统一授权，覆盖整批及最终观察。本对话许可按来源设备和会话隔离，跨回合有效，桌面退出后失效。
24 小时许可保存在执行桌面的用户数据目录，覆盖来自各设备的所有对话，重启仍有效，到期自动失效。
在设置 → Computer Use → Litch 自身访问授权可查看截止时间和撤销；撤销同时清掉本对话许可，等待中的批准也失效。
已绑定手机并开启手机远程批准后，手机显示相同风险说明和三档选项，批准需要系统验证，档位随答复签名交回桌面核验。
自身授权只接受扫码配对时核对过的钥匙；首次批准网站登录时记下的旧钥匙不能用于此授权，需重新配对。
拒绝或取消后不得换用其他应用或工具绕过。普通网页仍走 litch_browser，不受此项限制。

只保护正式发布版：macOS 精确匹配正式包标识 `io.github.slovx2.litch`；Windows 按正式安装器登记的可执行路径识别。
主窗口、DevTools 和浏览器面板等同进程窗口都包含在内。开发 Electron、其他渠道标识及 `LITCH_PROFILE` / `LITCH_MOCK`
隔离实例不属于此项限制，开发与验收可继续直接操作。应用清单可用于找到目标，但不展示正式版 Litch 的窗口标题。

### Working with apps and save panels

Start with list_apps, then get_app_state for the target app. Prefer current element numbers;
use screenshot coordinates only when there is no element. Actions return accessibility changes:
use those new numbers, and request another state if information is missing or a fresh screenshot is
needed. After a window change, old coordinates are invalid. A snapshot can change during animation.

A running app without a capturable window still exposes menus and window status. Use a menu item or
press_key (for example cmd+n) to create a window, or Escape to dismiss an ordinary Open panel.
System permission and login prompts still require the user. The agent does not launch a stopped app.

In a Save panel, put only the filename in **Save As**. Use Command+Shift+G for the directory and verify
the destination before saving. Prefer set_value for replacing the filename; do not assume selection
survived a focus change. Cross-process Save controls receive keys in their actual process during a
protected foreground visit. If the keyboard target cannot be resolved, input stops: observe again.

Shortcuts release injected keys and modifiers after success, failure or cancellation. If the helper
reports a modifier still held after recovery, stop and let the user press and release that key.
User-held keys are not forcibly released.

### Batch actions

After observing the app, prefer **run_actions** when two or more next steps are already known. It
accepts 1–12 actions, with the same tool name and arguments as individual calls. For example, after
observing the intended TextEdit window and confirming these steps are appropriate:

```json
{"actions":[{"tool":"press_key","arguments":{"app":"com.apple.TextEdit","key":"cmd+a"}},{"tool":"press_key","arguments":{"app":"com.apple.TextEdit","key":"cmd+b"}}]}
```

The batch stops at the first failure; it does not retry or undo completed work. A failed action may
have partly executed, so inspect the result before continuing. Actions have 60 seconds total and the
final observation up to 10 more seconds. Results contain short per-step summaries and the last
attempted app's full state, with at most one screenshot. Verify other apps separately. Do not repeat
that final observation when it already answers what you need to know.

No loops, nested batches or observations are allowed inside a batch. Stop to observe when the next
step depends on a new window or unknown controls. Stale element numbers stop execution. Device and
harness switches, system permissions, user activity and Stop still apply to every action. Obtain
any required sensitive-action approval before submitting a batch. There is no extra batch switch or
litch config operation: enable Computer Use with tools set and use its tool interface.

### Background control and preview (macOS)

Litch prefers background actions, which are not blocked by user activity. Where foreground is needed,
it briefly activates the target, performs the action and restores previous focus. It waits up to
eight seconds only for held buttons/keys or a reported IME composition, not for global inactivity.
Opening the target to look at it, moving the pointer and scrolling do not stop the agent. If input
overlaps during a foreground step, only that step fails: inspect the state and retry its unfinished
part. The session remains usable. Esc and the explicit Stop button still stop control for the turn.
macOS checks held keys and buttons against their current hardware state on every attempt, so a
missed release event does not leave control blocked. An input-conflict error can be retried after
releasing the input or finishing composition. An explicit Stop remains effective even after keys
are released: end the turn and send a new user message to continue in a new turn.
Pointer conflicts follow the window that received the click; overlapping or click-through overlays do not change its target.
On Windows, UI Automation actions also ignore user activity; mouse and keyboard fallback uses a
temporary foreground visit with the same step-scoped conflict rule. IME detection depends on the
target exposing its composition range through accessibility; some applications do not expose it.
The preview indicates foreground visits. Chromium/Electron clicks still need foreground fallback;
macOS text input uses per-character background events when the focused control accepts them.

Screen Recording's toggle can be on while first capture still needs a separate system confirmation.
If macOS asks for screen/window access, the user clicks Allow; retry after handling it. Litch reports
waiting, denial and capture failure separately, and only considers capture usable after a real image.

The session's **Computer preview** shows the window and agent pointer. **Stop** ends control for this
turn; **Take over** stops the agent and opens the actual window. **Float preview** opens a floating
window without taking focus. Hiding the panel stops its capture unless a floating preview is open.
Stale frames are labelled; previews are not recorded. Remote sessions operate this Mac's helper.
Ending/interruption/failure releases control and previews; closing all desktop windows hides floating
previews while background sessions continue.

### Common problems

No image: check computer status, the system prompt and whether there is a window to capture. “User
is using” means wait for the user to finish, then retry; an explicit Stop means leave that app alone
for this turn. Element missing or expired: use the latest action result or get_app_state. A batch
failure is not a reason to replay all its actions.

## Chrome on the controlling computer

`scripts/litch chrome get` reads the control switch, connected instances and allowed remote devices.
`scripts/litch chrome set on|off` changes the global switch; add `--device <device>` for one remote
device. Enabling either requires a confirmation card in Litch. These switches do not grant instance,
website or sign-in approval. Extension preparation/loading stays in Settings → Chrome;
`scripts/litch open settings/chrome` opens it.

Chrome uses the `litch_browser` tools with an explicit Chrome target. In **Settings → Chrome**, choose **Install from Chrome Web Store**: Litch prepares the local connection and opens the store in Chrome. Add Litch Browser there and keep Chrome open. The status updates automatically when the extension connects; returning to Litch also checks immediately. Installing does not enable agent control or grant website access.

“等待扩展连接”表示尚未收到连接握手，不能据此断言扩展已经安装。若已安装，请打开扩展页确认 Litch Browser 已启用。无法使用商店时，展开默认收起的“备选：手动安装”，先准备扩展，再在 Chrome 扩展页开启开发者模式，加载所示目录；保留该目录，更新 Litch 后可再次准备并重新加载扩展。

商店版扩展 ID 为 `ddnllmibgnhhiiaaidfamlknbnfjpnpo`。先升级 Litch，再在 Chrome 设置页准备扩展，
宿主清单才会同时允许商店版和开发版连接；商店安装按钮也会自动完成准备。设置页默认提供商店入口；商店条目尚未发布或不可访问时，
可展开“备选：手动安装”使用本地扩展。

Platforms: macOS, Windows and Linux desktops. **Prepare extension** registers the host for Google Chrome: on macOS in `~/Library/Application Support/Google/Chrome/NativeMessagingHosts`, on Windows in the registry key `HKCU\Software\Google\Chrome\NativeMessagingHosts\ai.litch.chrome` (the Litch uninstaller removes it), on Linux in `~/.config/google-chrome/NativeMessagingHosts` and also `~/.config/chromium/NativeMessagingHosts` when Chromium is installed. Edge, Brave and other Chromium-based browsers, and Chrome Beta/Canary, are not registered. The unpacked folder is under Litch's data folder (`~/Library/Application Support/Litch/chrome/extension`, `%APPDATA%\Litch\chrome\extension`, `~/.config/Litch/chrome/extension`). Litch must be running for the extension to connect; the extension retries on its own.

The extension and Litch check a wire protocol range instead of requiring the same version, so a store copy that updates on its own schedule keeps working with adjacent Litch versions. Settings shows connected instances and, when they do not fit, which side to update: **The extension is too old** (store copy: click Update on the extensions page or wait for Chrome; unpacked copy: reload it) or **is newer than this Litch supports** (update Litch). An unpacked copy that still works but is older than the folder shows a reload hint. The toolbar icon shows `!` while incompatible.

Chrome control is off by default. Enable it and select its remote-device scope: only checked remote devices can use this computer’s Chrome. This is part of the master switch, not an additional approval card. An unchecked device receives an immediate error directing the user to Settings → Chrome. Browser feature switches for the device and harness still apply. Chrome has its own site permissions, including localhost; it does not inherit the built-in browser's saved site approvals or “trust all” setting. Remote sessions operate Chrome on the controlling computer: localhost refers to that computer. Operating Chrome on the remote execution device is not supported in this version.

Chrome 的站点权限在 **设置 → Chrome**：默认关闭“信任所有网站”，黑名单和“一直允许的网站”为空。
审批可选本回合、本会话、一直允许或拒绝，也可直接开启“信任所有网站”。本回合许可和拒绝在回合结束清除；本会话许可保留到 Litch 退出；一直允许、信任开关和黑名单存在 Litch 的 `chrome/sites.json`，跨回合、Chrome 重连和 Litch 重启保留，对控制端所有已启用的设备会话生效。
黑名单与内置浏览器一致：只在信任所有网站开启时生效，按主机名匹配并包含子域名。可逐项删除黑名单、逐项或全部删除一直允许的网站。
Chrome 的 localhost 仍检查站点权限，因为它位于控制端并可能带有登录态；信任所有网站或记住该来源后无需再问。总开关开启后不再单独审批 Chrome 实例或标签；登录及密码和支付安全规则仍独立执行。

Chrome 总开关包含远程设备范围：只有下方勾选的远程设备可以使用，未勾选时立即返回提示，不会弹卡或等待。开启 Chrome 总开关后，所有获准使用此控制端的会话都可列出已连接 profile 的标签标题和网址，认领用户标签无需另批。页面访问只由 Chrome 的站点许可控制，用户已登录的标签和代理新开的标签遵循相同的站点规则；开启“信任所有网站”后，除黑名单以外的已登录网站都可被操作。网站许可不等于网络防火墙，也不替代发送、购买等具体操作所需的用户指令。

With Chrome control enabled, conversations allowed to use this controller can list titles and URLs across its connected profiles and claim user tabs without a separate instance or tab approval. Chrome site permissions control page access for both signed-in user tabs and agent-created tabs. With **Trust all websites** enabled, signed-in sites outside the blocklist are accessible. Site permission is not a network firewall or authorization to send messages or make purchases without the user's instruction.

网站需要批准时，平台会在发起调用的会话中显示站点卡并继续等待。等待不计入桥请求的 30 秒超时，批准后无需代理重试。侧栏显示等待，父会话的子会话待处理区和经理看板也显示审批；系统通知遵循现有通知设置。手机显示只读提示，须在执行操作的 Litch 桌面会话中处理。

When a site needs approval, Litch displays a card in the calling conversation and waits. Human approval time does not count toward the bridge's 30-second request timeout. The sidebar, parent conversation and manager board show the pending approval; notifications follow your notification preferences. Phones show a read-only notice directing you to that conversation on the controlling desktop.

The agent uses targets → tabs → claim. Claim tokens and leases still prevent stale or concurrent control, but do not create an extra approval. User tabs are released when the turn ends and are never closed by the agent. Agent tabs are temporary unless kept. Reconnection, extension reload and ended turns invalidate leases and references. Listing retries once if the same instance reconnects during the request; otherwise the tool tells the agent to list targets and claim again. Input actions are never replayed automatically because an interrupted action may already have executed.

点击扩展图标会停止此 profile 的控制；图标显示 OFF，停止状态跨 Chrome 和 Litch 重启保留。工具会明确提示用户点击扩展重新打开，代理不能自行恢复。再次点击扩展才重新开启，不会清除网站名单。Litch 设置页也会显示停止提示。“停止所有 Chrome 控制”释放当前租约；关闭总开关可阻止后续调用。

Click the extension icon to stop control of that profile. Its OFF badge and stopped state persist across Chrome and Litch restarts. Tools ask the user to click the extension again to resume; the agent cannot resume control itself. Site permissions remain saved. Litch Settings also shows the stopped state. **Stop all Chrome control** releases current leases; turn off the master switch to prevent further calls.

连接边界：Native Messaging 的扩展 ID 白名单、每次桌面启动生成的宿主令牌，以及用户私有配置和 socket 限制连接来源。它们不能防御同一操作系统用户下可读取配置并执行任意程序的恶意软件；开发者模式扩展的固定 ID 也不证明代码来自官方商店。启用前应信任该操作系统账号下运行的软件和安装的扩展。

The connection boundary uses a Native Messaging extension ID allowlist, a host token generated when the desktop starts, and private per-user configuration and socket access. These do not defend against malicious software running as the same OS user with arbitrary execution and access to the configuration. An unpacked extension's fixed ID does not attest that its code came from the official store. Enable control only when you trust the software and extensions running under that OS account.

Chrome sign-in is manual. `request_sign_in` brings the tab forward and pauses agent observation and actions in that Chrome instance. Sign in yourself, then choose **Sign-in complete** in Litch. The page reloads and the agent must claim it again. Never provide passwords or one-time codes to the agent. Remote uploads and cross-device downloads are not supported.

隐私政策见仓库 `docs/chrome-extension-privacy.md`。获批页面内容会作为工具结果交给当前代理，
可能发送到用户配置的模型服务商或远程执行设备，并留在代理会话记录中。卸载扩展不会删除这些
独立记录；标签组恢复记录则在扩展本地存储中保存，恢复成功后清除。不要向公开 Issues 提交敏感信息。

New popups are unclaimed and require source approval before observation or actions. This is not a network firewall: a page can already send cross-origin requests through images, forms and fetch. The first popup request may reach its destination with cookies, referrer or URL data before approval, and may trigger GET side effects. The enforced boundary is the agent's access to page content and controls, not preventing all requests to unapproved sites.

### Chrome 标签组与操作标记

代理打开或认领的标签按会话放进 `Litch · 会话标题简写` 标签组。同一会话跨多个 Chrome 窗口时，每个窗口各有一组，不搬动窗口。
用户标签只临时归组；释放、回合结束、断开或停止控制后，恢复原组、位置和固定状态。原组最后一个标签被临时移走时，恢复会重新创建同名、同色、同折叠状态的组。
用户控制期间自行移动了窗口或分组时，保留用户的新布局。代理临时标签仍在回合结束关闭；标记保留的标签交还给用户并移出代理组。

空闲的代理组为蓝色；执行操作时组变橙色，组名显示 `▶ AI` 和正在操作的标签标题，当前标签对应的扩展工具栏图标显示 `AI`。网页的标题与 favicon 不会被改写。
操作失败也会撤销活动标记。扩展启动时读取恢复记录，清理上次遗留分组和徽标；恢复未完成的记录保留并重试。点击扩展图标仍是停止控制。

升级开发版扩展：先更新 Litch，在设置的 Chrome 页准备扩展，再到 `chrome://extensions` 重新加载 Litch Browser。新增 `tabGroups` 权限允许管理标签组；Chrome 如提示“查看和管理标签组”，确认后才能继续使用。重载会释放现有认领，代理需要重新列出并认领标签。

### 浏览器批量动作（内置浏览器和 Chrome）

`litch_browser.run_actions` 两条路径使用相同参数和执行规则。先观察标签；连续动作及其参数都已知时，优先合成一批：

```json
{"actions":[
  {"tool":"type","arguments":{"tabId":"已观察的标签编号","ref":"e12","text":"查询词","clear":true}},
  {"tool":"press","arguments":{"tabId":"已观察的标签编号","key":"Enter"}}
]}
```

一批 1–12 步，支持 `click`、`type`、`press`、`scroll`、`navigate`、`wait`、`dialog`。每步必须给同一种浏览器的现有 `tabId`，参数与单步工具一致；不能创建标签、嵌套批量、执行脚本或登录。需要用户决定、需要读取新界面、跳转后需要新引用时结束当前批次。

动作总预算 60 秒，最终快照另有 10 秒。导航和等待沿用单步上限；每一步仍检查来源审批、租约/会话所有权、文档和取消状态。失败即停，不回滚、不自动重试；结果给出已尝试各步的成功状态和摘要，以及最后尝试标签的快照。若标签被释放或登录冻结，最后观察明确失败，不绕过限制。失败的一步可能已经部分执行，继续时只做尚未完成的部分。

执行桌面必须声明浏览器批量能力。升级后 Claude Code/Pi 会话恢复时可刷新工具；已有 Codex 会话需要新建才能获得新增工具。
