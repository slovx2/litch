# Managers and suggested tasks

## Managers

A manager is a conversation that coordinates worklines (sub-sessions), maintains decisions and items
on a board stored on its device, and reports progress. Repository changes remain the evidence for
what has landed. Managers and their worklines appear in the desktop sidebar's **Managers** view;
ordinary sessions appear in **Chat**. The phone home screen has a **Managers** entry: managers are
grouped by device, and each manager page has **Overview**, read-only **Manager items** and **Console**
(the same order as desktop), plus **Chat** to open the manager conversation. Manager rows use the
same mark and status text as the desktop sidebar (see below); managers with items to handle show the
count in an amber pill at the end of the row. Creating managers and editing dispatch settings remain
desktop actions.

### 重置经理会话 / Reset manager session

桌面经理页右上角的重置图标、手机经理页“⋯”菜单里的「重置经理会话」只能由用户主动操作，每次都会确认。
手机能力落后时，“⋯”上显示等待色记号，菜单项也说明有新版本能力。重置过程中菜单项禁用并显示等待原因。
工具或指令比设备当前版本旧时，
按钮显示等待色记号。Claude 保留同一会话和完整历史，新能力在下一轮生效；其他引擎先让旧会话写
交接摘要，再创建同引擎的新会话接手看板与工作线。旧对话只读，可从桌面重置对话框中的历史入口打开。
其余对话细节不会传入新线程；摘要失败时必须再次确认，才能仅根据看板接手。
经理自己的回合、后台任务和临时追问停止后才执行，工作线继续运行，回报先排队。

Use the reset icon at the top right on desktop, or **Reset manager session** in the mobile manager page's **⋯** menu.
Both always ask for confirmation. On mobile, an amber marker on **⋯** highlights available updates;
the menu entry is disabled with a waiting explanation while a reset is in progress. An amber
dot means tools or instructions are behind the connected device's current definitions. Claude keeps
the same conversation and loads the new capabilities on its next turn. Other harnesses write a
handover summary and start a new session with the same harness and settings; the board and worklines
remain. The previous conversation becomes read-only history, accessible from the desktop reset dialog.
Conversation details outside the summary do not carry over. If summarizing fails, the user must
confirm again to continue with the board alone. Reset waits for the manager's turn, background tasks
and temporary questions to finish; worklines continue and reports queue meanwhile.

### Where and how to create one

Switch the sidebar to Managers → **New manager**. The form has three steps:

1. **Basic information**: optional name, **Manager settings** (custom instructions), and first task.
2. **Environment**: device, project or working folder, manager harness, model and reasoning effort.
   A folder and a ready harness are required.
3. **Assignment and notifications**: workline harness/model/effort, whether code work gets its own
   worktree, who merges it, maximum running worklines and desktop decision notifications.

Previous returns to an earlier step without losing input. Create is on the final step; invalid
values keep the form on the relevant step. A blank name lets the manager name itself. A blank first
task asks it to plan and wait for the user to say to start. Manager settings can contain role,
preferences and project rules, or stay empty. Litch generates its operating rules from the current
dispatch and waiting settings; those generated rules are not a text field to edit.

After a manager is created successfully, this desktop remembers the device and, for each device,
the folder/project, manager harness/model/effort, workline settings, notifications and custom rules.
The next creation form prefills them; name and first task stay blank. An explicitly chosen device
or project takes priority. An entry with no project specified restores the saved project as well as its folder; choosing No project in the form still clears that choice. Missing devices, harnesses, models or effort levels fall back to defaults;
a removed project becomes a custom folder using the saved path. Cancelled or failed creation and
edits to an existing manager do not replace these defaults. Like ordinary new-session choices,
this memory stays on the client and is not shared with the phone (which has no manager creation form).

成功创建经理后，本机记住上次的设备，并按设备保存目录/工作区、经理 harness/模型/强度、派线设置、
通知及自定义规则。下次新建时预填，名称和首个任务留空；入口明确指定的设备或工作区优先。
已移除的设备、harness、模型或强度退回默认值；工作区被删除后保留原目录，改为自定义目录。
取消、创建失败或编辑已有经理不覆盖新建偏好。与普通新建对话一样，记忆只保存在当前客户端；
手机目前没有新建经理表单。

Defaults: worklines inherit the manager's harness/model/effort, share its folder, and are reviewed and
merged by the manager; separate worktrees are off, maximum running worklines is **4**, desktop
notifications are on, and unanswered decisions wait indefinitely. Changing workline harness without
choosing a model or effort uses that harness's defaults. Workline concurrency includes the entire
subtree; approvals and background work also occupy slots.

“代码修改使用独立工作树”只设置默认做法，开、关均不限制经理按任务选择。
独立改动或需要单独分支时，经理可为该线指定工作树；需要共享目录时也可单独关闭。
工作线遵守简报中实际分配的目录或工作树，共享目录时仍需保留其他线的修改。

工作线执行期间仅在出现重大变更、重大发现，或需要经理决策才能继续时发送中途消息；其余结果在每回合结束时集中回报。

### 看板编号

看板的事项和决策标题前显示淡色编号（`I-n`、`D-n`）。说明中引用当前看板已有的编号时，
点击会切到对应页签并定位；已完成或暂缓事项会自动展开分组，决策会切到相应状态。
不存在的编号保留为普通文字。

### 访问权限

创建经理时，访问权限默认采用当前设备上该项目目录记住的权限，可在“运行环境”中修改。项目权限记录跨 harness、桌面和手机共享；不会自动改变已有经理或工作线的权限。

子会话默认继承直接父会话开始派出时的访问权限，也可显式选择更低档位。设备按“只读 < 项目内 < 完全访问”校验；目标 harness 不支持该档位或请求越权时拒绝创建，用户点击任务卡也不能绕过。可以更换 harness 或先由用户调整父会话权限，再开始任务。各 harness 的同名档位仍采用各自的工具和沙箱语义。

### Editing settings

Open a manager → title-bar **Settings**. The same three sections are tabs. You can change its name,
custom Manager settings, workline dispatch and notifications. Device, folder and the manager's own
harness/model/effort are read-only after creation; there is no first-task field. Saving dispatch or
notifications preserves custom instructions and does not change existing worklines. Invalid
concurrency selects the dispatch tab; a failed save keeps the form. Cancel discards edits. Ending and
ended managers are read-only. Instruction changes leave a “Manager settings updated” event in the
conversation. Creation, board answers and ending have their own event labels as well.

### Commands

Run `scripts/litch status` first; use real device and manager ids returned by these reads:

```sh
scripts/litch managers list local
scripts/litch managers get local <manager-id>
scripts/litch managers set local <manager-id> --rules 'Review changes and report unverified work.'
scripts/litch managers set local <manager-id> --notify on --max-running 4 --worktree on --merge manager
scripts/litch managers create local --cwd /path/to/project --harness pi --first-task 'Prepare a plan.'
scripts/litch open managers
```

`get` and `set` also accept a unique manager name. Use `scripts/litch managers --help` for all flags.
`--line-harness`, `--line-model` and `--line-effort` set workline defaults; an empty string resets an
override. Changing one field preserves others. Verify with `managers get` after saving. These are
configuration commands; answering a decision and ending a manager remain explicit board actions.

Creating a manager authorizes it to dispatch work autonomously, including during event-driven turns.
The command therefore always shows a desktop confirmation card before creating anything. It names
the manager, summarizes custom instructions, and shows the device, folder, manager/workline harness,
concurrency limit, worktree/merge choices and whether a first task was supplied. Declining creates
nothing. Even with a blank first task, creation still requires confirmation.

Reads and ordinary edits (name, custom instructions, notifications or lower concurrency) execute
directly. Increasing concurrency, changing the effective workline harness, moving merge responsibility
from the user to the manager, or disabling separate worktrees requires the same confirmation.
Harness permissions cannot be reliably ranked, so any effective workline-harness change asks.
Declining leaves settings unchanged. If settings changed while the card was open, the command fails
instead of overwriting them; read again and retry the intended change.

### Board and decisions

The manager page has the conversation beside **Overview**, **Manager items** and **Console**.
Console contains four kinds of issue: **Decisions**, **Suggestions**, **For you** and **Reports**.
Suggestions shows the reviewed pending count and lets you start, edit or dismiss cards from the
manager and its entire workline subtree. Unreviewed cards remain in their collapsed group.
Use **Hide board** to give the conversation the full area, and **Show board** to bring it back.
Drag the divider to resize the board, or focus it and use the arrow keys (Home/End reach its limits).
Board width and visibility are saved on this computer. The board stays between 360 and 900 pixels
while reserving at least 460 pixels for chat; smaller spaces compress the board without changing
the saved preference. Both chat width settings continue to apply inside the available space.
Narrow windows keep the Chat/Board switch, independently of desktop board visibility.
Opening Files covers the board; the info rail is hidden.
Overview shows progress and blocked items. Work lines are managed from the left conversation tree;
the duplicate board tab is hidden. Opening a work line shows its conversation; **Back to manager** returns. Clicking an item's decision id opens that decision,
including the appropriate answered or closed group. Recent activity uses Markdown and clickable
board references, with long reports collapsed to about five lines. Expand or collapse each report
independently. Source labels distinguish manager, user, system and work lines; selecting a line’s
source opens that conversation.

Items are the manager’s own progress records, owned by the manager or a work line. New add/update
operations reject an explicit user owner; existing user-owned items remain unchanged. For work that
needs the user to initiate it, the manager creates a suggestion with `litch_sessions.start` and
`initiation: "propose"`, including the complete brief. Clicking Start creates a line under that manager.
Already-authorized work still starts directly; questions requiring an answer remain decisions.
Only the user can perform some tasks, such as device checks, settings changes or login. These belong
in **For you** (`R-n`), not items or suggestion cards. Each has a Markdown description and a delivery
button defined by the manager (default **Mark as done**). Click the button, write a reply, or add a note with
delivery; all are local drafts until **Submit to manager**. Responses can be submitted in the same
batch as decision answers and questions. Text alone means Replied, not Delivered. Use **Edit reply**
after submission to correct it. A cancelled request cannot be submitted. The overview lists open
requests and replies that have not been delivered. R-n references navigate like I-n/D-n.
The manager creates requests with add (kind=request, revision=0, why), reads them with get, and uses
update or close with the current revision and a reason. It can maintain content or cancel requests,
but cannot submit a delivery on the user’s behalf; previous responses remain in history.

Items separate their title, status and owner from the explanation and supporting metadata.
Unverified points have a distinct label and accent stripe; waiting decisions, evidence and related
links appear below the explanation. Item explanations and unverified points, decision backgrounds
and option descriptions support Markdown: lists, emphasis, inline code and links. Existing I-n/D-n
references in prose and inline code still navigate to the matching board object. Explicit Markdown
links keep their stated targets; HTML is displayed as text and images are not loaded automatically.

Choose an option or write an answer. Answers are local drafts until **Submit to manager**; they do
not sync before submission. Submitting saves them to the device and asks the manager to handle them.
Successful drafts clear; failed ones remain. If a decision changed, review its new version before
confirming. **Clear drafts** clears local unsent answers, questions and For you responses. Closed decisions can be reopened.
Submitting answers keeps the current decision filter. In **Open**, answered cards leave the list;
focus continues to the next open decision in the displayed order, or the list header if none follows.
Answered decisions offer **Edit answer**. Closed decisions offer **Reopen** and, when a previous
answer exists, **Edit answer**. Submit the revised answer to notify the manager; the previous answer and closure remain in the change history. A revised closed decision
moves to Answered. Decisions under an ending or ended manager remain read-only.
You may also answer explicitly in the manager conversation. Recorded links and evidence do not
automatically become stale or verified; there is no automatic deadline/default-answer execution.

Every issue keeps its original content and actions at the top, followed by a chronological discussion.
The former Answer/Ask tabs are replaced by this single post. **Ask manager** is the default: save a
local question draft, combine it with answers, request deliveries and questions on other issues,
and use **Submit to manager**. Failed drafts remain. The manager uses `post_get` and `post_reply`
with the current revision to append a reply, edit the original post, or both. **Edited** opens prior
versions and the edit reason. A question does not grant permission to act or answer a decision.

Reports contain longer progress summaries, limitations or release notes. The manager publishes them
with `litch_manager.report` and edits them with `post_reply`. **Mark as read** clears the unread state;
opening the report does not. Editing its original content makes it unread again. Pending decisions,
open For you requests and reviewed pending suggestions count towards **N to handle**. Unread reports
are excluded from this total and its tooltip; only the Reports category shows their unread badge.
Desktop and phone use the same rule.

**Temporary chat** is an alternative on Claude Code, Codex, Pi and OpenCode. Each issue has its own
device-stored thread shared between clients. It may read files and the board, and update only that
issue's original content. For a decision it may also withdraw or expire it. Apart from Git commands
described below, it cannot modify files. It cannot change other objects, start lines or send messages.
Changes are recorded as coming from the temporary
conversation and reach the manager on its next turn. Questions use the manager's latest finished
turn; newer progress or an edited post rebuilds the context with earlier Q&A quoted. OpenCode uses
a light conversation with board context and the manager's thread ID for retrieving recent history.
`litch_sessions.list/read` can query that manager and its currently owned worklines, including valid
descendants across harnesses. Other managers, detached lines and unrelated sessions are denied even
when they share a folder or their IDs appear in references. List filters only narrow this scope;
`scope: mine` excludes the manager itself. Reads are bounded recent snapshots, not full tool logs.
Retired helpers cannot regain tool access after refresh or restart. Apart from Git commands below,
helpers must not use network tools or run tests. ACP and DSH offer only Ask manager.

Temporary helpers also have `litch_repository.run`: provide an absolute `directory` and an `argv`
array including the Git subcommand, for example `["log", "-5"]` or `["add", "--", "file.txt"]`.
The starting repository must belong to the manager or a currently owned workline; for an outer
non-Git folder, specify its repository subdirectory. Git runs from the device PATH through execFile,
without a shell. All Git subcommands and options are accepted, including writes and network access;
device environment, repository configuration, hooks and helpers apply normally. The directory check
controls the starting repository, not subsequent paths selected by Git arguments or helpers.
New Codex managers register these tools before forking; older parents retain their existing shell
and may lack newly added tools. Availability is determined by the current tool list. The existing
`log/show/diff/blame/status` methods remain shortcuts. Results include the exit code and combined
stdout/stderr, with a timestamp. Commands can change the repository.
Output is capped at 512 KiB, returned in 12,000-character pages. Supply only `cursor` for the next
page of the same snapshot; cursors are session-bound and expire after two minutes (eight retained
snapshots maximum); paging does not execute the command again. Large output is truncated and binary
output is marked. Commands allow two concurrent jobs, support cancellation and time out after
15 seconds. Select a repository with a working tree, not a bare repository.

This is a scoped session-tool boundary, not complete filesystem isolation. Claude Code and Pi also
block known raw session-storage paths and direct symbolic links to them; Pi temporary helpers do
not load user extensions. Unknown copies, hard links, recursive search links and path replacement
are not fully isolated. Codex retains its existing read-only, no-network shell, which can still read
raw session files or run commands that do not write; OpenCode's native file tools have no equivalent
per-path guard. Never use raw storage to bypass the session scope.

The **Links** area groups Sources, Derived and Related targets. It sits on the right of wide cards,
and collapses above the post in narrow layouts. Issue links open the corresponding post; manager
item links locate the item; worklines open their conversation. Files use the file viewer, while
branches and commits open a read-only repository preview. Manager items and worklines provide
reverse links to related issues. Existing blocking links, evidence and repository links are included.
The manager supplies source/related when creating objects, or uses `relate` later. References such
as #D-30, #I-12 and #P-3 become links; desktop hover and phone long press show title and status.

The phone supports all four issue kinds, questions, edit history and links, with per-card submission.
Phone drafts stay on the phone; desktop drafts support mixed submission across cards. User-created
issues, derived-event cards in the timeline and embedded quick decisions are not part of this version.

Submitting an answer includes the saved Q&A; long temporary conversations include a summary followed
by the full text. Wait for a running temporary reply before submitting. **Forward to manager** sends
the Q&A without answering the decision. Questions remain available on answered and closed decisions
while the manager is active. Restarting the device retains submitted questions and replies; temporary
helpers are recreated, while pending manager questions remain pending. Unsubmitted drafts stay local.

**End manager** asks for confirmation, makes chat and board read-only during final tasks, then moves
the manager into Ended when its final turn stops. Unfinished items remain recorded. The manager may
archive its own completed, landed or abandoned worklines without asking again; running or pinned
sessions remain. This does not authorize archiving unrelated sessions. There is no takeover action.

### Common questions

- **Where are the rules?** Put custom instructions in Settings → Basic information → Manager settings. Automatic
  operating rules come from Assignment and notifications. There is no separate editable Scope field.
- **Why no notification?** See the manager-notification rules in `appearance-and-preferences.md`.
- **Why did the sidebar switch?** Chat and Managers remember separate positions for this app run.
  Opening a session from a notification, link or activity switches to its owning view. See
  `sessions-and-projects.md` for revealing its row.
- **Cannot edit or create?** Connect the device and use a version supporting managers. The runtime
  must be ready, the working directory must exist, and concurrency must be a positive integer.

## Suggested tasks

A suggestion is a proposed task, not work already started and not a manager board item. Its card
offers **Start**, **Edit and start**, **Do it here**, and **Dismiss** (on the phone the card shows Start and
Do it here, the other two are under ⋯). The brief shows the background and task; expand it before starting. Missing choices inherit from the parent at the time you start it
(a different harness uses its own model/effort defaults). Worktree behavior and session authorization
are in `sessions-and-projects.md`.

### Where and how to use them

The desktop sidebar's **Suggestions** entry shows pending suggestions across devices with
a count, alongside Tasks, Appearance and Settings in the bottom row. Cards automatically form a
multi-column grid when space allows and return to one column in narrow windows. They show the
title, brief, source conversation, project/device and creation time, with the
same actions as the original card. Suggestions belonging to a manager, including its entire
workline subtree, are grouped into one summary card per manager with its name, pending count and
the latest suggestion's title and excerpt. Select it to open that manager's **Console → Suggestions**. Cards created by the manager are already reviewed. Cards from its workline subtree start in a
collapsed **Not reviewed by manager** group, with a matching label on every card. Expanding the group
still allows Start, edit-and-start or dismiss without manager approval. The manager is notified of
new line cards and uses `litch_manager.endorse` for useful work, or `dismiss` with a reason. Both
operations are limited to its own subtree and recorded on the device. A reviewed card moves into
the default list. Global manager summaries show the reviewed count and latest reviewed excerpt,
with a separate muted unreviewed count; sidebar counts exclude unreviewed cards. Ordinary suggestions
remain individual cards and are unaffected.
Instant “New session / Do it here” offers are not included. The side panel also lists suggestions
for the current session; the phone also exposes manager issues through Console.

Handled, withdrawn and expired suggestions leave the pending list; history stays in the source conversation.
Manager issues with discussions also remain under **Handled suggestions** in Console.
Offline devices keep the last snapshot, but actions need a connection. An archived source is marked
and opens as a read-only preview. Click the source conversation's name and arrow to open it;
**Back to list** or Escape returns from an archived preview to the originating global list or
manager board tab.
**Do it here** first restores it and its worktree; a failed restore
leaves the suggestion pending. Deleting the source withdraws its pending cards.

### Configuration and common questions

`scripts/litch open suggestions` opens the global list. Retention is per device, in Devices → the
device → Session orchestration → Suggestion retention. Its values, commands and expiration behavior
are in `device-settings.md`. Task cards can be switched per harness with
`scripts/litch tools set <device> --harness <id> --task-cards on|off`.

No suggestions visible: check the manager's Suggestions tab, source device's connection and task-card switch,
and whether the cards were handled or expired. Increasing retention does not restore expired cards.

### 看板答复与待办提示

桌面侧栏和手机经理目录里，经理行前面的记号只表示经理会话自己：回合在跑是“运行中”的记号，回合结束但它的后台命令还在跑是后台任务的呼吸记号（写“N 个后台任务正在运行”），与普通会话行相同；只有工作线在跑时不画记号，文字写“N 条工作线运行中”，各条工作线的记号在其子行上（手机不嵌套工作线）。文字依次为运行中、N 条工作线运行中、N 个后台任务正在运行、空闲。经理页和工作线页的输入框上方都有“N 个后台任务正在运行”（手机上是只写记号和个数的小胶囊），点开可看命令、用时并停止。
桌面侧栏经理一节和普通对话的父子树同一种画法：经理行与普通对话的顶层行左边对齐，行尾是 harness 标签和待处理或状态文字（设备看左边竖线的颜色，名字在标签的悬停提示里）；工作线默认收起，经理行下面一行“› N 个子会话”（与“最近 / 未读”里经理行的写法相同），点它或行首左边的小箭头展开，工作线比经理行缩进一级；展开与否记在这台电脑上，切换对话和经理不变。选中的是某条工作线时，所在经理自动展开。经理行的记号列有一个细框（人文外观是圆圈），与“未读 / 最近”里的经理主项相同。
“进行中”“已结束”两组的标题和对话一侧的“未读 / 最近”同一种画法：左边折叠记号，都能收起；“已结束”默认收起，定位到某位经理时自动展开所在的组。

The dot on a manager's row, in the desktop sidebar and in the phone's manager list, describes the
manager session itself, as on ordinary rows: a running turn, or the breathing background mark with "N background tasks running" when its turn has ended but a
background command continues. When only worklines are running, the row shows no dot and says "N work
lines running"; on desktop each workline shows its own mark underneath. The text reads Running, then
N work lines running, then N background tasks running, then Idle. When there is something to handle,
the desktop row shows "N to handle" instead; hovering it adds the status text ("4 to handle · 1 work
line running") and the breakdown by kind. In the Human skin the background mark is a double ring,
the running mark a single ring.

侧栏、窄窗口的“看板”和收起后的“展开看板”数字，合计待定决策、待做的“请你做”和经理已审核待开始建议；报告未读不计入。
已回复、已交付或已取消的请求不重复计入；已回复但尚未交付的请求仍保留在概览中。
“请你做”的默认交付按钮是“标记完成 / Mark as done”，经理可以指定其他文案。
提交后的回复按 Markdown 展示，并标明回复时间。

修改已提交的答案或请求回复时，可以点“取消修改”放弃当前修改，其他草稿不受影响；
取消答案修改也保留同一决策的追问草稿。追问入口旁的草稿标记表示有尚未提交的追问。
写了草稿还没提交，议题却在别处结束了（决策被经理记下答复、关闭、忽略或撤回，请你做在别处交付、回复或被取消，建议已处理），草稿不删，但不再计入底部“N 项草稿，尚未提交”和侧栏的草稿数，也不会随“提交给经理”发出。卡片上先是答复、关闭或忽略的记录，再写明草稿还在，可“查看草稿”或“丢弃”；丢弃要再点一次“确认丢弃”，丢了不能恢复。决策重新打开（含撤销忽略）且问题本身没改时，草稿自动恢复、可直接提交；问题改过的仍要先确认。手机相同。
原帖操作留在议题卡中，追问时间线通过卡片标题行的讨论入口打开，追问方式可切换，记录标明发言人。
动态时间沿用消息时间格式，非当天显示星期或日期，悬停查看完整日期与时刻。

看板挤压对话时，输入框的模型、权限等选项按整项换行，避免按钮文字缩成单字。
矮窗口中长草稿在输入框内滚动，为请求卡片按钮和终端保留空间。
全局建议汇总卡的已审核数量与未审核数量并列在标题行；未审核卡的标签只占文字所需宽度。

侧栏、收起入口及窄窗口中的合计统一标为“N 待处理 / N to handle”，悬停可查看三类待处理议题的数量明细，数量为零的部分省略。收起入口的按钮与数量标签提供相同明细。侧栏同时保留待处理数与草稿数；看板内“待定”仍只表示决策。
已答复决策先展示答案，再提供“修改答案”；答复与核对时间沿用消息时间格式。
提交一条或多条答复后保留当前决策分栏。在“待定”栏，答复成功的卡片立即移出，无需等待看板重新加载；焦点接续当前显示顺序中的下一条待定决策，没有下一条时回到列表头，不自动切到“已答复”。提交失败时保留待定状态和草稿，并显示失败原因。手机同样在提交成功后立即显示已答状态。
临时追问的回复标为“助手（临时对话）”；请求卡的回复行仅显示“你的回复”和时间，状态保留在卡片头部。

### 控制台与议题（0.28）

经理看板的“事项”改名为“经理事项 / Manager items”，仍只记录经理与工作线进展。
需要用户关注的内容统一进入“控制台 / Console”，每一条称为“议题 / issue”，分为决策、建议、请你做和报告。
建议仍可开始、编辑后开始或忽略；工作线建议仍先归入默认收起的未审核组。请你做仍支持交付与文字回复。
报告承载较长的阶段说明、范围限制或版本小结，阅读后可点“标记已阅”。未阅报告不计入待处理，只在报告分类显示未读徽标；原帖编辑后重新未阅。

每类议题都可追问。原帖和操作区始终在上方，问答记录在下方按时间排列；不再切换“回答/追问”两套视图。
默认交给经理主对话，也可选受限的临时对话（支持该能力的 harness）；临时助手可更新当前原帖，但不能改其他议题或开工作线。除下述 Git 命令外，不能修改文件。

临时助手可通过 `litch_sessions.list/read` 读取当前经理主会话及归属仍有效的工作线，含跨引擎后代。其他经理、脱离归属的工作线和无关会话均拒绝，同目录、已知编号或引用不会授权；筛选参数只能缩小范围，`scope: mine` 不含经理自身。结果是有限的最近回合快照，不含完整工具过程。OpenCode 轻会话收到经理会话编号后可补读背景。已退役的助手不能在刷新或重启后重新取得权限。除下述 Git 命令外，不得使用联网工具；不得运行测试。ACP、DSH 本轮不支持。

临时助手另有 `litch_repository.run`：传仓库绝对路径 `directory` 和含子命令的 `argv` 数组，例如 `["log", "-5"]` 或 `["add", "--", "file.txt"]`。起始仓库必须在经理或有效工作线目录内；外层不是 Git 目录时指定其仓库子目录。设备通过 execFile 直接执行 PATH 上的 Git，不经 shell，接受全部 Git 子命令和参数，包括写入和联网；设备环境、仓库配置、钩子和辅助程序照常生效。目录检查限定起始仓库，不隔离 Git 参数或辅助程序随后选择的其他路径。新建 Codex 经理预登记工具，临时分叉继承；旧父会话保留现有 shell，可能没有新增工具，以当前工具表为准。原 `log/show/diff/blame/status` 保留为快捷入口。结果含退出码、合并的标准输出／错误输出及时间，命令可以改变仓库。

输出最多 512 KiB，每页 12000 字符；续页只传 `cursor`，不重新执行命令。游标绑定调用会话、两分钟过期，最多保留八份快照。过长输出截断，二进制输出标记；并发上限 2、支持取消、超时 15 秒。选择有工作目录的仓库，不支持裸库。

上述范围由会话工具强制执行，不代表文件系统完全隔离。Claude Code、Pi 另拦截已知原始会话存储路径及直接指向它们的符号链接；Pi 临时助手不加载用户扩展。未知副本、硬链接、递归搜索中的链接和检查后的路径替换仍未完整隔离。Codex 保留现有只读禁网 shell，仍可能读取原始记录或运行不写文件的命令；OpenCode 原生文件工具没有同等的逐路径闸。不得用直接翻原始存储绕过会话范围。
经理可只编辑原帖、只回复或两者同时做；“已编辑”可展开旧版本、编辑时间与原因。
控制台合计待定决策、待做请你做和经理已审核待开始建议；悬停也只显示这三类数量。手机采用相同口径。

手机首页有“经理”入口（第二行是待处理合计），经理按设备分组、先进行中后已结束；首页「最近」里经理那一行带“经理”小标签，它的工作线并在这一行里。经理行的记号和文字与桌面侧栏相同（见“看板答复与待办提示”）；有待处理时行尾是等待色的计数胶囊，读屏念整行时带上“N 待处理”。

进入经理是一个工作台：标题是经理名，副标题是状态（运行中、N 条工作线运行中、空闲等），下面一排页签“对话 · 控制台 · 工作线 · 概览”，默认落在对话。对话就是经理会话本身，和普通会话页一样能发消息、处理审批和工作线的审批；切到别的页签再回来，滚动位置和没发的草稿都在，只有对话页签显示着才把经理的回复标为已读。页签上的记号：对话在经理回合在跑或等人时有运行记号，有新回复时有未读点；控制台是等待色的待处理数（口径同桌面）；工作线是在跑的条数，有工作线等人或出错时换成等待记号。经理在对话里写到的看板编号（D-n、R-n、P-n、I-n）可以点：经理事项到概览并展开那一项，其他议题从底部拉起半屏议题卡，就在里面作答、忽略或交付，交上去后议题卡自动关上、回到对话原处；卡上的 ↗ 或标题是“在控制台打开”，点讨论记号也会到控制台并打开那条讨论。右上角“⋯”里是经理会话的建议任务、后台任务、用量和压缩上下文。

“工作线”页签列出经理开的每条线：记号和标题、最近动静的时间，第二行是状态和分支（领先几个提交、是否已合并），没有分支时写最近回报的第一句，行尾等待色的“没验 N”是回报里没验证的项数。等人、出错的排最前，然后是运行中、只剩后台任务、空闲；已合并的收在最下面“已结束 N”，默认收起。点一行进这条线的会话页；工作线会话页的副标题前半段是“↰ 经理名”，点了回到经理的工作线页签（从经理页进来时直接退回去，从链接或通知直达时新开经理页），“⋯”里也有“回到经理”和这条线的相关议题。

“概览”与桌面一致：现状、待用户决策与已完成两个数（分别点进控制台的决策和展开经理事项）、受阻事项（第二行写“等待决策 #D-n”，编号可点）、请你做和最近动态；长动态点“展开全文”看完整内容；最下面“经理事项 N”一节默认收起，展开后每项一行，点开看理由和关联。控制台在窄屏上把排序收成一个图标，与类别同一行。手机作答决策时先点选一项（单选），再点“提交给经理”（没选也没写时按钮下方写明“先选一项或写补充说明”，决策没有选项时写“先写补充说明”）；选中项和补充文字都存为本机草稿，离开再回来还在，卡片状态标“草稿”。修改答案时上方照样显示原来的答复，原来选的那一项已选中。控制台可阅读和操作四类议题，并提交经理或临时追问。
手机沿用建议的开始/编辑/忽略，支持请求交付/文字回复、决策答复、报告已阅和讨论历史；创建经理、派活设置及完整经理事项看板仍在桌面。
用户主动新建议题尚未开放。手机也提供只读经理事项供关联定位；目前按卡提交，桌面支持跨卡混合提交。

议题关联栏按来源、派生、相关分组（只有一组时不写组名），宽卡在右侧，窄卡在顶部折叠。编号链接可跳到议题或经理事项，桌面悬停显示标题与状态；手机长按可查看。工作线打开会话，文件进入文件查看器，分支与提交打开只读仓库内容。经理事项和工作线也能回到相关议题。经理创建对象时可填写 source/related，之后可用 relate 补充。已有的阻塞关系、依据和链接也显示在关联栏。
桌面经理模式的追问存为本地草稿，可与答案和交付同批提交；临时对话立即发起。问答、旧版本与关联存储在设备上，跨客户端可读；已处理建议的讨论保留在“已处理建议”分组。


### 议题显示与操作

决策状态使用文字筛选（○ 待定、✓ 已答复、⊘ 已关闭），与控制台分类分开。追问从讨论图标打开，输入框位于桌面底部分屏或手机底部抽屉；已有临时问答的帖子默认继续临时会话，可切回经理。桌面追问按 Enter 发送、Shift+Enter 换行，输入法组词时不发送；决策的答复文字框仍按 Enter 换行。经理追问可单独发送，未发送的追问仍随答复批量提交。编号统一显示 #X-n；桌面鼠标悬停或键盘聚焦会显示标题、状态卡片，手机长按预览。

关联按卡片宽度切换：达到 520px 放在右侧，否则顶部折叠。每项显示类型和标题，工作线不显示内部编号。手机的经理事项在控制台之外；已答复和已关闭默认不显示输入区；有旧答案的可点“修改答案”，从未答复的关闭决策先“重新打开”。请你做的交付按钮为唯一主操作，只有输入文字才出现次要提交按钮；已交付或已回复后通过“修改回复”再编辑。

Decision status filters are lightweight text links beneath the issue categories. The discussion icon opens questions in the desktop bottom pane or phone drawer. Existing temporary discussions default to that conversation, with a control to ask the manager instead. On desktop, Enter sends a question and Shift+Enter adds a newline; IME composition does not submit. Decision answer text still uses Enter for newlines. Questions to the manager can be sent separately; unsent drafts can still be submitted with answers.
Hover or keyboard-focus an object reference for its title and status. Links show their type and title
on separate rows; wide cards put them on the right. On phone, Manager items is separate from Console.
Answered and closed decisions show their result. Edit answer is available
when an answer exists; closed decisions can be reopened. For you cards use the delivery action as their only primary button; a secondary submit action
appears only when a text reply exists. Submitted replies can be edited explicitly.


手机与桌面的关闭决策规则一致：从未答复的关闭决策只显示“重新打开”；有旧答案的保留“修改答案”和“重新打开”。已答复决策只提供修改答案。手机追问框的读屏名称与当前模式的占位相同，关联标题使用链接色和下划线提示可点。
Closed decisions without an answer offer Reopen on both desktop and phone. Those with a previous
answer retain Edit answer as well; answered decisions only offer editing. Phone question inputs
use the same accessible name and placeholder. Related targets use link color and underlining.

### 排序与已答复决策

控制台所有列表默认最新优先（按议题发起时间），可切换为“最早优先”或“待处理优先”（待定决策、待做请你做、已审核待开始建议、未阅报告排在前面，同组内仍按最新）。桌面的排序在列表头右端：决策在“待定 / 已答复 / 已关闭”那一行，因为已按状态分开，只有最新、最早两项；其他三类在列表上方一行。手机在类别那一行的末尾，点开是单选列表。选择保存在本机，所有经理、所有类别共用；桌面和手机各记各的。

已答复的决策中，问题和答案分开：答案单独一块，写“你的答复”（经理从对话里记下的写“你在对话中的答复”）和时间，内容是选中的选项和答复文字。没选中的选项收在“其他选项 N”里，点开可看。已关闭的决策另有一块“已关闭 · 关闭者”写原因；重新打开的决策照常展开所有选项供作答，上方保留“上次的答复”，再下面是收起的“上次关闭 · 关闭者”，点开可看当初关闭的原因。桌面和手机相同。

### 忽略决策

不想答的待定决策可以点“忽略”，理由选填。忽略后它不计入待处理，不再提醒，也不唤醒经理；经理在下一个回合会得知你忽略了哪一项（经理正在运行时直接插入）。桌面把忽略的决策放在“已忽略”一栏，手机在列表里标“已忽略”并默认收起，点“展开详情”可看理由。手机上点“忽略”后作答区先收起，只留确认忽略那一块。点“撤销忽略”回到待定。

“忽略”是你不处理这个问题；“已关闭”是经理认为问题不在了（失效或撤回）。经理不能直接把忽略的决策记成已答复，只能在情况有变、确实需要你再看时写明理由重新打开；这时卡片上多一块默认展开的“经理重新打开”写着理由（可收起）；“上次关闭”仍默认收起。

### 设备服务比应用旧

经理所在设备的设备服务比应用旧时（常见于没升级的远程设备），控制台顶上写明哪些功能不可用，并提示在设备详情里升级设备服务。不可用的入口直接禁用，旁边写“设备服务版本较旧，升级后可用”：决策追问、请你做的交付与回复、议题追问、报告已阅、引用预览、忽略决策。决策答复照常可以提交；已写好的追问和回复草稿留着，升级后再提交。别的操作遇到设备不认识的请求时，同样提示去设备详情升级设备服务。手机相同。

Console lists default to **Newest first** by issue creation time. Switch to **Oldest first** or
**To handle first** (open decisions, open For you requests, reviewed suggestions and unread reports
first, newest within each group). On desktop the sort control sits at the right of the list header:
for decisions it is on the Open / Answered / Closed row and offers only Newest and Oldest, since the
states are already separated; the other kinds have a thin header row above the list. On phone it is
at the end of the category row and opens a single-choice list. The choice is stored per client and
shared by all managers and categories.

Answered decisions keep the question and the answer apart: **Your answer** is a separate block with
the time, the chosen option and the text (**Your answer in the conversation** when the manager
recorded it from chat). Unchosen options are collapsed under **Other options**. Closed decisions add
a **Closed** block with who closed it and why; a reopened decision shows all options for answering,
with the **Previous answer** above them and a collapsed **Previously closed** block that keeps the
reason it was closed. Desktop and phone behave the same. On phone, answering a decision means
choosing one option and then tapping **Submit to manager** (until you choose or write something, a
note below the button says so); the chosen option and the text are kept as local drafts if you
leave, and the card is marked **Draft**. When editing an answer, the previous answer stays visible and its
option is preselected.

If an issue ends elsewhere while you still have an unsent draft (the decision is answered, closed,
ignored or withdrawn; the request is delivered, replied to or cancelled elsewhere; the suggestion is
handled), the draft is kept but no longer counts toward the unsent bar or the sidebar draft count and
is not sent with **Submit to manager**. After the answer, closure or ignore record, the card says the draft is still
there, with **View draft** and **Discard**; discarding asks once more (**Discard draft**) because it
cannot be undone. If the decision is reopened (including undoing an ignore) and the question itself did not
change, the draft comes back and can be submitted directly. Phone behaves the same.

**Ignore** an open decision you do not want to answer; a reason is optional. Ignored decisions no
longer count as pending, send no reminders and do not wake the manager; the manager learns about it
in its next turn (or immediately if it is running). Desktop lists them under **Ignored**; on phone
they are labeled **Ignored** and collapsed until you tap **Show details**; tapping **Ignore** on
phone hides the answer area until you confirm or cancel. **Undo ignore** makes the decision open
again. Ignoring means you are not handling the question; **Closed** means the manager decided the
question no longer applies. The manager cannot record an answer for an ignored decision; it can only
reopen it with a reason when things have changed, which then shows as a **Reopened by the manager**
block, expanded by default; **Previously closed** stays collapsed.

When the device service on the manager's device is older than the app (typically a remote device
that has not been upgraded), the console says which features are unavailable and asks you to upgrade
the device service in the device details. The affected controls are disabled with the note
**Available after upgrading the device service**: decision follow-ups, delivering or replying to
requests, follow-ups on issues, marking reports as read, reference previews and ignoring decisions.
Decision answers can still be submitted; follow-up and reply drafts are kept for after the upgrade.
Any other request the device does not recognize shows the same upgrade advice. Phone behaves the
same.

### 看板阅读与新版本草稿

桌面看板跟随“对话区字号”，包括概览、控制台、正文和追问。帖子标题旁的箭头可收起正文，保留标题、首行摘要和状态；已处理的决策、请你做、已阅报告和历史建议默认收起。开合选择在当前客户端会话中按帖子记住。帖子变更历史在展开时显示正文。

控制台卡片标题行的讨论图标显示回复数；当前客户端内新到的回复、等待回复或未发出的追问带小点。点开后，全部问答按时间排在看板底部分屏，卡片列表独立滚动，当前卡片有选中记号。一次只打开一条讨论，换帖子会替换内容。拖动分隔条调整高度并保存在本机；聚焦分隔条后也可用上下方向键调整。点标题回到卡片，点关闭图标或按 Esc 关闭，未发出的草稿保留。窄窗口仍为卡片列表留出空间。

手机使用半屏底部抽屉，向上拖把手或点展开图标可到全屏，向下拖可收回半屏、再拖关闭；点标题关闭并回到卡片。两端的讨论默认展开，也可手动收起并记住。追问默认发到已有临时会话，没有临时问答时发给经理，输入框旁可切换。原来的草稿计数、随答复提交和已结束议题的草稿规则不变。全局建议窗口中的内嵌讨论仍在超过 1200 字符时默认收起。

决策更新后，仅选了选项的旧草稿会清除选择，标题旁提示“已更新，原选项已清除”，不再计入待提交；没有填写的草稿静默清空。有自由文字（包括追问）时保留原文，先确认新版本后再提交。已结束的议题继续保留草稿查看和丢弃入口。手机采用相同规则。推荐选项保留“推荐”标记，直接点选项选择。

The desktop board follows the conversation text size, including overview, console, posts and questions. A chevron beside each post title collapses its body while keeping the title, first-line summary and status. Handled decisions and requests, read reports and historical suggestions start collapsed. Each choice is remembered for the current client session.

The discussion icon in each console card header shows its reply count. A dot indicates a new reply received in this client session, a pending reply or an unsent question. Open it to read all questions and answers chronologically in a pane below the board. The card list scrolls independently and highlights the selected card. Opening another post replaces the single pane. Drag its separator to resize it; the height is saved locally. The focused separator also accepts the Up and Down keys. Select the title to return to the card, or close with the icon or Esc. Drafts survive closing, and narrow windows retain space for the card list.

On phone, discussions open in a half-screen bottom drawer. Drag the handle up or use the expand icon for full screen; drag down to return to half screen, then again to close. Selecting the title closes the drawer and returns to its card. Discussions start expanded on both platforms and remember manual collapse choices. Follow-ups default to the existing temporary conversation, or to the manager when there is none; switch targets beside the input. Draft counts, submission with answers and ended-issue draft rules are unchanged. Inline discussions in the global suggestions window still start collapsed above 1,200 characters.

When a decision changes, an old draft containing only an option selection is cleared with a compact hint beside the title and no longer counts as pending. Empty drafts clear silently. Drafts containing free text, including questions, retain their text and require confirmation of the new version before submission. Ended issues retain their existing draft review/discard flow. The phone follows the same rules. Recommended options retain their marker; select the option directly.

新建经理入口没有明确指定项目时，项目与目录一起恢复上次保存值；进入表单后仍可手动选择“无项目”。

新建经理每一步在进入下一步前校验。工作目录在目标设备上检查，显示解析后的设备路径；支持绝对路径、`~` 和 `~/项目目录`，远程设备使用远程设备自己的主目录。目录不存在、路径指向文件或无法访问时，提示原始输入、设备路径和修正方法。模型列表尚未加载时不能继续；型号和强度按目标 harness 的列表核对，创建时设备再次核验。名称、经理设定和首个任务可留空，最大并行工作线数必须为正安全整数。

创建或保存失败时，表单会定位到有问题的字段；前一步的错误会自动返回对应步骤并保留草稿。设备服务不认识操作时明确提示版本较旧；旧设备没有返回具体校验原因时，保留已知字段并提示升级设备服务，不能据此判断设置本身无效。
