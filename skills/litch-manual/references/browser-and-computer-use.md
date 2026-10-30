# Built-in browser and Computer Use

Both are capabilities of the Litch **desktop app** that agents can use: models in sessions started from
Litch (Codex, Claude Code, Pi, DSH, OpenCode, Gemini CLI, Qwen Code, ACP) get `litch_browser` and
`litch_computer` tools. Sessions on remote devices use the desktop's browser and Computer Use too,
while the desktop is connected (remote adapter 0.8.0 or later).

后台子会话（包括跨 harness 派出的会话）继承派出时父会话可用的桌面执行连接，无须先打开子会话即可调用
浏览器和 Computer Use。设备、harness 开关及网站、登录等审批仍由执行桌面检查。没有获授权且在线的
执行方时，调用立即返回 `noExecutor`，表示当前没有可执行的桌面端，不表示浏览器不可用。
执行中桌面断线会返回失败，不会自动换另一台桌面重做；操作可能已部分完成。先核查结果，再连接桌面并
打开会话后重试。已撤回或中断的调用不会因稍后打开会话而补执行。执行连接的继承仅保存在设备服务内存中，
服务重启后需重新打开会话以建立执行关系。

## Switches per device and harness

The browser and Computer Use are switched per device and, below that, per harness (task cards too;
see `sessions-and-projects.md`). A harness that was never switched on its own follows its device, and
so does a harness installed later. The tree under Settings → Per-harness switches lists only the
harnesses enabled on each device: one turned off in the device settings has no row there and is left
out when a device's box is clicked, and its switches are kept and apply again once it is enabled.

`scripts/litch tools set <device> …` changes them (exact flags: `scripts/litch tools --help`):

- without `--harness`, every harness on the device changes together;
- with `--harness <id>`, only that harness;
- `--task-cards on|off` writes the device's own setting `harness.<id>.taskCards`, so the device must
  be online; the browser and Computer Use are stored on the desktop and can be changed while the
  device is offline.

| Switch | Default | Notes |
|---|---|---|
| Task cards | on | Stored on the device; per harness only |
| Built-in browser | on | |
| Computer Use | off | Turning it on is **guarded**: Litch shows a confirmation card and the user must click Allow. For a remote device it means agents on that machine can operate any app on this computer, without asking app by app |
| Operate this computer | off | Remote devices only, not per harness, see `operate-this-computer.md`. Guarded |

In the UI: Settings → Per-harness switches, a table with a row per device (expand it to see its
harnesses) and a column per switch. A device cell is checked when all its harnesses are on, empty
when all are off and half-checked otherwise; clicking it sets the whole column for that device. The
task-card column of an offline device is read-only. The device page (Devices → the device) shows a
one-line summary with a link to that table.

When a session is created, the browser and Computer Use tools are only attached if they are on for
that session's harness; a session created while they were off does not get them later (start a new
session after turning them on). A switch turned off after a session was created makes the next call
fail at once, with a message telling the model where to turn it on.

## Built-in browser

- In the side panel, tab **Browser**: tabs, address bar (non-URLs search the web), back, forward,
  reload, "Open in system browser". One browser profile is shared by all sessions and devices: sign in
  once in the panel and agents can use that session.
- Agents work in their own tabs (marked "Agent"); they can only read the address and title of the
  user's tabs. Agent tabs close at the end of the turn unless the agent left one open for the user. To
  stop an agent in the browser, interrupt the turn. Downloads are cancelled; `file:` pages cannot be
  opened.
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
passwords). Invalid means expired or malformed cookies, partitioned cookies (the built-in browser
cannot store them), or password entries that are not for a website (Android apps). The import itself
never shows cookie values or passwords to agents or in the Litch window; only counts.

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

- **macOS permissions**: the separate helper app "Litch Computer Use" needs **Accessibility** and
  **Screen Recording**. Agents cannot grant these (exception E1). Tell the user: Litch → Settings →
  Computer Use → "Open System Settings", or System Settings → Privacy & Security → Accessibility, and
  → Screen Recording, turn on "Litch Computer Use"; after granting Screen Recording click "Restart
  helper" in Litch's Computer Use settings. If macOS offers "Quit & Reopen", "Later" is fine.
- **Windows**: no system permission is needed; the helper starts when needed. Litch warns when it runs
  as administrator or UAC is off (the helper could then control elevated windows).
- `scripts/litch computer status` reports the permission or helper state.
- **No per-app approval**: once Computer Use is on for the device and harness, the agent can use any
  running app, including an app without a window and sessions from remote devices; nothing asks first and there is no app
  list to manage. On Windows, windows that run as administrator still cannot be controlled. The agent
  does not open apps that are not running; it asks the user to.
- Not supported: Linux, a locked screen.

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

Litch prefers background actions. Where foreground is needed, it waits for keyboard/mouse inactivity,
briefly activates the target, performs the action and restores previous focus. The preview indicates
this foreground visit. If the user takes over, it stops instead of overriding the user's focus.

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

## Chrome on the controlling Mac

`scripts/litch chrome get` reads the control switch, connected instances and allowed remote devices.
`scripts/litch chrome set on|off` changes the global switch; add `--device <device>` for one remote
device. Enabling either requires a confirmation card in Litch. These switches do not grant instance,
website or sign-in approval. Extension preparation/loading stays in Settings → Chrome;
`scripts/litch open settings/chrome` opens it.

Chrome uses the `litch_browser` tools with an explicit Chrome target. In **Settings → Chrome**, prepare the extension, open the extensions page, enable Developer mode and load the displayed unpacked extension folder. Litch registers its Native Messaging host automatically. This version is not distributed through the Chrome Web Store. Keep the folder in place and reload the extension after updating Litch. The settings show the required version, connected instances and version mismatches.

Chrome control is off by default. Enable it separately and choose which remote devices may request access to this Mac. Browser feature switches for the device and harness still apply. Each source requires approval, including localhost; Chrome does not inherit the built-in browser's saved site approvals or “trust all” setting. Remote sessions operate Chrome on the controlling Mac: localhost refers to that Mac. Operating Chrome on the remote execution device is not supported in this version.

The agent lists targets, asks permission to list tab titles and URLs in one Chrome instance, and then explicitly claims a tab with a short-lived claim token. Instance permission and website origin approval are separate; reconnecting requires a new instance permission. User tabs are released when the turn ends and are never closed by the agent. New agent tabs are temporary unless kept. Reconnection, extension reload and ended turns invalidate leases and references; list and claim again. If a debugger cannot attach, close that tab's DevTools or other debugger and retry. Click the extension toolbar action or **Stop all Chrome control** in Litch to revoke control.

Chrome sign-in is manual. `request_sign_in` brings the tab forward and pauses agent observation and actions in that Chrome instance. Sign in yourself, then choose **Sign-in complete** in Litch. The page reloads and the agent must claim it again. Never provide passwords or one-time codes to the agent. Remote uploads and cross-device downloads are not supported.

New popups are unclaimed and require source approval before observation or actions. This is not a network firewall: a page can already send cross-origin requests through images, forms and fetch. The first popup request may reach its destination with cookies, referrer or URL data before approval, and may trigger GET side effects. The enforced boundary is the agent's access to page content and controls, not preventing all requests to unapproved sites.
