# Managers and suggested tasks

## Managers

### issue 与评论 / Issues and comments

issue 使用经理内独立递增的 `X-n`，用于双方共同维护的长期讨论。决策 `D-n`、请你做 `R-n`、
报告 `P-n` 和建议 `S-…` 保持原编号；`I-n` 仍是经理内部事项。用户和经理各自只能编辑自己的评论，旧正文保留审计。issue 支持开放、进行中、受阻、
已解决、已关闭五种状态。状态与跟进开关独立，评论不会自动回答决策、交付请求或标记报告已阅。

用户新建或评论会自动通知经理：运行时插话，空闲时唤醒。暂停跟进时评论照存但不唤醒，恢复后
不回放暂停期间的评论。已结束经理可留存评论和事件，但不会重新启动。经理回复形成持久未读，
客户端重连后仍可查看；报告的已阅状态独立保留。设备须支持 `litchManagerIssues`，旧设备不提供
issue 写入。已有经理需要重置会话才能取得新增 `issue_create/get/comment/update/follow` 工具。

Issues use independent per-manager `X-n` numbers for shared, ongoing discussions. Decisions,
requests, reports and suggestions retain their D/R/P/S identifiers; I-n remains the manager's notebook.
X-n states are open, in progress, blocked, resolved and closed. Follow-up is independent of status.
Comments do not answer decisions, deliver requests or mark reports read. User creation and comments
automatically reach a running manager or wake an idle one. Pausing follow-up saves comments without
waking the manager; resuming does not replay them. Ended managers retain comments without restarting.
Manager replies remain unread across reconnects until seen. Reset an existing manager session to load
the new issue tools; devices must advertise `litchManagerIssues` to support these actions.

#### 控制台里的 issue 列表 / Issues in Console

支持 issue 的设备上，控制台页签为决策、建议、请你做、报告、issue，默认打开决策。
issue 页签默认只选类型“issue”（X-n），类型过滤支持多选和全选。决策、建议、请求和报告只有
开启过讨论或已经有评论、问答时，才会出现在这个页签；关闭讨论抽屉后仍保留。其他四个页签列出各自类别的条目。
设备服务尚不支持讨论过滤时，issue 页签只列 X-n，其他页签和讨论仍可照常使用。
每个页签分别记住自己的过滤条件和排序。issue 页签还可按状态、创建者、未读和跟进筛选，支持新建。
首次进入决策、请你做和 issue 页签默认“开放”；建议默认“待开始”（经理已推荐，不含待审核），报告默认“未读”。
对应状态放在过滤选项第一位，“全部”在最后；用户选过的条件不重置，概览数字带入的条件优先。
点击对话中的 D-n、R-n、P-n、S- 或 X-n 链接，会切到目标实际所属的类别和状态，保留排序，清除作者、未读和跟进等可能隐藏目标的过滤。目标置于当前列表顶部并展开，收起后仍保留；手动改过滤或打开其他条目时结束定位。
展开 X-n 可查看原帖、状态与跟进、关联、评论及输入框；其他类型保留快速处理按钮，可打开底部讨论或完整讨论页。
完整讨论页和讨论抽屉保留对应的处理入口：决策提交答复（可只选选项）、请你做交付或回复、建议开始或编辑后开始、报告标为已阅。评论不会代替这些操作。
依据与关联默认只显示标题和数量，点击展开；重新进入页面时恢复收起。活动只显示经理对正文、选项、推荐等内容和状态的实质更新，不重复显示用户答复、关联或依据变更、讨论开关；没有有效时间的活动不显示，历史数据仍保留。
概览的 issue 摘要仍统计 X-n 的未完成、等我看、跟进已暂停；点击数字会回到 issue 页签，恢复只选 issue 类型并套用相应过滤。
手机的类别胶囊和过滤抽屉采用相同规则。设备不支持 issue 时仍显示原来的四类控制台，并提示升级设备服务。
手机控制台的状态过滤行始终显示，可直接切换开放、已答复或全部等状态；更多条件仍在过滤抽屉。列表读取中、无匹配条目或读取失败时显示对应提示，失败可重试。切换类别或从对话返回时，按各自条件恢复阅读位置。

The Console tabs are Decisions, Suggestions, For you, Reports and Issues. Decisions remains the default.
The Issues tab initially selects only the Issue type (X-n). Its type filter supports multiple selections or all types.
Decisions, suggestions, requests and reports appear here only after a discussion has been opened or has comments or questions;
closing the discussion does not remove them. Their dedicated tabs list entries of that type.
If the device service does not support discussion filtering yet, Issues lists only X-n; other tabs and discussions still work.
Each tab remembers its own filters and sorting. Issues also offers status, author, unread and follow-up filters, plus New issue.
On first entry, Decisions, For you and Issues default to Open; Suggestions to Ready to start (endorsed by the manager, excluding those awaiting review), and Reports to Unread.
That filter comes first and All comes last. Saved choices remain unchanged; filters from Overview counts take precedence.
Conversation links to D-n, R-n, P-n, S- or X-n select the target's actual category and status, preserve sorting, and clear author, unread and follow-up filters that could hide it. The target opens at the top of the list and remains after collapsing. Changing filters or opening another entry ends this placement.
X-n opens its description, status, follow-up, links and comments; other types keep their quick actions and can open a discussion drawer or full page.
Full discussions and drawers retain the relevant action: submit a decision answer (an option alone is enough), deliver or reply to a request, start or edit a suggestion, and mark a report as read. Comments do not replace these actions.
Evidence and links initially show only their title and count. Click to expand; reopening the page collapses them again. Activity shows substantive manager edits and status changes, omitting duplicate user responses, link or evidence changes, discussion toggles, and entries without a valid timestamp. The underlying history is retained.
Overview counts still cover X-n issues. Clicking a count selects the Issues tab and the Issue type with the corresponding filter.
The phone uses the same rules in its category pills and filter drawer. Older devices keep the four-category Console and show an upgrade notice.
The phone keeps status filters visible above the list. Loading, empty results and failures have explicit messages, with Retry for failures. Switching categories or returning from chat restores the reading position for the selected filters.

用户要求过或已批准的范围内任务，经理直接开工作线；经理自行发现、用户尚未要求或批准的工作
（如回报中顺带发现的问题、审查改进点、可选后续工作），会附完整简报放到「建议」页，由用户决定是否开始。
这些工作不会只留在待排事项中；已有对应事项会标为暂缓并注明建议卡。范围外工作先提看板决策。
关闭任务卡时，自行发现的工作改记看板决策或事项，需要批准的仍先等用户答复。

Managers directly start in-scope work you requested or approved. Self-discovered work you have not
requested or approved, such as incidental findings, review improvements or optional follow-ups,
appears in Suggestions with a full brief for you to start. It is not left only in the backlog;
any corresponding open item is deferred with a reference to the card. Out-of-scope work first
requires a board decision. With task cards disabled, findings go into board decisions or items,
and work requiring approval waits for your answer.

工作线也可以直接为任务外的新发现提建议卡，不必先请经理转提。卡片出现在经理的建议页，经理可推荐，
也可写明理由忽略无用或重复的卡片。任意层级工作线提卡成功后，Litch 设备服务自动通知经理，不依赖模型发送消息或工作线结束回合。短时间连发的卡片合并通知，包含短号、标题、背景首句和来源；经理先对照已合入提交及事项查重，再推荐或附理由撤掉。运行中的经理直接收到插话；空闲经理按唤醒上限、用户停止、后台任务等保护规则唤醒。通知独立持久保存，投递失败或经理重置期间留队，成功后移除；发送前再次检查卡片，已审核、已开始、已撤回或已过期的卡不再提醒，整批失效时不会唤醒经理。已有未审核旧卡不补发。工作线仍须完成已授权任务，不能把未完成部分改成建议。

Worklines can directly propose out-of-assignment findings. Their cards appear in the manager's
Suggestions tab for endorsement or dismissal with a reason; the manager does not recreate them.
After a workline at any depth proposes a card, the device automatically notifies the manager without a model sending a message or ending its turn. Cards created in a short burst are batched with their short IDs, titles, first background sentences and sources. The manager checks landed commits and items for duplicates, then endorses or dismisses with a reason. Running managers receive an in-turn message; idle managers follow the existing wake budget, user-stop and background-task protections. Notifications persist separately through failed delivery and manager resets, and are removed after delivery or when no review is needed. Before sending, Litch rechecks each card: reviewed, starting, started, withdrawn or expired cards no longer trigger a reminder. An empty batch does not wake the manager. Existing unreviewed cards are not backfilled. Assigned work still
belongs to the workline and must not be replaced by a suggestion.

工作线建议在经理“建议”页默认显示，待审核卡带有标记，来源会话保留在卡片上。无论从看板还是工作线对话点“开始”，新会话都是经理的直属工作线，与来源线平级，计入经理并发限制；首条简报包含来源。来源线未归档时，分叉仍使用来源线的上下文和权限。来源线已归档时，“开始”和“编辑后开始”只用卡片背景与任务新建经理直属工作线，默认配置取当前经理，卡片和编辑覆盖值仍优先；不恢复来源，也不继承分叉历史。“在来源会话里做”则先恢复来源，再向原会话发送任务。已开始的旧嵌套会话不迁移，普通会话的建议行为不变。

Workline suggestions appear by default in the manager’s Suggestions page, labeled when awaiting review and retaining their source session. Starting from either the board or the source conversation creates a direct workline of the manager, alongside the source line and subject to the manager’s concurrency limit. Its brief identifies the source; forks retain the context and permissions of an unarchived source. If the source is archived, Start and Edit then start create a fresh direct workline using the card’s background and task, with defaults from the current manager and any card or edited overrides taking priority. They do not restore the source or inherit its fork history. Do in source restores the source before sending the task there. Existing nested sessions and ordinary-session suggestions are unchanged.

经理自己提出的建议卡提供“开始”（创建工作线）、“编辑后开始”（修改简报后创建工作线）和“忽略”，不提供“在这里做”。普通会话和工作线提出的建议保持原有操作。旧客户端请求在经理会话执行建议时，设备会拒绝并提示开始工作线或忽略。

Suggestions proposed by a manager offer **Start** (create a workline), **Edit before starting** (revise the brief and create a workline), and **Dismiss**, without **Do it here**. Suggestions from ordinary sessions and worklines keep their usual actions. Requests from older clients to run a manager’s suggestion in place are rejected with guidance to start a workline or dismiss it.

经理负责维护「现状」，固定按顺序使用 `### 正在做`、`### 等你`、`### 接下来` 三个 Markdown 小节。
没有内容的小节整节省略，需要时可加 `### 风险`。每条一行，约 40 字以内，开头的关键词加粗；
细节用 `#D-n` / `#I-n` 编号指向看板，不在现状里重复。不写大段落，不用表格、代码块或一级、二级标题。
每次写入最多 1000 个 Unicode 字符（含 Markdown 标记）；超限会提示当前长度和上限。
已有长现状仍可完整读取，更新时须遵守上限。

Managers maintain the situation using these fixed level-3 Markdown headings, in order:
`### 正在做`, `### 等你`, `### 接下来` (In progress, Waiting for you, Next).
Omit empty sections and optionally add `### 风险` (Risks). Keep each item on one line, about 40
characters or fewer, with its opening keyword in bold. Link to details with `#D-n` / `#I-n` board
references instead of repeating them. Avoid long paragraphs, tables, code blocks and level-1 or level-2 headings.
Updates accept at most 1000 Unicode characters including markup; longer updates report their length
and the limit. Existing longer situations remain readable in full.

概览不再显示时间线。时间线没有独立写入工具或数据表；看板审计和工作线报告继续保存，
供问题历史、答复恢复和旧客户端读取。无需再要求经理维护时间线。

The overview no longer shows a timeline. There is no separate timeline tool or store. Board audit
records and workline reports remain available for issue history, answer recovery and older clients.

经理与能确定归属的工作线对话中，正文的 `#D-n`、`#I-n`、`#R-n`、`#P-n` 和 `#S-建议编号`
可直接打开对应看板对象。仅链接该经理看板中确认存在的编号；代码和已有链接不改写，普通会话不受影响。
桌面跳到看板对应分类，手机沿用议题卡和经理工作台的跳转。
跳到分页看板时按对象当前状态选中分栏，滚动到卡片并高亮；详情稍后到达或状态更新后会调整位置。
手动切换分类、状态或排序后停止跟随此次编号。

In manager and associated workline conversations, decision, item, request, report and suggestion
references open their board objects. Only confirmed references become links. Code and explicit
links remain unchanged, and ordinary conversations are unaffected.
Paged boards select the object's current status, scroll to its card and highlight it, including
when details arrive later or its status changes. Selecting another category, filter or sort order
ends following that reference.

「请你做」卡片的响应按钮直接提交该卡：完成按钮提交完成状态与已填写的备注；
「提交给经理」只提交文字回复。提交成功后清除该卡的响应草稿，其他卡片和讨论草稿保留；
失败时保留原文并显示原因。桌面与手机行为一致，底部提交条仍可批量提交尚未提交的草稿。

For you cards submit their response immediately: the completion button sends completion plus any
note, while Submit to manager sends a written reply. Success clears that response draft only;
failure keeps it and explains the error. Other cards and discussion drafts remain available for
batch submission on desktop and phone.

### 看板键盘提交 / Board keyboard submission

桌面看板的评论、讨论与追问、决策补充文字、请你做回复、忽略理由用 Enter 提交，Shift+Enter 换行。
决策补充沿用底部“提交给经理”的批量提交语义；请你做回复只提交当前卡。忽略理由为空时 Enter 不提交，仍可点确认忽略。
新建 issue 的标题用 Enter，正文用 Cmd+Enter（Windows/Linux 为 Ctrl+Enter）；多行正文的 Enter 和 Shift+Enter 都换行。
经理设置/创建表单及建议的“编辑后开始”也按单行 Enter、多行 Cmd/Ctrl+Enter；候选控件的 Enter 留给选择。
输入法组字确认不会发送；空内容不发送，提交中不重复发送，失败保留草稿。手机保留发送按钮，不新增外接键盘提交行为。

On desktop, Enter submits comments, discussion questions, decision notes, For you replies and dismissal reasons;
Shift+Enter inserts a newline. Decision notes use the existing batch submission; For you replies submit only that card.
An empty dismissal reason requires the confirmation button. For a new issue, Enter submits the title;
Cmd+Enter (Ctrl+Enter on Windows/Linux) submits its multiline body. Enter and Shift+Enter both add newlines in multiline editors.
Manager forms and Edit before starting use the same single-line/multiline rules; candidate controls keep Enter for selection.
IME confirmation never submits. Empty input and repeated submissions are blocked, and failed submissions keep drafts.
Phone send buttons remain; no external-keyboard submission behavior is added.

### 工作线问题的代答与撤回 / Settling workline questions

经理可通过 `litch_sessions.read` 查看 `pending_questions`，再以稳定的 `id` 调用
`litch_sessions.settle_question`，只处理自己子树里的异步提问或收尾问题。`action=answer`
附 `answer` 代答，`action=withdraw` 附 `reason` 撤回。适用于用户已在别处回答、经理权限内
可以决定或已经过期的问题；需要用户拍板、输入秘密或审批的事项不能代答。阻塞请求仍用 `respond`。
桌面和手机的待答、侧栏记号及计数会立即更新。原问题收成简短记录，展开可见经理、答案或原因，
并可点「重新回答」提交用户答复覆盖代答；经理记录保留。直接在工作线输入区说明修正也可以。
处理记录保存在会话所在设备，重连和重启不丢失；子会话在下一回合或唤醒时收到，操作本身不强制启动回合。
已有经理需要重置会话取得新增工具。普通 `send` 消息不会清除待答问题。

Managers use `read.pending_questions[].id` with `settle_question` to answer or withdraw asynchronous
and wrap-up questions in their own subtree. This is for answers already provided elsewhere, decisions
within delegated authority, or obsolete questions; user-only decisions, secrets and approvals remain
with the user. Pending indicators clear immediately on desktop and phone. Expand the original question
to inspect the manager record or choose **Answer again** to override it. Records survive reconnects and
device restarts; the child receives them on its next turn or wake, without starting a turn immediately.
Reset existing manager sessions to load the new tool. Ordinary `send` messages do not settle questions.

### 会话边界

- 经理输入区选定的模型和强度是当前会话的设置，后续看板事件沿用它们。
- 普通分叉和侧聊不会取得经理身份。Claude Code 分叉会移除经理工具与规则；不能替换工具的引擎拒绝分叉，需新建会话并提供简报。`hand_off` 同样遵守此限制，成功交接的工作线只保留工作线规则。
- 经理进入收尾后，对话和看板只读；手机工作台与普通详情页遵守同一状态。经理结束后，定时任务或其他设备内部调用也不能继续向该线程启动回合。
- 关闭「会话编排」不影响经理及其工作线的派线、回报和自动唤醒。用户停止、失败、单独停报或关闭自动唤醒等限制仍生效。
- 关闭对应 harness 的「任务卡」后，新建或重置的经理不再向模型提供提卡参数与提示；已有会话的提卡调用立即被拒绝，需要重置经理会话来更新已安装的工具。经理始终不使用 `wrap_up`。

### 看板分页

支持分页的设备提供看板摘要、分类列表、单条详情、版本历史和工作线核对接口。
未声明分页能力的设备继续使用原完整看板读取；已有设备数据库无需迁移。
摘要包含全板计数、局势、第一批待定决策、最近十条动态和工作线快照。
工作线核对独立进行；“尚未核对”或上次核对时间说明快照的新鲜度，失败时保留旧快照。
分页客户端只缓存已经打开的列表、详情和历史。答复成功后先根据设备回包更新该条决策及计数，
再在后台对账摘要和已加载的页；未打开的已答复、已关闭和已完成列表不会随答复一起读取。
桌面新决策通知仍覆盖全部待定决策，不受当前页或第一批条数限制。
桌面控制台、经理事项和手机工作台的分类列表每页 30 条，以“加载更多”继续，切换状态和排序时保留各自的滚动位置。
已答复、已关闭、已完成等状态在切换时读取。点击条目查看完整背景、选项、依据和讨论；版本历史独立展开，每次 30 条。
已加载范围在后台对账后保留，读取失败可重试；答复失败保留条目和草稿。正文中的编号可直接打开尚未加载的详情。
控制台卡片默认收起；有草稿的卡在卡头标“草稿”，下面一行写草稿里有什么（如“选了「…」 · 写了追问”）；
决策改过、草稿要先核对的标“草稿待确认”，议题已在别处结束的标“草稿已失效”并划掉摘要。
只要有能提交的草稿，“N 项草稿，尚未提交”提交条就固定在列表底部，不随卡片滚动；点草稿数依次跳到有草稿的卡，
提交成功后短暂显示“已提交 N 项”。没点开过的议题上的草稿同样计数、同样提交。手机相同，手机清除草稿前先确认。
决策页的提交条上另有“下一个”：按当前列表顺序展开当前展开项后面第一个待定、还没写草稿的决策（没有展开项时从头找；草稿待确认的不跳过），原来展开的收起，卡头停在列表顶部；后面没有了就置灰，悬停写明原因。偏好减少动态时直接定位。手机相同。

A manager is a conversation that coordinates worklines (sub-sessions), maintains decisions and items
on a board stored on its device, and reports progress. Repository changes remain the evidence for
what has landed. Managers and their worklines appear in the desktop sidebar's **Managers** view;
ordinary sessions appear in **Chat**. The phone home screen has a **Managers** entry: managers are
grouped by device. Desktop manager pages open **Console** first, followed by **Overview** and read-only **Manager items**.
The phone workbench opens **Console** first, followed by **Chat**, **Worklines** and **Overview** (with a collapsed manager items section at the bottom). Manager rows use the
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
Claude 刷新只等待当前回合结束，后台任务、临时追问与目标继续运行；其他引擎换会话仍等待经理回合、后台任务和临时追问结束。
等待期间可使用桌面原重置图标位置或手机标题栏的关闭图标取消重置，不增加页面高度。
发送消息或插话会自动取消等待并正常提交，重新加载会话与附件监听始终可用。
摘要或应用开始后不可取消，完成后可继续操作。重置结束、经理状态更新或设备重连时，客户端会重新订阅受影响的只读会话。
工作线继续运行，重置期间回报先排队。
重置时按设备当前开关补齐或移除浏览器、Computer Use、操作本机工具，并在设备提供定时任务时补齐定时任务工具。
已有 Claude 和 Pi 经理重新打开、重连或设备重启后恢复时也会更新这些工具；Codex 普通恢复不更新，重置创建的新会话使用当前开关。

Use the reset icon at the top right on desktop, or **Reset manager session** in the mobile manager page's **⋯** menu.
Both always ask for confirmation. On mobile, an amber marker on **⋯** highlights available updates;
the menu entry is disabled with a waiting explanation while a reset is in progress. An amber
dot means tools or instructions are behind the connected device's current definitions. Claude keeps
the same conversation and loads the new capabilities on its next turn. Other harnesses write a
handover summary and start a new session with the same harness and settings; the board and worklines
remain. The previous conversation becomes read-only history, accessible from the desktop reset dialog.
Conversation details outside the summary do not carry over. If summarizing fails, the user must
confirm again to continue with the board alone. Claude refresh waits only for the current turn;
background tasks, temporary questions and goals continue. Other harnesses also wait for background
tasks and temporary questions before replacing the session. While waiting, use the cancel icon in
the desktop reset button's position or the mobile title bar. Sending a message or steering cancels
the pending reset and submits the input normally. Subscriptions and attachment watching stay available.
Cancellation stops being available once summarizing or applying starts. Manager updates and device
reconnection retry affected read-only subscriptions. Worklines continue and reports queue meanwhile.
Reset adds or removes browser, Computer Use and local-machine tools according to current device settings,
and adds scheduling tools when the device provides scheduled tasks. Existing Claude and Pi managers also
refresh these tools when reopened, reconnected or resumed after a device restart. Normal Codex resumes
keep their tools; a replacement session created by reset uses the current settings.

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

经理或任意层级工作线**提出建议卡**时，卡片上的“新工作树”初值取经理设置，模型显式传参也不会覆盖。用户可在开始前修改开关；非 Git 目录不能勾选后直接开始，应关闭开关共享目录，或先编辑目录。直接派线仍可由经理按任务指定工作树。

For **suggestion cards** from a manager or any descendant workline, “New worktree” initially follows the manager setting, overriding the model’s argument. You can change the switch before starting. Outside a Git repository, turn it off to share the folder or edit the folder first. Direct dispatch can still select a worktree per task.

工作线执行期间仅在出现重大变更、重大发现，或需要经理决策才能继续时发送中途消息；其余结果在每回合结束时集中回报。

### 看板编号

看板的事项和决策标题前显示淡色编号（`I-n`、`D-n`）。说明中引用当前看板已有的编号时，
点击会切到对应页签并定位；已完成或暂缓事项会自动展开分组，决策会切到相应状态。
不存在的编号保留为普通文字。

### 访问权限

创建经理时，访问权限默认采用当前设备上该项目目录记住的权限，可在“运行环境”中修改。权限记录按设备、实际目录和 harness 分开保存，桌面和手机共享；不会自动改变已有经理或工作线的权限。无法保存记录时提示原因，仍按所选档位创建经理。

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
Overview starts with one row for the four console kinds (Decisions, For you, Reports, Suggestions),
each showing its open count; open counts are highlighted, and an all-zero row stays muted. Clicking
one switches to that console tab, exactly like choosing the kind inside Console. Below is the
manager's **Current status** card: Markdown written and maintained by the manager, with section
headings, lists and clickable board references, the update time and a small refresh icon. Overview
does not show manager items (they have their own tab) or the activity timeline; on paged boards the
work line list follows the status card. The **Manager settings** card closes the desktop Overview: the full rules with
line breaks and Markdown, long ones folded behind Show all, and an **Edit** button that opens the same
settings form as the header's Settings (only for an active manager on an online device). Work lines are managed from the left conversation tree;
the duplicate board tab is hidden. Opening a work line shows its conversation; **Back to manager** returns. Clicking an item's decision id opens that decision,
including the appropriate answered or closed group.

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
Collapsed cards mark drafts in the header (**Draft**, **Review draft** after the decision changed, or
**Draft no longer applies** after it ended elsewhere) with a one-line summary of what was written.
While submittable drafts exist, the submit bar stays pinned to the bottom of the list; select the
draft count to jump between drafted cards. Drafts on issues that were never opened still count and submit.
On the Decisions tab the bar also has **Next**: it opens the first open decision after the expanded
one in the current list order (from the top when none is expanded), skipping decisions that already
have a draft but not ones whose draft needs review, collapses the previous card and scrolls the new
card's header to the top of the list. It is disabled, with a tooltip, when no open decision follows.
With reduced motion it jumps without animation. The phone works the same way.
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

The phone supports all four issue kinds, questions, edit history and links. Each card can submit on
its own, and a submit bar pinned below the console submits all drafts together, as on desktop; clearing
asks for confirmation first. Phone drafts stay on the phone. User-created
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
- **Does opening a manager switch the sidebar?** No. Chat and Managers only choose the navigation tree.
  The last opened session determines the content; managers always include their full board. Switching trees also preserves an opening request that is still waiting for session identity. See
  `sessions-and-projects.md` for revealing its row.
  从侧栏“未读”“最近”等任何会话入口打开经理都进入经理工作台；工作线仍保留普通对话页面。
- **Cannot edit or create?** Connect the device and use a version supporting managers. The runtime
  must be ready, the working directory must exist, and concurrency must be a positive integer.

## Suggested tasks

A suggestion is a proposed task, not work already started and not a manager board item. Its card
offers **Start**, **Edit and start**, **Do it here**, and **Dismiss** (on the phone the card shows Start and
Do it here, the other two are under ⋯). The brief shows the background and task; expand it before starting. Missing choices inherit from the parent at the time you start it
(a different harness uses its own model/effort defaults). Worktree behavior and session authorization
are in `sessions-and-projects.md`.

### Where and how to use them

Before starting, use **Additional instructions (optional)** on the card or edit form to append
instructions to the new session’s task. The original card’s brief stays unchanged. Leave it blank
to start the original task. Enter starts from this field; Shift+Enter inserts a line break on desktop
and phone web previews. The phone’s software keyboard provides a Send action.

Starting closes the edit form immediately. The card shows **Starting…** while the device prepares
the session, including remote worktrees. You can keep using the app. A successful start shows the
child session link; a failed start stays on the card with **Retry start**, which resends the same
edited task and additional instructions, even after leaving and returning to the page.

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

经理自己的最近一份待办显示在桌面对话上方，沿用普通会话信息栏的待办卡片：可折叠、实时更新，全部完成且回合结束后默认收起。手机经理的“对话”页沿用普通会话输入框上方的“待办 N/N”按钮，点开查看清单；已完成的清单也可展开查看。

Claude Code 的系统附件和元数据提醒不作为对话正文展示。助手原样复述的已知 TodoWrite / Task 提醒前缀也会隐藏，后续回答保留；重新打开历史时同样处理，不修改原始会话记录。引用和解释提醒的正常回答保留。

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
已回复、已交付或已取消的请求不重复计入；已回复但尚未交付的请求仍计入“请你做”的未完成数。
“请你做”的默认交付按钮是“标记完成 / Mark as done”，经理可以指定其他文案。
提交后的回复按 Markdown 展示，并标明回复时间。

修改已提交的答案或请求回复时，可以点“取消修改”放弃当前修改，其他草稿不受影响；
取消答案修改也保留同一决策的追问草稿。追问入口旁的草稿标记表示有尚未提交的追问。
写了草稿还没提交，议题却在别处结束了（决策被经理记下答复、关闭、忽略或撤回，请你做在别处交付、回复或被取消，建议已处理），草稿不删，但不再计入底部“N 项草稿，尚未提交”和侧栏的草稿数，也不会随“提交给经理”发出。卡片上先是答复、关闭或忽略的记录，再写明草稿还在，可“查看草稿”或“丢弃”；丢弃要再点一次“确认丢弃”，丢了不能恢复。决策重新打开（含撤销忽略）且问题本身没改时，草稿自动恢复、可直接提交；问题改过的仍要先确认。手机相同。
原帖操作留在议题卡中，追问时间线通过卡片标题行的讨论入口打开，追问方式可切换，记录标明发言人。
追问输入框随内容自动增高，达到上限后在框内滚动；发送或清空后收回，不需手动拖拽。桌面上限与主输入框一致，手机沿用手机主输入框的增高方式。
Follow-up inputs grow with their content up to a limit, then scroll internally. Sending or clearing the text shrinks them again; no manual resizing is needed. Desktop uses the main composer’s height limit, and mobile uses its main composer’s growth behavior.
动态时间沿用消息时间格式，非当天显示星期或日期，悬停查看完整日期与时刻。

看板挤压对话时，输入框底栏保持单行，模型、权限等选项文字按可用宽度省略，完整当前值可通过悬停或读屏查看。
矮窗口中长草稿在输入框内滚动，为请求卡片按钮和终端保留空间。
全局建议汇总卡的已审核数量与未审核数量并列在标题行；未审核卡的标签只占文字所需宽度。

侧栏、收起入口及窄窗口中的合计统一标为“N 待处理 / N to handle”，悬停可查看三类待处理议题的数量明细，数量为零的部分省略。收起入口的按钮与数量标签提供相同明细。侧栏同时保留待处理数与草稿数；看板内“待定”仍只表示决策。
已答复决策先展示答案，再提供“修改答案”；答复与核对时间沿用消息时间格式。
提交一条或多条答复后保留当前决策分栏。在“待定”栏，答复成功的卡片立即移出，无需等待看板重新加载；焦点接续当前显示顺序中的下一条待定决策，没有下一条时回到列表头，不自动切到“已答复”。提交失败时保留待定状态和草稿，并显示失败原因。手机同样在提交成功后立即显示已答状态。
临时追问的回复标为“助手（临时对话）”；请求卡的回复行仅显示“你的回复”和时间，状态保留在卡片头部。

### 控制台与议题（0.28）

桌面看板页签依次为“控制台 · 概览 · 经理事项”，首次打开默认进入控制台；经理设定不再常驻在看板顶上，完整显示在概览末尾的“经理设定”卡里（保留换行和 Markdown，长的点“展开全文”），卡上的“编辑”与顶栏“设置”打开同一份表单；切换会话后返回仍保留原页签，指定议题的入口仍定位到对应类别。

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

手机首页有“经理”入口（第二行是待处理合计），经理按设备分组、先进行中后已结束；首页「最近」里经理那一行带“经理”小标签，工作线缩进显示在经理下面，行尾小箭头可收起，开合记在手机上；点击经理或工作线均打开对话详情。经理列表的记号和文字与桌面侧栏相同（见“看板答复与待办提示”）；有待处理时行尾是等待色的计数胶囊，读屏念整行时带上“N 待处理”。

进入经理是一个工作台：标题是经理名，副标题是状态（运行中、N 条工作线运行中、空闲等），下面一排页签“控制台 · 对话 · 工作线 · 概览”，首次打开默认落在控制台；显式链接和当前经理页已选择的页签优先。对话就是经理会话本身，和普通会话页一样能发消息、处理审批和工作线的审批；切到别的页签再回来，滚动位置和没发的草稿都在，只有对话页签显示着才把经理的回复标为已读。页签上的记号：对话在经理回合在跑或等人时有运行记号，有新回复时有未读点；控制台是等待色的待处理数（口径同桌面）；工作线是在跑的条数，有工作线等人或出错时换成等待记号。经理在对话里写到的看板编号（D-n、R-n、P-n、I-n）可以点：经理事项到概览并展开那一项，其他议题从底部拉起半屏议题卡，就在里面作答、忽略或交付，交上去后议题卡自动关上、回到对话原处；卡上的 ↗ 或标题是“在控制台打开”，点讨论记号也会到控制台并打开那条讨论。右上角“⋯”里是经理会话的建议任务、后台任务、用量和压缩上下文。

“工作线”页签列出经理开的每条线：记号和标题、最近动静的时间，第二行是状态和分支（领先几个提交、是否已合并），没有分支时写最近回报的第一句，行尾等待色的“没验 N”是回报里没验证的项数。等人、出错的排最前，然后是运行中、只剩后台任务、空闲；已合并的收在最下面“已结束 N”，默认收起。点一行进这条线的会话页；工作线会话页的副标题前半段是“↰ 经理名”，点了回到经理的工作线页签（从经理页进来时直接退回去，从链接或通知直达时新开经理页），“⋯”里也有“回到经理”和这条线的相关议题。

“概览”与桌面一致：上面一行是控制台四类（决策、请你做、报告、建议）的未完成数，点哪一类就到控制台的那一类；下面是经理维护的现状卡（Markdown，小标题、列表和看板编号可点，卡头有更新时间和刷新图标）；不显示受阻事项和最近动态。手机没有单独的经理事项页签，最下面“经理事项”一节默认收起，展开后每项一行，点开看理由和关联。控制台在窄屏上把排序收成一个图标，与类别同一行。手机作答决策时先点选一项（单选），再点“提交给经理”（没选也没写时按钮下方写明“先选一项或写补充说明”，决策没有选项时写“先写补充说明”）；选中项和补充文字都存为本机草稿，离开再回来还在，卡片状态标“草稿”。修改答案时上方照样显示原来的答复，原来选的那一项已选中。控制台可阅读和操作四类议题，并提交经理或临时追问。
手机沿用建议的开始/编辑/忽略，支持请求交付/文字回复、决策答复、报告已阅和讨论历史；创建经理、派活设置及完整经理事项看板仍在桌面。
用户主动新建议题尚未开放。手机也提供只读经理事项供关联定位；每张卡可单独提交，也可用控制台底部的提交条跨卡一起提交（同桌面）。

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

控制台所有列表默认最新优先（按议题发起时间），可切换为“最早优先”或“待处理优先”（待定决策、待做请你做、待审核及待开始建议、未阅报告排在前面，同组内仍按最新）。桌面的排序在列表头右端：决策在“待定 / 已答复 / 已关闭”那一行，因为已按状态分开，只有最新、最早两项；其他三类在列表上方一行。手机在类别那一行的末尾，点开是单选列表。选择保存在本机，所有经理、所有类别共用；桌面和手机各记各的。

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

从看板的建议来源、决策、事项等会话链接打开对话后，可用后退按钮、快捷键、鼠标侧键或手机返回回到原看板标签和滚动位置；未分页看板也保留阅读位置。

Opening a conversation from a suggestion source, decision, item or other board link adds a navigation entry. Use Back, the navigation shortcut, a mouse back button or the phone’s back action to return to the original board tab and scroll position. Unpaged boards also preserve their reading position.

桌面看板跟随“对话区字号”，包括概览、控制台、正文和追问。帖子标题旁的箭头可收起正文，保留标题、首行摘要和状态；已处理的决策、请你做、已阅报告和历史建议默认收起。开合选择在当前客户端会话中按帖子记住。帖子变更历史在展开时显示正文。

桌面和手机的分页看板按设备、经理、页签、状态筛选和排序分别记住展开的卡片与滚动位置；切换后返回、离开经理再返回均会恢复。每个列表最多展开一张卡，列表和详情加载完成后恢复位置；原卡已处理或不在当前筛选中时保持收起，滚动到原位置附近。阅读位置与对话滚动一样仅保留在当前客户端会话内，重启后不保留；排序偏好仍保存在本机。

控制台卡片标题行的讨论图标显示回复数；当前客户端内新到的回复、等待回复或未发出的追问带小点。点开后，全部问答按时间排在看板底部分屏，卡片列表独立滚动，当前卡片有选中记号。一次只打开一条讨论，换帖子会替换内容。拖动分隔条调整高度并保存在本机；聚焦分隔条后也可用上下方向键调整。点标题回到卡片，点关闭图标或按 Esc 关闭，未发出的草稿保留。窄窗口仍为卡片列表留出空间。

手机使用半屏底部抽屉，向上拖把手或点展开图标可到全屏，向下拖可收回半屏、再拖关闭；点标题关闭并回到卡片。两端的讨论默认展开，也可手动收起并记住。追问默认发到已有临时会话，没有临时问答时发给经理，输入框旁可切换。原来的草稿计数、随答复提交和已结束议题的草稿规则不变。全局建议窗口中的内嵌讨论仍在超过 1200 字符时默认收起。

待定决策更新后，已选的选项和已写的文字都保留，提示“决策已更新”，批量提交前先核对并确认新版本；没有填写的草稿静默清空。讨论输入框保留草稿和编辑位置，经理追问提示原帖已更新，两个页签都可继续编辑或单独发送，单独追问使用当前版本。已结束的议题继续保留草稿查看和丢弃入口。手机采用相同规则。推荐选项保留“推荐”标记，直接点选项选择。

临时对话下方的“转给经理”按钮带发送图标，悬停说明会发送本议题的完整问答记录。转交的消息显示议题编号、标题和各方发言，请经理继续解答，不代表决策答复或执行授权。

The desktop board follows the conversation text size, including overview, console, posts and questions. A chevron beside each post title collapses its body while keeping the title, first-line summary and status. Handled decisions and requests, read reports and historical suggestions start collapsed. Each choice is remembered for the current client session.

On desktop and mobile, paged boards remember the expanded card and scroll position separately for each device, manager, tab, status filter and sort order. Returning to a tab or manager restores its position after the list and card details load. Each list keeps at most one card expanded. If the card is no longer in the list, it stays collapsed and the list returns as close as possible to the previous position. Like conversation scroll positions, this reading state lasts for the current client session; the sort preference remains saved locally.

The discussion icon in each console card header shows its reply count. A dot indicates a new reply received in this client session, a pending reply or an unsent question. Open it to read all questions and answers chronologically in a pane below the board. The card list scrolls independently and highlights the selected card. Opening another post replaces the single pane. Drag its separator to resize it; the height is saved locally. The focused separator also accepts the Up and Down keys. Select the title to return to the card, or close with the icon or Esc. Drafts survive closing, and narrow windows retain space for the card list.

On phone, discussions open in a half-screen bottom drawer. Drag the handle up or use the expand icon for full screen; drag down to return to half screen, then again to close. Selecting the title closes the drawer and returns to its card. Discussions start expanded on both platforms and remember manual collapse choices. Follow-ups default to the existing temporary conversation, or to the manager when there is none; switch targets beside the input. Draft counts, submission with answers and ended-issue draft rules are unchanged. Inline discussions in the global suggestions window still start collapsed above 1,200 characters.

When an open decision changes, existing choices and text are kept with a review prompt. Confirm the new version before submitting. Empty drafts clear silently. Ended issues retain their existing draft review/discard flow. The phone follows the same rules. Recommended options retain their marker; select the option directly.

展开未读议题会合并确认已读；同一版内容的确认失败后不随页面刷新反复重试。新回复或重新打开时可再确认；报告仍由“已阅”操作处理。读取失败后同一查询的自动重读冷却 30 秒；手动重试、刷新或加载更多立即重新请求。连接恢复时重新对账。

Opening an unread issue coalesces read confirmations. A failed confirmation is not retried on each refresh of the same content. New replies or reopening allow another attempt; reports still use Mark as read. Automatic rereads of failed queries have a 30-second cooldown; manual retry, refresh and load more request data immediately. Reconnecting reconciles the board.

新建经理入口没有明确指定项目时，项目与目录一起恢复上次保存值；进入表单后仍可手动选择“无项目”。

新建经理每一步在进入下一步前校验。工作目录在目标设备上检查，显示解析后的设备路径；支持绝对路径、`~` 和 `~/项目目录`，远程设备使用远程设备自己的主目录。目录不存在、路径指向文件或无法访问时，提示原始输入、设备路径和修正方法。模型列表尚未加载时不能继续；型号和强度按目标 harness 的列表核对，创建时设备再次核验。名称、经理设定和首个任务可留空，最大并行工作线数必须为正安全整数。

创建或保存失败时，表单会定位到有问题的字段；前一步的错误会自动返回对应步骤并保留草稿。设备服务不认识操作时明确提示版本较旧；旧设备没有返回具体校验原因时，保留已知字段并提示升级设备服务，不能据此判断设置本身无效。

工作目录保留手动输入，并提供“选择目录”。桌面本机设备打开系统文件夹对话框；远程设备和手机浏览目标设备上的目录，可以返回主目录、逐层进入或输入路径跳转。只有确认“选择此目录”才回填，取消保留原草稿。在经理表单中选择其他目录会取消原项目选择，不修改原项目的根目录。

“决策未答复时持续等待”是固定选项；如果设备指出此项无效，表单定位到该项说明，并提示重新打开表单恢复默认值。

控制台的决策、建议、请你做和报告收起时点卡片任意空白处即可在原位展开，展开后点卡头收起；键盘在卡头上用 Enter、空格。
按钮、回复框、选项与链接单独操作，不折叠卡片；拖选或双击选取卡片文字时也不会开合。
控制台一次展开一张：点开另一张时，原来展开的收起，被点的卡留在原处不跳动；它展开后大半落在可视区外时，才平滑滚到能看见。
展开、收起有短暂的过渡；桌面上，提交、忽略或在别处处理后离开当前列表的卡原处收拢淡出，下面的卡上移补位，新卡淡入。
系统开启“减少动态效果”时不做这些过渡，状态立即切换。

Console decisions, suggestions, requests and reports expand in place when you click anywhere on a collapsed card; click the header of an expanded card to collapse it. From the keyboard, use Enter or Space on the header.
Buttons, reply boxes, options and links work on their own, and selecting card text by dragging or double-clicking does not toggle the card.
The console expands one card at a time: opening another card collapses the previous one while the selected card stays where it was. It scrolls smoothly only when most of the expanded card would be out of view.
Expanding and collapsing use a short transition. On desktop, cards that leave the current list after you submit, ignore or handle them elsewhere fold away in place while the cards below move up, and new cards fade in.
With the system's reduce-motion setting on, these transitions are skipped and changes apply immediately.

请你做与事项的依据、相关链接统一显示在“关联”中，同一目标只显示一次。文件链接在所属设备的文件预览打开，仓库外绝对路径同样支持；目录定位到文件树。
网址沿用浏览器偏好，分支与提交显示 Git 原文，会话与看板编号跳到对应对象。
桌面悬停显示完整目标，手机长按查看；无法读取时显示原因。

### 工作线并发上限

经理的 `dispatch.maxRunningLines` 是整个经理子树的并发上限，替代普通会话的直接子会话 8 条、整树 24 条默认保护；不计经理自身。新建工作线、恢复后开始新回合、`send` 唤起已结束的工作线执行同一检查。启动中、运行回合、等待审批或输入、后台任务、待接续都占一个名额，同一工作线只计一次；插话不重复占位，仅加载历史不占位。非经理会话仍使用 8/24 的默认上限；深度和单回合直接启动次数限制不变。超限错误会显示限制来源、当前数量和上限。

A manager's `dispatch.maxRunningLines` replaces the ordinary 8-direct-child / 24-session-tree concurrency defaults for its entire subtree, excluding the manager itself. Starting a line, starting a new turn after resume, and waking an idle line with `send` share the same check. Starting sessions, active turns, waiting approvals or input, background work, and pending continuations each occupy one slot per line. Steering an active turn adds no slot; loading history alone adds none. Ordinary sessions retain the 8/24 defaults. Depth and per-turn direct-start limits still apply. Capacity errors identify the limit, current occupancy, and maximum.


“请你做”请求可以选择“忽略”，填写选填理由后确认。忽略会移出待处理并进入“已忽略”分栏，经理会收到答复事件，明确知道您不准备做这件事；忽略不代表完成，也不同于经理取消。原有完成按钮和文字回复仍可使用，已处理请求可通过修改回复更新结果。旧设备不支持忽略时，入口禁用并提示升级设备服务。

For you requests have an Ignore action with an optional reason. Confirming removes the request from pending and puts it under Ignored. The manager receives a response event stating that you chose not to do it; ignoring is neither completion nor cancellation by the manager. The existing completion button and text replies remain available. Edit a handled request’s response to update its outcome. On older devices, Ignore is disabled with an upgrade explanation.

### 有效草稿与定位 / Active drafts

侧栏和提交条只统计当前仍有效的草稿。决策已答复、关闭或删除时，遗留草稿保留在本机，但不计数、不提交；用户主动选择“修改答复”后写的当前版本草稿仍可提交。待定决策版本变化时保留选项和文字，提示“决策已更新”，核对确认后才能提交。点击桌面侧栏的草稿数量会打开决策页并定位底部提交条。手机使用相同的草稿状态规则。

Sidebar and submit-bar counts include only active drafts. Drafts for answered, closed or deleted decisions stay locally but are neither counted nor submitted; an explicit edit of the current answer remains available. When an open decision changes, choices and text are kept for review before submission. Click the desktop sidebar draft count to open Decisions and focus the submit bar. Mobile uses the same draft-state rules.


经理事项（item）是经理自己的记录本，不应期待用户查看。需要用户注意、决定或处理的事，经理应提出决策（decision）或“请你做”（request）；新建事项的工具回执也会提醒这一点。

Manager items are the manager’s own notebook; the manager must not rely on the user reading them. Anything requiring the user’s attention, decision or action belongs in a decision or a For you request. The tool repeats this reminder after creating an item.
