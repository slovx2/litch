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
| Sidebar text size (`--tree-text`) | 90%, 100%, 110%, 120%, 135%, 150% | 100% |
| Conversation text size (`--chat-text`) | 90%, 100%, 110%, 120%, 135%, 150% | 100% |

Sidebar text size (会话列表字号) and conversation text size (对话字号) scale their reading areas
relative to the current skin. The selected factors are retained when switching skins.
Conversation text size covers prose, code, diagrams, questions, approval cards and the input box;
sidebar text size covers device, project and session rows.
The top bar, sidebar header and footer, settings, menus, info rail, diffs, files, terminal and browser
keep their own text sizes. Text size changes text and necessary line heights, while zoom scales the
whole window. The factors multiply: 150% text size with 150% zoom gives 225%.
Both preferences are saved on this computer, do not sync to phones, and also work in browser previews.

`scripts/litch look set --tree-text 120 --chat-text 135` changes both sizes; `scripts/litch status`
reads them back. Percent signs are optional; the factors `1.2` and `1.35` are also accepted.

Conversation width only matters in wide windows: the conversation and the input box stay centred and
never run under the info rail; when the conversation area is narrower than about 810 px both settings
look the same.

## Language (Settings → Language)

`scripts/litch look language zh-CN` or `scripts/litch look language en` switches the whole UI (and the
app menu). There is no "follow the system" choice; on first launch Litch picks the system language.

## Notifications (Settings → Notifications)

“设置 → 通知 → 会话”中的“通知范围”有“全部对话”（默认）和“仅主会话”两档，沿用这台电脑的本地偏好存储，修改后立即生效。
主会话指会话树里没有父会话的对话；Litch 子会话、经理工作线和其他应用派出的有父会话的对话，均属于子会话。
父会话尚未加载或已归档不改变该关系；其他应用的会话若没有已知父会话字段，按主会话处理，仍遵守侧栏隐藏时不通知的规则。
“仅主会话”过滤子会话的回合结束、出错、待审批和待回答通知，不改变未读数与 Dock 角标。
经理新决策、定时任务以及无会话归属的远程操作审批通知不受范围设置影响；会话通知总开关仍控制范围内的普通会话通知。
命令 `scripts/litch notify scope main` 选择仅主会话，`scripts/litch notify scope all` 恢复全部对话；
等同于 `litch config notify scope main|all`，`scripts/litch status` 可读回 `notifyScope`。
手机端目前没有系统推送，不同步此桌面偏好。

经理的“新决策通知桌面”由每个经理的新建表单或设置单独控制，不受普通会话通知开关影响。
桌面端连接期间，看板新增待答决策或重新打开决策时通知一次；修改待答决策的文字不重复通知。
首次连接、重连、重新加载看板或刚开启开关时，不补发已有决策。前台正在查看该经理时不弹出。
标题为经理名称，正文为决策标题，过长会截断；点击通知唤起窗口并打开该经理页，可在那里查看看板。
关闭桌面应用或设备断线期间不发送。

Each manager's **Desktop notifications for new decisions** setting is independent of session
notifications. While connected, the desktop app notifies once when a decision becomes open,
including reopened decisions. Editing an open decision does not notify again. Initial loading,
reconnecting, reloading a board, or enabling the setting does not replay existing decisions.
No notification appears while you are viewing that manager in the focused window. The title names
the manager and the body shows the decision title, shortened if needed. Clicking brings Litch
forward and opens the manager page, where its board is available. Notifications require the desktop
app to be running and connected to the device.

A session shows a system notification when its turn ends or fails and when it stops for an approval
or an answer, unless you are looking at that very session in the focused Litch window (looking at
another session still notifies). Sub-sessions notify with the default scope; sessions another app started stay quiet
while the sidebar hides them; runs of scheduled tasks are covered below. The title is the session's
title (for an approval, the project), the line under it names the project or session and the device,
and the text says what happened: the start of the last answer, the error, the command or files
waiting for approval, or the question itself. Each session keeps at most one notification for its
latest turn and one for what it is waiting on: a newer one replaces the older, the waiting one is
withdrawn once it is handled anywhere, and opening the session withdraws its turn notification. While
an approval or question waits and the window is in the background, the Dock icon bounces. Clicking a
notification opens that session. `scripts/litch notify sessions on` (or `off`) turns this on or off
(default on).

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
