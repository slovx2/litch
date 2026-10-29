# Concepts and a tour of the UI

## Concepts

- **Device.** A machine Litch talks to. **Local** (中文「本机」) is this computer; Litch ships its own copy of
  the adapter and starts a background *device service* for it. A **remote device** is another machine
  reached over SSH that has the Litch adapter (the device service) installed, or only the Codex CLI.
  Every device has a name, an id and a **wire color** (英文界面 "Color", 中文「线色」) that tints the
  window when you work on it. See `devices.md`.
- **Harness.** A coding agent that runs on a device: Claude Code, Codex, Pi, DSH (DeepSeek Harness),
  OpenCode, Gemini CLI, Qwen Code, or a custom ACP agent. Litch does not bundle harnesses; it uses the
  ones installed on each device, with their own sign-in and models. Each harness on each device can be
  Ready, Unavailable (with a reason) or Disabled. See `harnesses.md`.
- **Device service.** The adapter's resident process on a device. It gathers every harness on that
  machine behind one connection, keeps terminals and scheduled tasks running when no client is
  connected, and stores the device's settings (`device-settings.md`). It keeps running after Litch quits.
- **Project** (中文「项目」). A folder on a device. Sessions of any harness in the same folder share the
  project. Sessions can also live outside any project ("No project").
- **Session** (also "conversation"; 中文「会话」「对话」). One conversation with one harness on one
  device. Sessions can be forked, rolled back, archived, and can have **sub-sessions** (a session tree).
  See `sessions-and-projects.md`.
- **Group** (中文「组」). A sidebar folder you create on a device to collect sessions and projects.
  Projects not in a group or pinned sit in the built-in **Projects** group (中文「项目」), which can't
  be renamed or deleted. Groups and Projects can be reordered by dragging their title rows.
- **Skin.** The look of the whole app: **Retro** (default), **Literary** (internal name `human`,
  中文「文艺」) and **Standard**, each in light or dark. See `appearance-and-preferences.md`.

## Layout

### 经理入口与看板

桌面侧栏顶部的“对话 / 经理”切换整个侧栏内容。“经理”显示进行中的经理的待定决策总数；经理栏包含“新经理”、进行中的经理和默认折叠的已结束组。经理行显示名称、设备颜色、待定数或运行状态，有未交答复时显示本地草稿数。展开后沿用会话树显示子会话，普通对话栏不重复显示它们。

经理主区将普通对话和设备看板并排显示；窗口不足约 1240 像素时改为顶部切换。看板四个页签分别显示现状与动态、决策、事项、工作线。信息栏在经理页隐藏；文件侧面板覆盖看板，不挤压对话宽度。看板过程记录以仓库事实为准。全部经理页和新建经理页沿用定时任务的页面结构。

- **Title bar** (top): sidebar toggle, a breadcrumb "device / project / session" with the harness badge,
  and on the right: the remote-activity marker (only when remote devices are running commands on this
  computer or waiting for approval, see `operate-this-computer.md`), the terminal toggle, the info
  panel toggle (only while the session has something for the info panel) and the side panel toggle.
  The bar takes the current device's wire color. The sidebar and the info panel can be hidden
  completely; whether they are hidden is remembered on this computer.
- **Sidebar** (left): **New session** button, a harness filter and a "more" menu at the top (the menu's
  **Always show active conversations**, on by default, keeps running, unread and waiting sessions listed
  while the filter is on; **Show Claude Code sub-sessions** shows sessions the Claude desktop app
  started from another session); then one block per device
  (device row with status, then Pinned, your groups, the built-in Projects group, and "No project"
  sessions); at the bottom three small buttons: **Schedule** (scheduled tasks), **Appearance** (a
  popover for skin, theme and language, with a link to Settings → Appearance) and **Settings** (Devices
  and Archived sessions are entered from the Settings page).
  Hovering a device, project or "No project" row shows a **+** that starts a new session there (the
  device row and "No project" start one outside any project); the **+** on the Projects row adds a
  project. Right-click or the "more"
  button on a device, project or session row opens its menu (add project, new group, use on phone;
  rename, pin, move, delete; schedule a task, start a sub-session, archive, delete).
  Device rows, groups, projects and sessions with sub-sessions can be collapsed. What is collapsed is
  remembered per device (on the phone too) and kept after a restart; new ones start expanded.
- **Main area**: the new-session page, a session, or one of the pages (Devices, Settings, Scheduled
  tasks, Archived sessions).
- **Info panel** (right of the conversation): small cards that appear only when there is something to
  show, such as the session's latest to-do list and its worktree. It stays out when the window is too
  narrow; when it is hidden or out, the to-do list is shown in the conversation instead.
- **Side panel** (right) with tabs **Files**, **Diff**, **Browser**, **Background tasks** (background commands and subagents), and **Side chat** (a temporary fork for side questions, Claude Code / Pi / Codex sessions only). It follows the
  current session's device and project. Each session remembers whether the panel is open and which tab it shows.
- **Terminal panel** (below the conversation). Terminals belong to a project and keep running on the
  device when the connection drops.

Open a page for the user with `scripts/litch open` (the argument is the page: `settings`,
`settings/<section>`, `device <device>`, `tasks`, `new`; see `scripts/litch open --help`). This only
changes what the window shows.

## Pages

### New session

The default page. A prompt box with, below it, pickers for **Device** and **Project** (last item: Add
project…), and in the composer bar: harness picker (only when more than one harness is ready), Model,
Reasoning effort, Permissions (Read only / In project / Full access, or the harness's own presets) and
the Plan mode switch where supported. The menus list names only; hovering an item shows what it means.
Plan mode is a small on/off switch next to its name: knob left and grey when off, knob right in the
accent color when on. The session is created when the first message is sent. Litch
remembers the last device, project, harness and per-harness model/effort/permissions. When nothing can
be started (no device, device offline, no ready harness) the page says why with an "Open Devices"
button.

### Session

The transcript (messages, activity, to-dos, plans, file changes that open in the Diff tab), cards above
the composer (approvals, questions, forms, browser site approvals, "operate this computer"
approvals, plan confirmation, sub-session proposals), and the composer. Details in
`sessions-and-projects.md`. When a turn ends with a final answer its activity folds into one line (click
to open it; the phone does the same); a stopped turn, or one that ended without a final answer, stays
open, so what was done and a reply cut off midway are in view.

### Devices

A list of devices (status, harnesses, activity) with **Add device**. A device's detail page has, from
top to bottom: **This device** (reconnect, rename, edit connection, remove, wire color),
**Use this computer** (built-in browser, Computer Use, and for remote devices "Operate this computer"),
**Device service** (version, how it was started), **Phones** (paired phones, "Use on phone…"), and the
management area: **Harnesses** (per-harness enable switch, restart, CLI path, environment variables),
**SSH entries for the Codex desktop app**, **Reconnectable terminals**, **Scheduled tasks**,
**Session orchestration**, **Diagnostics** and **Logs**. Changes in the management area are saved
together with a save bar. See `devices.md` and `device-settings.md`.

### Settings

Sections in order: **Appearance** (skin, theme, density, conversation width, zoom), **Language**, **Devices** (a shortcut
to the Devices page), **Built-in browser** (links, import from another browser, trust all sites and the blocklist, always-allowed sites, saved passwords, clear browsing data),
**Computer Use** (macOS and Windows only: permissions or helper status),
**Notifications** (sessions, scheduled tasks), **Config assistant** (section id `assist`: the switch that
installs this manual into local harnesses and where it went, "Open config assistant", "Show the
welcome guide again"), **Shortcuts** (read-only list), **About** (version, updates, licenses).

### Welcome guide and config assistant

On first launch Litch shows a two-step welcome guide over the main area: if no harness on this
computer is usable it lists the supported harnesses with one-click install buttons and links to the
official instructions; once one works it suggests the config assistant. The **Config assistant**
button under the new-session title (also in Settings → Config assistant) opens the new-session page on
this computer with `/litch-manual` and "Use the Litch manual to help me configure: " filled in; the
user finishes the sentence and sends it to the harness they picked.

### Scheduled tasks

Tasks grouped by device, **New task**, a detail view with runs. See `scheduled-tasks.md`.

### Archived sessions

Archived sessions per device: Restore, Open (read-only), Delete.

## Status overview

`scripts/litch status` prints devices and their connection state, harnesses and versions per device,
tool switches, the number of paired phones, the app version, language and look. Run it first in every
configuration conversation.

## Keyboard shortcuts

Shortcuts cannot be changed. The full list is in Settings → Shortcuts. The common ones (Mod is Cmd on
macOS, Ctrl elsewhere): Mod+, settings; Mod+N new session; Mod+Shift+B sidebar; Ctrl+` terminal (also on
macOS); Mod+Alt+B side panel; Mod+= / Mod+- / Mod+0 zoom; Enter send, Shift+Enter new line; Cmd+← / Cmd+→ (Home / End on
Windows and Linux) start or end of the line in the composer; in approval
cards Enter approves and Esc declines; Esc leaves the Devices, Archived and Settings pages.

## Composer commands

Typing `/` in the composer lists built-in commands (`/new`, `/compact`, `/plan`, `/model`, `/effort`,
`/permissions`, `/terminal`) and the harness's skills (this manual appears as `/litch-manual` in
harnesses that list it). `@` searches files in the session's working folder.
