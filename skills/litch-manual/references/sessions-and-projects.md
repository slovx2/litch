# Projects and sessions

## 搜索

桌面标题栏的文字查找图标“在对话中查找”打开搜索条；macOS 用 `Cmd+F`，Windows/Linux 用 `Ctrl+F`。`Enter` 下一处、`Shift+Enter` 上一处，`Esc` 关闭。同一窗口只打开一个查找栏：在另一处打开会自动关闭前一个并恢复其折叠与阅读状态。窄窗口经理页处于看板时，查找会先切到对话。
搜索当前已读取的用户消息、助手回答和过程说明、可见思考摘要、代码块、计划、提问与评论卡片文字。
索引构建或查询失败时显示失败提示，可关闭查找后重新打开重试。
命中尚未显示的早期回合会先显示目标附近内容；收起的过程、思考和卡片会临时展开，再定位高亮，关闭搜索后恢复原折叠选择，并停留在最后命中所在位置；焦点返回打开前的控件。
命令、工具参数和输出、子代理活动、编辑工具的文件差异不参与搜索，也没有“包含工具”开关。
搜索范围是已读取的内容，不代表引擎的全部原生历史。首次选择离当前视口最近的命中；每次最多列出视口附近 500 处，仍按对话顺序上下跳转。达到上限请缩小查询。支持中文、大小写和全角字母归一化。

侧栏顶部的放大镜“搜索会话”（侧栏收起时在标题栏的新对话旁）或 `Cmd/Ctrl+Shift+F` 按标题搜索所有设备，默认包含归档；原生子代理和临时会话不参与搜索。
可按设备筛选，结果显示设备、项目名、harness、相对时间与归档标签，完整路径在悬停提示中。离线设备只搜缓存标题，会话列表未完整读取时提示结果可能不全，可点“重新读取会话列表”重试；读取中按钮禁用，失败单独提示。
空查询先显示最近会话；方向键选择结果，Enter 打开并聚焦目标会话输入框；Esc 取消才返回原控件。结果以标题/时间/归档和设备/项目/harness两行显示；没有项目归属的会话显示“无项目”。点击活动会话打开对话，点击归档会话进入只读历史。每台设备最多显示 100 项，超过时请输入更完整的标题。
全局标题搜索不检索消息正文；手机搜索界面尚未提供。

## 侧栏「未读 / 最近」

桌面「对话」视图在各设备前显示「未读」「最近」，两组可独立收起。
未读沿用本机的新结果标记：未查看的对话从运行转为停止时标记，打开后清除；随侧栏缓存保存，重启保留。
从未读组打开后，当前主项保留在原位置并恢复已读样式，切到其他主会话或离开对话后才移出，避免连续点击打开下一项。未读计数只计算仍未读的主项，最近组不显示总数。
这不是逐条消息的已读计数，客户端离线期间结束的回合不保证标记；不同电脑和手机的已读状态不互相同步。

最近的空状态提示为“查看满 5 秒或有过操作的对话会出现在这里”（Conversations you view for 5 seconds or interact with appear here）。
最近按本机最后一次查看或操作倒序排列。打开、切换或查看会话，须在当前可见窗口连续停留满 5 秒才更新，时间记录为满 5 秒的时刻；同一段连续停留只记一次。
切走会话、离开对话页、窗口失去前台、最小化或隐藏会清零计时，返回后重新计满 5 秒。打开立即清除未读，不用等待，也不会仅因清未读而进入最近。
发送、插话、回答、批准或拒绝、停止、恢复、提交编辑等成功操作立即更新，不受查看时长限制；
模型输出、定时任务、后台唤醒、子会话自动回报不更新。首次使用从新的查看和操作开始记录，不读取所有历史回填。
手机端目前未记录最近；以后接入时复用核心的相同前台停留规则。
最近覆盖连接的各台设备，但不跨客户端同步；离线设备保留缓存条目，归档、删除及经理和工作线子树不列入。

子会话符合条件时列出其主会话，展开主会话可查看整个子树，子会话不单独列出；父会话不在活动目录时不列出孤立子项。
两组默认各显示 5 个主会话，「显示更多」每次增加 10 个，不限总数。组头菜单可分别选择按项目聚合、默认显示 5 / 10 / 20 条，设置在本机记住。
默认不按项目聚合；聚合后项目按组内最新项排序、项目内按时间排序。当前显示的投影包含多台设备时，项目头显示“项目名 · 设备名”；只有一台设备时项目头不重复显示设备名。平铺时仅远程设备的行显示淡色设备名，本机行省略设备名，设备色线保留。
设备色线与原树一致；新添加设备自动选色优先蓝、紫、灰，已有设备的颜色保持原样。文字名称提供设备区分，不依赖颜色。组头菜单以勾选标明项目聚合状态和默认条数。
最近组的时间是最后查看或操作的时间；未读组是主会话及子会话中最新未读结果的时间。悬停时间可查看口径和完整日期。
项目的新建对话、重命名、颜色、置顶、移动与删除操作与原设备树相同。投影组不受设备树的 harness 筛选影响；原设备树仍保留全部原有条目。
会话菜单打开后，滚动侧栏使该行移动时菜单收起；打开前已经完成的滚动不会关闭新菜单。

## 输入历史与清空草稿

桌面输入框在光标位于开头时用上、下方向键回忆本会话的用户输入；会话通信、经理事件、子会话回报、定时任务和自动续跑指令不进入输入历史。
仅 macOS：`Ctrl+C` 清空整份草稿（文字、图片、提及、技能、评论及差异批注），`Cmd+Z` 可撤销清空；不打断回合，输入法组字中不处理。Windows/Linux 的 `Ctrl+C` 保持原生复制行为。

## 过程开合

桌面对话展开或收起过程、步骤组和命令时，保持被点击行的位置；滚到顶部收起时也保持该位置。

## 复制消息

桌面端悬停或聚焦消息可见“复制消息”按钮；手机端按钮常显在消息下方。
手机端等待确认时，确认卡片会为最近消息的正文和复制按钮保留显示空间。
复制成功显示“已复制”，失败会给出重试提示。离线和输出中也可复制当前已收到的全文。
一条回答以消息条目为界：多段过程说明与最终回答分别复制，不合并整个回合；
手机端把长回答分块显示时仍复制该条完整 Markdown，代码围栏和链接原样保留。
用户消息复制正文、附件名称（无名称时用附件类型）、评论编号与完整引用和备注；
会话提及复制显示标题，不复制内部评论指令、会话元数据或图片数据。
折叠的长消息仍复制全文；系统和协作消息展开后的按钮复制其可见原文。

## 访问权限

访问权限的选择与确认按执行设备上的实际项目目录保存。同目录换 harness、新建会话或换用手机时，共用项目默认值和确认记录；不同目录与设备各自记录。降低默认权限不会抹掉此前明确确认过的档位。项目没有记录时采用 harness 默认；目标不支持项目档位时，需选择其他权限或 harness，不自动升权。

## Projects

A project is a folder on one device. Sessions of every harness in that folder are listed under it, and
the side panel (files, diff) and terminals follow the project.

- `scripts/litch projects list <device>` lists the device's projects with their paths (arguments of
  the project actions: `scripts/litch projects --help`).
- `scripts/litch projects add <device> <path>` adds a folder as a project. The path is on that device
  (absolute, or `~/…`); the folder must exist there.
- `scripts/litch projects remove <device> <project>` removes the project from the sidebar. The folder
  and the sessions in it are not deleted; the sessions show under "No project" or wherever their working
  folder fits.

In the UI: Add project… on the device's menu, the **+** on the built-in Projects group, or in the
new-session project picker. In the dialog, type the folder, pick one used by sessions not in a project,
or press Choose…: on this computer it opens the system folder dialog, on a remote device (and in the
phone app) it browses the device's folders in place (Up, tap a folder to go in; hidden folders are not
listed); rename, color, pin, move to a group (or back to Projects), reorder and delete
from the project's menu. Groups (sidebar folders) are made from the device menu (New group…). Projects
that are not pinned or in a group are listed under the built-in Projects group (it can't be renamed or
deleted). In the sidebar, drag a project onto a group's title row to put it at the end of that group
(the row lights up), or between two projects to place it there (a line shows where it lands); dragging
it onto Projects takes it out of its group. Drag a group's title row (or Projects') above or below
another group to change their order, or use Move up / Move down in its menu; Pinned stays on top and
the order is remembered on this computer only. Sessions can be dragged onto Pinned or a group's title, or
back onto their own project. The phone app shows the same groups but has no dragging. Arranging the
sidebar (groups, pins, order) is not available through the command; tell the user how to do it in the
sidebar.

## Sessions

会话可以在后台任务运行期间切换；离开大对话或关闭其后台任务面板，不需要等待任务结束。
切换只释放当前界面的会话订阅，不会停止设备上的 Agent 或后台任务。

### 侧栏中的子会话

桌面侧栏将子会话缩进显示在父会话下方，以实线连接。收起父会话后，仍显示当前选中、
待处理和未读的子会话（未读会话仍受 harness 筛选影响）。其余子会话在竖线内汇总为
“N 个子会话”；已有子会话显示时，汇总为“还有 N 个子会话”，只计算尚未显示的数量。
点击汇总行展开。筛选或显示开关隐藏的子会话不计入该数量；全部已显示时没有汇总行。
手机端仍使用父会话行上的箭头和数量展开、收起，没有单独的数量汇总行。

### Opening from outside the sidebar

Opening a session from a notification, task card, link, manager workline or pending activity reveals
its device, project/group and parent chain and highlights the row. It scrolls only if the row is out
of view. Clicking a row already in the tree does not reveal or scroll it again. A hidden sidebar stays
hidden and locates the row when reopened. A single-group view returns to the full list.
Filters and display switches are preserved; when the target cannot be shown, its nearest visible
ancestor is revealed. Archived previews do not select a sidebar row.

Chat and Managers remember separate open sessions/pages/panels until the app closes. Opening from
an external entry switches to the session's owning view (manager and worklines → Managers, ordinary
sessions → Chat) without overwriting the other view's location. Removed managers and archived or
deleted sessions are not restored. These navigation behaviors have no setting to turn off.
Managers and the global suggestion list: see [Managers and suggested tasks](managers-and-suggestions.md).

### Pending questions and answers

Answer pending wrap-up and asynchronous questions **above the composer**, on desktop and phone.
They survive sub-session reports, schedules, messages and background wakes. Several old and new
questions can coexist; duplicates are shown once. Answering one settles only that question. A message
you type in the main composer settles earlier pending questions together. Automated plan confirmation
follows the same distinction. Automated turns do not count as your answer.

The transcript shows a question only after it is answered, ignored or closed, combining its record
and answers in one card. In partially answered groups only settled questions appear there; the rest
remain above the composer. Answered groups fold to a count and summary; expand to read answers and
other options. In pending questions, clicking an option sends that answer immediately on desktop
and phone. The Send button is only for a custom answer. Desktop answer fields use Enter to confirm and Shift+Enter for a newline; IME Enter
only confirms composition. On the phone Return adds a newline and the card's button submits.

The pending section can collapse while retaining its count. Cards show their age and later
sub-session report count. Replies follow the configured send mode (immediate or queued); cancelling a
queued answer restores the question. **Ignore**, when supported by the device, hides a question
without sending a message or answering it, and syncs across clients/reconnects. Ignored questions
remain visible to the agent in wake/reminder context; obsolete questions should be explicitly
withdrawn through wrap_up. Ignore state is not inherited when a session forks.

Blocking approvals and questions remain in their request cards until answered, withdrawn or their
owning turn ends. The parent also shows direct children's blocking requests above its composer;
expanding one opens the original request card. The model can read a current request id and explicitly
respond when authorized (its descendants, or a user-input turn). Ordinary messages never answer a
request. Secrets, MCP forms and requests owned only by another executor still require the user in the
original flow. Delegated answers leave an audit record in the child conversation.

### Folded turns and mid-turn input

Long desktop conversations load their history progressively so the sidebar stays responsive.
When returning to an earlier reading position, the transcript briefly shows a loading message
while restoring it. You can select another conversation during that time.
Scrolling while earlier turns are being filled in keeps your reading position; code blocks and
other inner scroll areas retain their own scrolling.

In the compact transcript, a finished turn with a final answer folds its activity into a full-width
row: elapsed time, supporting counts of commentary/steps/subagents, and any failure, refusal or still
running background work. Click the row to expand. Stopped turns and turns without a final answer stay
open. Every message explicitly marked as a final answer stays outside the folded activity, including
a conclusion followed by a short reply to a message received in the same turn. The detailed view
keeps its usual behavior.

Native subagents appear as compact rows with a description, status and elapsed time when available
on desktop and phone. Click a row to open the subagent's conversation. Codex activity markers and
the structured subagent calls used by Claude Code, Pi, DSH and OpenCode share this presentation;
repeated activity markers update the same row within a turn. Generic ACP tool reports without a
subagent identity remain tool steps.

A user message delivered during a turn appears as a regular message bubble. It stays in
that turn and divides its activity into independently expandable segments on desktop and phone.
Segment time appears only when every entry has timestamps. The turn's source appears once at its
start, and completion/total time once at its end. With no mid-turn input there is one activity row.
System events (reports, schedules, messages and manager updates) fold to their source and summary;
expand to read the body. Their open state is remembered per session.

Ordinary sessions are managed in the UI or with session tools; manager configuration has its own commands. What the user can do in the UI, so you can
explain it:

- **Start**: New session (Mod+N) → pick device, project, harness, model, reasoning effort, permissions
  (Read only / In project / Full access, or the harness's own presets) and optionally turn on the
  Plan mode switch → send the
  first message. `scripts/litch open new` brings the user to this page.
- **Worktrees**: on the New session page, when the project folder is in a git repository on a device
  that supports worktrees, "Where" offers Local (the project folder) or New worktree. A new worktree is
  created by the device service with its own branch (named from the first line of the message), so the
  session's changes stay out of the project folder; "From" picks what to branch from: the default
  branch, the current local state (current commit plus uncommitted changes and new files), or any
  local or remote branch. The choice is remembered per device and project. Such a session shows a
  branch mark in the sidebar and a Worktree card in the info rail (branch, base, path; Terminal, Copy
  path, and Restore when the folder was removed). The terminal panel follows the session: in such a
  session it switches to a terminal opened in the worktree (opening one if needed; the card's
  Terminal does the same), and new terminals open there; other sessions of the project switch back to
  one at the project root. The session's menu has "Delete worktree": it deletes the folder and keeps
  the session and branch (uncommitted changes saved as a snapshot, brought back when the session is
  opened again). Ignored files copied when the worktree was made (`.worktreeinclude`, local harness
  settings) are copied again when it is restored. Device settings → Worktrees lists every worktree on
  the device: Remove deletes the folder and keeps the branch (uncommitted changes saved as a snapshot,
  or discarded), Restore brings a removed one back with its snapshot, Remove with branch deletes both
  for good. The Worktree card also has "Merge <base>": it merges new commits from the branch the
  worktree started from (nothing is pushed; commit the worktree's changes first; on conflicts it stops
  and lists the files to resolve in the terminal or by the model). In such a session the Diff tab's
  "All" compares against where the worktree started (its latest common commit with the base branch),
  so committed changes show too ("Since <commit>"); those can't be discarded there. Archiving the
  session removes a clean worktree (the branch stays), keeps one with uncommitted changes (see
  `worktrees.keptDays`), or hands it to a session still sharing it (a sub-session or fork working in
  that folder); reopening or unarchiving the session, or a sharing session, brings the folder back
  (changes made on the branch since then are kept; a clash is left as conflicts to resolve). Deleting
  the session hands the worktree to a session still sharing it, otherwise deletes the folder without
  a snapshot (the confirmation says so).
  Where worktrees go, how branches are named and automatic cleanup: `device-settings.md`.
  The phone app has the same "Where" and "Start from" choices on its New session page; a session in a
  worktree shows its branch in the session list and under the title, and the conversation menu's
  **Worktree** sheet shows branch, base and path with Terminal, Merge <base>, Copy path, and Restore
  when the folder was removed.
- **While a turn runs**: with Settings → Conversation → Sending during a turn set to Send now (the
  default) a message goes straight into the running turn and the button reads Send; set to Queue, or
  when the harness can't take messages mid-turn (or can't take images mid-turn and the message has
  some), it waits in the queue above the composer until the turn ends and the button reads Queue
  (the composer's placeholder says which). Codex, Claude Code, Pi, DSH and OpenCode take images
  mid-turn; ACP agents (Gemini, Qwen and the generic ACP entry) take no messages mid-turn. "Send now"
  on a queued message puts it into the running turn. With nothing typed the button is Stop, which interrupts the turn.
  Pressing Enter again while the previous message is still being sent is accepted too (desktop and
  phone): it goes in order, queued or into the running turn per the setting. On the new-conversation
  page the next message waits until the conversation has been created.
  停止或回合失败后，本客户端尚未发送的消息暂停，不会自动开启下一回合。桌面和手机输入框上方显示
  “已停止，N 条待发”，可发送全部或单条、编辑回输入框、移除。再次输入消息时，发送处先选择
  “连同 N 条待发一起发”（默认）或“只发这条”，一次提交；前者保持各条消息的顺序与附件归属，后者保留原待发。
  Claude Code 的插话气泡区分“排队中”“已发送”“已停止待发送”“状态待确认”；“已发送”只表示运行时已接纳，
  不保证模型已经执行。只有明确取消的未消费输入进入待发；状态待确认的消息不会自动重发，核实后可编辑再发。
  待发原文和附件保存在当前客户端，重启后保持暂停并尽量按 Claude 历史对账；尚不在设备间同步。
  编辑时若现有草稿容纳不下附件，消息仍留在待发列表。此阶段仅 Claude 提供交付状态，其他 harness 只统一停止后暂停队列。
  若界面误以为回合仍在运行、引擎明确拒绝插话，客户端会重新核对回合状态；确认已正常结束后，原消息作为新回合发送一次。
  无法确认状态时，消息和附件保留为暂停待发，可在状态恢复后点击“发送”。用户在核对期间点停止，仍须明确恢复发送。
- Child sessions show their harness in the sidebar/list, cards and details. A successful user message
  during an automated turn makes that turn user-driven.
- **Approvals and questions** appear as cards above the composer: commands, file changes, extra
  permissions, MCP tools (Allow once / Allow for this session / Always allow / Decline / Decline and
  stop, or decline with a note for the model); multi-question forms; plan confirmation (Run the plan /
  Ask for changes / Not now).
- **Per message**: Fork a new conversation from here; Edit (the message turns into an editor in place,
  a dialog on the phone; nothing changes until Send, Esc or Cancel restores it. Send removes that
  message and everything after it, then sends the edited text as a new turn; files are only restored
  where the harness supports it, the note under the editor says which. Comments, mentioned sessions and
  inline images are resent; device-disk images, audio, files and skills are not, the editor lists
  them). On a message sent while the turn was running, both cut at that message and keep the earlier
  part of the turn; harnesses that can't cut inside a turn (only Claude Code can) don't offer them
  there. On the phone, long-press the message.
- **Composer**: `/` for commands and skills, `@` to mention a file, attach images, files and folders
  (dragged or pasted; files and folders are mentioned by path, never uploaded). Remote devices take the
  contents of text files only; other files and folders on this computer go by their path here only when
  the device has "Operate this computer" on, so the agent reads them with `litch_machine`. Context meter. In an existing session, clicking the meter shows context
  usage and a Compact context button (dimmed with the reason underneath while a turn runs or when the
  harness can't compact). When the harness is signed in with a subscription (Claude Code with an
  Anthropic subscription, Codex with ChatGPT) it also lists the plan limits: the 5-hour and weekly
  limits, per-model weekly limits when there are any, how much of each is used and when it resets. API
  keys and third-party providers have no plan limits, and those rows are not shown.
  Compaction shows in the conversation as a divider: “Compacting context” while it runs, “Context
  compacted” when done (manual and automatic alike), “Compaction didn’t finish” when it was cut short.
  In Claude Code, background notifications that continue after manual compaction run in a separate
  normal turn with the session’s own permissions; they do not inherit compaction’s temporary
  read-only restrictions.
- **Side panel**: Files (tree, search, read-only viewer, add a file to the conversation), Diff (all /
  staged / unstaged, stage, unstage, discard, comment on lines; comments go with the next message),
  Browser, Suggested tasks, Background tasks, Goal, Side chat.
- **File previews (desktop)**: the Files tab opens tree/search results and file links read-only.
  Markdown renders by default (Source is available; line-number links open source). Static images
  and SVG can zoom. PDF supports pages, scroll, zoom and text selection. CSV/TSV shows strings, never
  evaluates formulas, and offers source for cropped fields. Static HTML disables scripts, forms,
  navigation and external resources. Short MP3/WAV/MP4/WebM media has manual playback; codec support
  depends on the system. DOCX approximates document layout; XLSX shows sheets and saved formula
  results without recalculation, with basic number/date formats, merges and limited frozen panes.
  Unsupported formats include DOC, XLS, PPT and PPTX. Previews do not reproduce every Office feature.
  Project-relative images/links stay inside the project root; remote images, active SVG, PDF actions,
  macros and encrypted Office files are not opened. Size/complexity limits show a reason (PDF:
  20 MiB/200 pages; Office: 10 MiB compressed/40 MiB expanded; media: 16 MiB). Large table previews
  are cropped with a notice. Use the original application for editing or full fidelity. Preview
  fonts do not follow Conversation text size. A device without preview support offers its ordinary
  source/type view; phone file viewing is unchanged.
- **Side chat**: a temporary fork of the current session for asking something on the side. It starts
  with the session's context up to the last finished turn (if a turn is running it stops before it, and
  the main turn keeps going), lives in the side panel's Side chat tab, never shows in the sidebar, and
  is gone when closed (closing one you talked in asks first) or when the app restarts, and may be gone
  after the device was disconnected for a while; New side chat starts over from the main session's latest. Two ways in: the Side chat tab
  (Start side chat), or select text in a reply and choose Side chat (the text goes into the side chat's
  composer as a quote, not sent; with a side chat open the button reads Send to side chat). Selecting
  text in a side chat reply offers Add to main chat instead, which quotes it into the main composer.
  One side chat per session. It uses the main session's model and permissions (changeable in the side
  chat) and the same folder, so it can change files if asked; the model is told to only answer and not
  to continue the main task. Only Claude Code, Pi and Codex sessions have it: OpenCode and generic ACP
  temporary sessions carry no history, and DSH can't fork.
- **Background tasks**: work still running after a turn ends (a background command, a Claude Code
  Monitor, a dsh background job, a long-running Codex command, or a background command Litch gives Pi,
  OpenCode and ACP sessions through its `litch_shell` tools (on by default; each harness's "Background
  commands" setting turns it off). The session counts as idle, not stuck:
  a breathing line above the composer says how many are running, counting running subagents too;
  clicking it opens the Background tasks tab. That tab lists background commands and the harness's own
  subagents together (running first, then finished ones; type icon, name, elapsed time and status).
  Sub-sessions are not background tasks: they sit under their parent in the sidebar, and you stop one
  from its own page. Click a subagent to open its page below the list, a command to see its output.
  Running commands and monitors have a Stop button on harnesses that can stop them (not dsh, whose
  background jobs can only be listed), and so do subagents of harnesses that can stop one on its own
  (Claude Code; stopping one leaves the turn and the other subagents running). The folded
  turn says "N running in the background", and the sidebar row shows a slowly breathing hollow mark
  instead of the spinner. Claude Code, dsh and Litch's background commands (Pi, OpenCode, ACP)
  continue on their own when a task finishes by itself; that turn starts with "Background task
  finished, continuing" instead of a message from the user. A task you or the model stopped does not
  wake the session; when you stop one, the model is told on its next turn that you stopped it. 原生 Codex 在新建 Litch 会话中默认提供 `litch_background.watch/read/cancel`：模型用原生命令执行有限任务，再登记需要结果后继续的 session_id；登记成功后可以结束回合，任务完成后设备自动投递结果并继续。开发服务器和监听不登记，不因退出自动续跑。命令权限和沙箱仍由 Codex 管理。Gemini CLI and Qwen Code get no Litch
  background commands. Litch's background commands run on the device the session runs on, as the
  model's own commands do; their output goes to a log file the model can read. They keep running when
  every client disconnects, and stop when the harness's runtime restarts (a settings change, a service
  restart or upgrade) or the session is deleted. A sub-session reports to its parent when its turn ends and says how many
  background tasks are still running, then reports again when they finish (after the turn that
  continues, or right away for unregistered Codex terminals and when the tasks were stopped). If you stopped them, that report
  says so and does not wake the parent. A scheduled run ends with its turn too; when the background
  work finishes later, the run's summary and count are updated and it shows as unread again.
  原生 Codex 登记的任务在后台页显示自动继续状态。停止回合会暂停自动继续，命令本身不会额外被杀；输入框中的待发消息不会因此自动发送，用户明确发送后才能解除暂停。取消登记只撤销自动继续，停止命令使用后台页的停止按钮。客户端全部断开时，设备仍可收到结果并继续；设备服务或 Codex 重启不自动续跑，已保存结果仍可读取。自动续跑没有次数上限，可能持续产生模型费用；重复完成只投递一次，交付未确认时不自动重试。官方客户端同时打开同一线程会看到标准回合和工具输出；绕过设备的并发写入不能获得设备侧的原子仲裁保证。
  To stop a task without the Stop button, ask the model or stop the turn. With Pi's "Ask before acting" on, starting a background command is asked about like
  any other command; in OpenCode's read-only permission mode the model cannot start one, and outside
  the project folder it asks first (except with full access). On the phone, the same line (or
  "Background tasks" in the session's menu) opens a simpler page with the same list, where a subagent
  opens its own page and running commands can be stopped; the folded steps and the
  line at the start of a continuing turn look the same as on the desktop.
- **Messages Litch sends for you** show as cards, not as your own message: a scheduled task's run
  ("Scheduled task · <name>", with "Run manually" for Run now), a sub-session's first message ("Sub-session
  brief", "Fork brief" or "Handed-off task", with the session it came from, which opens it), and "Do it
  here" on a suggested-task card ("Task card · Do it here"). The card shows the title and the start of
  the task; Show full text shows exactly what the model received, Show less folds it again. A message
  another session sent with `litch_sessions.send` shows as "Message from …" (as below), folded to one
  line until you expand it. These cards sit on the left at the width of the answers; the right side is
  only for what you typed yourself. Desktop and phone alike.
- **To-dos**: the to-do list a harness keeps (Claude Code, OpenCode, ACP agents, Codex) shows in the
  info rail on the right, with the latest list staying until the next one replaces it; when the rail
  doesn't fit it shows in the conversation instead. On the phone a small "To-do 2/6" button sits above
  the composer next to the background-tasks line while steps remain (or the turn is still running);
  tap it to open the list above the composer and Collapse to put it away. In the conversation the
  phone shows one line per list (progress and the current step); tap it to expand the list in place.
- **CJK emphasis**: in replies and Markdown file previews, bold, italic and strikethrough render even
  when the markers touch Chinese punctuation (for example `**“文件”**的`); code and link text stay
  as written. Desktop and phone use the same rules.
- **Mermaid diagrams**: a `mermaid` code block in a reply is drawn as a diagram once the block is
  complete (while it is still being written, the source shows). The block's header switches between
  Diagram and Source and copies the source; Enlarge opens a viewer (wheel to zoom, drag to pan). If a
  diagram can't be drawn (a syntax error), the source shows with the reason in the header. On the
  phone each diagram is a fixed-height card with the whole diagram scaled down; tap it for full screen
  (pinch to zoom, drag, double-tap to reset, Source and Copy at the top, Back closes it). Diagrams are
  drawn on the desktop or phone itself, without a network connection.
- **Goals** (Codex and Claude Code only; other harnesses show no goal controls): type `/goal` followed
  by what should be achieved and send it. Instead of a normal message this sets the session's goal,
  and the harness keeps working on it turn after turn while the session is idle, until the goal is
  achieved, blocked, hits a usage limit or runs out of its budget. Each turn it starts on its own
  begins with "Goal not met yet, continuing" instead of a message from the user. A line above the
  composer shows the status, the goal and the time or tokens used, with Pause / Resume and Clear;
  clicking it opens the Goal tab in the side panel, where the goal can be edited (Save, or Mod+S;
  saving also resumes it). Sending `/goal` with different text while a goal is unfinished asks before
  replacing it. Stop pauses an active goal before stopping the turn, so it does not start again by
  itself. `/goal` also works on the New session page. Once the goal is achieved it is cleared right
  away: the line above the composer goes, and "Goal reached · <time>" appears under the last answer
  of the turn that achieved it (until a new goal is set). Only text is accepted (no images or files),
  and a token budget can be shown but not set in Litch. The phone follows the same rules: the goal
  line above the composer (status, time, Pause / Resume, Clear — no confirmation), `/goal` from the
  slash list (also on the New session page), the line at the start of a continuing turn and the
  "Goal reached" line; editing in a side tab is desktop only. For Codex, a goal set in another app on
  the same session shows up here too; if goals are turned off in the Codex configuration, the
  controls disappear for that session.
- **Terminal**: per project; "Put away, keep it running on the device" keeps a terminal alive and
  "Terminals on the device" brings it back. Limits are device settings (`device-settings.md`).
- **Session menu**: pin, move to group or project, rename, archive (undo available), delete (permanent),
  schedule a task for this session, start a sub-session, detach a sub-session.
- **Session names**: Claude Code sessions take the title Claude Code writes; Codex sessions started in
  Litch are named after their first text message is accepted, independently of the main turn
  (switch and conditions in `harnesses.md`). Interrupting the turn does not cancel naming. A name
  the user sets by hand is never replaced.
- **Archived sessions** page: restore, open read-only, delete.
- **Archiving with sub-sessions**: archiving a session (sub-sessions included) also archives its
  sub-sessions that have stopped, and theirs; ones still working (a turn running, waiting for you,
  background tasks) or pinned stay in the list. Restoring a session brings back only that one.
- **Reply style**: sessions that Litch starts (including sub-sessions and scheduled tasks) tell the model
  that replies appear in Litch, which renders Markdown and Mermaid diagrams, and to answer
  conversationally rather than like a terminal. Codex sessions do not get this (Codex keeps its own
  style, as in the official Codex app). The user's own instructions take precedence. It is fixed when
  a session is created: sessions started outside Litch (for example in the official Codex app) and
  sessions created before this version do not have it, and a session Litch created keeps it when
  opened in another app. There is no setting to turn it off.

## Claude Code sessions started elsewhere

The Claude Code harness also lists Claude Code sessions started elsewhere on the machine (Claude desktop
app, `claude` in a terminal). They can be opened and continued in Litch, and back in the other app.

- **Read-only while another process has it open**: when the Claude desktop app or a `claude` in a
  terminal still has the session open, the session is read-only in Litch: the composer is greyed out
  with "Another process has taken over this session, so it is read-only here" (中文「此会话正由另一个
  进程接管，这边只读」), and sending, rewinding and compacting are refused. Two processes writing one
  session would fork its history. What the other side does still shows up in Litch every few seconds,
  and the session becomes writable again by itself once the other side lets go.
- **How to make the desktop app let go**: archive that session in the Claude desktop app, or quit the
  Claude desktop app (it keeps a session's process running after the reply, so a session used there
  recently is usually still held). In a terminal, exit `claude`. A session that was written to in the
  last 10 seconds by something Litch cannot identify also counts as held.
- **Going back**: do not continue the session in the desktop app while Litch is still running a turn
  in it; wait until Litch's turn has finished. The desktop app does not check, so this cannot be
  blocked.
- **Settings**: when Litch picks up the session, it takes the model, reasoning effort, permissions
  (bypass permissions becomes Full access) and Plan from what the other app used last. A setting the
  user changes in Litch stays as set; the others keep following the other app. Titles and approvals
  granted for the session are not shared.
- **Context usage** shows how much the last request used; the window size is only known for models
  Litch has run itself, otherwise only the amount used is shown.

## Session trees (sub-sessions)

A session can start **sub-sessions** on the same device, with any harness. They are nested under the
parent in the sidebar, their results come back to the parent, and the parent can be
woken to continue.

- **By hand**: session menu → Start a sub-session… → harness, model, project, context ("Start fresh",
  or carry over the parent's context, which needs the parent's harness), title, task, background
  (only for a fresh start, optional: what the sub-session cannot see of this conversation), and
  "Wake the main session when done". If the chosen harness cannot give the same sandbox as the parent,
  the dialog warns that the sub-session will be looser.
- **By the model**: in sessions of every harness (Codex, Claude Code, Pi, DSH, OpenCode, Gemini CLI,
  Qwen Code, ACP) the model has `litch_sessions` tools: list and read sessions on the device, start
  sub-sessions, send to and interrupt its own sub-sessions, wait for them, and archive or restore
  sessions. In a turn you started it may send to or interrupt any session. Once two sessions have
  exchanged a message in any way (a message the model sent, an interruption, a session you mentioned
  with `@` in the other, a sub-session's brief and reports, a Claude Code inbox message), both may
  message each other at any time after that, also after archiving and restoring either (interrupting
  still needs a turn you started, unless it is its own sub-session). It archives a session only after you agree in a message you typed (when its sub-sessions
  have all finished it may suggest archiving them), never one that is still working or pinned; it can
  restore its own sub-sessions any time. Without authorization to start sub-sessions (including earlier authorization still in effect), the model proposes a task card instead. To use another
  harness or model it first looks up what the device offers (`litch_sessions.options`: each harness's
  models as in the model menu, Claude Code's with their provider, reasoning efforts, defaults); a
  harness or model the device does not have is refused with the choices instead of starting a session
  that fails on its first turn.
- **Suggested tasks**: the model proposes work with an outcome of its own that you may want to
  follow separately, including independent steps of an agreed plan. Parts of the current task,
  unfinished work and verification stay in the conversation. Most turns need no card. A next step
  continuing a diagnosis is one question with reply buttons; answering sends your response to this
  session. Wrap-up suggestions appear below the final answer when the turn ends; mid-turn proposals
  appear where raised. Card actions, inheritance, retention and the session/global lists are in
  `managers-and-suggestions.md`. Repeated Start returns the original child, not another session;
  an already settled card reports its actual state.
- **Where a sub-session works** (devices that support worktrees): when the parent session is in a
  worktree Litch created (or shares one), a new sub-session gets its own new worktree and branch,
  starting from the last commit of the parent's branch (the parent's uncommitted changes are not
  carried over); otherwise it shares the parent's folder. The model can say which it wants; cards,
  the "New session" choice of an offer card and the Start a sub-session dialog have a "New worktree"
  checkbox, preset this way, and what is checked there wins. "Do it here" always stays in the current
  session and folder. A handed-off task gets a worktree only on harnesses that can fork into another
  folder (Codex, Claude Code); elsewhere it shares the folder. On the phone the cards, the offer card
  and "Edit and start" have the same "New worktree" switch.
  At most three unsolicited suggestions and four total cards can be raised per turn. To start one,
  click its card or tell the model which one. The model withdraws stale proposals. Wrap-up precedes
  the final answer and may carry no suggestions. A missed wrap-up can trigger one reminder turn.
  Settings for task cards, wrap-up and reminders are documented once in `device-settings.md`;
  these do not remove authorization for explicitly requested sub-sessions. Cards live on the device
  and can be created while no desktop or phone is connected.
- **New task or here**: when the user asks for something unrelated to the current session (after a
  first task has been done in it; the first request is simply what the session is for), the model
  first shows a card with only a title and two buttons, "New session" and "Do it here". New session: the
  model writes the brief and the sub-session starts; if the brief targets a harness that cannot be
  sandboxed as tightly as this session, it does not start and the card turns into an ordinary
  suggested task saying why, for you to review and start. Do it here: the model does it in this session.
  Sending a new message instead of choosing counts as "Do it here". Requests that build on the session
  (corrections, follow-ups, the next iteration, going ahead with what was just suggested) get no card.
- **Hand-off**: when an unrelated message arrives while the model is in the middle of a task, it hands the
  task and its remaining plan to a forked sub-session (a "Handed off to a forked session" card, started
  at once, waking the parent when done) and answers the new message here. The fork starts before the
  current turn, so work done in that turn reaches it only through the remaining plan.
- **Previously authorized sub-sessions**: `start(initiation: "user_asked")` can run in any later turn,
  including wake, reminder and scheduled turns, if you already requested sub-sessions or approved a
  plan that includes them. Approving a goal alone does not authorize separate sessions. Later changes
  or withdrawal of your authorization take precedence. Task cards may be off. Direct starts have a
  separate limit of 16 per parent per turn and 8 direct children running or starting at once; they do
  not consume the 4-card allowance shared by proposals, offers and wrap-up suggestions. The whole tree allows 24 running or starting sessions including the root,
  with maximum depth 4 (root is 0).
  Wider sandbox access still needs confirmation; the 50-wake limit is unchanged.
- **Reports and waking**: when a sub-session finishes a turn, the start of its last answer is handed to
  the parent ("Reports from sub-sessions"). When the parent is idle and its sub-sessions have stopped,
  the parent is woken to continue (up to 50 times per user message; your next message resets the count). The model can set `wake_parent` when starting a sub-session (default true), then use
  `litch_sessions.set_wake(thread_id, wake)` to disable or re-enable waking for its direct children,
  including overriding the setting previously chosen in the UI.
  Reports still arrive while waking is off; enabling it rechecks eligible queued reports under the
  normal wake rules, without overriding stops, failures, scheduled turns or wake limits.
  `list` and `read` include the current `wake_parent` value. Desktop session details and mobile rows
  show “Wake off”. The spawn dialog and Edit and start also let you choose the initial setting. Waking happens on the
  device, also when no desktop or phone is connected. Background tasks still running in the parent or a
  sub-session after its turn do not hold it back. Turns run by scheduled tasks report but do not wake;
  a scheduled run in the parent itself carries the reports waiting there. After you stop the parent's
  turn (or it fails) the parent is not woken; waiting reports go with your next message.
  A sub-session you stop or archive yourself does not wake the parent either: the report notes it and
  the parent sees it on your next message. The same goes for a turn you start yourself by typing in the
  sub-session (as in Claude's desktop app): its report waits until you next message the parent. A failed or interrupted turn's report carries its error and
  does not wake the parent (as in Claude's desktop app); it goes with your next message, or with a wake
  another sub-session's report brings. Nothing wakes while another sub-session is still running.
  Reports not yet handed over show as soon as they arrive as one small button above the parent's
  composer, next to Background tasks ("Report from …", or "Reports from N sub-sessions"); tap it to
  see them. "Handle now" there hands them over at once: into the running turn, or in a new turn when the
  parent is idle, without waiting for the other sub-sessions. Once handed over they show on the message
  that carried them.
  If a sub-session finishes several turns while the parent is busy, only its latest report is handed over.
  Users can also stop automatic reports entirely; see [Stop or resume reporting](#stop-or-resume-reporting) below.
- **Detach as a standalone session** (session menu or the "Started from …" bar at the top of a
  sub-session) cuts the link.
- **Subagents** started by a harness itself (for example Codex's agents) are not sub-sessions; they show
  in the side panel's Background tasks tab and cannot be messaged directly. In Claude Code sessions, Litch stops
  a subagent that shows no activity for 30 minutes; the turn and the other subagents keep running, and
  the model is told that Litch, not you, stopped it.
- **Messages from other Claude sessions**: Claude Code sessions on the same computer can message each
  other (`ListAgents`, `SendMessage`), including the Claude desktop app's sessions and Claude Code in a
  terminal. A message that reaches a Litch session shows as a "Message from …" card on the left, not as
  your own message, folded to one line until expanded (with "Sender skips approvals" when the sender
  runs tools without asking, and "Open session" or "Open in Claude" when the sender is a Litch session
  or a Claude desktop session); an idle session handles it in a turn of its own,
  a busy one right after its current step. On the sending side the step reads "Message …". This is the
  device setting `harness.claude-code.crossSessionInbox` (on by default), and works only between
  sessions on the same computer. A session keeps the same address while Litch restarts its Claude Code
  process. When another Litch session messages one whose process is not running, Litch starts it
  first and the message opens a turn there; from the Claude desktop app or a terminal, the receiving
  session's process has to be running. Turns a harness opens by itself like this (and turns that go on
  after background work finishes) can still use Litch's session tools (messaging other sessions,
  sub-sessions, task cards, wrap-up) and scheduled tasks when no desktop or phone is connected: the device
  runs those tools itself.

The whole feature can be switched per device with the `sessions.enabled` setting
(`scripts/litch settings set <device> sessions.enabled=false`); remote devices need adapter 0.11.0 or
later.

A running client tool does not mean the session needs user input. Browser sign-in approvals explicitly shared by the desktop appear in the parent’s pending section; complete them through the original approval flow. Other approvals held only by a client may require opening that sub-session on that client.


### Stop or resume reporting

Right-click a child session on desktop, or long-press it on the phone, then choose **Stop reporting to
parent** or **Resume reporting to parent**. Manager worklines have the same menu. It requires an online
device supporting the feature; a stopped row shows **Reports off**. The setting is stored on that
device and survives reconnects/restarts.

Stopping reports keeps the child in the tree and leaves its own running/waiting status visible. It
suppresses future automatic completion, failure, interruption, pending-request and background reports,
removes undelivered reports and prevents their wakes. Already delivered reports remain. Other
children still report and wake normally. Resuming does not replay old results; a currently pending
request is reported once after the usual 10-second waiting threshold. Waking also obeys the separate
wake_parent switch. Models can read report_parent through list/read but cannot change this user
control; set_wake only controls waking. There is no litch config command for it.
