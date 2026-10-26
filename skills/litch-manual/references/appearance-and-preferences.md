# Appearance and preferences

These are preferences of the Litch app on this computer (not device settings). They apply at once.

## Look (Settings → Appearance)

Skin, theme and language can also be changed from the **Appearance** button at the bottom of the sidebar.

`scripts/litch look set` changes any of (exact flags: `scripts/litch look --help`):

| Item | Values | Default |
|---|---|---|
| Skin | `retro` (Retro), `human` (Literary, 中文「文艺」), `standard` (Standard) | `retro` |
| Theme | `system`, `light`, `dark` | `system` |
| Density | Compact, Standard, Roomy | Standard |
| Conversation width (`--width`) | `wide` (text up to 1280 px), `compact` (up to 760 px, 中文「紧凑」) | `wide` |
| Zoom | 80%, 90%, 100%, 110%, 125%, 150% | 100% |

Conversation width only matters in wide windows: the conversation and the input box stay centred and
never run under the info rail; when the conversation area is narrower than about 810 px both settings
look the same.

## Language (Settings → Language)

`scripts/litch look language zh-CN` or `scripts/litch look language en` switches the whole UI (and the
app menu). There is no "follow the system" choice; on first launch Litch picks the system language.

## Notifications (Settings → Notifications)

While the Litch window is in the background, a session shows a system notification when its turn
ends or fails and when it stops for an approval or an answer (sub-sessions only for the latter; runs
of scheduled tasks are covered below). The title is the session's title, the line under it names the
project and device, and the text says what happened: the start of the last answer, the error, the
command or files waiting for approval, or the question itself. Clicking it opens that session.
`scripts/litch notify sessions on` (or `off`) turns this on or off (default on).

The Dock icon counts unread sessions only: a session becomes unread when its turn ends or fails while
you are not looking at it, and opening it clears that. Approvals and questions notify but do not add
to the count. Every unread session also shows a dot in the sidebar and stays listed even under a
collapsed parent session or behind "Show more", so the count always matches dots you can find.
Unread state is kept by each Litch app on its own (the desktop and a phone do not share it).

Failed scheduled-task runs always show a system notification. `scripts/litch notify task-success on`
(or `off`) controls whether successful runs notify too (default off).

## Links

Whether links in conversations open in the built-in browser or the system browser:
`scripts/litch browser links` (`browser-and-computer-use.md`).

## Opening pages

`scripts/litch open` shows a page in the Litch window: `settings` or `settings/<section>`,
`device <device>`, `tasks`, `new` (see `scripts/litch open --help`). Use it to point the user at
something they have to do themselves.

## Not covered

- **Updates of Litch itself** (checking, downloading, "Restart to update", the automatic-check switch)
  are in Settings → About → Updates and are handled by the user.
- **Keyboard shortcuts** cannot be changed (Settings → Shortcuts lists them).
- Sidebar layout (width, groups, pins, order), panel sizes and the side-panel tab are changed by hand
  in the window.
