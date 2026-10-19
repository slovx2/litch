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
  other site asks first with a card: Allow this turn / Allow for this session / Always allow / Decline.
- **Remote localhost**: when a session on a remote device opens `localhost:<port>`, Litch forwards that
  port over SSH to this computer automatically (loopback only) and rewrites the address. Apps that
  hard-code `localhost:3000` in OAuth callbacks or CORS lists may not match the forwarded port.

Preferences (Settings → Built-in browser):

- `scripts/litch browser links` sets whether links in conversations open in the built-in browser
  (default) or the system browser. Cmd/Ctrl-click and middle-click always use the system browser.
- `scripts/litch browser sites` lists the always-allowed sites.
- `scripts/litch browser allow` adds a site to the always-allowed list. **Guarded**: the user confirms in
  Litch. Only do it when the user asked for that site.
- `scripts/litch browser forget` removes one always-allowed site, or all of them (see `--help`).
- `scripts/litch browser clear-data` clears cookies, sign-ins, site storage and cache of the built-in
  browser. **Irreversible: ask first**, then the user confirms in Litch (the user will be signed out
  of every site there). Always-allowed sites are kept.

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
