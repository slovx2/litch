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
| Zoom | 80%, 90%, 100%, 110%, 125%, 150% | 100% |

## Language (Settings → Language)

`scripts/litch look language zh-CN` or `scripts/litch look language en` switches the whole UI (and the
app menu). There is no "follow the system" choice; on first launch Litch picks the system language.

## Notifications (Settings → Notifications)

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
