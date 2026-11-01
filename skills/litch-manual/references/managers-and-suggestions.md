# Managers and suggested tasks

## Managers

A manager is a conversation that coordinates worklines (sub-sessions), maintains decisions and items
on a board stored on its device, and reports progress. Repository changes remain the evidence for
what has landed. Managers and their worklines appear in the desktop sidebar's **Managers** view;
ordinary sessions appear in **Chat**. The phone can read manager events and workline conversations,
but has no manager board or manager settings page.

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

The manager page has the conversation beside **Overview**, **Decisions**, **Items**, **For you**
and **Suggestions**. The Suggestions tab shows the pending count and lets you start, edit or dismiss
suggestions from this manager and its entire workline subtree directly on the board.
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
button defined by the manager (default **Done**). Click the button, write a reply, or add a note with
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
Answered and closed decisions also offer **Edit answer**. Submit the revised answer to notify the
manager; the previous answer and closure remain in the change history. A revised closed decision
moves to Answered. Decisions under an ending or ended manager remain read-only.
You may also answer explicitly in the manager conversation. Recorded links and evidence do not
automatically become stale or verified; there is no automatic deadline/default-answer execution.

Every decision has **Answer** and **Ask** tabs, starting on Answer. In Ask, **Ask manager** is the
default: type a question as a local draft, combine drafts across decisions and use **Submit to manager**
for answers and questions together. Failed or conflicting drafts remain for review. Questions do not
answer the decision. The manager responds in its main conversation and saves each reply back to the
question log with `litch_manager.reply`, using the decision id, current revision and reply text.
Replies and newly submitted questions advance the revision to protect against stale responses.

**Temporary chat** is an alternative on Claude Code, Codex, Pi and OpenCode. Each decision has its
own thread, stored on the device and shared between windows. It can read files and the board, and
update only that decision’s title, background, options or recommendation, or close it as withdrawn
or expired. It cannot modify files, other board objects or fields, start lines, or send messages.
Changes are recorded as coming from the question conversation and reach the manager on its next turn.
A running manager is not interrupted: questions use its latest finished turn. If the manager advances
or the decision changes, the next question uses fresh context with the earlier Q&A quoted.
OpenCode uses a light conversation with board context. ACP and DSH offer only Ask manager.

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
offers **Start**, **Edit and start**, **Do it here**, and **Dismiss**. The brief shows the background and
task; expand it before starting. Missing choices inherit from the parent at the time you start it
(a different harness uses its own model/effort defaults). Worktree behavior and session authorization
are in `sessions-and-projects.md`.

### Where and how to use them

The desktop sidebar's **Suggestions** entry shows pending suggestions across devices with
a count, alongside Tasks, Appearance and Settings in the bottom row. Cards automatically form a
multi-column grid when space allows and return to one column in narrow windows. They show the
title, brief, source conversation, project/device and creation time, with the
same actions as the original card. Suggestions belonging to a manager, including its entire
workline subtree, are grouped into one summary card per manager with its name, pending count and
the latest suggestion's title and excerpt. Select it to open that manager's **Suggestions** board
tab. Cards created by the manager are already reviewed. Cards from its workline subtree start in a
collapsed **Not reviewed by manager** group, with a matching label on every card. Expanding the group
still allows Start, edit-and-start or dismiss without manager approval. The manager is notified of
new line cards and uses `litch_manager.endorse` for useful work, or `dismiss` with a reason. Both
operations are limited to its own subtree and recorded on the device. A reviewed card moves into
the default list. Global manager summaries show the reviewed count and latest reviewed excerpt,
with a separate muted unreviewed count; sidebar counts exclude unreviewed cards. Ordinary suggestions
remain individual cards and are unaffected.
Instant “New session / Do it here” offers are not included. The side panel also lists suggestions
for the current session; the phone has only the per-session list.

Handled, withdrawn and expired suggestions leave the list; history stays in the source conversation.
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

侧栏、窄窗口的“看板”和收起后的“展开看板”数字，合计待定决策与待做的“请你做”。
已回复、已交付或已取消的请求不重复计入；已回复但尚未交付的请求仍保留在概览中。
“请你做”的默认交付按钮是“标记完成 / Mark as done”，经理可以指定其他文案。
提交后的回复按 Markdown 展示，并标明回复时间。

修改已提交的答案或请求回复时，可以点“取消修改”放弃当前修改，其他草稿不受影响；
取消答案修改也保留同一决策的追问草稿。“追问”页签上的圆点表示有尚未提交的追问。
“回答 / 追问”支持方向键和 Home、End 切换；追问方式使用次级文字切换，记录标明发言人。
动态时间沿用消息时间格式，非当天显示星期或日期，悬停查看完整日期与时刻。

看板挤压对话时，输入框的模型、权限等选项按整项换行，避免按钮文字缩成单字。
全局建议汇总卡的已审核数量与未审核数量并列在标题行；未审核卡的标签只占文字所需宽度。
