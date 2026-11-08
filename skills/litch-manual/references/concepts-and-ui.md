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

Use the sidebar's **Chat / Managers** switch for ordinary conversations or manager worklines.
Each view remembers its own position until the app closes. Manager setup and board use are in
[Managers and suggested tasks](managers-and-suggestions.md); external session opening and automatic
sidebar location are in [Projects and sessions](sessions-and-projects.md).

- **Title bar** (top): fixed Back / Forward buttons, sidebar toggle, a breadcrumb "device / project / session" with the harness badge,
  and on the right: the remote-activity marker (only when remote devices are running commands on this
  computer or waiting for approval, see `operate-this-computer.md`), the terminal toggle, the info
  panel toggle (only while the session has something for the info panel) and the side panel toggle.
  The bar takes the current device's wire color. The sidebar and the info panel can be hidden
  completely; whether they are hidden is remembered on this computer.
- **Sidebar** (left): **New session** button, a harness filter and a "more" menu at the top (the menu's
  **Always show active conversations**, on by default, keeps running, unread and waiting sessions listed
  while the filter is on; **Show Claude Code sub-sessions** shows sessions the Claude desktop app
  started from another session); then **Pinned** (pinned sessions and projects of all devices in one
  list), **Local groups** (only when you have some), Unread and Recent, and one block per device
  (device row with status, then your device groups, the built-in Projects group, and "No project"
  sessions); at the bottom: **Suggestions** (pending suggestions across devices), **Schedule** (scheduled tasks), **Appearance** (a
  popover for skin, theme and language, with a link to Settings → Appearance) and **Settings** (Devices
  opens inside the Settings window; Archived sessions opens in the main view).
  Hovering a device, project or "No project" row shows a **+** that starts a new session there (the
  device row and "No project" start one outside any project); the **+** on the Projects row adds a
  project. Right-click or the "more"
  button on a device, project or session row opens its menu (add project, new group, use on phone;
  rename, pin, move, delete; schedule a task, start a sub-session, archive, delete).
  Device rows, groups, projects and sessions with sub-sessions can be collapsed. What is collapsed is
  remembered per device (on the phone too) and kept after a restart; new ones start expanded.
- **Main area**: the new-session page, a session, Managers, or Archived sessions.
- **Settings, Suggestions and Scheduled tasks** open in an in-app modal window. The main view stays
  in place but cannot be interacted with until the window closes. Esc closes it and restores focus;
  links to conversations or main pages close it before navigating. These are not separate OS windows.
  Opening or closing a modal does not add a navigation-history entry.
- **Info panel** (right of the conversation): small cards that appear only when there is something to
  show, such as the session's latest to-do list and its worktree. It stays out when the window is too
  narrow; when it is hidden or out, the to-do list is shown in the conversation instead.
- 子代理页的“分派的任务”从首个回合读取原始正文，展开后可滚动查看全文。原文无法读取时保留任务摘要，并提示可能已截断；后续追问不会替换初始任务。
- The subagent page loads the assigned task from its first turn. Expand and scroll to read the full text. If the original is unavailable, a notice identifies the potentially truncated preview. Follow-up messages do not replace the initial task.
- 桌面上下文用量已上报、窗口大小未知时，输入框旁显示已用 token 数，提示窗口未知；知道窗口后才显示百分比。
- When context usage is reported without a window size, the desktop composer shows the token count and identifies the unknown window. A percentage appears only when the window is known.
- **Side panel** (right) with tabs **Files**, **Diff**, **Browser**, **Background tasks** (background commands and subagents), and **Side chat** (a temporary fork for side questions, Claude Code / Pi / Codex sessions only). It follows the
  current session's device and project. Each session remembers whether the panel is open and which tab it shows.
- **Terminal panel** (below the conversation). Terminals belong to a project and keep running on the
  device when the connection drops.

Open a page for the user with `scripts/litch open` (the argument is the page: `settings`,
`settings/<section>`, `device <device>`, `tasks`, `managers`, `suggestions`, `new`; see `scripts/litch open --help`). This only
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

The device list, device details and harness details are inside the Settings modal. The settings navigation stays visible; device-menu links open the requested detail directly. Closing the window or leaving an edited section asks to save, discard or cancel.

A list of devices (status, harnesses, activity) with **Add device**. A device's detail page has, from
top to bottom: **This device** (reconnect, rename, edit connection, remove, wire color),
**Use this computer** (built-in browser, Computer Use, and for remote devices "Operate this computer"),
**Device service** (version, how it was started), **Phones** (paired phones, "Use on phone…"), and the
management area: **Harnesses** (per-harness enable switch, restart, CLI path, environment variables),
**SSH entries for the Codex desktop app**, **Reconnectable terminals**, **Scheduled tasks**,
**Session orchestration**, **Diagnostics** and **Logs**. Changes in the management area are saved
together with a save bar. See `devices.md` and `device-settings.md`.

### Settings

Sections in order: **Appearance**, **Language**, **Conversation**, **Per-harness switches**,
**Built-in browser**, **Chrome** (desktop), **Computer Use** (supported desktop platforms),
**Notifications**, **Config assistant**, **Shortcuts**, **About**. **Devices** and **Archived sessions**
sit above the section list: Devices stays in the Settings window, while Archived sessions opens the main view. Appearance includes window zoom and the two
text sizes. Conversation sets mid-turn sending. Browser and Chrome use separate permission settings.
Configuration commands and defaults are in the corresponding references.

### Welcome guide and config assistant

On first launch Litch shows a two-step welcome guide over the main area: if no harness on this
computer is usable it lists the supported harnesses with one-click install buttons and links to the
official instructions; once one works it suggests the config assistant. The **Config assistant**
button under the new-session title (also in Settings → Config assistant) opens the new-session page on
this computer with `/litch-manual` and "Use the Litch manual to help me configure: " filled in; the
user finishes the sentence and sends it to the harness they picked.

Settings → Config assistant also offers **Show the welcome guide again** and **Install the manual into
local harnesses** (on by default). It lists installation paths, status and failure reasons. Read this
with `scripts/litch assist get`; use `scripts/litch assist manual on|off` to install/remove only
Litch-managed copies, then read back. Turning it on reinstalls them. User-owned skills are preserved;
remote devices do not receive this manual. If it is absent from a harness's skill list, the assistant
prefills its file path instead. A failed/skipped install is explained in this section; do not edit
Litch-managed skill files by hand.

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

## 桌面导航与应用内窗口

标题栏左侧固定显示后退、前进，切换普通对话、经理和其他主页面时位置不变。
macOS 使用 `Cmd+[` / `Cmd+]`，Windows/Linux 使用 `Alt+←` / `Alt+→`，也支持鼠标侧键。
输入框有焦点、输入法组字或模态窗口打开时不触发导航。没有可用历史时按钮禁用。
历史包含主窗口访问的对话、新建页、经理页和归档预览，保留到本次应用关闭。
后退后打开新位置会清除前进分支；归档或删除的活动会话在历史中跳过。
设置、建议、定时任务以应用内模态窗口打开，阻塞主界面；关闭回到原位置。建议、定时任务窗口按内容定高（内容少时变矮，空状态居中），设置窗口大小固定。用鼠标打开时初始项不画焦点框，键盘打开或按键后照常显示。
桌面窗口较窄时，标题栏上“N 个命令 · N 项待处理”缩成图标加数字，悬停可看完整文字。设备列表、设备详情和 harness 详情都属于设置窗口，左侧设置导航保留。
窗口里的设置立即生效；点“打开对话”等链接会先关窗口，再进入主窗口并记录历史。手机行为不变。
