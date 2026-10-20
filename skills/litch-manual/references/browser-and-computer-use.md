# Built-in browser and Computer Use

Both are capabilities of the Litch **desktop app** that agents can use: models in sessions started from
Litch (Codex, Claude Code, Pi, DSH, OpenCode, Gemini CLI, Qwen Code, ACP) get `litch_browser` and
`litch_computer` tools. Sessions on remote devices use the desktop's browser and Computer Use too,
while the desktop is connected (remote adapter 0.8.0 or later).

## Per-device switches

`scripts/litch tools set <device> …` turns the capabilities on or off for one device (flags for the
browser, Computer Use and "operate this computer"; exact names: `scripts/litch tools --help`).

| Switch | Default | Notes |
|---|---|---|
| Built-in browser | on | |
| Computer Use | off | Turning it on is **guarded**: Litch shows a confirmation card and the user must click Allow. For a remote device it means agents on that machine can operate this computer's apps |
| Operate this computer | off | Remote devices only, see `operate-this-computer.md`. Guarded |

In the UI: Devices → the device → "Use this computer". A switch that is off makes the tool fail at once
with a message telling the model where to turn it on; turning it on works for existing sessions from
their next call.

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
sign-ins) and **Saved passwords** are on by default, **History** (the last 90 days) is off. Kinds that
cannot be read on this computer, or that the profile does not have, are greyed out with the reason.
"Only import cookies for these sites" limits cookies to listed domains (subdomains included).

Before importing:

- Quit the source browser completely (also from the background). While it is open its files are in
  use and the result says so; quit it and click "Try again".
- macOS asks once for permission to use the browser's key in the Keychain; the user must choose Allow
  (exception E1). If they denied it, "Try again" asks again.
- On Windows some browsers need administrator consent to read cookies and passwords: the user ticks
  "Allow reading cookies and passwords as administrator" and approves the UAC prompt (E1). Without it
  those two kinds are skipped and history still imports.

The result lists each kind with how many were imported, already there, invalid and failed. Nothing
already in Litch is overwritten (same site, name and path for cookies; same site and user name for
passwords). Invalid means expired or malformed cookies, password entries that are not for a website
(Android apps), history older than 90 days. Cookie values and passwords never reach agents or the
Litch window; only counts do.

### Saved passwords

Imported passwords are kept in Litch's own store, encrypted with the system's secure storage. They
are filled in only in tabs the user opened, never in agent tabs, and only after the user picks an
entry; agents reading a page never see password fields. Settings → Built-in browser → **Saved
passwords** lists them by site and user name: search, delete one, delete all. Passwords cannot be
shown or copied, and Litch does not yet offer to save new ones. "Clear browsing data" keeps them.

### History

The built-in browser keeps the pages visited in all tabs (http and https), agent tabs included and
marked as such, for 90 days. Typing in the address bar suggests from history. The history page lets
the user search it, delete one entry or delete all of it; "Clear browsing data" clears history too.

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
- `scripts/litch browser clear-data` clears cookies, sign-ins, site storage, cache and history of the
  built-in browser. **Irreversible: ask first**, then the user confirms in Litch (the user will be
  signed out of every site there). Always-allowed sites and saved passwords are kept.

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
- **App approval**: the first action on each app in a session asks: Allow this turn / Allow for this
  session / Always allow / Decline. Sessions on remote devices never get "Always allow", and this
  computer's always-allowed apps do not count for them. Some apps are always refused (Litch itself,
  password managers, Keychain, system authentication dialogs, System Settings; on Windows also security
  tools, Control Panel, registry and task manager); browsers and terminals are marked high-risk. The
  agent does not open apps that are not running; it asks the user to.
- `scripts/litch computer apps` lists always-allowed apps; `scripts/litch computer forget` removes one.
- Not supported: Linux, a locked screen.
